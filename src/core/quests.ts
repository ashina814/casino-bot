/**
 * クエストシステム — 拡張可能設計
 *
 * 現状: 日次クエスト（3つ / 簡単・普通・難）
 * 将来: 週次 / イベント / 実績 を同じ枠組みで追加可能
 *
 * アーキテクチャ:
 *   - QuestDef: 任務定義（catalog）。type で daily / weekly / event を区別
 *   - pickQuests(periodKind, periodId, userId): 決定論的選出
 *   - getProgress(quest, userId, period): transaction_logs から query で算出
 *   - claim(quest, userId, periodId): quest_claims に記録 + 報酬支給
 *
 * 進捗計算はクエリベース（追加カウンタテーブル不要）。
 */
import { db } from "./db";
import { adjustBalance } from "./bank";
import { addExp } from "./economy";

/** 循環依存回避のための lazy import */
function getTodayLuckyGame(guildId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../ui/home").getTodayLuckyGame(guildId);
}

// ─── Types ─────────────────────────────────────────────

export type QuestKind = "daily" | "weekly" | "event";
export type QuestDifficulty = "easy" | "normal" | "hard";

/**
 * 進捗の計算方法。transaction_logs を期間でフィルタしてカウント／集計。
 *  - play_count: bet系の行数（game IS NOT NULL）
 *  - win_count: win系の行数
 *  - wager_sum: bet系の |amount| 合計
 *  - win_amount_max: win系の amount 最大値
 *  - distinct_games: 異なるゲームでの play 数
 *  - daily_claim: daily_bonus 行の有無
 */
export type Metric =
  | { kind: "play_count"; game?: string | "_lucky_" }
  | { kind: "win_count"; game?: string | "_lucky_" }
  | { kind: "wager_sum" }
  | { kind: "win_amount_max" }
  | { kind: "distinct_games" }
  | { kind: "daily_claim" };

export type QuestDef = {
  key: string;
  kind: QuestKind;
  difficulty: QuestDifficulty;
  title: string;
  description: string;          // {target} と {game} がプレースホルダで使える
  metric: Metric;
  target: number;
  reward: { coins: number; exp: number };
};

// ─── Catalog ───────────────────────────────────────────

const DAILY_QUESTS: QuestDef[] = [
  // EASY
  { key: "play_any_1",   kind: "daily", difficulty: "easy", title: "賭場に顔を出す",       description: "何でも 1 回プレイする",                 metric: { kind: "play_count" },                  target: 1,    reward: { coins: 300,  exp: 5 } },
  { key: "play_any_3",   kind: "daily", difficulty: "easy", title: "今日も常連",            description: "何でも 3 回プレイする",                 metric: { kind: "play_count" },                  target: 3,    reward: { coins: 500,  exp: 5 } },
  { key: "claim_daily",  kind: "daily", difficulty: "easy", title: "福分けを受け取る",     description: "`/福分け` を受け取る",                  metric: { kind: "daily_claim" },                 target: 1,    reward: { coins: 300,  exp: 5 } },

  // NORMAL
  { key: "win_3",        kind: "daily", difficulty: "normal", title: "三勝の手応え",        description: "何かのゲームで 3 勝する",              metric: { kind: "win_count" },                   target: 3,    reward: { coins: 700,  exp: 10 } },
  { key: "wager_5k",     kind: "daily", difficulty: "normal", title: "賭場で巡らす",        description: "累計 ◉5,000 を賭ける",                  metric: { kind: "wager_sum" },                   target: 5000, reward: { coins: 800,  exp: 10 } },
  { key: "distinct_3",   kind: "daily", difficulty: "normal", title: "色々と試す",          description: "3 種類のゲームで遊ぶ",                  metric: { kind: "distinct_games" },              target: 3,    reward: { coins: 700,  exp: 10 } },
  { key: "lucky_win",    kind: "daily", difficulty: "normal", title: "ラッキーゲームで勝つ", description: "本日のラッキーゲーム ({game}) で 1 勝する", metric: { kind: "win_count", game: "_lucky_" }, target: 1,    reward: { coins: 900,  exp: 12 } },

  // HARD
  { key: "big_win_3k",   kind: "daily", difficulty: "hard", title: "一発の華",              description: "1勝で ◉3,000 以上獲得する",            metric: { kind: "win_amount_max" },              target: 3000, reward: { coins: 1500, exp: 20 } },
  { key: "wager_20k",    kind: "daily", difficulty: "hard", title: "賭場の常客",            description: "累計 ◉20,000 を賭ける",                metric: { kind: "wager_sum" },                   target: 20000,reward: { coins: 1800, exp: 22 } },
  { key: "win_5",        kind: "daily", difficulty: "hard", title: "五勝のリズム",          description: "本日 5 勝する",                         metric: { kind: "win_count" },                   target: 5,    reward: { coins: 2000, exp: 25 } },
  { key: "distinct_5",   kind: "daily", difficulty: "hard", title: "百鬼夜行",              description: "5 種類のゲームで遊ぶ",                  metric: { kind: "distinct_games" },              target: 5,    reward: { coins: 2000, exp: 25 } },
];

export const QUEST_CATALOG: Record<string, QuestDef> = Object.fromEntries(
  DAILY_QUESTS.map((q) => [q.key, q]),
);

function questsBy(kind: QuestKind, difficulty: QuestDifficulty): QuestDef[] {
  return DAILY_QUESTS.filter((q) => q.kind === kind && q.difficulty === difficulty);
}

// ─── Period Helpers (JST 04:00 リセット) ────────────────

/** 現在の「クエスト日」（YYYY-MM-DD）。JST 04:00 を境に切り替わる。 */
export function getDailyPeriod(now = Date.now()): string {
  // JST = UTC+9h。日界を 04:00 JST に揃えるため、UTC から +5h シフトしてから日付を取る
  const shifted = new Date(now + 5 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// ─── Deterministic Picker ───────────────────────────────

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 日次の3任務（簡単・普通・難）を user × period で決定論的に選出。 */
export function pickDailyQuests(userId: string, period: string): [QuestDef, QuestDef, QuestDef] {
  const seed = hashStr(`${period}:${userId}`);
  const easyPool = questsBy("daily", "easy");
  const normalPool = questsBy("daily", "normal");
  const hardPool = questsBy("daily", "hard");
  const e = easyPool[seed % easyPool.length];
  const n = normalPool[(seed >>> 8) % normalPool.length];
  const h = hardPool[(seed >>> 16) % hardPool.length];
  return [e, n, h];
}

// ─── Progress Computation ──────────────────────────────

const BET_REASON_LIKE = "%_bet";
const WIN_REASON_LIKE = "%_win";

/**
 * 日次 period の transaction_logs を絞り込む WHERE 句（period 同日帯）。
 * SQLite の datetime(created_at, '+5 hours') で「クエスト日」に正規化して照合。
 */
function dayMatchClause(): string {
  return "date(datetime(created_at, '+5 hours')) = ?";
}

/** 指定 quest の現在の進捗を返す（progress, target, ratio）。 */
export function getQuestProgress(
  userId: string,
  quest: QuestDef,
  period: string,
  guildId?: string,
): { progress: number; target: number; completed: boolean } {
  let progress = 0;
  const target = quest.target;

  // metric.game の解決（_lucky_ → 今日のラッキーゲーム）
  let gameFilter: string | undefined;
  if (quest.metric.kind === "play_count" || quest.metric.kind === "win_count") {
    const g = (quest.metric as any).game as string | undefined;
    if (g === "_lucky_" && guildId) {
      gameFilter = getTodayLuckyGame(guildId);
    } else if (g && g !== "_lucky_") {
      gameFilter = g;
    }
  }

  switch (quest.metric.kind) {
    case "play_count": {
      const params: any[] = [userId, period];
      let q = `SELECT COUNT(*) as c FROM transaction_logs
               WHERE user_id = ? AND ${dayMatchClause()}
                 AND reason LIKE '${BET_REASON_LIKE}' AND game IS NOT NULL`;
      if (gameFilter) { q += " AND game = ?"; params.push(gameFilter); }
      const r = db.prepare(q).get(...params) as { c: number };
      progress = r.c;
      break;
    }
    case "win_count": {
      const params: any[] = [userId, period];
      let q = `SELECT COUNT(*) as c FROM transaction_logs
               WHERE user_id = ? AND ${dayMatchClause()}
                 AND reason LIKE '${WIN_REASON_LIKE}'`;
      if (gameFilter) { q += " AND game = ?"; params.push(gameFilter); }
      const r = db.prepare(q).get(...params) as { c: number };
      progress = r.c;
      break;
    }
    case "wager_sum": {
      const r = db.prepare(`
        SELECT IFNULL(SUM(ABS(amount)), 0) as s FROM transaction_logs
        WHERE user_id = ? AND ${dayMatchClause()}
          AND reason LIKE '${BET_REASON_LIKE}'
      `).get(userId, period) as { s: number };
      progress = r.s;
      break;
    }
    case "win_amount_max": {
      const r = db.prepare(`
        SELECT IFNULL(MAX(amount), 0) as m FROM transaction_logs
        WHERE user_id = ? AND ${dayMatchClause()}
          AND reason LIKE '${WIN_REASON_LIKE}'
      `).get(userId, period) as { m: number };
      progress = r.m;
      break;
    }
    case "distinct_games": {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT game) as c FROM transaction_logs
        WHERE user_id = ? AND ${dayMatchClause()}
          AND reason LIKE '${BET_REASON_LIKE}' AND game IS NOT NULL
      `).get(userId, period) as { c: number };
      progress = r.c;
      break;
    }
    case "daily_claim": {
      const r = db.prepare(`
        SELECT COUNT(*) as c FROM transaction_logs
        WHERE user_id = ? AND ${dayMatchClause()}
          AND reason = 'daily_bonus'
      `).get(userId, period) as { c: number };
      progress = r.c;
      break;
    }
  }

  return { progress, target, completed: progress >= target };
}

// ─── Claim Tracking ─────────────────────────────────────

export function isClaimed(userId: string, questKey: string, period: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM quest_claims WHERE user_id = ? AND quest_key = ? AND period = ?"
  ).get(userId, questKey, period);
  return !!row;
}

export type ClaimResult =
  | { ok: true; reward: { coins: number; exp: number } }
  | { ok: false; reason: "already_claimed" | "not_completed" | "balance_error" };

/**
 * 任務を受領（報酬を支給して quest_claims に記録）。
 * 必ず progress を再チェックして完了状態を確認する（クライアント信用しない）。
 */
export function claimQuest(
  userId: string,
  quest: QuestDef,
  period: string,
  guildId: string,
): ClaimResult {
  if (isClaimed(userId, quest.key, period)) {
    return { ok: false, reason: "already_claimed" };
  }
  const prog = getQuestProgress(userId, quest, period, guildId);
  if (!prog.completed) {
    return { ok: false, reason: "not_completed" };
  }
  // 報酬付与
  const result = adjustBalance(userId, quest.reward.coins, `quest_${quest.key}`, "quest", guildId);
  if (!result.ok) {
    return { ok: false, reason: "balance_error" };
  }
  addExp(userId, quest.reward.exp);
  db.prepare(
    "INSERT INTO quest_claims (user_id, quest_key, period) VALUES (?, ?, ?)"
  ).run(userId, quest.key, period);
  return { ok: true, reward: quest.reward };
}

// ─── Description Formatter ─────────────────────────────

/** 任務説明のプレースホルダ ({game}, {target}) を展開。 */
export function formatDescription(quest: QuestDef, guildId: string): string {
  let desc = quest.description.replace("{target}", String(quest.target));
  if (desc.includes("{game}")) {
    let game = "";
    if (quest.metric.kind === "play_count" || quest.metric.kind === "win_count") {
      const g = (quest.metric as any).game as string | undefined;
      game = g === "_lucky_" ? getTodayLuckyGame(guildId) : (g ?? "");
    }
    desc = desc.replace("{game}", game);
  }
  return desc;
}

/** 進捗の見栄え（バーと数値）。 */
export function formatProgress(progress: number, target: number): string {
  const ratio = Math.min(1, progress / target);
  const filled = Math.floor(ratio * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const pct = Math.floor(ratio * 100);
  // 大きな目標値は通貨フォーマット
  const showNum = (n: number) => n >= 1000 ? `◉${n.toLocaleString()}` : String(n);
  return `\`${bar}\` ${showNum(progress)} / ${showNum(target)} (${pct}%)`;
}
