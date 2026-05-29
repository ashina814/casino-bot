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
  { key: "thanks", titleName: "アステルの心友", requiredProgress: 5 },
  { key: "alone", titleName: "アステルの秘密を知る者", requiredProgress: 1 },
  { key: "shichifukujin", titleName: "七星の寵愛", requiredProgress: 7 },
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
    message: "丑三つ時に賭場に来るなんて、きみもなかなかの夜更かしだね。\nこの時間のわたし、ちょっとだけ素が出ちゃうんだけど……ま、いっか。\n二つ名「丑三つ時の常連」をあげる。",
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
    return { triggered: true, message: "「ぞろ目だ。粋な賭け方するね。今回は特別に、まっさらで勝負させてあげる。」" };
  }

  setProgress(userId, "zorome", 1);
  markCompleted(userId, "zorome");
  awardTitle(userId, "zorome", "粋人");

  return {
    triggered: true,
    titleName: "粋人",
    message: "「ふふ、粋な賭け方するじゃない。ぞろ目は縁起がいいんだよ。\n……ちょっとだけ、おまけしとくね。」\n二つ名「粋人」をあげる。",
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
    message: "「うう……きみがここまで負け続けるの、\nわたしの光が足りないせいかもしれない……\nごめんね。ほんと、ごめん……」\n\n（アステルが半泣きで ◈10,000 をそっと握らせてきた）",
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
    awardTitle(userId, "thanks", "アステルの心友");
    return {
      triggered: true,
      titleName: "アステルの心友",
      message: "「……5回も、ありがとうって言ってくれたんだ。\nきみ、ほんと変わってるね。\n……ふふ、でも、悪い気はしないな。\n二つ名「アステルの心友」をあげる。大事にしてよ？」",
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
  awardTitle(userId, "alone", "アステルの秘密を知る者");

  return {
    triggered: true,
    titleName: "アステルの秘密を知る者",
    message: "「……あれ、今夜はきみだけか。\nねえ、たまにはさ、賭けなしで話さない？\n……この賭場を開いたばっかりの頃はね、誰も来てくれなくて、すごく寂しかったんだ。\nだから、きみが来てくれると……うん。嬉しいよ、ほんとに。」",
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
    awardTitle(userId, "shichifukujin", "七星の寵愛");
    return {
      triggered: true,
      titleName: "七星の寵愛",
      message: "「七日、七つの勝ち……すごいね、きみ。\nまるで七つの星ぜんぶに気に入られたみたいだ。\nこれは……七星の寵愛、かな。」",
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
    message: "「ひぇっ……エテル百万だって！？\nきみ、まさかこの賭場ごと買い取る気じゃ……ないよね？\nおそろしい人だなあ。二つ名『大富豪』をあげる。」",
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
    message: "「あーあ、見事にすってんてんだ。\nまあ、どん底まで落ちたら、あとは上がるだけだよ。\n元気出して。ほら、少しだけエテルあげる。\n二つ名『すってんてん』も、ね。」",
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
    message: "「お、777。縁起のいい数字だね。\nきみには特別に、運をちょっと分けてあげる。\n二つ名『幸運児』をあげるよ。」",
  };
}

/**
 * /thanks コマンド用の応答テキスト
 */
export function thanksResponse(userId: string): string {
  const { progress, completed } = getProgress(userId, "thanks");

  if (completed) {
    return "「……今日も来てくれたね。うん、嬉しい。」";
  }

  const responses = [
    "「……ありがとう、って？ ふふ、きみ、変わってるね。」",
    "「また言うんだ。……悪い気はしないけどさ。」",
    "「三度目。……本気で言ってる？ ……ちょっと、嬉しいかも。」",
    "「四度目……ふふ、もうすぐ何か起こるかもよ？」",
  ];

  return responses[Math.min(progress, responses.length - 1)];
}
