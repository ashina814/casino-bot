/**
 * 統一Embed生成モジュール
 * 全ゲーム・全UIで共通のカラーパレットとレイアウトルールを適用する。
 */
import { EmbedBuilder, Colors } from "discord.js";
import { getBalance } from "../core/bank";
import { getTierByKey, getTierForLevel, expForNextLevel, type TierInfo } from "../core/economy";
import type { UserProfile } from "../core/db";

const TIER_THRESHOLDS: Array<{ level: number; key: string; name: string; emoji: string }> = [
  { level: 0,   key: "human",    name: "漂着者", emoji: "✦" },
  { level: 10,  key: "half",     name: "星拾い", emoji: "✧" },
  { level: 25,  key: "yokai",    name: "星渡り", emoji: "✶" },
  { level: 50,  key: "daiyokai", name: "星詠み", emoji: "✷" },
  { level: 100, key: "kami",     name: "北極星", emoji: "✹" },
];

function nextTierInfo(currentLevel: number): { name: string; emoji: string; levelsTo: number } | null {
  for (const t of TIER_THRESHOLDS) {
    if (currentLevel < t.level) return { name: t.name, emoji: t.emoji, levelsTo: t.level - currentLevel };
  }
  return null;
}

function progressBar(current: number, max: number, width = 10): string {
  if (max <= 0) return "█".repeat(width);
  const filled = Math.min(width, Math.max(0, Math.floor((current / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Colors (テーマカラー) ─────────────────────────────
// 寒色（青・紫）メインへ統一。金だけ暖色アクセントとして温存。
// ※キー名（MAIN/WIN/LOSE 等）は後方互換のため据え置き、値だけ寒色系に。

export const COLORS = {
  /** 深青紫 — メイン / パネル */
  MAIN: 0x4338CA,
  /** 星金 — アクセント / エテル / ジャックポット（暖色1色だけ温存） */
  GOLD: 0xF1C40F,
  /** 紺墨 — ベース / 通常状態 */
  BASE: 0x1E293B,
  /** 藤色 — 特別イベント */
  EVENT: 0x8E44AD,
  /** 水色 — ポジティブ / 利益 / 勝ち（旧:翠） */
  WIN: 0x38BDF8,
  /** 紫紅 — ネガティブ / 損失 / 負け（旧:紅） */
  LOSE: 0x9333EA,
  /** 暗紫 — 丑三つ時 */
  USHIMITSU: 0x2C003E,
} as const;

// ─── Base Embed Builder ────────────────────────────────

export function baseEmbed(title: string, color: number = COLORS.BASE): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp();
}

// ─── Game Result Embed ─────────────────────────────────

export function gameResultEmbed(opts: {
  title: string;
  description: string;
  result: "win" | "lose" | "draw" | "jackpot";
  fields?: { name: string; value: string; inline?: boolean }[];
  userId: string;
  guildId?: string;
  footer?: string;
}): EmbedBuilder {
  const colorMap = {
    win: COLORS.WIN,
    lose: COLORS.LOSE,
    draw: COLORS.GOLD,
    jackpot: COLORS.GOLD,
  };

  const embed = baseEmbed(opts.title, colorMap[opts.result])
    .setDescription(opts.description);

  if (opts.fields) {
    for (const f of opts.fields) {
      embed.addFields({ name: f.name, value: f.value, inline: f.inline ?? true });
    }
  }

  const balance = getBalance(opts.userId, opts.guildId);

  // 任務進捗のさりげない可視化（達成/全数）
  let questBadge = "";
  try {
    const { pickDailyQuests, getDailyPeriod, isClaimed, getQuestProgress } = require("../core/quests");
    const period = getDailyPeriod();
    const quests = pickDailyQuests(opts.userId, period);
    const done = quests.filter((q: any) => {
      if (isClaimed(opts.userId, q.key, period)) return true;
      return getQuestProgress(opts.userId, q, period, opts.guildId).completed;
    }).length;
    if (done > 0) questBadge = ` | 📋 任務 ${done}/${quests.length}`;
  } catch { /* quests module not ready or guild missing — skip silently */ }

  // 残高ゼロ（破産）時の出口ヒント
  if (balance === 0) {
    embed.addFields({
      name: "💸 賭場の救済",
      value: [
        "*「むぅ…、すっからかんになってしまったか。」*",
        "・明日の **福分け**（`/案内` のボタン）で復帰できる（連続ボーナス継続）",
        "・破産しても **段位・好感度・二つ名** は失わぬ",
        "・たまには `/アステル お礼` でわたしに声を掛けてみて",
      ].join("\n"),
      inline: false,
    });
  }

  embed.setFooter({ text: `${opts.footer ? opts.footer + " | " : ""}所持金: ◈${balance.toLocaleString()}${questBadge}` });

  return embed;
}

// ─── Profile Embed ─────────────────────────────────────

export function profileEmbed(profile: UserProfile, activeTitle?: string, vip = false): EmbedBuilder {
  const tier = getTierByKey(profile.tier);
  const totalGames = profile.total_wins + profile.total_losses;
  const winRate = totalGames > 0 ? ((profile.total_wins / totalGames) * 100).toFixed(1) : "0.0";

  // アステルとの星約（覚醒）情報
  let zashikiLine = "";
  try {
    const { getAffection } = require("../core/db");
    const { getStage } = require("../core/zashikiStage");
    const affection = getAffection(profile.user_id);
    const stage = getStage(affection);
    zashikiLine = `${stage.emoji} ${stage.name}（Lv${stage.level}）`;
    if (affection > 0) zashikiLine += `\n💖 好感度: ${affection}`;
  } catch {
    zashikiLine = "◌ 暗";
  }

  // レベル/星位 表示
  const expNext = expForNextLevel(profile.level);
  const expBar = progressBar(profile.exp, expNext, 10);
  const nextTier = nextTierInfo(profile.level);
  const tierProgress = nextTier
    ? `\n${nextTier.emoji} あと Lv${nextTier.levelsTo} で **${nextTier.name}** に昇格（賭け上限解放）`
    : "\n✹ 最上位「北極星」に到達";

  const curStreak = profile.current_win_streak > 0
    ? `🔥 ${profile.current_win_streak}連勝中`
    : profile.current_lose_streak > 0 ? `💧 ${profile.current_lose_streak}連敗中` : "—";
  const betCapEff = tier.betCap * (vip ? 2 : 1);
  const { tierBalanceCap } = require("../core/economy");
  const balCap: number = tierBalanceCap(tier);

  const embed = baseEmbed("✦ 通行証", COLORS.GOLD)
    .setDescription(
      [
        vip ? "💎 **VIP会員**" : "",
        activeTitle ? `🏷️ 「${activeTitle}」` : "",
        `${tier.emoji} **${tier.name}**　Lv.${profile.level}　\`${expBar}\``,
        tierProgress.replace(/^\n/, ""),
      ].filter(Boolean).join("\n"),
    )
    .addFields(
      { name: "💰 所持金", value: `◈${profile.balance.toLocaleString()} / 上限 ◈${balCap.toLocaleString()}`, inline: true },
      { name: "🎲 賭け上限", value: `◈${betCapEff.toLocaleString()}${vip ? "（×2）" : ""}`, inline: true },
      { name: "🔥 連続ログイン", value: `${profile.daily_streak}日`, inline: true },
      { name: "✦ アステル", value: zashikiLine, inline: true },
      { name: "📈 勝率", value: `${winRate}%（${profile.total_wins}勝${profile.total_losses}敗）`, inline: true },
      { name: "🏆 自己ベスト", value: `最高 ◈${profile.biggest_win.toLocaleString()}\n最長 ${profile.best_win_streak}連勝`, inline: true },
    )
    .setFooter({ text: `現在: ${curStreak}　|　ゲームで星の力が貯まり、段位が上がると賭け上限が解放される` });

  return embed;
}

// ─── Economy Status Embed ──────────────────────────────

export function economyEmbed(opts: {
  emoji: string;
  label: string;
  totalSupply: number;
  playerCount: number;
  healthyLine: number;
  jackpotPool: number;
  reliefPool: number;
}): EmbedBuilder {
  const avg = opts.playerCount > 0 ? Math.floor(opts.totalSupply / opts.playerCount) : 0;

  return baseEmbed("🔧 星約の賭場 — 管理パネル", COLORS.MAIN)
    .addFields(
      {
        name: "📊 経済状況",
        value: [
          `${opts.emoji} ${opts.label}`,
          `総流通量: ◈${opts.totalSupply.toLocaleString()}`,
          `プレイヤー数: ${opts.playerCount}人`,
          `1人あたり平均: ◈${avg.toLocaleString()}`,
          `健全ライン: ◈${opts.healthyLine.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "🏦 プール",
        value: [
          `JPプール: ◈${opts.jackpotPool.toLocaleString()}`,
          `底辺保護: ◈${opts.reliefPool.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
    );
}

// ─── Simple Info Embed ─────────────────────────────────

export function infoEmbed(title: string, description: string, color: number = COLORS.BASE): EmbedBuilder {
  return baseEmbed(title, color).setDescription(description);
}

export function errorEmbed(description: string): EmbedBuilder {
  return baseEmbed("❌ エラー", COLORS.LOSE).setDescription(description);
}

export function successEmbed(description: string): EmbedBuilder {
  return baseEmbed("✅ 成功", COLORS.WIN).setDescription(description);
}
