/**
 * 座敷童セリフエンジン
 *
 * セリフ = f(結果, 所持金, 格, 連勝/連敗数, 好感度, モード, ランダム)
 * 覚醒段階の掛け算で座敷童の反応が動的に変わる。
 */

// ─── Imports ───────────────────────────────────────────

import {
  TierKey,
  WELCOME,
  WIN_SMALL,
  WIN_BIG,
  WIN_JACKPOT,
  LOSE_SMALL,
  LOSE_STREAK,
  LOSE_BIG,
  BANKRUPTCY,
  DAILY,
  DAILY_DEFAULT,
  FUKU_WEIGHT,
  TSUNDERE,
  YAMI,
  AFFECTION_WIN,
  AFFECTION_LOSE,
  AFFECTION_DAILY,
} from "./dialogueData";

// ─── Types ─────────────────────────────────────────────

export type DialogueContext = {
  tier: TierKey;
  balance: number;
  winStreak: number;
  loseStreak: number;
  mode?: "default" | "tsundere" | "yami";
  affection?: number;
};

// ─── Utility ───────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isUshimitsudoki(): boolean {
  const hour = new Date().getHours();
  return hour >= 2 && hour < 3;
}

/**
 * 好感度に応じたセリフプールから選択する。
 * 閾値の高いものから順にチェックし、該当するプールから1つ返す。
 * 該当なしの場合は null を返す。
 */
function pickByAffection(pool: Record<number, string[]>, affection: number): string | null {
  const thresholds = Object.keys(pool).map(Number).sort((a, b) => b - a);
  for (const threshold of thresholds) {
    if (affection >= threshold) {
      return pick(pool[threshold]);
    }
  }
  return null;
}

/**
 * 好感度を解決する。ctx に直接指定されていればそれを使い、
 * なければ DB から取得する（後方互換性）。
 */
function resolveAffection(ctx: DialogueContext & { userId?: string }): number {
  if (ctx.affection !== undefined) return ctx.affection;
  if (ctx.userId) {
    try {
      const { getAffection } = require("./db");
      return getAffection(ctx.userId);
    } catch {}
  }
  return 0;
}

// ─── Speech Style by Tier ──────────────────────────────

function honorific(tier: TierKey): string {
  switch (tier) {
    case "human":
    case "half":
      return "客人";
    case "yokai":
      return "お主";
    case "daiyokai":
      return "貴殿";
    case "kami":
      return "友よ";
  }
}

// ─── Public API ────────────────────────────────────────

export function dialogueWelcome(): string {
  return pick(WELCOME);
}

export function dialogueWin(
  ctx: DialogueContext & { userId?: string },
  winAmount: number,
  betAmount: number,
): string {
  const ratio = winAmount / betAmount;
  const affection = resolveAffection(ctx);

  // ─── Mode Override ───
  if (ctx.mode === "tsundere") {
    if (ratio >= 50) return pick(TSUNDERE.winJackpot);
    if (ratio >= 5 || winAmount >= 10_000) return pick(TSUNDERE.winBig);
    return pick(TSUNDERE.winSmall);
  }
  if (ctx.mode === "yami") {
    if (ratio >= 50) return pick(YAMI.winJackpot);
    if (ratio >= 5 || winAmount >= 10_000) return pick(YAMI.winBig);
    return pick(YAMI.winSmall);
  }

  // ─── 特大勝ち ───
  if (ratio >= 50) {
    const affLine = pickByAffection(AFFECTION_WIN, affection);
    if (affection >= 100 && affLine) {
      return pick([...WIN_JACKPOT, affLine]);
    }
    return pick(WIN_JACKPOT);
  }

  // ─── 大勝ち ───
  if (ratio >= 5 || winAmount >= 10_000) {
    const affLine = pickByAffection(AFFECTION_WIN, affection);
    if (affection >= 100 && affLine) {
      return pick([...WIN_BIG, affLine]);
    }
    return pick([...WIN_BIG, "大勝じゃな。運が向いておるぞ。"]);
  }

  // ─── 通常勝ち ───
  // 好感度セリフがあればそちらを優先（高好感度ほど座敷童らしい反応に）
  const affLine = pickByAffection(AFFECTION_WIN, affection);
  if (affLine) return affLine;

  return pick([...WIN_SMALL[ctx.tier], "勝負はこれからじゃ。"]);
}

export function dialogueLose(ctx: DialogueContext & { userId?: string }, loseAmount: number): string {
  const affection = resolveAffection(ctx);

  // ─── Mode Override ───
  if (ctx.mode === "tsundere") {
    if (ctx.balance <= 0) return pick(TSUNDERE.bankruptcy);
    if (ctx.loseStreak >= 10) return pick(TSUNDERE.loseBig);
    if (ctx.loseStreak >= 5) return pick(TSUNDERE.loseStreak);
    return pick(TSUNDERE.loseSmall);
  }
  if (ctx.mode === "yami") {
    if (ctx.balance <= 0) return pick(YAMI.bankruptcy);
    if (ctx.loseStreak >= 10) return pick(YAMI.loseBig);
    if (ctx.loseStreak >= 5) return pick(YAMI.loseStreak);
    return pick(YAMI.loseSmall);
  }

  // ─── 破産 ───
  if (ctx.balance <= 0) {
    if (affection >= 100) {
      return "おやおや…全部使い果たしたか。しゃーないのう、少しだけ貸してやるから、泣くでないぞ。";
    }
    return pick(BANKRUPTCY);
  }

  // ─── 大連敗 ───
  if (ctx.loseStreak >= 10) {
    const affLine = pickByAffection(AFFECTION_LOSE, affection);
    if (affection >= 100 && affLine) return affLine;
    return pick(LOSE_BIG);
  }

  // ─── 連敗 ───
  if (ctx.loseStreak >= 5) {
    const affLine = pickByAffection(AFFECTION_LOSE, affection);
    if (affection >= 50 && affLine) return affLine;
    return pick(LOSE_STREAK);
  }

  // ─── 通常負け ───
  const affLine = pickByAffection(AFFECTION_LOSE, affection);
  if (affLine) return affLine;

  return pick([...LOSE_SMALL[ctx.tier], "まぁ、気を取り直しての。"]);
}

export function dialogueDaily(
  streak: number,
  affection: number = 0,
  userId?: string,
  mode?: "default" | "tsundere" | "yami",
): string {
  // ─── Mode Override ───
  if (mode === "tsundere") return pick(TSUNDERE.daily);
  if (mode === "yami") return pick(YAMI.daily);

  // ─── 好感度セリフ ───
  const affLine = pickByAffection(AFFECTION_DAILY, affection);
  if (affLine) return affLine;

  // ─── 連続ログイン記念 ───
  const milestones = [30, 14, 7, 3, 1];
  for (const m of milestones) {
    if (streak >= m && DAILY[m]) {
      return pick(DAILY[m]);
    }
  }
  return pick([...DAILY_DEFAULT, "毎日コツコツが大事じゃぞ。"]);
}

export function dialogueFukuWeight(balance: number): string | null {
  if (balance <= 10_000) return null;
  return pick([...FUKU_WEIGHT, "大金は身を滅ぼすやもしれぬぞ？"]);
}

export function dialogueUshimitsudoki(): string | null {
  if (!isUshimitsudoki()) return null;
  return "…丑三つ時か。この時間の賭場は…少し違う雰囲気じゃろう？";
}

export function dialogueAbout(): string {
  return "先代の座敷童に敬意を込めて。";
}
