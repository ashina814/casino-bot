import { db, getServerConfig, runTransaction, UserProfile } from "./db";
import { emitTxEvent } from "./txfeed";

// ─── Types ─────────────────────────────────────────────

export type BankAdjustResult =
  | { ok: true; balance: number }
  | { ok: false; reason: "INSUFFICIENT_FUNDS" | "INVALID_AMOUNT" | "BALANCE_CAP" };

export type BetValidationResult =
  | { ok: true; value: number }
  | { ok: false; reason: "NOT_INTEGER" | "TOO_SMALL" | "TOO_LARGE" | "NOT_SAFE" };

/**
 * 賭け金入力の共通バリデーション。
 * - 整数（小数・NaN・Infinity を拒絶）
 * - 正の値かつ min..max の範囲
 * - Number.isSafeInteger 内（オーバーフロー防御）
 */
export function validateBet(input: unknown, min: number, max: number): BetValidationResult {
  const num = typeof input === "string" ? Number(input) : (typeof input === "number" ? input : NaN);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return { ok: false, reason: "NOT_INTEGER" };
  }
  if (!Number.isSafeInteger(num)) {
    return { ok: false, reason: "NOT_SAFE" };
  }
  if (num < min) {
    return { ok: false, reason: "TOO_SMALL" };
  }
  if (num > max) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  return { ok: true, value: num };
}

// ─── Core Functions ────────────────────────────────────

function toInt(value: number): number {
  return Math.floor(value);
}

export function ensureUser(userId: string, guildId?: string): UserProfile {
  let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserProfile | undefined;
  if (!user) {
    const cfg = guildId ? getServerConfig(guildId) : null;
    const initialBalance = cfg?.initial_balance ?? 3000;
    db.prepare("INSERT INTO users (user_id, balance) VALUES (?, ?)").run(userId, initialBalance);
    user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserProfile;
  }
  // 特別ユーザーへのトリビュート付与（冪等、初回のみ実効）
  try {
    const { grantSpecialTributes } = require("./specialUsers");
    grantSpecialTributes(userId);
  } catch { /* non-critical */ }
  return user;
}

/**
 * 残高を変更する。正の値 = 増加、負の値 = 減少。
 * 福の重み（累進奉納）は呼び出し側で別途計算して適用する。
 *
 * guildId を渡すと所持金上限（balance_cap）を強制する。上限を超えた分は
 * jackpot_pool と relief_pool に半々で奉納し、ユーザー残高は cap でクランプする。
 */
export function adjustBalance(userId: string, amount: number, reason: string, game?: string, guildId?: string): BankAdjustResult {
  return runTransaction(() => {
    const normalizedAmount = toInt(amount);
    if (!Number.isFinite(normalizedAmount) || !Number.isSafeInteger(normalizedAmount)) {
      console.warn(`[adjustBalance] rejected unsafe amount: ${amount} (user=${userId}, reason=${reason})`);
      return { ok: false as const, reason: "INVALID_AMOUNT" as const };
    }

    ensureUser(userId, guildId);
    const userRow = db.prepare("SELECT balance, tier FROM users WHERE user_id = ?").get(userId) as { balance: number; tier: string };
    const currentBalance = userRow.balance;
    let newBalance = currentBalance + normalizedAmount;

    if (normalizedAmount < 0 && newBalance < 0) {
      return { ok: false as const, reason: "INSUFFICIENT_FUNDS" as const };
    }

    // 加算結果も安全整数内に収まることを保証（防御層）
    if (!Number.isSafeInteger(newBalance)) {
      console.warn(`[adjustBalance] rejected: newBalance overflow (current=${currentBalance}, delta=${normalizedAmount}, user=${userId})`);
      return { ok: false as const, reason: "INVALID_AMOUNT" as const };
    }

    // 所持金上限: ティア別上限（betCap×50, 30万〜500万）と
    // サーバー設定の balance_cap（ハード天井）の min を取る。
    // 増加方向だけでなく、既に上限超過のユーザーが何か操作した場合も
    // 結果残高が cap を超えていれば差分を奉納する（移行期の自動収縮）。
    let overflow = 0;
    if (guildId && newBalance > 0) {
      const { getTierByKey, tierBalanceCap } = require("./economy");
      const tier = getTierByKey(userRow.tier ?? "human");
      const tierCap = tierBalanceCap(tier);
      const cfg = getServerConfig(guildId);
      const serverCap = typeof cfg?.balance_cap === "number" ? cfg.balance_cap : Number.POSITIVE_INFINITY;
      const cap = Math.min(tierCap, serverCap);
      if (newBalance > cap) {
        overflow = newBalance - cap;
        newBalance = cap;
      }
    }

    db.prepare("UPDATE users SET balance = ? WHERE user_id = ?").run(newBalance, userId);
    db.prepare("INSERT INTO transaction_logs (user_id, amount, reason, game) VALUES (?, ?, ?, ?)").run(userId, normalizedAmount, reason, game ?? null);
    emitTxEvent({ userId, amount: normalizedAmount, reason, game: game ?? null, guildId: guildId ?? null, currency: "currency2" });

    if (overflow > 0 && guildId) {
      const half = Math.floor(overflow / 2);
      const rest = overflow - half;
      db.prepare(`
        UPDATE server_config
        SET jackpot_pool = jackpot_pool + ?,
            relief_pool = relief_pool + ?
        WHERE guild_id = ?
      `).run(half, rest, guildId);
      db.prepare("INSERT INTO transaction_logs (user_id, amount, reason, game) VALUES (?, ?, ?, ?)").run(userId, -overflow, `${reason}_cap_奉納`, game ?? null);
      emitTxEvent({ userId, amount: -overflow, reason: `${reason}_cap_奉納`, game: game ?? null, guildId, currency: "currency2" });
    }

    // Easter-egg checks (silent: titles awarded, visible in /案内 → 二つ名)
    try {
      const { checkMillionaire, checkBankrupt } = require("../easter-eggs/index");
      if (normalizedAmount > 0) checkMillionaire(userId, newBalance);
      if (normalizedAmount < 0 && newBalance === 0) checkBankrupt(userId, newBalance);
    } catch { /* ignore — easter eggs are non-critical */ }

    return { ok: true as const, balance: newBalance };
  });
}

export function getBalance(userId: string, guildId?: string): number {
  const user = ensureUser(userId, guildId);
  return user.balance;
}

export function getProfile(userId: string, guildId?: string): UserProfile {
  return ensureUser(userId, guildId);
}

// ─── Stats Update ──────────────────────────────────────

export function recordWin(userId: string, winAmount: number): void {
  let v = toInt(winAmount);
  // 非数・無限・安全整数超過は記録しない（DB を壊さない防御層）
  if (!Number.isFinite(v) || !Number.isSafeInteger(v) || v < 0) {
    console.warn(`[recordWin] rejected unsafe winAmount: ${winAmount} (user=${userId})`);
    return;
  }

  // カムバック勝利判定: 更新前の連敗数を読む（UPDATE で 0 にリセットされる前に取る）
  let preLoseStreak = 0;
  try {
    const row = db.prepare("SELECT current_lose_streak FROM users WHERE user_id = ?").get(userId) as { current_lose_streak: number } | undefined;
    preLoseStreak = row?.current_lose_streak ?? 0;
  } catch { /* silent */ }

  db.prepare(`
    UPDATE users SET
      total_wins = total_wins + 1,
      total_earned = MIN(total_earned + ?, ${Number.MAX_SAFE_INTEGER}),
      biggest_win = MAX(biggest_win, ?),
      current_win_streak = current_win_streak + 1,
      best_win_streak = MAX(best_win_streak, current_win_streak + 1),
      current_lose_streak = 0
    WHERE user_id = ?
  `).run(v, v, userId);

  // マイルストーン称号（百戦錬磨/千勝/大穴/連勝の灯 など）の冪等付与
  try {
    const { checkWinMilestones } = require("./milestoneTitles");
    checkWinMilestones(userId);
  } catch { /* silent */ }

  // カムバック勝利: 連敗5+からの復帰勝利で好感度 +3。
  // 連敗 0 リセット後の次の勝利では preLoseStreak が 0 なので、1連勝につき1回しか発火しない。
  if (preLoseStreak >= 5) {
    try {
      const { addAffection } = require("./db");
      const { AFFECTION_GAINS } = require("./zashikiStage");
      addAffection(userId, AFFECTION_GAINS.comebackWin);
    } catch { /* silent */ }
  }
}

export function recordLoss(userId: string): void {
  db.prepare(`
    UPDATE users SET
      total_losses = total_losses + 1,
      current_lose_streak = current_lose_streak + 1,
      current_win_streak = 0
    WHERE user_id = ?
  `).run(userId);
}

// ─── v2: 第一通貨 (currency1) 操作 ───────────────────────
// カジノコイン (balance) と完全に独立した残高。
// 主な用途: /両替, 従業員給与 (Iter.4), 管理者調整。
// ゲームでは絶対に使わない（カジノは第二通貨で完結する設計）。

export function getCurrency1Balance(userId: string, guildId?: string): number {
  const user = ensureUser(userId, guildId);
  return user.currency1_balance ?? 0;
}

export function adjustCurrency1Balance(
  userId: string,
  amount: number,
  reason: string,
  guildId?: string,
): BankAdjustResult {
  return runTransaction(() => {
    const normalizedAmount = toInt(amount);
    if (!Number.isFinite(normalizedAmount) || !Number.isSafeInteger(normalizedAmount)) {
      return { ok: false as const, reason: "INVALID_AMOUNT" as const };
    }

    ensureUser(userId, guildId);
    const current = (db.prepare("SELECT currency1_balance FROM users WHERE user_id = ?").get(userId) as { currency1_balance: number }).currency1_balance;
    const newBalance = current + normalizedAmount;

    if (normalizedAmount < 0 && newBalance < 0) {
      return { ok: false as const, reason: "INSUFFICIENT_FUNDS" as const };
    }
    if (!Number.isSafeInteger(newBalance)) {
      return { ok: false as const, reason: "INVALID_AMOUNT" as const };
    }

    db.prepare("UPDATE users SET currency1_balance = ? WHERE user_id = ?").run(newBalance, userId);
    db.prepare("INSERT INTO transaction_logs (user_id, amount, reason, game, currency) VALUES (?, ?, ?, NULL, 'currency1')")
      .run(userId, normalizedAmount, reason);

    return { ok: true as const, balance: newBalance };
  });
}

/** v2: 換金マイル累計を加算（称号判定用） */
export function addExchangeMiles(userId: string, direction: "in" | "out", amount: number): void {
  const v = toInt(amount);
  if (!Number.isFinite(v) || !Number.isSafeInteger(v) || v <= 0) return;
  const col = direction === "in" ? "exchange_in_total" : "exchange_out_total";
  db.prepare(`UPDATE users SET ${col} = MIN(${col} + ?, ${Number.MAX_SAFE_INTEGER}) WHERE user_id = ?`).run(v, userId);
}

export function recordWager(userId: string, amount: number): void {
  const v = toInt(amount);
  if (!Number.isFinite(v) || !Number.isSafeInteger(v) || v < 0) {
    console.warn(`[recordWager] rejected unsafe amount: ${amount} (user=${userId})`);
    return;
  }
  db.prepare(`UPDATE users SET total_wagered = MIN(total_wagered + ?, ${Number.MAX_SAFE_INTEGER}) WHERE user_id = ?`)
    .run(v, userId);

  // マイルストーン称号（太客）の冪等付与
  try {
    const { checkWagerMilestones } = require("./milestoneTitles");
    checkWagerMilestones(userId);
  } catch { /* silent */ }

  // Easter-egg: bet == 777 → 「幸運児」
  try {
    const { checkLucky7 } = require("../easter-eggs/index");
    checkLucky7(userId, v);
  } catch { /* ignore */ }
}
