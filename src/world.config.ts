/**
 * 世界観プレースホルダ層 (v2)
 * ─────────────────────────────────────────────────────────
 * 賭場名・通貨名・マスコット名・派閥名・絵文字など、
 * 世界観に依存する固定値を全部ここに集約する。
 *
 * Iter.5 で世界観を確定したら、このファイルの値だけ
 * 差し替えれば Bot 全体の見た目が変わる構造。
 *
 * `[仮:○○]` という表記は **未確定** という意味で目立たせている。
 * grep 検索で残漏れを発見できるよう、必ずこの形式で書く。
 */

export const WORLD = {
  // ─── 名称 ─────────────────────────────────────────────
  /** 賭場（カジノ）の正式名称 */
  CASINO_NAME: "[仮:賭場名]",
  /** Bot 表示名 */
  BOT_NAME: "[仮:Bot名]",
  /** マスコットキャラクター名 */
  MASCOT_NAME: "[仮:マスコット]",
  /** マスコットの自称 */
  MASCOT_FIRST_PERSON: "[仮:わし]",

  // ─── 通貨 ─────────────────────────────────────────────
  /** 第一通貨（サーバー全体経済通貨）の名称 */
  CURRENCY_1_NAME: "[仮:第一通貨]",
  CURRENCY_1_EMOJI: "💴",
  CURRENCY_1_SYMBOL: "¥",
  /** 第二通貨（カジノコイン）の名称 — このBot内で使う通貨 */
  CURRENCY_2_NAME: "[仮:カジノコイン]",
  CURRENCY_2_EMOJI: "🎰",
  /** カジノコインの表示記号（既存の◉を一旦継承） */
  CURRENCY_2_SYMBOL: "◉",

  // ─── 派閥 ─────────────────────────────────────────────
  /** 3派閥の名称（Iter.3 で導入） */
  FACTION_NAMES: ["[仮:派閥A]", "[仮:派閥B]", "[仮:派閥C]"] as const,
  FACTION_EMOJIS: ["🔴", "🔵", "🟢"] as const,

  // ─── 場 ───────────────────────────────────────────────
  /** 表口カテゴリ名 */
  AREA_FRONT: "[仮:表口]",
  /** 奥座敷カテゴリ名（VIP＋運営） */
  AREA_BACK: "[仮:奥座敷]",
  /** 派閥カテゴリ名 */
  AREA_FACTION: "[仮:派閥]",

  // ─── ゲーム名 ─────────────────────────────────────────
  /** 各ゲームの世界観フレーバー名 */
  GAME_SLOTS: "[仮:百鬼夜行巻物]",
  GAME_BLACKJACK: "[仮:花札勝負]",
  GAME_CHINCHIRO: "[仮:賽]",
  GAME_CRASH: "[仮:龍脈昇り]",
  GAME_HIGHLOW: "[仮:丁半博打]",
  GAME_ROULETTE: "[仮:運命の水鏡]",
  GAME_KEIBA: "[仮:神馬競走]",
  GAME_STOCKS: "[仮:龍脈相場]",
  GAME_SASHI: "[仮:サシ勝負]",
  GAME_BOARD: "[仮:賭場の板]",

  // ─── プール ────────────────────────────────────────────
  /** ジャックポットプールの世界観名 */
  POOL_JACKPOT: "[仮:JPプール]",
  /** 底辺保護プール（救済プール）の世界観名 */
  POOL_RELIEF: "[仮:救済プール]",
  /** 換金時の奉納の世界観名 */
  EXCHANGE_TRIBUTE: "[仮:奉納]",

  // ─── 称号関連 ─────────────────────────────────────────
  /** 換金マイル称号の世界観名 */
  TITLE_EXCHANGE_PATRON: "[仮:篤志家]",
} as const;

// ─── ヘルパ ────────────────────────────────────────────

/** 第二通貨の表示文字列 (例: ◉1,000) */
export function formatCurrency2(amount: number): string {
  return `${WORLD.CURRENCY_2_SYMBOL}${amount.toLocaleString()}`;
}

/** 第一通貨の表示文字列 */
export function formatCurrency1(amount: number): string {
  return `${WORLD.CURRENCY_1_SYMBOL}${amount.toLocaleString()}`;
}

/** プレースホルダ含有チェック用 (grep 検索の代替) */
export const PLACEHOLDER_MARKER = "[仮:";
