/**
 * 使い切り景品（消費アイテム）— カタログ・在庫・装備・発動
 * ─────────────────────────────────────────────────────────
 * 装備制: /商店 使う で在庫から1つ消費して active_effects に「装備」。
 *   装備は発動条件を満たした瞬間に消費される（次の1回を厳密に縛らない）。
 *     armed_win  … 次に勝った時に発動（勝利金 ×(1+power)）
 *     armed_loss … 次に負けた時に発動（賭け金 ×power を返金。庇護=1.0 > 保険=0.5 優先）
 *     game_reroll … チンチロ振り直し（プレイ中に消費）
 *     stocks_insider … 次の株表示でトレンド開示（消費）
 *
 * ゲーム側は consumeWinBonus / consumeLossProtection / consumeReroll / consumeInsider を呼ぶだけ。
 */
import { db, runTransaction } from "./db";

export type ItemKind = "armed_win" | "armed_loss" | "game_reroll" | "stocks_insider";

export type ConsumableDef = {
  key: string;
  name: string;
  desc: string;
  price: number;
  kind: ItemKind;
  power: number; // armed_win: 倍率加算(0.05) / armed_loss: 返金率(0.5,1.0)
};

export const CONSUMABLES: ConsumableDef[] = [
  // armed_win 系（power 大きいほど高グレード／consumeWinBonus で優先発動）
  { key: "omamori",        name: "福のお守り",     desc: "次に勝った時、勝利金が +5% になる。",       price: 4_000,  kind: "armed_win",  power: 0.05 },
  { key: "omamori_silver", name: "白銀のお守り",   desc: "次に勝った時、勝利金が +10% になる。",      price: 9_000,  kind: "armed_win",  power: 0.10 },
  { key: "omamori_gold",   name: "黄金のお守り",   desc: "次に勝った時、勝利金が +20% になる。",      price: 22_000, kind: "armed_win",  power: 0.20 },
  // armed_loss 系（power 大きいほど高グレード／consumeLossProtection で優先発動）
  { key: "hoken",          name: "保険符",         desc: "次に負けた時、賭け金の半分が戻る。",         price: 3_000,  kind: "armed_loss", power: 0.50 },
  { key: "hoken_dai",      name: "大保険符",       desc: "次に負けた時、賭け金の 75% が戻る。",        price: 7_500,  kind: "armed_loss", power: 0.75 },
  { key: "higo",           name: "庇護の札",       desc: "次の敗北を無効化（賭け金が全額戻る）。",     price: 12_000, kind: "armed_loss", power: 1.00 },
  // ゲーム固有
  { key: "reroll",         name: "二度振りの権",   desc: "チンチロでもう一度振り直せる（1回）。",      price: 5_000,  kind: "game_reroll",    power: 0 },
  { key: "insider",        name: "インサイダーの噂", desc: "次に株を開いた時、トレンドをこっそり開示。", price: 5_000,  kind: "stocks_insider", power: 0 },
];

const BY_KEY = new Map(CONSUMABLES.map((c) => [c.key, c]));
export function getConsumableDef(key: string): ConsumableDef | undefined { return BY_KEY.get(key); }

// ─── 在庫 ─────────────────────────────────────────────
export function grantItem(userId: string, key: string, n = 1): void {
  db.prepare(
    `INSERT INTO consumable_items (user_id, item_key, quantity) VALUES (?, ?, ?)
     ON CONFLICT(user_id, item_key) DO UPDATE SET quantity = quantity + ?`,
  ).run(userId, key, n, n);
}

export function getItemQty(userId: string, key: string): number {
  const r = db.prepare("SELECT quantity FROM consumable_items WHERE user_id = ? AND item_key = ?").get(userId, key) as { quantity: number } | undefined;
  return r?.quantity ?? 0;
}

export function getInventory(userId: string): Array<{ key: string; quantity: number }> {
  return db.prepare("SELECT item_key AS key, quantity FROM consumable_items WHERE user_id = ? AND quantity > 0 ORDER BY item_key").all(userId) as Array<{ key: string; quantity: number }>;
}

// ─── 装備 ─────────────────────────────────────────────
export function getArmed(userId: string): string[] {
  return (db.prepare("SELECT effect_key FROM active_effects WHERE user_id = ?").all(userId) as Array<{ effect_key: string }>).map((r) => r.effect_key);
}

export function isArmed(userId: string, key: string): boolean {
  return !!db.prepare("SELECT 1 FROM active_effects WHERE user_id = ? AND effect_key = ?").get(userId, key);
}

export type ArmResult = { ok: true } | { ok: false; reason: "NO_STOCK" | "ALREADY_ARMED" | "UNKNOWN_ITEM" };

/** 在庫から1つ消費して装備する。 */
export function armItem(userId: string, key: string): ArmResult {
  const def = getConsumableDef(key);
  if (!def) return { ok: false, reason: "UNKNOWN_ITEM" };
  return runTransaction<ArmResult>(() => {
    if (isArmed(userId, key)) return { ok: false, reason: "ALREADY_ARMED" };
    const qty = getItemQty(userId, key);
    if (qty <= 0) return { ok: false, reason: "NO_STOCK" };
    db.prepare("UPDATE consumable_items SET quantity = quantity - 1 WHERE user_id = ? AND item_key = ?").run(userId, key);
    db.prepare("INSERT INTO active_effects (user_id, effect_key) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, key);
    return { ok: true };
  });
}

function disarm(userId: string, key: string): void {
  db.prepare("DELETE FROM active_effects WHERE user_id = ? AND effect_key = ?").run(userId, key);
}

// ─── 発動（ゲームから呼ぶ） ───────────────────────────

/** 勝利時: armed_win があれば勝利金倍率を返して消費（高 power が先に発動）。 */
export function consumeWinBonus(userId: string): { mult: number; note?: string } {
  const wins = CONSUMABLES.filter((c) => c.kind === "armed_win").sort((a, b) => b.power - a.power);
  for (const def of wins) {
    if (isArmed(userId, def.key)) {
      disarm(userId, def.key);
      return { mult: 1 + def.power, note: `${def.name} 発動（+${Math.round(def.power * 100)}%）` };
    }
  }
  return { mult: 1 };
}

/** 敗北時: armed_loss があれば返金率を返して消費（庇護優先）。 */
export function consumeLossProtection(userId: string): { refundRate: number; note?: string } {
  const losses = CONSUMABLES.filter((c) => c.kind === "armed_loss").sort((a, b) => b.power - a.power); // 庇護(1.0)が先
  for (const def of losses) {
    if (isArmed(userId, def.key)) {
      disarm(userId, def.key);
      return { refundRate: def.power, note: `${def.name} 発動（${def.power >= 1 ? "敗北無効・全額返金" : `${Math.round(def.power * 100)}%返金`}）` };
    }
  }
  return { refundRate: 0 };
}

/** チンチロ: 二度振りが装備中なら消費して true。 */
export function consumeReroll(userId: string): boolean {
  if (isArmed(userId, "reroll")) { disarm(userId, "reroll"); return true; }
  return false;
}

/** 株: インサイダーが装備中なら消費して true。 */
export function consumeInsider(userId: string): boolean {
  if (isArmed(userId, "insider")) { disarm(userId, "insider"); return true; }
  return false;
}
