/**
 * 破損した数値（JS safe integer 超過）を妥当な範囲にクランプする一回限りの修復。
 *
 * 対象:
 * - users: balance / total_wagered / total_earned / biggest_win
 * - server_config: jackpot_pool / relief_pool / balance_cap
 *
 * 使い方: npx ts-node src/scripts/repair-corrupt.ts
 *
 * 修復ポリシー:
 * - balance は balance_cap でクランプ
 * - 累計（total_earned/total_wagered）は MAX_SAFE_INTEGER 未満で頭打ち
 * - biggest_win は balance_cap か total_earned の小さい方でクランプ
 * - pool は 0 にリセット（破損由来の偽値なので保持しない）
 */
import Database from "better-sqlite3";
import { resolve } from "path";

const dbPath = resolve(process.cwd(), "data", "database.sqlite");
const db = new Database(dbPath);
db.defaultSafeIntegers(true);

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const SANE_BIG_WIN_CAP = 10_000_000n; // 1千万を「実質的な最高勝利」上限と見なす

console.log("== users 修復 ==");
const users = db.prepare(
  "SELECT user_id, balance, total_wagered, total_earned, biggest_win FROM users"
).all() as Array<{
  user_id: string; balance: bigint; total_wagered: bigint; total_earned: bigint; biggest_win: bigint;
}>;
const updateUser = db.prepare(
  "UPDATE users SET balance = ?, total_wagered = ?, total_earned = ?, biggest_win = ? WHERE user_id = ?"
);
for (const u of users) {
  const dirty = u.balance > SAFE || u.total_wagered > SAFE || u.total_earned > SAFE || u.biggest_win > SAFE;
  if (!dirty) continue;
  const newBalance = u.balance > SAFE ? 300000n : u.balance;
  const newWagered = u.total_wagered > SAFE ? 0n : u.total_wagered;
  // total_earned は実態に近い値（balance + total_wagered 程度）にクランプ
  const sensibleEarned = newBalance + newWagered;
  const newEarned = u.total_earned > SAFE ? sensibleEarned : u.total_earned;
  const newBiggest = u.biggest_win > SAFE ? (newBalance < SANE_BIG_WIN_CAP ? newBalance : SANE_BIG_WIN_CAP) : u.biggest_win;
  console.log(`  ${u.user_id}: earned ${u.total_earned} -> ${newEarned}, biggest_win ${u.biggest_win} -> ${newBiggest}`);
  updateUser.run(
    Number(newBalance), Number(newWagered), Number(newEarned), Number(newBiggest), u.user_id
  );
}

console.log("\n== server_config 修復 ==");
const cfgs = db.prepare(
  "SELECT guild_id, jackpot_pool, relief_pool, balance_cap FROM server_config"
).all() as Array<{ guild_id: string; jackpot_pool: bigint; relief_pool: bigint; balance_cap: bigint }>;
const updateCfg = db.prepare(
  "UPDATE server_config SET jackpot_pool = ?, relief_pool = ?, balance_cap = ? WHERE guild_id = ?"
);
for (const c of cfgs) {
  const dirty = c.jackpot_pool > SAFE || c.relief_pool > SAFE || c.balance_cap > SAFE;
  if (!dirty) continue;
  // 破損プールは 0 にリセット（偽の値だから保持しても害）
  const newJp = c.jackpot_pool > SAFE ? 0n : c.jackpot_pool;
  const newRelief = c.relief_pool > SAFE ? 0n : c.relief_pool;
  const newCap = c.balance_cap > SAFE ? 300000n : c.balance_cap;
  console.log(`  ${c.guild_id}: jp ${c.jackpot_pool} -> ${newJp}, relief ${c.relief_pool} -> ${newRelief}`);
  updateCfg.run(Number(newJp), Number(newRelief), Number(newCap), c.guild_id);
}

console.log("\n== 完了 ==");
db.close();
