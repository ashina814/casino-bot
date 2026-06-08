/**
 * GilBeinBOT ASTERIA 両替API クライアント
 * ─────────────────────────────────────────────────────────
 * 第一通貨「Gil」は Gil-bot が管理。casino-bot はこの HTTP API 経由で
 * 残高確認 / 見積もり / 両替実行(commit) / 取消(cancel) を行う。
 *
 * direction（Gil-bot 視点: 内部=Gil / 外部=エテル）:
 *   external_to_internal = エテル→Gil（casino がエテル徴収 → Gil-bot が Gil 付与）
 *   internal_to_external = Gil→エテル（Gil-bot が Gil 減算 → externalPayout → casino がエテル付与）
 *
 * 認証: X-API-Key ヘッダ。env: EXCHANGE_API_BASE_URL / EXCHANGE_API_KEY。
 * 未設定なら available()=false で /両替 は「準備中」応答にする。
 */

export type GilDirection = "external_to_internal" | "internal_to_external";

export type GilOperation = {
  requestId: string;
  status: string; // "committed" など
  direction: GilDirection;
  externalAmount?: number;
  internalAmount?: number;
  feeInternal?: number;
  balanceAfter?: number;
  externalPayout?: number;
};

export type GilOk<T> = { ok: true; data: T };
export type GilErr = { ok: false; code: string; message: string; httpStatus?: number };
export type GilResult<T> = GilOk<T> | GilErr;

const BASE_URL = (process.env.EXCHANGE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.EXCHANGE_API_KEY ?? "";
const TIMEOUT_MS = 10_000;

/** API 連携が有効か（env が揃っているか） */
export function isExchangeApiAvailable(): boolean {
  return BASE_URL !== "" && API_KEY !== "";
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<GilResult<T>> {
  if (!isExchangeApiAvailable()) {
    return { ok: false, code: "API_DISABLED", message: "両替APIが設定されていません。" };
  }
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": API_KEY,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let json: any = null;
    try { json = await res.json(); } catch { /* 非JSON応答 */ }

    if (!res.ok) {
      const code = json?.error?.code ?? `HTTP_${res.status}`;
      const message = json?.error?.message ?? `APIエラー (HTTP ${res.status})`;
      return { ok: false, code, message, httpStatus: res.status };
    }
    if (json && json.ok === false) {
      return { ok: false, code: json.error?.code ?? "UNKNOWN", message: json.error?.message ?? "APIエラー", httpStatus: res.status };
    }
    return { ok: true, data: (json ?? {}) as T };
  } catch (err: any) {
    const aborted = err?.name === "AbortError";
    return { ok: false, code: aborted ? "TIMEOUT" : "NETWORK_ERROR", message: aborted ? "APIがタイムアウトしたよ。" : "APIに繋がらなかったよ。" };
  } finally {
    clearTimeout(timer);
  }
}

// ─── エンドポイント ───────────────────────────────────

export async function gilHealth(): Promise<GilResult<{ ok?: boolean }>> {
  return request("GET", "/api/v1/health");
}

export async function gilBalance(guildId: string, userId: string): Promise<GilResult<{ balance: number }>> {
  const qs = `?guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}`;
  return request("GET", `/api/v1/balance${qs}`);
}

export type QuoteReq = { guildId: string; userId: string; direction: GilDirection; amount: number };
export async function gilQuote(req: QuoteReq): Promise<GilResult<{ operation: GilOperation }>> {
  return request("POST", "/api/v1/exchange/quote", req);
}

export type CommitReq = { guildId: string; userId: string; direction: GilDirection; amount: number; requestId: string; memo?: string };
export async function gilCommit(req: CommitReq): Promise<GilResult<{ operation: GilOperation }>> {
  return request("POST", "/api/v1/exchange/commit", req);
}

export type CancelReq = { guildId: string; requestId: string; reason?: string; reverse?: boolean };
export async function gilCancel(req: CancelReq): Promise<GilResult<{ operation?: GilOperation }>> {
  return request("POST", "/api/v1/exchange/cancel", req);
}

export async function gilTransactions(guildId: string, limit = 100): Promise<GilResult<{ transactions: any[] }>> {
  const qs = `?guildId=${encodeURIComponent(guildId)}&limit=${limit}`;
  return request("GET", `/api/v1/exchange/transactions${qs}`);
}
