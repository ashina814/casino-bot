/**
 * DB の異常値（JS safe integer 超過）を検出し、レポートするスクリプト。
 * 使い方: npx ts-node src/scripts/inspect-corrupt.ts
 */
import Database from "better-sqlite3";
import { resolve } from "path";

const dbPath = resolve(process.cwd(), "data", "database.sqlite");
const db = new Database(dbPath);
db.defaultSafeIntegers(true);

const SAFE = 9007199254740991n;

console.log("=== users (異常値) ===");
type UserRow = {
  user_id: string;
  balance: bigint;
  total_wagered: bigint;
  total_earned: bigint;
  biggest_win: bigint;
};
const users = db.prepare("SELECT user_id, balance, total_wagered, total_earned, biggest_win FROM users").all() as UserRow[];
for (const u of users) {
  if (u.balance > SAFE || u.total_wagered > SAFE || u.total_earned > SAFE || u.biggest_win > SAFE) {
    console.log({
      user_id: u.user_id,
      balance: u.balance.toString(),
      total_wagered: u.total_wagered.toString(),
      total_earned: u.total_earned.toString(),
      biggest_win: u.biggest_win.toString(),
    });
  }
}

console.log("\n=== server_config (異常値) ===");
type CfgRow = { guild_id: string; jackpot_pool: bigint; relief_pool: bigint; balance_cap: bigint };
const cfgs = db.prepare("SELECT guild_id, jackpot_pool, relief_pool, balance_cap FROM server_config").all() as CfgRow[];
for (const c of cfgs) {
  if (c.jackpot_pool > SAFE || c.relief_pool > SAFE || c.balance_cap > SAFE) {
    console.log({
      guild_id: c.guild_id,
      jackpot_pool: c.jackpot_pool.toString(),
      relief_pool: c.relief_pool.toString(),
      balance_cap: c.balance_cap.toString(),
    });
  }
}

console.log("\n=== users 全件（参考、上位10件） ===");
const top = db.prepare("SELECT user_id, balance, total_wagered FROM users ORDER BY CAST(balance AS TEXT) DESC LIMIT 10").all() as Array<{ user_id: string; balance: bigint; total_wagered: bigint }>;
for (const u of top) console.log(u.user_id, u.balance.toString(), u.total_wagered.toString());

console.log("\n=== server_config 全件（参考） ===");
const allCfg = db.prepare("SELECT guild_id, balance_cap, jackpot_pool, relief_pool FROM server_config").all() as CfgRow[];
for (const c of allCfg) console.log(c.guild_id, "cap:", c.balance_cap.toString(), "jp:", c.jackpot_pool.toString(), "relief:", c.relief_pool.toString());

db.close();
