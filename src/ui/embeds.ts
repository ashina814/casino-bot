/**
 * 統一Embed生成モジュール
 * 全ゲーム・全UIで共通のカラーパレットとレイアウトルールを適用する。
 */
import { EmbedBuilder, Colors } from "discord.js";
import { getBalance } from "../core/bank";
import { getTierByKey, getTierForLevel, expForNextLevel, type TierInfo } from "../core/economy";
import type { UserProfile } from "../core/db";

const TIER_THRESHOLDS: Array<{ level: number; key: string; name: string; emoji: string }> = [
  { level: 0,   key: "human",    name: "人間",  emoji: "👤" },
  { level: 10,  key: "half",     name: "半妖",  emoji: "🌗" },
  { level: 25,  key: "yokai",    name: "妖",    emoji: "👹" },
  { level: 50,  key: "daiyokai", name: "大妖",  emoji: "🐉" },
  { level: 100, key: "kami",     name: "神",    emoji: "⛩️" },
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

export const COLORS = {
  /** 朱色 — メイン / 勝利 / アクション */
  MAIN: 0xC0392B,
  /** 金色 — アクセント / 小判 / ジャックポット */
  GOLD: 0xF1C40F,
  /** 墨色 — ベース / 通常状態 */
  BASE: 0x2C2C2C,
  /** 藤色 — 特別イベント */
  EVENT: 0x8E44AD,
  /** 翡翠 — ポジティブ / 利益 / 勝ち */
  WIN: 0x27AE60,
  /** 紅 — ネガティブ / 損失 / 負け */
  LOSE: 0xE74C3C,
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
        "・明日の **`/福分け`** で復帰できる（連続ボーナス継続）",
        "・破産しても **段位・好感度・二つ名** は失わぬ",
        "・たまには `/感謝` でわしに声を掛けてみよ",
      ].join("\n"),
      inline: false,
    });
  }

  embed.setFooter({ text: `${opts.footer ? opts.footer + " | " : ""}所持金: ◉${balance.toLocaleString()}${questBadge}` });

  return embed;
}

// ─── Profile Embed ─────────────────────────────────────

export function profileEmbed(profile: UserProfile, activeTitle?: string): EmbedBuilder {
  const tier = getTierByKey(profile.tier);
  const totalGames = profile.total_wins + profile.total_losses;
  const winRate = totalGames > 0 ? ((profile.total_wins / totalGames) * 100).toFixed(1) : "0.0";

  // 座敷童の覚醒情報
  let zashikiLine = "";
  try {
    const { getAffection, getAffectionFull } = require("../core/db");
    const { getStage, GOGYO } = require("../core/zashikiStage");
    const affection = getAffection(profile.user_id);
    const stage = getStage(affection);
    const row = getAffectionFull(profile.user_id);
    const element = row.element;

    zashikiLine = `${stage.emoji} ${stage.name}（Lv${stage.level}）`;
    if (affection > 0) zashikiLine += `\n💖 好感度: ${affection}`;
    if (element && GOGYO[element]) {
      const info = GOGYO[element];
      zashikiLine += `\n${info.emoji} ${info.name}`;
      if (stage.level >= 6) {
        zashikiLine += ` → ✨ ${info.shinchu}`;
      }
    }
  } catch {
    zashikiLine = "🫥 幽か";
  }

  // レベル/段位 表示
  const expNext = expForNextLevel(profile.level);
  const expBar = progressBar(profile.exp, expNext, 10);
  const nextTier = nextTierInfo(profile.level);
  const tierProgress = nextTier
    ? `\n${nextTier.emoji} あと Lv${nextTier.levelsTo} で **${nextTier.name}** に昇格（賭け上限解放）`
    : "\n⛩️ 最上位「神」に到達";

  const embed = baseEmbed("🏮 座敷童の賭場 — 通行証", COLORS.GOLD)
    .addFields(
      {
        name: "👤 プレイヤー",
        value: [
          activeTitle ? `🏷️ 「${activeTitle}」` : "",
          `${tier.emoji} **${tier.name}** （Lv.${profile.level}）`,
          `妖力 \`${expBar}\` ${profile.exp.toLocaleString()} / ${expNext.toLocaleString()}`,
          `賭け上限: ◉${tier.betCap.toLocaleString()}${tierProgress}`,
        ].filter(Boolean).join("\n"),
        inline: false,
      },
      {
        name: "💰 資産",
        value: `◉${profile.balance.toLocaleString()}`,
        inline: true,
      },
      {
        name: "🏮 座敷童",
        value: zashikiLine,
        inline: true,
      },
      {
        name: "📈 戦績",
        value: [
          `勝率: **${winRate}%** （${profile.total_wins.toLocaleString()}勝 / ${profile.total_losses.toLocaleString()}敗、${totalGames.toLocaleString()}戦）`,
          `最大勝ち: ◉${profile.biggest_win.toLocaleString()}`,
          `最長連勝: ${profile.best_win_streak}回`,
          `現在: ${profile.current_win_streak > 0 ? `🔥 ${profile.current_win_streak}連勝中` : profile.current_lose_streak > 0 ? `💧 ${profile.current_lose_streak}連敗中` : "（無印）"}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "💴 累計",
        value: [
          `賭け額: ◉${profile.total_wagered.toLocaleString()}`,
          `稼ぎ: ◉${profile.total_earned.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "📅 ログイン",
        value: `🔥 連続: ${profile.daily_streak}日`,
        inline: true,
      },
    );

  // 称号取得数
  try {
    const { db } = require("../core/db");
    const { TITLES_CATALOG } = require("../core/titlesCatalog");
    const row = db.prepare("SELECT COUNT(*) AS c FROM titles WHERE user_id = ?").get(profile.user_id) as { c: number };
    embed.addFields({
      name: "📜 二つ名",
      value: `${row.c} / ${TITLES_CATALOG.length}`,
      inline: true,
    });
  } catch { /* ignore */ }

  embed.setFooter({ text: "妖力(EXP)はゲームをプレイすると貯まる。レベルが上がると段位も昇格し、賭け上限が解放される。" });

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

  return baseEmbed("🔧 座敷童の賭場 — 管理パネル", COLORS.MAIN)
    .addFields(
      {
        name: "📊 経済状況",
        value: [
          `${opts.emoji} ${opts.label}`,
          `総流通量: ◉${opts.totalSupply.toLocaleString()}`,
          `プレイヤー数: ${opts.playerCount}人`,
          `1人あたり平均: ◉${avg.toLocaleString()}`,
          `健全ライン: ◉${opts.healthyLine.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "🏦 プール",
        value: [
          `JPプール: ◉${opts.jackpotPool.toLocaleString()}`,
          `底辺保護: ◉${opts.reliefPool.toLocaleString()}`,
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
