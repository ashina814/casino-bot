/**
 * オーナー呼称ヘルパー
 * ─────────────────────────────────────────────────────────
 * アステルがオーナー（俺）に対してだけ「オーナー」と呼ぶ世界観演出。
 * - isOwnerId(userId): 判定
 * - addressOwner(text, userId): "きみ" を "オーナー" に置換（オーナーのみ）
 *
 * 用途例: daily.ts / nagareboshi.ts / zashiki.ts などアステルが直接話す場面
 */
import { config } from "../config";

const OWNER_ID_FALLBACK = "1436392582635847691";

export function isOwnerId(userId: string): boolean {
  return userId === (config.ownerId ?? OWNER_ID_FALLBACK);
}

/** きみ/お主/お前/ぼうず/客人 をオーナーのみ「オーナー」に置換。 */
export function addressOwner(text: string, userId: string): string {
  if (!isOwnerId(userId)) return text;
  return text
    .replace(/きみ/g, "オーナー")
    .replace(/お主/g, "オーナー")
    .replace(/客人/g, "オーナー");
}
