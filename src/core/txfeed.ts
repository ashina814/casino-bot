/**
 * 通貨ログのライブフィード — transaction_logs への INSERT を購読してチャットに流す。
 * ─────────────────────────────────────────────────────────
 *  - core/bank.ts が emitTxEvent() を呼ぶ
 *  - src/index.ts が setTxFeedHandler() で受信側を登録（discord.js を core に持ち込まないため）
 *  - 設定: server_config.tx_feed_channel_id（/管理 設定 → ログ設定 で登録）
 */

export type TxEvent = {
  userId: string;
  amount: number;
  reason: string;
  game: string | null;
  guildId: string | null;
  currency: "currency1" | "currency2";
};

let handler: ((e: TxEvent) => void) | null = null;

export function setTxFeedHandler(fn: ((e: TxEvent) => void) | null): void {
  handler = fn;
}

export function emitTxEvent(e: TxEvent): void {
  if (!handler) return;
  try {
    handler(e);
  } catch (err) {
    // フィード処理は本筋の取引には影響させない
    console.warn("[txfeed] handler failed:", err);
  }
}
