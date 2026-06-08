/**
 * JP バーン清算（自動）
 * ─────────────────────────────────────────────────────────
 * JP プールが閾値を超えると、5分ごとの cron で確率発火する。
 * 発火時:
 *   - プールの 50% を放出
 *   - 直近 7日 の賭け金累計を重みとして上位 5名 を抽選
 *   - 重み比で当選者へ分配（端数は relief_pool へ）
 *   - jackpot_channel_id に告知（無設定なら静かに何もしない）
 *
 * 確率: prob = clamp((pool/threshold - 1) * 0.05, 0, 0.10)
 *   pool 4.5M (1.5x): 2.5%/tick
 *   pool 6.0M (2.0x): 5.0%/tick
 *   pool 9.0M (3.0x): 10%/tick（cap）
 */
import { Client, ChannelType, type TextChannel } from "discord.js";
import { db, runTransaction } from "./db";
import { adjustBalance } from "./bank";
import { baseEmbed } from "../ui/embeds";
import { PALETTE, formatEther } from "../world.config";

export const BURN_THRESHOLD = 3_000_000;
export const BURN_STRIP_RATE = 0.5;   // 50% ストリップ
export const BURN_MAX_WINNERS = 5;
export const BURN_WEIGHT_DAYS = 7;
export const BURN_PROB_SLOPE = 0.05;
export const BURN_PROB_MAX = 0.10;
const BURN_POOL_FLOOR = 10_000; // slots.JP_POOL_FLOOR と一致させる

function computeBurnProb(pool: number): number {
  if (pool <= BURN_THRESHOLD) return 0;
  const r = pool / BURN_THRESHOLD - 1;
  return Math.max(0, Math.min(BURN_PROB_MAX, r * BURN_PROB_SLOPE));
}

type Candidate = { userId: string; wager: number };

function pickWeighted(cands: Candidate[], n: number): Candidate[] {
  // 重み付き復元なし抽選（重みは賭け金累計）
  const pool = [...cands];
  const picked: Candidate[] = [];
  while (picked.length < n && pool.length > 0) {
    const total = pool.reduce((s, c) => s + c.wager, 0);
    if (total <= 0) break;
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].wager;
      if (r <= 0) { idx = i; break; }
    }
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

/** 5分ごとに呼ぶ。全 guild を見て、閾値超のところで RNG。 */
export async function tickJackpotBurn(client: Client): Promise<void> {
  const rows = db.prepare(
    "SELECT guild_id, jackpot_pool, jackpot_channel_id FROM server_config WHERE jackpot_pool > ?"
  ).all(BURN_THRESHOLD) as Array<{ guild_id: string; jackpot_pool: number; jackpot_channel_id: string | null }>;

  for (const row of rows) {
    const prob = computeBurnProb(row.jackpot_pool);
    if (Math.random() >= prob) continue;
    try {
      await fireBurn(client, row.guild_id, row.jackpot_channel_id);
    } catch (e) {
      console.error(`[jackpotBurn] fire failed for guild ${row.guild_id}:`, e);
    }
  }
}

/** 実際にバーンを実行する（外部からの強制発火にも使える）。 */
export async function fireBurn(client: Client, guildId: string, channelId: string | null): Promise<{
  released: number;
  winners: Array<{ userId: string; share: number; weight: number }>;
} | null> {
  // 候補: 直近 N日 で実際に賭けたユーザー（bj_bet, slots_bet 等の wager イベント）
  const since = `datetime('now', '-${BURN_WEIGHT_DAYS} days')`;
  const cands = db.prepare(
    `SELECT user_id, SUM(ABS(amount)) AS wager FROM transaction_logs
     WHERE created_at >= ${since}
       AND game IS NOT NULL
       AND amount < 0
     GROUP BY user_id
     HAVING wager > 0`
  ).all() as Array<{ user_id: string; wager: number }>;

  if (cands.length === 0) {
    console.log(`[jackpotBurn] no candidates in ${BURN_WEIGHT_DAYS}d for guild ${guildId}; skip`);
    return null;
  }

  const candidates: Candidate[] = cands.map((c) => ({ userId: c.user_id, wager: c.wager }));
  const winners = pickWeighted(candidates, Math.min(BURN_MAX_WINNERS, candidates.length));
  if (winners.length === 0) return null;

  // プール再読み込み（同時実行レース対策）
  const cur = db.prepare("SELECT jackpot_pool FROM server_config WHERE guild_id = ?").get(guildId) as { jackpot_pool: number } | undefined;
  const pool = cur?.jackpot_pool ?? 0;
  if (pool <= BURN_THRESHOLD) return null; // 直前に他経路で消費されていた

  const releasable = Math.floor((pool - BURN_POOL_FLOOR) * BURN_STRIP_RATE);
  if (releasable <= 0) return null;

  // 重み比で分配
  const totalWeight = winners.reduce((s, w) => s + w.wager, 0);
  const shares = winners.map((w) => ({
    userId: w.userId,
    weight: w.wager,
    share: Math.floor(releasable * (w.wager / totalWeight)),
  }));
  const distributed = shares.reduce((s, x) => s + x.share, 0);
  const leftover = releasable - distributed;

  runTransaction(() => {
    db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool - ? WHERE guild_id = ?").run(releasable, guildId);
    for (const s of shares) {
      if (s.share > 0) {
        adjustBalance(s.userId, s.share, "JPバーン清算: 自動", "jackpot_burn", guildId);
      }
    }
    // 端数は relief_pool へ
    if (leftover > 0) {
      db.prepare("UPDATE server_config SET relief_pool = relief_pool + ? WHERE guild_id = ?").run(leftover, guildId);
    }
  });

  // 告知
  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch && ch.type === ChannelType.GuildText) {
        const lines = shares
          .filter((s) => s.share > 0)
          .map((s, i) => `${["①","②","③","④","⑤"][i] ?? "・"} <@${s.userId}>　**+${formatEther(s.share)}**　(重み ${formatEther(s.weight)})`);
        const embed = baseEmbed("🔥 ジャックポットバーン清算！", PALETTE.STARGOLD).setDescription([
          "*「星溜まりが、ふくらみすぎちゃった。──弾けちゃうね。」*",
          "",
          `💸 放出額: **${formatEther(releasable)}**（プール 50% / 残 ${formatEther(pool - releasable)}）`,
          `🎯 抽選: 直近 ${BURN_WEIGHT_DAYS}日 の賭け金重み付き ・ 最大 ${BURN_MAX_WINNERS}名`,
          "",
          ...lines,
        ].join("\n"));
        await (ch as TextChannel).send({ embeds: [embed] }).catch(() => {});
      }
    } catch (e) {
      console.warn("[jackpotBurn] announce failed:", e);
    }
  }

  return { released: releasable, winners: shares };
}

/** オーナー手動: 配布せずプールを純粋に削る（誤発行修正用）。 */
export function pureBurnJackpot(guildId: string, amount: number): { burned: number; remaining: number } {
  const cur = db.prepare("SELECT jackpot_pool FROM server_config WHERE guild_id = ?").get(guildId) as { jackpot_pool: number } | undefined;
  const pool = cur?.jackpot_pool ?? 0;
  const burnable = Math.max(0, pool - BURN_POOL_FLOOR);
  const burn = Math.min(Math.max(0, Math.floor(amount)), burnable);
  if (burn <= 0) return { burned: 0, remaining: pool };
  db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool - ? WHERE guild_id = ?").run(burn, guildId);
  return { burned: burn, remaining: pool - burn };
}
