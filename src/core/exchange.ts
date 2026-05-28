/**
 * v2: 為替機構
 * ─────────────────────────────────────────────────────────
 * 第一通貨 ⇄ 第二通貨（カジノコイン）の為替レート計算と両替実行。
 *
 * 設計（DESIGN_v2.md §1.2 ＆ §1.3）:
 *   - 基準レート: 1 第一通貨 = BASE_RATE カジノコイン
 *   - 自動補正: カジノコイン総供給量 vs (アクティブ人数 × HEALTHY_PER_PLAYER)
 *       供給過多 → レート悪化（コイン安）
 *       供給不足 → レート好転（コイン高）
 *   - 手動補正: server_config.exchange_rate_offset（管理者介入用）
 *
 * 両替手数料（DESIGN_v2.md §1.3, §1.4）:
 *   - 第一 → 第二（"in"）: 手数料 0%
 *   - 第二 → 第一（"out"）: 手数料 20%（半分→JPプール、半分→救済プール＝「奉納」）
 */

import { db, getServerConfig, runTransaction, type CurrencyExchange } from "./db";
import {
  ensureUser,
  adjustBalance,
  adjustCurrency1Balance,
  addExchangeMiles,
} from "./bank";

// ─── 定数 ─────────────────────────────────────────────

/** 基準レート: 1 第一通貨 = この数の第二通貨 */
export const BASE_RATE = 10.0;

/** 1人あたりの健全カジノコイン保有量（経済の中心値） */
export const HEALTHY_PER_PLAYER = 50_000;

/** 自動補正の上限／下限（基準からの倍率） */
export const AUTO_OFFSET_MIN = -3.0; // コイン安方向に最大 -3
export const AUTO_OFFSET_MAX = 3.0;  // コイン高方向に最大 +3

/** 第二→第一の換金時手数料率（奉納率） */
export const EXCHANGE_OUT_FEE = 0.20;

// ─── 型 ───────────────────────────────────────────────

export type ExchangeRateInfo = {
  /** 最終レート (1 第一 = N 第二) */
  rate: number;
  /** 基準レート */
  base: number;
  /** 自動補正値 */
  autoOffset: number;
  /** 手動補正値 (server_config から) */
  manualOffset: number;
  /** カジノコイン総供給量 */
  totalSupply: number;
  /** アクティブプレイヤー数 */
  playerCount: number;
  /** 健全ライン (= playerCount × HEALTHY_PER_PLAYER) */
  healthyLine: number;
  /** 経済状態ラベル */
  trend: "コイン高" | "通常" | "コイン安";
};

export type ExchangeResult =
  | {
      ok: true;
      direction: "in" | "out";
      sourceAmount: number;
      receivedAmount: number;
      feeAmount: number; // 奉納額（第二通貨基準）
      rate: number;
      record: CurrencyExchange;
    }
  | {
      ok: false;
      reason: "INVALID_AMOUNT" | "INSUFFICIENT_FUNDS" | "RECEIVED_TOO_SMALL";
    };

// ─── レート計算 ────────────────────────────────────────

/**
 * 現在の為替レートを算出する。
 * 純関数（DBから状態を読むだけ、副作用なし）。
 */
export function computeExchangeRate(guildId: string): ExchangeRateInfo {
  const cfg = getServerConfig(guildId);

  const stats = db.prepare(
    "SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total FROM users"
  ).get() as { count: number; total: number };

  const playerCount = stats.count;
  const totalSupply = stats.total;
  const healthyLine = playerCount * HEALTHY_PER_PLAYER;

  // 自動補正: 供給過多なら + (コイン安)、不足なら - (コイン高)
  let autoOffset = 0;
  let trend: ExchangeRateInfo["trend"] = "通常";

  if (healthyLine > 0) {
    const ratio = totalSupply / healthyLine;
    // ratio = 1 → 補正なし
    // ratio = 2 → +2 (コイン安)
    // ratio = 0.5 → -1 (コイン高)
    autoOffset = (ratio - 1) * 2;
    autoOffset = Math.max(AUTO_OFFSET_MIN, Math.min(AUTO_OFFSET_MAX, autoOffset));
    if (autoOffset > 0.3) trend = "コイン安";
    else if (autoOffset < -0.3) trend = "コイン高";
  }

  const manualOffset = cfg.exchange_rate_offset ?? 0;
  const rate = Math.max(1.0, BASE_RATE + autoOffset + manualOffset);

  return {
    rate: Math.round(rate * 100) / 100, // 小数点2桁
    base: BASE_RATE,
    autoOffset: Math.round(autoOffset * 100) / 100,
    manualOffset,
    totalSupply,
    playerCount,
    healthyLine,
    trend,
  };
}

// ─── 両替実行 ────────────────────────────────────────

/**
 * 第一通貨 → 第二通貨 への両替。手数料なし。
 * @param sourceAmount 投入する第一通貨の額
 */
export function exchangeIn(
  userId: string,
  sourceAmount: number,
  guildId: string,
): ExchangeResult {
  return runTransaction(() => {
    const amt = Math.floor(sourceAmount);
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isSafeInteger(amt)) {
      return { ok: false as const, reason: "INVALID_AMOUNT" as const };
    }

    const info = computeExchangeRate(guildId);
    const received = Math.floor(amt * info.rate);
    if (received <= 0) {
      return { ok: false as const, reason: "RECEIVED_TOO_SMALL" as const };
    }

    ensureUser(userId, guildId);

    // 第一通貨を引く
    const debit = adjustCurrency1Balance(userId, -amt, "両替: 第一→第二", guildId);
    if (!debit.ok) {
      return { ok: false as const, reason: "INSUFFICIENT_FUNDS" as const };
    }

    // カジノコインを足す（balance_cap 自動奉納あり）
    const credit = adjustBalance(userId, received, "両替: 第一→第二", "exchange", guildId);
    if (!credit.ok) {
      // 万一失敗したらロールバック
      throw new Error("exchangeIn credit failed: " + credit.reason);
    }

    addExchangeMiles(userId, "in", received);

    const insert = db.prepare(`
      INSERT INTO currency_exchanges
        (user_id, direction, source_amount, received_amount, fee_amount, rate)
      VALUES (?, 'in', ?, ?, 0, ?)
    `);
    const result = insert.run(userId, amt, received, info.rate);
    const id = Number(result.lastInsertRowid);
    const record = db.prepare("SELECT * FROM currency_exchanges WHERE id = ?").get(id) as CurrencyExchange;

    return {
      ok: true as const,
      direction: "in" as const,
      sourceAmount: amt,
      receivedAmount: received,
      feeAmount: 0,
      rate: info.rate,
      record,
    };
  });
}

/**
 * 第二通貨 → 第一通貨 への両替。手数料 20%。
 * 手数料は JP プール／救済プール に半々で奉納される。
 * @param sourceAmount 投入するカジノコインの額
 */
export function exchangeOut(
  userId: string,
  sourceAmount: number,
  guildId: string,
): ExchangeResult {
  return runTransaction(() => {
    const amt = Math.floor(sourceAmount);
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isSafeInteger(amt)) {
      return { ok: false as const, reason: "INVALID_AMOUNT" as const };
    }

    const info = computeExchangeRate(guildId);
    const fee = Math.floor(amt * EXCHANGE_OUT_FEE);
    const netCoin = amt - fee; // 換金対象（手数料引き後のカジノコイン）
    const received = Math.floor(netCoin / info.rate);
    if (received <= 0) {
      return { ok: false as const, reason: "RECEIVED_TOO_SMALL" as const };
    }

    ensureUser(userId, guildId);

    // カジノコインを引く（全額）
    const debit = adjustBalance(userId, -amt, "両替: 第二→第一", "exchange", guildId);
    if (!debit.ok) {
      return { ok: false as const, reason: "INSUFFICIENT_FUNDS" as const };
    }

    // 手数料を JP / 救済プール に半々奉納
    if (fee > 0) {
      const half = Math.floor(fee / 2);
      const rest = fee - half;
      db.prepare(`
        UPDATE server_config
        SET jackpot_pool = jackpot_pool + ?, relief_pool = relief_pool + ?
        WHERE guild_id = ?
      `).run(half, rest, guildId);
    }

    // 第一通貨を足す
    const credit = adjustCurrency1Balance(userId, received, "両替: 第二→第一", guildId);
    if (!credit.ok) {
      throw new Error("exchangeOut credit failed: " + credit.reason);
    }

    addExchangeMiles(userId, "out", amt);

    const insert = db.prepare(`
      INSERT INTO currency_exchanges
        (user_id, direction, source_amount, received_amount, fee_amount, rate)
      VALUES (?, 'out', ?, ?, ?, ?)
    `);
    const result = insert.run(userId, amt, received, fee, info.rate);
    const id = Number(result.lastInsertRowid);
    const record = db.prepare("SELECT * FROM currency_exchanges WHERE id = ?").get(id) as CurrencyExchange;

    return {
      ok: true as const,
      direction: "out" as const,
      sourceAmount: amt,
      receivedAmount: received,
      feeAmount: fee,
      rate: info.rate,
      record,
    };
  });
}

/**
 * 管理者: 手動レート補正を設定。
 * 例えば +3 で大幅コイン安 (1:13)、 -3 でコイン高 (1:7) など。
 */
export function setManualOffset(guildId: string, offset: number): void {
  const clamped = Math.max(-5, Math.min(5, offset));
  db.prepare("UPDATE server_config SET exchange_rate_offset = ? WHERE guild_id = ?").run(clamped, guildId);
}
