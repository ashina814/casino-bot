import { db, getServerConfig } from "./db";
import { getBalance } from "./bank";

// ─── 福の重み（累進奉納率） ────────────────────────────

/**
 * 所持金に応じた奉納率を返す。
 * 勝利金額にこの率を掛けた分が自動的にプール（JP + 底辺保護）に流れる。
 */
export function getFukuWeight(balance: number): number {
  if (balance <= 10_000) return 0;
  if (balance <= 50_000) return 0.05;
  if (balance <= 100_000) return 0.10;
  if (balance <= 300_000) return 0.20;
  return 0.30;
}

export function getFukuWeightLabel(balance: number): string | null {
  const rate = getFukuWeight(balance);
  if (rate === 0) return null;
  return `${Math.round(rate * 100)}%`;
}

// ─── 動的ハウスエッジ（妖気の潮流） ────────────────────

export type EconomyState = "inflation" | "normal" | "deflation";

export function getEconomyState(guildId: string): {
  state: EconomyState;
  label: string;
  emoji: string;
  totalSupply: number;
  playerCount: number;
  healthyLine: number;
} {
  const result = db.prepare(
    "SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total FROM users"
  ).get() as { count: number; total: number };

  const healthyLine = result.count * 15_000;
  const total = result.total;

  let state: EconomyState;
  let label: string;
  let emoji: string;

  if (healthyLine === 0) {
    state = "normal";
    label = "妖気は穏やか";
    emoji = "🟡";
  } else if (total > healthyLine * 1.5) {
    state = "inflation";
    label = "妖気が満ちておる";
    emoji = "🟢";
  } else if (total < healthyLine * 0.5) {
    state = "deflation";
    label = "妖気が薄い";
    emoji = "🔴";
  } else {
    state = "normal";
    label = "妖気は穏やか";
    emoji = "🟡";
  }



  return {
    state,
    label,
    emoji,
    totalSupply: total,
    playerCount: result.count,
    healthyLine,
  };
}

/**
 * 身代わりの加護（超低確率での敗北無効化）
 * 覚醒段階に応じて発動率が上がる。
 */
export function checkSubstituteBlessing(userId: string): boolean {
  try {
    const { getAffection } = require("./db");
    const { checkGuardBlessing } = require("./zashikiStage");
    const affection = getAffection(userId);
    return checkGuardBlessing(affection);
  } catch {
    return false;
  }
}

/**
 * サーバーの経済状態を加味した実効ハウスエッジを返す。
 * baseEdge はゲームごとのデフォルトハウスエッジ（0.02〜0.05）。
 */
export function getEffectiveHouseEdge(guildId: string, baseEdge: number): number {
  const cfg = getServerConfig(guildId);
  const { state } = getEconomyState(guildId);

  let adjustment = cfg.house_edge_offset / 100; // stored as percentage
  if (state === "inflation") adjustment += 0.02;
  if (state === "deflation") adjustment -= 0.02;

  return Math.max(0, Math.min(0.15, baseEdge + adjustment));
}

// ─── ジャックポットプール管理 ──────────────────────────

/**
 * ハウスが吸収したエテルを各プールに分配する。
 * 吸収額の 20% → JPプール, 30% → 底辺保護, 50% → 消滅
 */
export function distributeHouseEarnings(guildId: string, absorbed: number): void {
  if (absorbed <= 0) return;

  const toJP = Math.floor(absorbed * 0.20);
  const toRelief = Math.floor(absorbed * 0.30);
  // 残り50%は消滅（何もしない）

  db.prepare(`
    UPDATE server_config
    SET jackpot_pool = jackpot_pool + ?,
        relief_pool = relief_pool + ?
    WHERE guild_id = ?
  `).run(toJP, toRelief, guildId);
}

/**
 * 福の重みで徴収した分をプールに入れる。
 * 50% → JPプール, 50% → 底辺保護
 */
export function distributeFukuTax(guildId: string, taxed: number): void {
  if (taxed <= 0) return;

  const half = Math.floor(taxed / 2);
  db.prepare(`
    UPDATE server_config
    SET jackpot_pool = jackpot_pool + ?,
        relief_pool = relief_pool + ?
    WHERE guild_id = ?
  `).run(half, taxed - half, guildId);
}

// ─── デイリーボーナス計算 ──────────────────────────────

export function calculateDailyBonus(guildId: string, userId: string): number {
  const cfg = getServerConfig(guildId);
  const balance = getBalance(userId, guildId);

  let base: number;
  if (balance <= 10_000) {
    base = cfg.daily_base;
  } else if (balance <= 50_000) {
    base = Math.floor(cfg.daily_base * 0.75);
  } else if (balance <= 200_000) {
    base = Math.floor(cfg.daily_base * 0.5);
  } else {
    base = cfg.daily_rich;
  }

  return base;
}

// ─── 格（Tier）の判定 ──────────────────────────────────

export type TierInfo = {
  key: string;
  name: string;
  emoji: string;
  betCap: number;
};

const TIERS: TierInfo[] = [
  { key: "human",    name: "人間",  emoji: "👤", betCap: 500 },
  { key: "half",     name: "半妖",  emoji: "🌗", betCap: 2_000 },
  { key: "yokai",    name: "妖",    emoji: "👹", betCap: 10_000 },
  { key: "daiyokai", name: "大妖",  emoji: "🐉", betCap: 50_000 },
  { key: "kami",     name: "神",    emoji: "⛩️", betCap: 100_000 },
];

export function getTierForLevel(level: number): TierInfo {
  if (level >= 100) return TIERS[4];
  if (level >= 50) return TIERS[3];
  if (level >= 25) return TIERS[2];
  if (level >= 10) return TIERS[1];
  return TIERS[0];
}

export function getTierByKey(key: string): TierInfo {
  return TIERS.find((t) => t.key === key) ?? TIERS[0];
}

export function expForNextLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.3));
}

/**
 * 妖力（経験値）を加算し、レベルアップがあればtierも更新する。
 * 戻り値: レベルアップしたかどうか
 */
export function addExp(userId: string, amount: number): boolean {
  const user = db.prepare("SELECT level, exp FROM users WHERE user_id = ?").get(userId) as
    | { level: number; exp: number }
    | undefined;
  if (!user) return false;

  let { level, exp } = user;
  exp += amount;
  let leveledUp = false;

  while (exp >= expForNextLevel(level)) {
    exp -= expForNextLevel(level);
    level += 1;
    leveledUp = true;
  }

  const tier = getTierForLevel(level);
  db.prepare("UPDATE users SET level = ?, exp = ?, tier = ? WHERE user_id = ?")
    .run(level, exp, tier.key, userId);

  return leveledUp;
}
