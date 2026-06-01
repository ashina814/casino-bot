/**
 * VIP（奥座敷）— 月課金エテルの会員制
 * ─────────────────────────────────────────────────────────
 * 入場権をエテルで購入 → VIPロール付与 → 奥座敷アクセス＋特権。
 * 期間制（VIP_DAYS日）。expires_at を過ぎたらスケジューラがロール剥奪。
 *
 * 特権:
 *   - 奥座敷チャンネルアクセス（VIPロール＝Discord権限で制御）
 *   - 高bet上限（getVipBetCapMultiplier、各ゲームのbet検証で乗算）※別途配線
 *   - VIP識別（通行証等に 👑 表示）
 */
import { db } from "./db";

/** VIP 月会費（エテル）と期間 */
export const VIP_PRICE = 30_000;
export const VIP_DAYS = 30;
/** VIP の賭け上限倍率（高bet特権） */
export const VIP_BETCAP_MULT = 2;

export type VipRow = { user_id: string; guild_id: string; expires_at: string; since: string };

function nowMs(): number { return Date.now(); }
// expires_at は grantVip が ISO(UTC, 末尾Z) で保存するので素直にパースできる
function parseTs(s: string): number { return new Date(s).getTime(); }

export function getVip(userId: string, guildId: string): VipRow | undefined {
  return db.prepare("SELECT * FROM vip_members WHERE user_id = ? AND guild_id = ?").get(userId, guildId) as VipRow | undefined;
}

/** 現在VIP有効か（期限内か） */
export function isVip(userId: string, guildId: string): boolean {
  const row = getVip(userId, guildId);
  if (!row) return false;
  return parseTs(row.expires_at) > nowMs();
}

/** VIPの残り日数（無効なら0） */
export function vipDaysLeft(userId: string, guildId: string): number {
  const row = getVip(userId, guildId);
  if (!row) return 0;
  const ms = parseTs(row.expires_at) - nowMs();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/**
 * VIPを付与/更新（days日延長）。既に有効なら現在の期限から、切れてれば今から延長。
 * 戻り値: 新しい expires_at(ISO)
 */
export function grantVip(userId: string, guildId: string, days = VIP_DAYS): string {
  const cur = getVip(userId, guildId);
  const base = cur && parseTs(cur.expires_at) > nowMs() ? parseTs(cur.expires_at) : nowMs();
  const next = new Date(base + days * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO vip_members (user_id, guild_id, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, guild_id) DO UPDATE SET expires_at = ?`,
  ).run(userId, guildId, next, next);
  return next;
}

/** 期限切れVIPの行を返す（ロール剥奪用）。delete はしない（呼び出し側で剥奪後に削除）
 *  expires_at は ISO 保存なので SQL の datetime 比較は使わず JS で判定する。 */
export function getExpiredVips(): VipRow[] {
  const now = nowMs();
  const all = db.prepare("SELECT * FROM vip_members").all() as VipRow[];
  return all.filter((v) => parseTs(v.expires_at) <= now);
}

/** VIP行を削除（期限切れ処理後） */
export function removeVip(userId: string, guildId: string): void {
  db.prepare("DELETE FROM vip_members WHERE user_id = ? AND guild_id = ?").run(userId, guildId);
}

/** bet上限の倍率（VIPなら VIP_BETCAP_MULT、非VIPは1） */
export function getVipBetCapMultiplier(userId: string, guildId: string): number {
  return isVip(userId, guildId) ? VIP_BETCAP_MULT : 1;
}
