/**
 * マイルストーン称号の判定・自動付与
 * ─────────────────────────────────────────────────────────
 * バンク／日次／ゲーム結果のフックから checkXxx を呼ぶと、
 * その時点の users 行を見て条件を満たす称号を冪等に付与する。
 *
 * 設計:
 *   - 称号の名前・条件・閾値は titlesCatalog に集約（DRY）
 *   - 付与は titles テーブルへ INSERT OR IGNORE（重複なし）
 *   - 呼び出し側は失敗しても本処理を止めない（try/catch）
 *   - 通知はせず silent grant。ユーザーは /案内→二つ名 で気付く
 */
import { db } from "./db";
import { MILESTONE_THRESHOLDS, getTitleDef } from "./titlesCatalog";

function awardTitle(userId: string, titleKey: string): boolean {
  const def = getTitleDef(titleKey);
  if (!def) return false;
  try {
    db.prepare(
      "INSERT OR IGNORE INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)",
    ).run(userId, titleKey, def.name);
    return true;
  } catch {
    return false;
  }
}

type UserStatsRow = {
  total_wins: number;
  total_wagered: number;
  biggest_win: number;
  best_win_streak: number;
  daily_streak: number;
};

function getUserStats(userId: string): UserStatsRow | null {
  const r = db.prepare(
    "SELECT total_wins, total_wagered, biggest_win, best_win_streak, daily_streak FROM users WHERE user_id = ?",
  ).get(userId) as UserStatsRow | undefined;
  return r ?? null;
}

/**
 * 勝利系の称号を判定（recordWin の直後に呼ぶ想定）。
 *   - centurion / kilo_winner: total_wins
 *   - jackpot_hit: biggest_win
 *   - chain_keeper / chain_legend: best_win_streak
 *   - heavy_better: total_wagered（賭けに応じても伸びるが勝利後に拾うのが軽い）
 */
export function checkWinMilestones(userId: string): void {
  try {
    const s = getUserStats(userId);
    if (!s) return;
    if (s.total_wins >= MILESTONE_THRESHOLDS.centurion)        awardTitle(userId, "centurion");
    if (s.total_wins >= MILESTONE_THRESHOLDS.kilo_winner)       awardTitle(userId, "kilo_winner");
    if (s.biggest_win >= MILESTONE_THRESHOLDS.jackpot_hit)      awardTitle(userId, "jackpot_hit");
    if (s.best_win_streak >= MILESTONE_THRESHOLDS.chain_keeper) awardTitle(userId, "chain_keeper");
    if (s.best_win_streak >= MILESTONE_THRESHOLDS.chain_legend) awardTitle(userId, "chain_legend");
    if (s.total_wagered  >= MILESTONE_THRESHOLDS.heavy_better)  awardTitle(userId, "heavy_better");
  } catch { /* silent */ }
}

/**
 * 賭け系の称号を判定（recordWager の直後に呼ぶ想定）。
 *   - heavy_better: total_wagered
 * 勝ち負けに関係なく賭け額累計で進む称号はここ。
 */
export function checkWagerMilestones(userId: string): void {
  try {
    const s = getUserStats(userId);
    if (!s) return;
    if (s.total_wagered >= MILESTONE_THRESHOLDS.heavy_better) awardTitle(userId, "heavy_better");
  } catch { /* silent */ }
}

/**
 * 連続ログイン系の称号を判定（/福分け の直後に呼ぶ想定）。
 *   - regular_visitor: daily_streak >= 30
 *   - devotee: daily_streak >= 100
 */
export function checkDailyMilestones(userId: string): void {
  try {
    const s = getUserStats(userId);
    if (!s) return;
    if (s.daily_streak >= MILESTONE_THRESHOLDS.regular_visitor) awardTitle(userId, "regular_visitor");
    if (s.daily_streak >= MILESTONE_THRESHOLDS.devotee)         awardTitle(userId, "devotee");
  } catch { /* silent */ }
}

/**
 * 全カテゴリ一括チェック（軽量なので起動時整合用や手動コマンドで呼べる）。
 */
export function checkAllMilestones(userId: string): void {
  checkWinMilestones(userId);
  checkWagerMilestones(userId);
  checkDailyMilestones(userId);
}
