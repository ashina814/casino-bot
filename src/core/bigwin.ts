/**
 * 大勝ち速報 — JP当選・高倍率勝ちを「大勝ち速報チャンネル」へ流す
 * ─────────────────────────────────────────────────────────
 * 賭場の"賑わい可視化"の核。各ゲームの勝ち確定点から broadcastBigWin() を呼ぶだけ。
 * 投稿先は server_config.jackpot_channel_id（/管理 で設定）。未設定なら静かに何もしない。
 *
 * 発火条件（いずれか）:
 *   - JP当選（isJackpot）… 常に
 *   - 高倍率: 払戻/ベット ≥ RATIO かつ 純益 ≥ RATIO_MIN_NET
 *   - 大金: 純益 ≥ ABS_NET（倍率が低くても特大なら）
 */
import { Client, ChannelType, type TextChannel } from "discord.js";
import { db } from "./db";
import { baseEmbed } from "../ui/embeds";
import { PALETTE, formatEther, WORLD } from "../world.config";

const RATIO = 15;            // 払戻 / ベット のしきい値
const RATIO_MIN_NET = 5_000; // 高倍率でも最低この純益が要る（少額20倍の連発を防ぐ）
const ABS_NET = 100_000;     // 倍率が低くてもこの純益なら速報

export type BigWinOpts = {
  userId: string;
  game: string;        // 表示名（"スロット" 等）
  bet: number;
  payout: number;      // 払い戻し総額（賭け金返却込み）
  isJackpot?: boolean;
};

/** 大勝ち判定→該当すれば速報を投げる（fire-and-forget・失敗は握り潰す） */
export function broadcastBigWin(client: Client, guildId: string, o: BigWinOpts): void {
  try {
    const row = db
      .prepare("SELECT jackpot_channel_id FROM server_config WHERE guild_id = ?")
      .get(guildId) as { jackpot_channel_id: string | null } | undefined;
    const chId = row?.jackpot_channel_id;
    if (!chId) return;

    const net = o.payout - o.bet;
    const ratio = o.bet > 0 ? o.payout / o.bet : 0;
    const qualifies = !!o.isJackpot || (ratio >= RATIO && net >= RATIO_MIN_NET) || net >= ABS_NET;
    if (!qualifies) return;

    void post(client, chId, o, net, ratio);
  } catch (e) {
    console.warn("[bigwin] broadcast check failed:", e);
  }
}

async function post(client: Client, chId: string, o: BigWinOpts, net: number, ratio: number): Promise<void> {
  try {
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return;

    const title = o.isJackpot ? "🎉 JACKPOT！" : "🔥 大勝ち速報";
    const headline = o.isJackpot
      ? `<@${o.userId}> が **${o.game}** で **${WORLD.POOL_JACKPOT}** を射止めた！　**+${formatEther(net)}**`
      : `<@${o.userId}> が **${o.game}** で **${ratio.toFixed(1)}倍** の大勝ち！　**+${formatEther(net)}**`;
    const flavor = o.isJackpot
      ? "*「……星が、ぜんぶきみのものになっちゃった。すごいね、ほんと。」*"
      : "*「うわっ、出たね。賭場がざわついてる。」*";

    const embed = baseEmbed(title, PALETTE.STARGOLD).setDescription(`${headline}\n${flavor}`);
    await (ch as TextChannel).send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.warn("[bigwin] post failed:", e);
  }
}
