/**
 * 為替オーケストレーション（Gil-bot API 連携）
 * ─────────────────────────────────────────────────────────
 * レート/手数料/上限は Gil-bot 側が正。casino は API が返した額でエテルを増減するだけ。
 *
 * 入庫（Gil→エテル / internal_to_external）:
 *   ①commit(amount=Gil) → Gil減算・externalPayout 返る ②エテル付与(原子) ③付与失敗→cancel(Gil返金)
 * 出庫（エテル→Gil / external_to_internal）:
 *   ①エテル徴収(原子) ②commit(amount=エテル) → Gil付与 ③commit失敗→エテル返金
 *
 * requestId = "casino-{rowId}" で安定生成。再試行は同IDで Gil-bot 冪等に乗る。
 * 整合性: ローカルのエテル増減と status='done'/'pending_commit' を **同一 runTransaction** で更新し、
 *   「付与したのに未記録」を防ぐ。再起動時の resume は方向別に分岐（出庫は再徴収しない）。
 */
import { db, runTransaction } from "./db";
import { adjustBalance } from "./bank";
import { WORLD } from "../world.config";
import {
  gilCommit, gilCancel, isExchangeApiAvailable,
  type GilDirection, type GilOperation,
} from "./gilApi";

export { isExchangeApiAvailable } from "./gilApi";

/**
 * 還光率: 出庫（エテル→ルクス）時に徴収エテルのこの割合を **バーン（消滅）** し、
 * 残りだけをルクス化する。入庫（ルクス→エテル）は無料。
 *   例: 1000 エテル出庫 → 500 バーン消滅 / 500 をルクスに換金。
 * ※ JP/救済プールには回さず純粋に消す方針（運営決定 2026-06）。
 */
export const RYUKO_RATE = 0.5;

export type ApiExchangeRow = {
  id: number;
  guild_id: string;
  user_id: string;
  direction: GilDirection;
  amount: number;
  request_id: string;
  status: string; // pending_approval / pending_commit / done / failed / cancelled
  external_amount: number | null;
  internal_amount: number | null;
  fee_internal: number | null;
  ether_delta: number | null;
  memo: string | null;
};

export type ExecResult =
  | { ok: true; etherDelta: number; op: GilOperation }
  | { ok: false; code: string; message: string };

export function getExchangeRow(id: number): ApiExchangeRow | undefined {
  return db.prepare("SELECT * FROM api_exchanges WHERE id = ?").get(id) as ApiExchangeRow | undefined;
}

function setStatus(id: number, status: string): void {
  db.prepare("UPDATE api_exchanges SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}
function setMeta(id: number, f: Partial<Pick<ApiExchangeRow, "external_amount" | "internal_amount" | "fee_internal">>): void {
  db.prepare("UPDATE api_exchanges SET external_amount = COALESCE(?, external_amount), internal_amount = COALESCE(?, internal_amount), fee_internal = COALESCE(?, fee_internal), updated_at = datetime('now') WHERE id = ?")
    .run(f.external_amount ?? null, f.internal_amount ?? null, f.fee_internal ?? null, id);
}

/** 両替リクエストを作成（pending_approval）。requestId を確定して返す。 */
export function createExchange(
  guildId: string, userId: string, direction: GilDirection, amount: number, memo?: string,
): { id: number; requestId: string } {
  const res = db.prepare(
    "INSERT INTO api_exchanges (guild_id, user_id, direction, amount, request_id, status, memo) VALUES (?, ?, ?, ?, 'pending', 'pending_approval', ?)",
  ).run(guildId, userId, direction, amount, memo ?? null);
  const id = Number(res.lastInsertRowid);
  const requestId = `casino-${id}`;
  db.prepare("UPDATE api_exchanges SET request_id = ? WHERE id = ?").run(requestId, id);
  return { id, requestId };
}

/** リクエストを実行する（承認後 or 即時）。 */
export async function executeExchange(id: number): Promise<ExecResult> {
  const row = getExchangeRow(id);
  if (!row) return { ok: false, code: "NOT_FOUND", message: "両替リクエストが見つからないよ。" };
  if (row.status === "done") return { ok: false, code: "ALREADY_DONE", message: "もう処理済みだよ。" };
  if (!isExchangeApiAvailable()) return { ok: false, code: "API_DISABLED", message: "両替APIが準備中だよ。" };

  if (row.direction === "internal_to_external") return runInflow(row);
  return runOutflow(row, /*alreadyDebited*/ row.status === "pending_commit");
}

// ─── 入庫: Gil → エテル ───────────────────────────────
async function runInflow(row: ApiExchangeRow): Promise<ExecResult> {
  setStatus(row.id, "pending_commit");
  const commit = await gilCommit({
    guildId: row.guild_id, userId: row.user_id, direction: "internal_to_external",
    amount: row.amount, requestId: row.request_id, memo: row.memo ?? "casino入庫(Gil→エテル)",
  });
  if (!commit.ok) {
    setStatus(row.id, "failed");
    return { ok: false, code: commit.code, message: commit.message };
  }
  const op = commit.data.operation;
  const ether = op.externalPayout ?? op.externalAmount ?? row.amount;
  setMeta(row.id, { internal_amount: op.internalAmount, external_amount: ether, fee_internal: op.feeInternal });

  // エテル付与と done を原子的に
  const credit = runTransaction<{ ok: boolean }>(() => {
    const r = adjustBalance(row.user_id, ether, "両替: 入庫(Gil→エテル)", "exchange", row.guild_id);
    if (!r.ok) return { ok: false };
    db.prepare("UPDATE api_exchanges SET status='done', ether_delta=?, updated_at=datetime('now') WHERE id=?").run(ether, row.id);
    return { ok: true };
  });
  if (!credit.ok) {
    // 付与失敗（上限など稀ケース）→ Gil を返金
    await gilCancel({ guildId: row.guild_id, requestId: row.request_id, reason: "casino側のエテル付与に失敗" });
    setStatus(row.id, "cancelled");
    return { ok: false, code: "CREDIT_FAILED", message: `エテルの付与に失敗したので、${WORLD.CURRENCY_1_NAME}を返金したよ。` };
  }
  return { ok: true, etherDelta: ether, op };
}

// ─── 出庫: エテル → ルクス（還光バーンあり） ───────────
//   徴収エテルのうち burn = floor(amount × RYUKO_RATE) を消滅させ、
//   net = amount − burn だけをルクス化する（Gil-bot commit の amount = net）。
//   burn/net は amount から決定論的に再計算できるので resume 時も安全。
async function runOutflow(row: ApiExchangeRow, alreadyDebited: boolean): Promise<ExecResult> {
  const burn = Math.floor(row.amount * RYUKO_RATE);
  const net = row.amount - burn;
  if (net <= 0) {
    setStatus(row.id, "failed");
    return { ok: false, code: "AMOUNT_TOO_SMALL", message: "額が小さすぎて、還光すると残らないよ。" };
  }

  if (!alreadyDebited) {
    // ①エテル徴収（net=ルクス化 / burn=消滅）＋ pending_commit を原子的に
    const debit = runTransaction<{ ok: boolean }>(() => {
      const r1 = adjustBalance(row.user_id, -net, "両替: 出庫(エテル→ルクス)", "exchange", row.guild_id);
      if (!r1.ok) return { ok: false };
      if (burn > 0) {
        const r2 = adjustBalance(row.user_id, -burn, "両替: 還光バーン", "exchange", row.guild_id);
        if (!r2.ok) {
          // net は引けたが burn が引けない（残高ちょうど）→ net を巻き戻して失敗
          adjustBalance(row.user_id, net, "両替: 出庫ロールバック", "exchange", row.guild_id);
          return { ok: false };
        }
      }
      db.prepare("UPDATE api_exchanges SET status='pending_commit', external_amount=?, fee_internal=?, updated_at=datetime('now') WHERE id=?").run(net, burn, row.id);
      return { ok: true };
    });
    if (!debit.ok) {
      setStatus(row.id, "failed");
      return { ok: false, code: "INSUFFICIENT_ETHER", message: "エテルの残高が足りないみたい。" };
    }
  }

  // ②commit → ルクス付与（net 分のみ）
  const commit = await gilCommit({
    guildId: row.guild_id, userId: row.user_id, direction: "external_to_internal",
    amount: net, requestId: row.request_id, memo: row.memo ?? "casino出庫(エテル→ルクス・還光後)",
  });
  if (!commit.ok) {
    // ③commit 失敗 → エテル全額（net+burn）返金
    runTransaction(() => {
      adjustBalance(row.user_id, net, "両替: 出庫失敗の返金", "exchange", row.guild_id);
      if (burn > 0) adjustBalance(row.user_id, burn, "両替: 還光バーン取消・返金", "exchange", row.guild_id);
      db.prepare("UPDATE api_exchanges SET status='failed', ether_delta=0, updated_at=datetime('now') WHERE id=?").run(row.id);
    });
    return { ok: false, code: commit.code, message: commit.message };
  }
  const op = commit.data.operation;
  db.prepare("UPDATE api_exchanges SET status='done', internal_amount=?, fee_internal=?, ether_delta=?, updated_at=datetime('now') WHERE id=?")
    .run(op.internalAmount ?? net, burn, -row.amount, row.id);
  return { ok: true, etherDelta: -row.amount, op };
}

/**
 * 起動時整合: 中断した両替（pending_commit）を回収する。
 *  - 入庫: commit 再試行（冪等）→ 付与/返金
 *  - 出庫: 既にエテル徴収済みなので **再徴収せず** commit 再試行のみ（冪等）
 */
export async function reconcileStaleExchangesOnStartup(): Promise<void> {
  if (!isExchangeApiAvailable()) return;
  const rows = db.prepare("SELECT * FROM api_exchanges WHERE status = 'pending_commit'").all() as ApiExchangeRow[];
  if (rows.length === 0) return;
  for (const row of rows) {
    try {
      if (row.direction === "internal_to_external") await runInflow(row);
      else await runOutflow(row, /*alreadyDebited*/ true);
    } catch (e) {
      console.warn(`[bootstrap] exchange reconcile failed id=${row.id}:`, e);
    }
  }
  console.log(`[bootstrap] reconciled ${rows.length} stale exchange(s)`);
}
