/**
 * 世界観定義層 — 星約の賭場 (ASTERIA)
 * ─────────────────────────────────────────────────────────
 * 世界観に依存する固定値の集約点。正典は WORLD.md。
 *
 * ビジュアル指針（WORLD.md §7）:
 *   - 基調はモノクロの星型グリフ（◌ ✦ ✧ ✶ ✷ ✸ ✹ ◈ ☾ ☀）
 *   - カラー絵文字は特大イベント限定（安っぽさを避ける）
 *   - 色は embed パレットで出す
 *
 * 未確定値は `[仮:○○]` で目立たせる（grep 検索で残漏れを発見できる）。
 */

export const WORLD = {
  // ─── 名称 ─────────────────────────────────────────────
  /** 賭場（カジノ）の正式名称 */
  CASINO_NAME: "星約の賭場",
  /** Bot 表示名 */
  BOT_NAME: "星約の賭場",
  /** マスコットキャラクター名。始原星アステラの小さな分け身＝座敷童の生まれ変わり */
  MASCOT_NAME: "アステル",
  /** マスコットの自称（確定: わたし。呼称はプレイヤーを「きみ」） */
  MASCOT_FIRST_PERSON: "わたし",
  /** プレイヤーへの呼びかけ */
  MASCOT_ADDRESS: "きみ",

  // ─── 通貨 ─────────────────────────────────────────────
  /** 第一通貨（GilBeinBOT ASTERIA 管理）の名称 */
  CURRENCY_1_NAME: "Gil",
  CURRENCY_1_EMOJI: "✧",
  CURRENCY_1_SYMBOL: "Gil",
  /** 第二通貨。アステルの光のかけら。賭場でのみ意味を持つ */
  CURRENCY_2_NAME: "エテル",
  CURRENCY_2_EMOJI: "◈",
  /** エテルの表示記号 */
  CURRENCY_2_SYMBOL: "◈",

  // ─── 賭ける行為 ───────────────────────────────────────
  /** 賭けの世界観名。運命と交わす契約 */
  ACT_OF_BETTING: "星約",

  // ─── 派閥＝三星（星約段階3で盟約） ────────────────────
  /** 三星の名称（知恵/言葉/火） */
  FACTION_NAMES: ["知恵の星", "言葉の星", "火の星"] as const,
  /** 三星のグリフ（モノクロ基調） */
  FACTION_GLYPHS: ["☾", "✶", "☀"] as const,
  /** 三星のカラー（embed 用） */
  FACTION_COLORS: [0x3a6ea5, 0x2e8b6f, 0xc0392b] as const,
  /** 三すくみ: index i は (i+1)%3 に有利。知恵→火→言葉→知恵 */
  // 0:知恵 御す 2:火 / 2:火 焼く 1:言葉 / 1:言葉 動かす 0:知恵

  // ─── 場（カテゴリ） ───────────────────────────────────
  AREA_FRONT: "表口",
  AREA_BACK: "奥座敷",
  AREA_FACTION: "星々の座",

  // ─── ゲーム名 ─────────────────────────────────────────
  // 方針: 名前は「何のゲームか一目で分かる通称」。世界観はアステルのセリフ・演出・embed色で出す。
  GAME_SLOTS: "スロット",
  GAME_BLACKJACK: "ブラックジャック",
  GAME_CHINCHIRO: "チンチロ",
  GAME_CRASH: "クラッシュ",
  GAME_HIGHLOW: "丁半",
  GAME_ROULETTE: "ルーレット",
  GAME_KEIBA: "競馬",
  GAME_STOCKS: "株",
  GAME_SASHI: "サシ勝負",
  GAME_BOARD: "賭場の板",

  // ─── プール ────────────────────────────────────────────
  /** ジャックポットプール */
  POOL_JACKPOT: "星溜まり",
  /** 底辺保護プール */
  POOL_RELIEF: "巡りの光",
  /** 換金時の奉納（20%手数料） */
  EXCHANGE_TRIBUTE: "還光",

  // ─── 星約（覚醒）7段階 ───────────────────────────────
  /** index = 段階 Lv。name とグリフ。しきい値・恩恵は zashikiStage.ts 側 */
  STAGES: [
    { name: "暗", glyph: "◌" },
    { name: "微光", glyph: "✦" },
    { name: "瞬き", glyph: "✧" },
    { name: "星約", glyph: "✶" },
    { name: "煌めき", glyph: "✷" },
    { name: "常燈", glyph: "✸" },
    { name: "満天", glyph: "✹" },
  ] as const,

  // ─── 星位（格 / tier） ───────────────────────────────
  /** tier key（既存コードのキーに対応）→ 表示名 */
  TIERS: {
    human: "漂着者",
    half: "星拾い",
    yokai: "星約者",
    daiyokai: "星詠み",
    kami: "北極星",
  } as Record<string, string>,

  // ─── セリフモード（旧 default/tsundere/yami） ──────────
  MODES: {
    default: "常",
    tsundere: "拗ね",
    yami: "蝕",
  } as Record<string, string>,

  // ─── レアイベント名 ───────────────────────────────────
  EVENT_DREAM: "流星",        // 旧: 座敷童の夢
  EVENT_SURGE: "星祝",        // 旧: 福の奔流
  EVENT_GUARD: "庇護の光",     // 旧: 花散らしの守り
  EVENT_RESONANCE: "星約の共鳴", // 旧: 魂の共鳴
  EVENT_HIDDEN: "星隠れ",      // 旧: 神隠し

  // ─── 称号 ─────────────────────────────────────────────
  TITLE_EXCHANGE_PATRON: "[仮:還光の使徒]",
} as const;

// ─── カラーパレット（WORLD.md §7） ────────────────────
// 寒色（青・紫）メインに統一。金だけ暖色アクセント温存。
// ※キー名は後方互換で据え置き、値のみ寒色系に書き換え。
export const PALETTE = {
  /** 夜空 — ベース・通常 */
  NIGHT: 0x0b1026,
  /** 星金 — エテル・ジャックポット・勝利アクセント（暖色1色温存） */
  STARGOLD: 0xe8c56a,
  /** 蒼 — 知恵の星・情報 */
  AZURE: 0x3a6ea5,
  /** 蒼緑 — 利益（旧:翠 JADE） */
  JADE: 0x0891B2,
  /** 紫 — 対人・血気（旧:朱 VERMILION） */
  VERMILION: 0x8b5cf6,
  /** 紫紅 — 損失・敗北・無効（旧:紅 CRIMSON） */
  CRIMSON: 0x9333EA,
  /** 蝕紫 — 蝕モード・第八の星 */
  ECLIPSE: 0x2c003e,
} as const;

// ─── ヘルパ ────────────────────────────────────────────

/** エテル（第二通貨）の表示文字列 (例: ◈1,000) */
export function formatEther(amount: number): string {
  return `${WORLD.CURRENCY_2_SYMBOL}${amount.toLocaleString()}`;
}

/** 第二通貨の表示（汎用エイリアス） */
export const formatCurrency2 = formatEther;

/** 第一通貨の表示文字列 */
export function formatCurrency1(amount: number): string {
  return `${WORLD.CURRENCY_1_SYMBOL}${amount.toLocaleString()}`;
}

/** プレースホルダ含有チェック用（grep 代替） */
export const PLACEHOLDER_MARKER = "[仮:";
