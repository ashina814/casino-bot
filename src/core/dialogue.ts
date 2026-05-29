/**
 * アステル セリフエンジン
 *
 * セリフ = f(結果, 所持金, 星位, 連勝/連敗数, 星約(好感度), モード, ランダム)
 * 星約段階の掛け算でアステルの反応が動的に変わる。
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
  ZENSE,
  AFFECTION_WIN,
  AFFECTION_LOSE,
  AFFECTION_DAILY,
} from "./dialogueData";

// ─── Types ─────────────────────────────────────────────

/** セリフモード: default=常 / tsundere=拗ね / yami=蝕 / zense=前世(座敷童) */
export type DialogueMode = "default" | "tsundere" | "yami" | "zense";

export type DialogueContext = {
  tier: TierKey;
  balance: number;
  winStreak: number;
  loseStreak: number;
  mode?: DialogueMode;
  affection?: number;
};

/** モードに対応するセリフプール（default は null = 通常ロジックへ） */
function modePool(mode?: DialogueMode): typeof TSUNDERE | null {
  if (mode === "tsundere") return TSUNDERE;
  if (mode === "yami") return YAMI;
  if (mode === "zense") return ZENSE;
  return null;
}

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
  const mp = modePool(ctx.mode);
  if (mp) {
    if (ratio >= 50) return pick(mp.winJackpot);
    if (ratio >= 5 || winAmount >= 10_000) return pick(mp.winBig);
    return pick(mp.winSmall);
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
    return pick(WIN_BIG);
  }

  // ─── 通常勝ち ───
  // 星約セリフがあればそちらを優先（高いほどアステルらしい反応に）
  const affLine = pickByAffection(AFFECTION_WIN, affection);
  if (affLine) return affLine;

  return pick(WIN_SMALL[ctx.tier]);
}

export function dialogueLose(ctx: DialogueContext & { userId?: string }, loseAmount: number): string {
  const affection = resolveAffection(ctx);

  // ─── Mode Override ───
  const mp = modePool(ctx.mode);
  if (mp) {
    if (ctx.balance <= 0) return pick(mp.bankruptcy);
    if (ctx.loseStreak >= 10) return pick(mp.loseBig);
    if (ctx.loseStreak >= 5) return pick(mp.loseStreak);
    return pick(mp.loseSmall);
  }

  // ─── 破産 ───
  if (ctx.balance <= 0) {
    if (affection >= 100) {
      return "あらら、ぜんぶ使い果たしたか。しょうがないなあ、少しだけ貸すから、そんな顔しないの。";
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

  return pick(LOSE_SMALL[ctx.tier]);
}

export function dialogueDaily(
  streak: number,
  affection: number = 0,
  userId?: string,
  mode?: DialogueMode,
): string {
  // ─── Mode Override ───
  const mp = modePool(mode);
  if (mp) return pick(mp.daily);

  // ─── 星約セリフ ───
  const affLine = pickByAffection(AFFECTION_DAILY, affection);
  if (affLine) return affLine;

  // ─── 連続ログイン記念 ───
  const milestones = [30, 14, 7, 3, 1];
  for (const m of milestones) {
    if (streak >= m && DAILY[m]) {
      return pick(DAILY[m]);
    }
  }
  return pick(DAILY_DEFAULT);
}

export function dialogueFukuWeight(balance: number): string | null {
  if (balance <= 10_000) return null;
  return pick(FUKU_WEIGHT);
}

export function dialogueUshimitsudoki(): string | null {
  if (!isUshimitsudoki()) return null;
  return "……丑三つ時か。この時間の賭場は、少しだけ雰囲気が変わるんだよ。";
}

export function dialogueAbout(): string {
  return "星約の賭場 — アステル。先代（座敷童）に敬意を込めて。";
}
