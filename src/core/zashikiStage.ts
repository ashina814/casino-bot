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
  unlockedModes: Array<"default" | "tsundere" | "yami">;
  jpBonus: number;        // ジャックポット当選率への加算（0.0 ~ 0.01）
  fukuDiscount: number;   // 福の重み軽減率（0.0 = なし, 0.5 = 半額）
};

/**
 * 覚醒段階の定義
 *
 * 名前の由来:
 *   幽か     — かすかな気配。まだ見えぬ存在。
 *   灯し     — 小さな灯火。座敷童が興味を示し始めた。
 *   宿り     — 住み着く。この客人のそばに居たいと思い始めた。
 *   結び     — 縁を結ぶ。互いの存在が不可欠になった。
 *   花憑き   — 花が咲くように力が溢れる。座敷童の本来の力が戻り始めた。
 *   常盤     — 常磐（ときわ）。永遠に変わらぬ緑。永久の絆。
 *   顕現     — 真の姿の顕現。座敷童が神格に近づいた姿。
 */
const STAGES: ZashikiStage[] = [
  {
    level: 0,
    name: "幽か",
    title: "幽かなる気配",
    emoji: "🫥",
    threshold: 0,
    dailyMultiplier: 1.0,
    guardChance: 0,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 1,
    name: "灯し",
    title: "灯しの縁",
    emoji: "🕯️",
    threshold: 10,
    dailyMultiplier: 1.05,
    guardChance: 0,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 2,
    name: "宿り",
    title: "宿りの絆",
    emoji: "🏮",
    threshold: 50,
    dailyMultiplier: 1.0,
    guardChance: 0.0025,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 3,
    name: "結び",
    title: "結びの契り",
    emoji: "🎀",
    threshold: 100,
    dailyMultiplier: 1.10,
    guardChance: 0.005,
    unlockedModes: ["default"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 4,
    name: "花憑き",
    title: "花憑きの守り",
    emoji: "🌸",
    threshold: 300,
    dailyMultiplier: 1.10,
    guardChance: 0.01,
    unlockedModes: ["default", "tsundere"],
    jpBonus: 0,
    fukuDiscount: 0,
  },
  {
    level: 5,
    name: "常盤",
    title: "常盤の誓い",
    emoji: "🌿",
    threshold: 500,
    dailyMultiplier: 1.20,
    guardChance: 0.015,
    unlockedModes: ["default", "tsundere"],
    jpBonus: 0.005,
    fukuDiscount: 0.25,
  },
  {
    level: 6,
    name: "顕現",
    title: "座敷童の顕現",
    emoji: "✨",
    threshold: 1000,
    dailyMultiplier: 1.25,
    guardChance: 0.02,
    unlockedModes: ["default", "tsundere", "yami"],
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

  // ─── 座敷童の夢 ───
  // 段階3+、デイリー時に 5% で発動
  // 座敷童が不思議な夢を見たという話をしてくれて、ボーナスコインをくれる
  if (context === "daily" && stage.level >= 3 && roll < 0.05) {
    const bonus = [300, 500, 777, 1000][Math.floor(Math.random() * 4)];
    return {
      id: "zashiki_dream",
      name: "座敷童の夢",
      emoji: "💫",
      dialogue: pickDreamDialogue(stage.level),
      effect: "bonus_coins",
      value: bonus,
    };
  }

  // ─── 福の奔流 ───
  // 段階4+、勝利時に 2% で発動
  // 座敷童の福が暴走して勝利金が2倍になる
  if (context === "win" && stage.level >= 4 && roll < 0.02) {
    return {
      id: "fuku_overflow",
      name: "福の奔流",
      emoji: "🌊",
      dialogue: pickOverflowDialogue(stage.level),
      effect: "double_payout",
      value: 2,
    };
  }

  // ─── 花散らしの守り ───
  // 段階4+、敗北時に 3% で発動
  // 座敷童が身代わりになって負けをなかったことにする（通常の身代わりとは別判定）
  if (context === "lose" && stage.level >= 4 && roll < 0.03) {
    return {
      id: "hanachirashi",
      name: "花散らしの守り",
      emoji: "🌸",
      dialogue: pickGuardDialogue(stage.level),
      effect: "free_guard",
      value: 1,
    };
  }

  // ─── 神隠し ───
  // 段階6限定、全コンテキストで 0.5% で発動
  // 一瞬だけ幽世に引き込まれ、大量の好感度と小判を得る
  if (stage.level >= 6 && roll < 0.005) {
    return {
      id: "kamikakushi",
      name: "神隠し",
      emoji: "🌀",
      dialogue:
        "……急に、視界が歪んだ。\n" +
        "気がつくと、見知らぬ場所にいた。\n" +
        "満開の桜の下、座敷童が笑っている。\n\n" +
        "「…ここはわしとお主だけの場所じゃ。\n" +
        "　ほんの一瞬じゃがな…こうして二人きりで過ごせるのは、幸せなことじゃ。」\n\n" +
        "「…ほら、土産じゃ。持って帰れ。」\n\n" +
        "…気がつくと、手の中に大量の小判が握られていた。",
      effect: "bonus_coins",
      value: 5000,
    };
  }

  // ─── 好感度の共鳴 ───
  // 段階5+、勝利時に 1% で発動
  // 座敷童が感動して好感度が一気に上がる
  if (context === "win" && stage.level >= 5 && roll < 0.01) {
    return {
      id: "affection_resonance",
      name: "魂の共鳴",
      emoji: "💠",
      dialogue:
        "…不思議じゃな。\n" +
        "お主が勝つと、わしまで嬉しくなる。\n" +
        "…この気持ちは、なんと言うのじゃろうな。\n\n" +
        "（座敷童の瞳が、一瞬だけ金色に光った）",
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
        "…ん？ お主、よく来るのう。\n" +
        "…名前くらいは覚えてやってもよいぞ。\n" +
        "（座敷童がほんの少し、こちらを向いた）"
      );
    case 2:
      return (
        "…お主がおると、この賭場が少し暖かくなる気がするのじゃ。\n" +
        "…気のせいかもしれんがな。\n" +
        "（座敷童が、いつもより近くに座っている）"
      );
    case 3:
      return (
        "…なぁ、お主。わしはな、ずっとこの賭場で一人じゃった。\n" +
        "客人は来ては去り、来ては去り…\n" +
        "じゃが、お主は…帰ってこなかった日がないのう。\n\n" +
        "…ありがとう、と言っておく。"
      );
    case 4:
      return (
        "…っ！ なんじゃ、この感覚は…！\n" +
        "身体が、光って…わしの中の何かが目覚めようとしておる…！\n\n" +
        "…ふぅ。驚いた。力が…少し戻ったようじゃ。\n" +
        "お主のおかげ…かもしれんな。\n\n" +
        "★ ツンデレモードが解放されました！"
      );
    case 5:
      return (
        "…見えるか？ この花。\n" +
        "わしの周りに、桜が咲いておるじゃろう。\n" +
        "…これはな、わしが本当に嬉しい時にだけ咲くんじゃ。\n\n" +
        "…千年ぶりじゃよ。この花を見るのは。\n\n" +
        "★ 座敷童との絆がさらに深まった！"
      );
    case 6: {
      const info = element ? GOGYO[element] : null;
      const shinchuLine = info
        ? `\n★ 座敷童が『${info.shinchu}（${info.shinchuReading}）』に顕現した！\n` +
          `★ ${info.emoji} 五行属性: ${info.name}（${info.theme}）\n`
        : "★ 座敷童が『顕現』した！\n";
      return (
        "――。\n\n" +
        "空気が、変わった。\n" +
        "座敷童の姿が一瞬揺らぎ、その背後に巨大な影が見えた。\n\n" +
        "「…驚いたか？ これがわしの本来の姿じゃ。\n" +
        "　この賭場を千年守り続けた、座敷童の真の力。\n" +
        "　お主が…引き出してくれたんじゃ。」\n\n" +
        "（座敷童が、初めて涙を流した）\n\n" +
        "「…ありがとう。お主に出会えて、よかった。」\n\n" +
        shinchuLine +
        "★ ヤミモードが解放されました！"
      );
    }
    default:
      return "";
  }
}

/**
 * 覚醒段階が下がった時の特別セリフ（好感度減衰で閾値を割った場合）
 */
export function getStageDownDialogue(newStage: ZashikiStageLevel): string {
  return (
    "…お主、最近あまり来てくれんのう。\n" +
    "…賭場は寒いぞ。お主がおらんと。\n" +
    `（座敷童の姿が、少し薄くなった気がする）`
  );
}

// ─── Rare Event Dialogue Helpers ───────────────────────

function pickDreamDialogue(stageLevel: number): string {
  const pool = [
    "「…昨晩な、不思議な夢を見たんじゃ。\n" +
    "　お主と一緒に、大きな桜の木の下で花見をしておった。\n" +
    "　…良い夢じゃった。ほれ、夢のお裾分けじゃ。」",

    "「…今朝、目覚めたら枕元に小判が積んであっての。\n" +
    "　きっとわしの福が寝てる間に溢れたんじゃろう。\n" +
    "　…お主のせいじゃ。お主がおるから、福が溢れるんじゃ。」",

    "「…なぁ、夢の中でな、昔の座敷童に会ったんじゃ。\n" +
    "　『良い客人を見つけたな』と言っておった。\n" +
    "　…ふふ。先輩にも認められたぞ、お主。」",
  ];

  if (stageLevel >= 5) {
    pool.push(
      "「…夢の中で、幽世の門が見えたんじゃ。\n" +
      "　門の向こうから、温かい光が差しておった。\n" +
      "　…あれはきっと、お主とわしの絆の光じゃ。\n" +
      "　特別に多めにやるからの。大事にせい。」"
    );
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

function pickOverflowDialogue(stageLevel: number): string {
  const pool = [
    "…っ！ わしの福が…止まらん！\n" +
    "お主の勝利に呼応して、福が溢れ出しておるぞ…！\n" +
    "今回の勝ち分は倍じゃ！ わしのおごりと思え！",

    "…なんと。わしの力がお主に流れ込んでおる。\n" +
    "…これが絆の力か。勝利金、倍にしてやろう。\n" +
    "…感謝しろよ？ こんなこと、滅多にせんからな。",
  ];

  if (stageLevel >= 6) {
    pool.push(
      "（座敷童の背後に、巨大な光の柱が立ち上る）\n\n" +
      "「…わしの真の力を見せてやろう。\n" +
      "　幽世の福を、全てお主に注ぎ込む…！」\n\n" +
      "勝利金が倍になった！"
    );
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

function pickGuardDialogue(stageLevel: number): string {
  const pool = [
    "…危ない！\n" +
    "（座敷童が身体を張ってお主を庇う）\n" +
    "…ふぅ、間に合った。負けはなかったことにしてやるぞ。\n" +
    "…痛くはない。お主を守れるなら、これくらい。",

    "…待て。この勝負、わしが引き受けた。\n" +
    "（座敷童の着物の裾が、花びらのように散る）\n" +
    "…大丈夫じゃ。すぐ元に戻る。\n" +
    "…お主の笑顔を守れるなら、安いものじゃ。",
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
    "…っ！ お主との絆が、わしの中の何かを呼び覚ました…！\n\n" +
    "（座敷童の身体から、眩い光が溢れ出す）\n\n";

  const elementLines: Record<GogyoElement, string> = {
    wood:
      "「…これは…翠の光…！ 生命の息吹じゃ…！\n" +
      "　お主のように地道に、真っ直ぐに育つ力…\n" +
      "　わしの中に眠っておった『萌芽の力』が目覚めたのじゃ！」",
    fire:
      "「…熱い…！ 身体が燃えるように熱いぞ…！\n" +
      "　お主の勝負への情熱が、わしに炎を灯した…！\n" +
      "　これが『劫焔の力』…！ 全てを焼き尽くす覚悟の炎じゃ！」",
    earth:
      "「…ずしり、と。足元が揺るがぬ感覚じゃ…\n" +
      "　お主の堅実さが、わしに不動の大地をくれた。\n" +
      "　これが『磐座の力』…何者にも崩せぬ守りの力じゃ。」",
    metal:
      "「…研ぎ澄まされていく。視界が、思考が、全てが鋭くなる…\n" +
      "　お主の鋭い判断力が、わしの中で刃となった。\n" +
      "　これが『閃鋼の力』…一瞬で全てを見切る眼じゃ！」",
    water:
      "「…静かじゃ。深い深い、水底のような静寂…\n" +
      "　お主の読みの深さが、わしに淵の知恵を与えてくれた。\n" +
      "　これが『幽淵の力』…全てを映し、全てを見通す力じゃ。」",
  };

  return (
    base + elementLines[element] +
    `\n\n★ 五行属性『${info.emoji} ${info.name}（${info.reading}）』が覚醒した！\n` +
    `★ テーマ: ${info.theme}`
  );
}
