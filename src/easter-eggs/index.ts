/**
 * 🥚 イースターエッグ判定エンジン
 *
 * 各ゲーム結果やコマンド実行後にチェックされ、
 * 条件を満たしていれば二つ名を付与 + 特別演出。
 */
import { db } from "../core/db";

// ─── Types ─────────────────────────────────────────────

type EggDefinition = {
  key: string;
  titleName: string;
  requiredProgress: number;
};

const EGGS: EggDefinition[] = [
  { key: "ushimitsudoki", titleName: "丑三つ時の常連", requiredProgress: 1 },
  { key: "zorome", titleName: "粋人", requiredProgress: 1 },
  { key: "lose_100", titleName: "不屈の魂", requiredProgress: 100 },
  { key: "thanks", titleName: "座敷童の心友", requiredProgress: 5 },
  { key: "alone", titleName: "座敷童の秘密を知る者", requiredProgress: 1 },
  { key: "shichifukujin", titleName: "七福神の寵愛", requiredProgress: 7 },
];

// ─── Progress Tracking ─────────────────────────────────

function getProgress(userId: string, eggKey: string): { progress: number; completed: number } {
  const row = db.prepare(
    "SELECT progress, completed FROM easter_egg_progress WHERE user_id = ? AND egg_key = ?"
  ).get(userId, eggKey) as { progress: number; completed: number } | undefined;

  return row ?? { progress: 0, completed: 0 };
}

function setProgress(userId: string, eggKey: string, progress: number): void {
  db.prepare(`
    INSERT INTO easter_egg_progress (user_id, egg_key, progress, last_triggered)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, egg_key) DO UPDATE SET progress = ?, last_triggered = datetime('now')
  `).run(userId, eggKey, progress, progress);
}

function markCompleted(userId: string, eggKey: string): void {
  db.prepare(
    "UPDATE easter_egg_progress SET completed = 1 WHERE user_id = ? AND egg_key = ?"
  ).run(userId, eggKey);
}

function awardTitle(userId: string, titleKey: string, titleName: string): boolean {
  try {
    db.prepare(
      "INSERT INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)"
    ).run(userId, titleKey, titleName);
    return true;
  } catch {
    return false; // already has it
  }
}

// ─── Public Check Functions ────────────────────────────

export type EggResult = {
  triggered: boolean;
  titleName?: string;
  message?: string;
  bonusAmount?: number;
};

/**
 * EE-01: 丑三つ時の賭場 — AM2-3時にプレイ
 */
export function checkUshimitsudoki(userId: string): EggResult {
  const hour = new Date().getHours();
  if (hour < 2 || hour >= 3) return { triggered: false };

  const { completed } = getProgress(userId, "ushimitsudoki");
  if (completed) return { triggered: false };

  setProgress(userId, "ushimitsudoki", 1);
  markCompleted(userId, "ushimitsudoki");
  awardTitle(userId, "ushimitsudoki", "丑三つ時の常連");

  return {
    triggered: true,
    titleName: "丑三つ時の常連",
    message: "…丑三つ時に賭場に来るとは、お主もなかなかの夜更かしじゃな。\n二つ名「丑三つ時の常連」を授けよう。",
  };
}

/**
 * EE-02: ぞろ目ベット — 1111, 2222等
 */
export function checkZorome(userId: string, betAmount: number): EggResult {
  const str = String(betAmount);
  if (str.length < 4) return { triggered: false };
  const isZorome = str.split("").every((c) => c === str[0]);
  if (!isZorome) return { triggered: false };

  const { completed } = getProgress(userId, "zorome");
  if (completed) {
    // Already got title, but still give 0% edge
    return { triggered: true, message: "「ぞろ目じゃな。粋な賭け方じゃ。今回は特別に公平にしてやろう。」" };
  }

  setProgress(userId, "zorome", 1);
  markCompleted(userId, "zorome");
  awardTitle(userId, "zorome", "粋人");

  return {
    triggered: true,
    titleName: "粋人",
    message: "「おや…粋な賭け方をするのう。ぞろ目は縁起が良い。\n少しだけ…おまけしてやろう。」\n二つ名「粋人」を授けよう。",
  };
}

/**
 * EE-03: 100連敗
 */
export function checkLoseStreak(userId: string, currentLoseStreak: number): EggResult {
  if (currentLoseStreak < 100) return { triggered: false };

  const { completed } = getProgress(userId, "lose_100");
  if (completed) return { triggered: false };

  setProgress(userId, "lose_100", 100);
  markCompleted(userId, "lose_100");
  awardTitle(userId, "lose_100", "不屈の魂");

  return {
    triggered: true,
    titleName: "不屈の魂",
    message: "「う…うう…お主がここまで負け続けるのは、\nわしの福の力が足りぬせいかもしれぬ…\nすまぬ…すまぬのう…」\n\n（座敷童が泣きながら◈10,000をくれた）",
    bonusAmount: 10_000,
  };
}

/**
 * EE-04: /thanks を5回
 */
export function checkThanks(userId: string): EggResult {
  const { progress, completed } = getProgress(userId, "thanks");
  if (completed) return { triggered: false };

  const newProgress = progress + 1;
  setProgress(userId, "thanks", newProgress);

  if (newProgress >= 5) {
    markCompleted(userId, "thanks");
    awardTitle(userId, "thanks", "座敷童の心友");
    return {
      triggered: true,
      titleName: "座敷童の心友",
      message: "「…5回も礼を言ってくれたのか。\nお主は本当に変わった客人じゃな。\n…ふふ、悪い気はせぬ。\n二つ名「座敷童の心友」を授けよう。」",
    };
  }

  return { triggered: false };
}

/**
 * EE-05: 深夜の独り言 — サーバーで自分だけオンライン
 * (This requires guild member presence data - simplified check)
 */
export function checkAlone(userId: string, onlineCount: number): EggResult {
  if (onlineCount > 1) return { triggered: false };

  const { completed } = getProgress(userId, "alone");
  if (completed) return { triggered: false };

  setProgress(userId, "alone", 1);
  markCompleted(userId, "alone");
  awardTitle(userId, "alone", "座敷童の秘密を知る者");

  return {
    triggered: true,
    titleName: "座敷童の秘密を知る者",
    message: "「…おや、今夜はお主だけか。\n…なぁ、客人よ。たまにはゲームなしで話さぬか。\n…この賭場を始めた頃はの、誰も来てくれなくて寂しかったんじゃ。\nじゃからお主が来てくれると…嬉しい。」",
  };
}

/**
 * EE-06: 七福神 — 7日連続別ゲーム勝利
 * progressは7ビットのビットマスク (day0=bit0, day1=bit1, ...)
 */
export function checkShichifukujin(userId: string, dayIndex: number): EggResult {
  const { progress, completed } = getProgress(userId, "shichifukujin");
  if (completed) return { triggered: false };

  const newProgress = progress | (1 << (dayIndex % 7));
  setProgress(userId, "shichifukujin", newProgress);

  // Check if all 7 bits are set
  if (newProgress === 0b1111111) {
    markCompleted(userId, "shichifukujin");
    awardTitle(userId, "shichifukujin", "七福神の寵愛");
    return {
      triggered: true,
      titleName: "七福神の寵愛",
      message: "「七日…七つの勝利…\nこれはまさに七福神の加護…！」",
      bonusAmount: 5_000,
    };
  }

  return { triggered: false };
}

/**
 * EE-07: 大富豪 — 残高が1,000,000を超える
 */
export function checkMillionaire(userId: string, balance: number): EggResult {
  if (balance < 1000000) return { triggered: false };

  const { completed } = getProgress(userId, "millionaire");
  if (completed) return { triggered: false };

  setProgress(userId, "millionaire", 1);
  markCompleted(userId, "millionaire");
  awardTitle(userId, "millionaire", "大富豪");

  return {
    triggered: true,
    titleName: "大富豪",
    message: "「ひぇっ…百万ベルじゃと…！？\nお主、まさかこの賭場を買い取る気か…？\n恐ろしい客人じゃ…二つ名『大富豪』を授けよう。」",
  };
}

/**
 * EE-08: 破産者 — 残高が0になる
 */
export function checkBankrupt(userId: string, balance: number): EggResult {
  if (balance > 0) return { triggered: false };

  const { completed } = getProgress(userId, "bankrupt");
  if (completed) return { triggered: false };

  setProgress(userId, "bankrupt", 1);
  markCompleted(userId, "bankrupt");
  awardTitle(userId, "bankrupt", "すってんてん");

  return {
    triggered: true,
    titleName: "すってんてん",
    message: "「あーあ、見事にすってんてんじゃな。\nまあ、どん底まで落ちればあとは上がるだけじゃ。\n元気づけに、少しだけエテルをくれてやろう。\n二つ名『すってんてん』を授けよう。」",
    bonusAmount: 3000,
  };
}

/**
 * EE-09: ラッキー7 — ちょうど777ベット
 */
export function checkLucky7(userId: string, betAmount: number): EggResult {
  if (betAmount !== 777) return { triggered: false };

  const { completed } = getProgress(userId, "lucky7");
  if (completed) return { triggered: false };

  setProgress(userId, "lucky7", 1);
  markCompleted(userId, "lucky7");
  awardTitle(userId, "lucky7", "幸運児");

  return {
    triggered: true,
    titleName: "幸運児",
    message: "「おっ、777…縁起がいい数字じゃのう！\nお主には特別に幸運を分けてやろう。\n二つ名『幸運児』を授けるぞ。」",
  };
}

/**
 * /thanks コマンド用の応答テキスト
 */
export function thanksResponse(userId: string): string {
  const { progress, completed } = getProgress(userId, "thanks");

  if (completed) {
    return "「…今日も来てくれたか。嬉しいのう。」";
  }

  const responses = [
    "「…ありがとう、じゃと？ …お主は変わった客人じゃな。」",
    "「また言うのか。…ふふ、悪い気はせぬな。」",
    "「三度目じゃと…？ 本気で言っておるのか。…嬉しいのう。」",
    "「四度…もうすぐ何かが起こるかもしれぬぞ…？」",
  ];

  return responses[Math.min(progress, responses.length - 1)];
}
