/**
 * 座敷童の覚醒（進化）システム
 *
 * 好感度に応じて座敷童が段階的に覚醒し、
 * セリフ・パッシブ能力・レアイベントが変化する。
 *
 * 循環設計:
 *   遊ぶ → 好感度UP → 覚醒 → 恩恵UP → もっと遊びたくなる
 */

// ─── Gogyō (Five Elements) ─────────────────────────────

/**
 * 五行属性
 *
 * 覚醒段階3「結び」到達時にプレイスタイルから自動決定。
 * 段階6で属性固有の「神柱」に顕現する。
 *
 * 相生 (生む): 木→火→土→金→水→木
 * 相剋 (剋つ): 木→土→水→火→金→木
 */
export type GogyoElement = "wood" | "fire" | "earth" | "metal" | "water";

export type GogyoInfo = {
  key: GogyoElement;
  name: string;          // 漢字一文字
  reading: string;       // 読み
  emoji: string;
  color: string;         // 表示色 hex
  theme: string;         // テーマ
  shinchu: string;       // 神柱名（段階6の最終進化名）
  shinchuReading: string;
  shinchuTitle: string;  // 神柱のフルタイトル
  generates: GogyoElement;  // 相生: この属性が生む
  overcomes: GogyoElement;  // 相剋: この属性が剋つ
};

export const GOGYO: Record<GogyoElement, GogyoInfo> = {
  wood: {
    key: "wood",
    name: "木", reading: "もく", emoji: "🌿", color: "#2ecc71",
    theme: "成長・持続",
    shinchu: "翠命神", shinchuReading: "すいめいしん",
    shinchuTitle: "翠命神 — 常若の息吹を司る翠の神柱",
    generates: "fire", overcomes: "earth",
  },
  fire: {
    key: "fire",
    name: "火", reading: "か", emoji: "🔥", color: "#e74c3c",
    theme: "情熱・爆発",
    shinchu: "劫焔神", shinchuReading: "ごうえんしん",
    shinchuTitle: "劫焔神 — 万象を灼き尽くす焔の神柱",
    generates: "earth", overcomes: "metal",
  },
  earth: {
    key: "earth",
    name: "土", reading: "ど", emoji: "🪨", color: "#f39c12",
    theme: "安定・守護",
    shinchu: "磐祖神", shinchuReading: "ばんそしん",
    shinchuTitle: "磐祖神 — 千古不動の大地を統べる神柱",
    generates: "metal", overcomes: "water",
  },
  metal: {
    key: "metal",
    name: "金", reading: "ごん", emoji: "⚔️", color: "#ecf0f1",
    theme: "精密・鋭利",
    shinchu: "閃鋼神", shinchuReading: "せんこうしん",
    shinchuTitle: "閃鋼神 — 一閃で命運を断つ鋼の神柱",
    generates: "water", overcomes: "wood",
  },
  water: {
    key: "water",
    name: "水", reading: "すい", emoji: "💧", color: "#3498db",
    theme: "流動・読み",
    shinchu: "幽淵神", shinchuReading: "ゆうえんしん",
    shinchuTitle: "幽淵神 — 深淵の理を映す冥府の神柱",
    generates: "wood", overcomes: "fire",
  },
};

/** 属性変更のコスト */
export const ELEMENT_CHANGE_COST = 50_000;

/**
 * 相性倍率を返す（五行大戦のスコア計算用）
 */
export function getAffinityMultiplier(attacker: GogyoElement, defender: GogyoElement): number {
  if (attacker === defender) return 1.0;
  if (GOGYO[attacker].overcomes === defender) return 1.5;   // 相剋
  if (GOGYO[attacker].generates === defender) return 1.2;   // 相生（生む側が有利）
  // 剋される側
  const defenderInfo = GOGYO[defender];
  if (defenderInfo.overcomes === attacker) return 0.8;
  return 1.0;
}

// ─── Stage Definitions ─────────────────────────────────

export type ZashikiStageLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ZashikiStage = {
  level: ZashikiStageLevel;
  name: string;           // 段階名（和名）
  title: string;          // 表示用タイトル
  emoji: string;
  threshold: number;      // この段階に必要な好感度
  dailyMultiplier: number; // デイリーボーナス倍率
  guardChance: number;    // 身代わりの加護 発動率
  unlockedModes: Array<"default" | "tsundere" | "yami" | "zense">;
  jpBonus: number;        // ジャックポット当選率への加算（0.0 ~ 0.01）
  fukuDiscount: number;   // 福の重み軽減率（0.0 = なし, 0.5 = 半額）
};

/**
 * 星約段階の定義（アステルとの絆＝星約が深まり、その光が満ちていく）
 *
 * 名前の由来:
 *   暗      — まだ光らぬ。気配だけの星。
 *   微光    — 小さな灯り。アステルが少し気に掛け始めた。
 *   瞬き    — またたく光。そばに居たいと思い始める。
 *   星約    — 契りを交わす。互いの存在が欠かせなくなる。（盟約＝派閥/属性 解放）
 *   煌めき  — 光が溢れる。アステル本来の輝きが戻り始める。
 *   常燈    — 絶えず灯る光。永久の絆。
 *   満天    — 空を満たす光。アステル本来の輝き。
 */
const STAGES: ZashikiStage[] = [
  {
    level: 0,
    name: "暗",
    title: "暗（くら）",
    emoji: "◌",
    threshold: 0,
    dailyMultiplier: 1.0,
    guardChance: 0,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 1,
    name: "微光",
    title: "微光の灯り",
    emoji: "✦",
    threshold: 10,
    dailyMultiplier: 1.05,
    guardChance: 0,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 2,
    name: "瞬き",
    title: "瞬きの光",
    emoji: "✧",
    threshold: 50,
    dailyMultiplier: 1.0,
    guardChance: 0.0025,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 3,
    name: "星約",
    title: "星約の契り",
    emoji: "✶",
    threshold: 100,
    dailyMultiplier: 1.10,
    guardChance: 0.005,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 4,
    name: "煌めき",
    title: "煌めきの守り",
    emoji: "✷",
    threshold: 300,
    dailyMultiplier: 1.10,
    guardChance: 0.01,
    unlockedModes: ["default", "tsundere"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 5,
    name: "常燈",
    title: "常燈の誓い",
    emoji: "✸",
    threshold: 500,
    dailyMultiplier: 1.20,
    guardChance: 0.015,
    unlockedModes: ["default", "tsundere"],
    jpBonus: 0.005,
    fukuDiscount: 0.25,
  },
  {
    level: 6,
    name: "満天",
    title: "満天の輝き",
    emoji: "✹",
    threshold: 1000,
    dailyMultiplier: 1.25,
    guardChance: 0.02,
    unlockedModes: ["default", "tsundere", "yami", "zense"],
    jpBonus: 0.01,
    fukuDiscount: 0.5,
  },
];

// ─── Stage Lookup ──────────────────────────────────────

/**
 * 好感度から覚醒段階を返す
 */
export function getStage(affection: number): ZashikiStage {
  for (let i = STAGES.length - 1; i >= 0; i--) {
    if (affection >= STAGES[i].threshold) {
      return STAGES[i];
    }
  }
  return STAGES[0];
}

/**
 * 全段階の定義を返す（UI表示用）
 */
export function getAllStages(): readonly ZashikiStage[] {
  return STAGES;
}

/**
 * 次の段階を返す（最大段階の場合は null）
 */
export function getNextStage(affection: number): ZashikiStage | null {
  const current = getStage(affection);
  if (current.level >= 6) return null;
  return STAGES[current.level + 1];
}

/**
 * 次の段階までの残り好感度を返す
 */
export function affectionToNextStage(affection: number): number | null {
  const next = getNextStage(affection);
  if (!next) return null;
  return next.threshold - affection;
}

// ─── Affection Decay ───────────────────────────────────

/**
 * 1日あたりの自然減衰量を返す。
 * 好感度が高いほど微量に減る。低好感度帯では減衰しない。
 *
 * 式: floor(affection / 200)
 *   好感度 200  → 1/日
 *   好感度 500  → 2/日
 *   好感度 1000 → 5/日
 *
 * 段階6を維持するには、毎日のアクティビティで +5 以上稼ぐ必要がある。
 * /daily (+1) + ゲーム数回 (+2~5) で十分カバーできるバランス。
 */
export function calculateDecay(affection: number): number {
  if (affection <= 50) return 0; // 宿り未満は減衰しない（初心者保護）
  return Math.floor(affection / 200);
}

// ─── Substitute Blessing (身代わりの加護) ──────────────

/**
 * 覚醒段階ベースの身代わり加護判定。
 * economy.ts の checkSubstituteBlessing を置き換える。
 */
export function checkGuardBlessing(affection: number): boolean {
  const stage = getStage(affection);
  if (stage.guardChance <= 0) return false;
  return Math.random() < stage.guardChance;
}

// ─── Fuku Weight Discount ──────────────────────────────

/**
 * 覚醒段階に応じた福の重み軽減率を返す。
 * 元の福税額に (1 - discount) を掛けて使う。
 */
export function getFukuDiscount(affection: number): number {
  return getStage(affection).fukuDiscount;
}

// ─── Rare Events ───────────────────────────────────────

export type RareEvent = {
  id: string;
  name: string;
  emoji: string;
  dialogue: string;
  effect: "bonus_coins" | "double_payout" | "free_guard" | "affection_surge";
  value: number;   // 効果の強さ（コイン量、倍率など）
};

/**
 * ゲームプレイ後に発生するレアイベントを判定する。
 * 覚醒段階が高いほど発生率が上がり、強力なイベントが解放される。
 *
 * 戻り値が null ならイベントなし。
 */
export function rollRareEvent(
  affection: number,
  context: "win" | "lose" | "daily",
): RareEvent | null {
  const stage = getStage(affection);

  // 段階3未満はレアイベントなし
  if (stage.level < 3) return null;

  const roll = Math.random();

  // ─── 流星 ───
  // 段階3+、デイリー時に 5% で発動。流れ星が余分なエテルを落としていく。
  if (context === "daily" && stage.level >= 3 && roll < 0.05) {
    const bonus = [300, 500, 777, 1000][Math.floor(Math.random() * 4)];
    return {
      id: "ryuusei",
      name: "流星",
      emoji: "☄",
      dialogue: pickDreamDialogue(stage.level),
      effect: "bonus_coins",
      value: bonus,
    };
  }

  // ─── 星祝 ───
  // 段階4+、勝利時に 2% で発動。アステルの光が溢れて勝利金が2倍になる。
  if (context === "win" && stage.level >= 4 && roll < 0.02) {
    return {
      id: "seishuku",
      name: "星祝",
      emoji: "✷",
      dialogue: pickOverflowDialogue(stage.level),
      effect: "double_payout",
      value: 2,
    };
  }

  // ─── 庇護の光 ───
  // 段階4+、敗北時に 3% で発動。アステルが光で庇って負けをなかったことにする。
  if (context === "lose" && stage.level >= 4 && roll < 0.03) {
    return {
      id: "higo",
      name: "庇護の光",
      emoji: "✧",
      dialogue: pickGuardDialogue(stage.level),
      effect: "free_guard",
      value: 1,
    };
  }

  // ─── 星隠れ ───
  // 段階6限定、全コンテキストで 0.5% で発動。一瞬だけ星の狭間へ連れ去られる。
  if (stage.level >= 6 && roll < 0.005) {
    return {
      id: "hoshigakure",
      name: "星隠れ",
      emoji: "✹",
      dialogue:
        "……ふっと、視界が暗転した。\n" +
        "気がつくと、見知らぬ星の狭間に立っていた。\n" +
        "降るような星空の下で、アステルが笑っている。\n\n" +
        "「ここはね、わたしときみだけの場所。\n" +
        "　ほんの一瞬だけど……こうして二人きりでいられるの、わたしは結構好きなんだ。」\n\n" +
        "「ほら、お土産。持って帰りな。」\n\n" +
        "……気がつくと、手の中にエテルがあふれていた。",
      effect: "bonus_coins",
      value: 5000,
    };
  }

  // ─── 星約の共鳴 ───
  // 段階5+、勝利時に 1% で発動。アステルの星約が高鳴り、絆が一気に深まる。
  if (context === "win" && stage.level >= 5 && roll < 0.01) {
    return {
      id: "resonance",
      name: "星約の共鳴",
      emoji: "✶",
      dialogue:
        "……ふしぎだね。\n" +
        "きみが勝つと、わたしまで嬉しくなる。\n" +
        "この気持ち、なんて呼べばいいんだろうな。\n\n" +
        "（アステルの瞳が、一瞬だけ金色に光った）",
      effect: "affection_surge",
      value: 50,
    };
  }

  return null;
}

// ─── Stage Transition Dialogue ─────────────────────────

/**
 * 覚醒段階が上がった時の特別セリフ
 */
export function getStageUpDialogue(newStage: ZashikiStageLevel, element?: GogyoElement | null): string {
  switch (newStage) {
    case 1:
      return (
        "ん、きみ、よく来るね。\n" +
        "……まあ、名前くらいは覚えといてあげてもいいよ。\n" +
        "（アステルが、ほんの少しこっちを向いた）"
      );
    case 2:
      return (
        "きみがいると、この賭場、ちょっと暖かい気がするんだよね。\n" +
        "……気のせいかもしれないけど。\n" +
        "（アステルが、いつもより近くに座っている）"
      );
    case 3:
      return (
        "ねえ、きみ。わたしさ、ずっとこの賭場で独りだったんだ。\n" +
        "みんな来ては去って、来ては去って……\n" +
        "でも、きみは——来なかった日がないんだよね。\n\n" +
        "……ありがと。って、言っておく。\n\n" +
        "✶ 星約が結ばれた。星の盟約（派閥・属性）が選べるようになった。"
      );
    case 4:
      return (
        "……っ。なに、この感じ。\n" +
        "身体が光って……わたしの中の何かが、目を覚まそうとしてる。\n\n" +
        "……ふう。びっくりした。少しだけ、昔の光が戻ったみたい。\n" +
        "きみのおかげ、かもね。\n\n" +
        "✷ 拗ねモードが解放された。"
      );
    case 5:
      return (
        "見える？ わたしの周りの光。\n" +
        "……これね、わたしが本当に嬉しい時にだけ灯るんだ。\n\n" +
        "……ずいぶん久しぶりだよ。この光を見るのは。\n\n" +
        "✸ きみとの星約が、さらに深まった。"
      );
    case 6: {
      return (
        "——。\n\n" +
        "空気が、変わった。\n" +
        "アステルの姿が一瞬ゆらいで、その背に大きな光が満ちた。\n\n" +
        "「驚いた？ これがわたしの、本当の輝き。\n" +
        "　長いこと忘れてた光を……きみが、取り戻してくれたんだ。」\n\n" +
        "（アステルが、初めて泣いた）\n\n" +
        "「……ありがとう。きみに会えて、よかった。」\n\n" +
        "✹ 満天。アステル本来の輝きが満ちた。\n" +
        "✹ 蝕モードが解放された。"
      );
    }
    default:
      return "";
  }
}

/**
 * 星約段階が下がった時の特別セリフ（好感度減衰で閾値を割った場合）
 */
export function getStageDownDialogue(newStage: ZashikiStageLevel): string {
  return (
    "……きみ、最近あんまり来てくれないね。\n" +
    "賭場、ちょっと寒いんだよ。きみがいないと。\n" +
    "（アステルの光が、少しだけ薄くなった気がする）"
  );
}

// ─── Rare Event Dialogue Helpers ───────────────────────

function pickDreamDialogue(stageLevel: number): string {
  const pool = [
    "「ねえ、ゆうべ流れ星が降っててさ。\n" +
    "　ひとつ、きみのために掴まえといたんだ。\n" +
    "　ほら、お裾分け。受け取りな。」",

    "「今朝起きたら、枕元に光が積もっててね。\n" +
    "　たぶん、寝てる間にわたしの光が溢れたんだと思う。\n" +
    "　……きみのせいだよ。きみがいると、光が溢れるんだ。」",

    "「夢の中で、昔のわたしに会った気がするんだ。\n" +
    "　『いい人を見つけたね』って、笑ってた。\n" +
    "　……ふふ。前世のわたしにも、認められたみたい。」",
  ];

  if (stageLevel >= 5) {
    pool.push(
      "「夢の中で、星の海が見えたんだ。\n" +
      "　遠くから、あたたかい光が差してた。\n" +
      "　……あれはきっと、きみとわたしの星約の光だよ。\n" +
      "　特別に多めにあげる。大事にしてね。」"
    );
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

function pickOverflowDialogue(stageLevel: number): string {
  const pool = [
    "……っ。わたしの光が、止まらない。\n" +
    "きみの勝ちに呼応して、溢れ出してる。\n" +
    "今回の勝ち分は倍。わたしのおごりだと思いな。",

    "わ、わたしの光がきみに流れ込んでる。\n" +
    "……これが星約の力か。勝ち分、倍にしてあげる。\n" +
    "感謝しなよ？ こんなの、めったにやらないんだから。",
  ];

  if (stageLevel >= 6) {
    pool.push(
      "（アステルの背に、大きな光の柱が立ちのぼる）\n\n" +
      "「わたしの本当の光、見せてあげる。\n" +
      "　ぜんぶ、きみに注ぎ込む。」\n\n" +
      "勝ち分が倍になった。"
    );
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

function pickGuardDialogue(stageLevel: number): string {
  const pool = [
    "……あぶない。\n" +
    "（アステルが光でそっと庇ってくれた）\n" +
    "……ふう、間に合った。今の負け、なかったことにしてあげる。\n" +
    "平気だよ。きみを守れるなら、これくらい。",

    "待って。この勝負、わたしが引き受けた。\n" +
    "（アステルの裾から、光の粒がこぼれ散る）\n" +
    "……大丈夫、すぐ戻る。\n" +
    "きみが笑っててくれるなら、安いもんだよ。",
  ];

  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Affection Gains ───────────────────────────────────

/** ゲームプレイによる好感度獲得量 */
export const AFFECTION_GAINS = {
  daily: 1,
  weekStreak: 5,          // 7日連続ログイン達成時
  gamePlayed: 0.5,        // ゲーム1回（1日10回まで）
  gamePlayedDailyCap: 10,
  tip: 2,                 // /tip 使用時（1日3回まで）
  tipDailyCap: 3,
  comebackWin: 3,         // 連敗5+からの復帰勝利
} as const;

// ─── Element Determination ─────────────────────────────

/**
 * プレイ履歴から五行属性を判定する。
 * 覚醒段階3「結び」到達時に呼ばれる。
 */
export function determineElement(userId: string): GogyoElement {
  try {
    const { db } = require("./db");
    const user = db.prepare(
      "SELECT total_wins, total_losses, total_wagered, total_earned, daily_streak FROM users WHERE user_id = ?"
    ).get(userId) as {
      total_wins: number; total_losses: number;
      total_wagered: number; total_earned: number;
      daily_streak: number;
    } | undefined;

    if (!user) return pickRandomElement();

    const totalGames = user.total_wins + user.total_losses;
    if (totalGames < 10) return pickRandomElement();

    const winRate = user.total_wins / Math.max(1, totalGames);
    const avgBet = user.total_wagered / Math.max(1, totalGames);

    // スコアリング
    const scores: Record<GogyoElement, number> = {
      wood: 0, fire: 0, earth: 0, metal: 0, water: 0,
    };

    // 木: 連続ログインが長い = コツコツ型
    scores.wood += Math.min(user.daily_streak * 2, 30);

    // 火: 平均BETが高い = ギャンブラー
    if (avgBet > 2000) scores.fire += 20;
    if (avgBet > 5000) scores.fire += 15;

    // 土: 勝率が安定 (40-60%) = 堅実
    if (winRate >= 0.4 && winRate <= 0.6) scores.earth += 20;
    scores.earth += Math.min(user.daily_streak, 15);

    // 金: 高勝率 = 技巧派
    if (winRate > 0.55) scores.metal += 25;
    if (winRate > 0.65) scores.metal += 15;

    // 水: 多くのゲーム経験 = 情報収集型
    if (totalGames > 100) scores.water += 15;
    if (totalGames > 300) scores.water += 15;

    // ゲーム種別のカウント（transaction_logs から推定）
    try {
      const gameCounts = db.prepare(`
        SELECT game, COUNT(*) as cnt FROM transaction_logs
        WHERE user_id = ? AND game IS NOT NULL
        GROUP BY game
      `).all(userId) as { game: string; cnt: number }[];

      for (const { game, cnt } of gameCounts) {
        if (game === "crash" || game === "roulette") scores.fire += Math.min(cnt, 20);
        if (game === "blackjack" || game === "highlow") scores.metal += Math.min(cnt, 20);
        if (game === "stocks" || game === "keiba") scores.water += Math.min(cnt, 20);
        if (game === "slots") scores.earth += Math.min(cnt, 10);
        if (game === "daily") scores.wood += Math.min(cnt, 10);
      }
    } catch {}

    // tip 回数
    try {
      const tipCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM transaction_logs WHERE user_id = ? AND reason = 'tip_send'"
      ).get(userId) as { cnt: number };
      scores.wood += Math.min(tipCount.cnt * 3, 30);
    } catch {}

    // 最高スコアの属性を選択
    let best: GogyoElement = "wood";
    let bestScore = -1;
    for (const [element, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        best = element as GogyoElement;
      }
    }

    return best;
  } catch {
    return pickRandomElement();
  }
}

function pickRandomElement(): GogyoElement {
  const elements: GogyoElement[] = ["wood", "fire", "earth", "metal", "water"];
  return elements[Math.floor(Math.random() * elements.length)];
}

/**
 * 属性決定時の演出セリフ
 */
export function getElementAwakeningDialogue(element: GogyoElement): string {
  const info = GOGYO[element];
  const base =
    "……っ。きみとの星約が、わたしの中の何かを呼び覚ました。\n\n" +
    "（アステルの身体から、眩い光が溢れ出す）\n\n";

  const elementLines: Record<GogyoElement, string> = {
    wood:
      "「これは……翠の光。生命の息吹だ。\n" +
      "　きみみたいに、地道に真っ直ぐ育つ力……\n" +
      "　わたしの中で眠ってた『萌芽の力』が目を覚ましたみたい。」",
    fire:
      "「……熱い。身体が燃えるみたいに熱い。\n" +
      "　きみの勝負への情熱が、わたしに火を灯したんだ。\n" +
      "　これが『劫焔の力』……すべてを焼き尽くす、覚悟の炎。」",
    earth:
      "「……ずしり、と。足元が揺るがない感じ。\n" +
      "　きみの堅実さが、わたしに不動の大地をくれた。\n" +
      "　これが『磐座の力』……何者にも崩せない、守りの力だよ。」",
    metal:
      "「……研ぎ澄まされていく。視界も、思考も、ぜんぶ鋭くなる。\n" +
      "　きみの鋭い判断が、わたしの中で刃になった。\n" +
      "　これが『閃鋼の力』……一瞬で見切る眼だ。」",
    water:
      "「……静かだ。深い、水底みたいな静けさ。\n" +
      "　きみの読みの深さが、わたしに淵の知恵をくれた。\n" +
      "　これが『幽淵の力』……すべてを映して、見通す力。」",
  };

  return (
    base + elementLines[element] +
    `\n\n✶ 星の属性『${info.emoji} ${info.name}（${info.reading}）』が目覚めた。\n` +
    `✶ テーマ: ${info.theme}`
  );
}
