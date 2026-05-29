/**
 * 二つ名マスターカタログ
 *
 * 全ての称号のメタデータ（取得条件・レアリティ）を集中管理する。
 * UI（タイトル一覧パネル）と取得判定の両方から参照される。
 */
import { db } from "./db";

export type TitleRarity = "common" | "rare" | "legend" | "myth";

export type TitleDef = {
  key: string;
  name: string;
  /** ユーザー向けの取得条件説明（謎めかしてもOK） */
  hint: string;
  rarity: TitleRarity;
  category: "easter_egg" | "shop" | "milestone" | "tribute";
};

export const TITLES_CATALOG: TitleDef[] = [
  // ─── Easter Eggs ─────────────────────────────────
  { key: "ushimitsudoki", name: "丑三つ時の常連", hint: "深夜の刻にこの賭場を訪れる", rarity: "rare", category: "easter_egg" },
  { key: "zorome", name: "粋人", hint: "粋な賭け方をする者に", rarity: "rare", category: "easter_egg" },
  { key: "lose_100", name: "不屈の魂", hint: "百度敗れてもなお立ち上がる者", rarity: "rare", category: "easter_egg" },
  { key: "thanks", name: "アステルの心友", hint: "感謝の言葉を重ねる", rarity: "legend", category: "easter_egg" },
  { key: "alone", name: "アステルの秘密を知る者", hint: "誰もいない夜に来てみて", rarity: "myth", category: "easter_egg" },
  { key: "shichifukujin", name: "七星の寵愛", hint: "七日続けての勝ち", rarity: "legend", category: "easter_egg" },
  { key: "millionaire", name: "大富豪", hint: "エテル百万を所持した者", rarity: "legend", category: "easter_egg" },
  { key: "bankrupt", name: "すってんてん", hint: "残高がゼロになりし者", rarity: "rare", category: "easter_egg" },
  { key: "lucky7", name: "幸運児", hint: "縁起のいい数字で賭ける", rarity: "rare", category: "easter_egg" },

  // ─── Shop (奉納) ──────────────────────────────────
  { key: "title_patron", name: "賭場のパトロン", hint: "商店で奉納（◈100,000）", rarity: "rare", category: "shop" },
  { key: "title_gold", name: "黄金の成金", hint: "商店で奉納（◈500,000）", rarity: "legend", category: "shop" },
  { key: "title_zashiki", name: "アステルの寵児", hint: "商店で奉納（◈1,000,000）", rarity: "myth", category: "shop" },

  // ─── Tribute（特別な人へ） ─────────────────────────
  { key: "second_zashiki", name: "二代目", hint: "わたしが眠る前、この場所を守ってくれた人へ", rarity: "myth", category: "tribute" },
];

export const RARITY_LABEL: Record<TitleRarity, string> = {
  common: "凡",
  rare: "雅",
  legend: "伝",
  myth: "幻",
};

export const RARITY_COLOR: Record<TitleRarity, number> = {
  common: 0x95a5a6,
  rare: 0x5dade2,
  legend: 0xf1c40f,
  myth: 0xe74c3c,
};

export function getTitleDef(key: string): TitleDef | undefined {
  return TITLES_CATALOG.find((t) => t.key === key);
}

export function getUserTitleKeys(userId: string): Set<string> {
  const rows = db.prepare("SELECT title_key FROM titles WHERE user_id = ?").all(userId) as { title_key: string }[];
  return new Set(rows.map((r) => r.title_key));
}

export function getActiveTitleKey(userId: string): string | null {
  const row = db.prepare("SELECT title_key FROM active_titles WHERE user_id = ?").get(userId) as { title_key: string } | undefined;
  return row?.title_key ?? null;
}

export function setActiveTitle(userId: string, titleKey: string | null): void {
  if (titleKey === null) {
    db.prepare("DELETE FROM active_titles WHERE user_id = ?").run(userId);
    return;
  }
  db.prepare(`
    INSERT INTO active_titles (user_id, title_key) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET title_key = ?
  `).run(userId, titleKey, titleKey);
}
