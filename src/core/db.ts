import fs from "node:fs";
import path from "node:path";
// @ts-ignore — node:sqlite is available in Node 22+ but lacks types
import { DatabaseSync } from "node:sqlite";
import { config } from "../config";

// ─── Types ─────────────────────────────────────────────

export type HorseStyle = "nige" | "senko" | "sashi" | "oikomi";

export type KeibaHorse = {
  id: number;
  name: string;
  base_speed: number;
  style: HorseStyle;
};

export type UserProfile = {
  user_id: string;
  /**
   * v2: カジノコイン（第二通貨）残高。
   * 既存の `balance` カラムをそのまま再解釈し、カジノコインとして扱う。
   * すべてのゲーム・福分け・商店はこのカラムで動作する。
   */
  balance: number;
  /**
   * v2 新規: 第一通貨残高。
   * サーバー全体経済の通貨。従業員給与（Iter.4）で初めて入る予定。
   * 両替（/両替）で出入りする。Iter.1 時点ではゼロのまま運用される想定。
   */
  currency1_balance: number;
  /**
   * v2 新規: 累計両替量（第一→第二）。換金マイル称号判定用。
   */
  exchange_in_total: number;
  /**
   * v2 新規: 累計両替量（第二→第一）。換金マイル称号判定用。
   */
  exchange_out_total: number;
  level: number;
  exp: number;
  tier: string;
  daily_streak: number;
  last_daily: string | null;
  total_wins: number;
  total_losses: number;
  total_wagered: number;
  total_earned: number;
  biggest_win: number;
  current_win_streak: number;
  current_lose_streak: number;
  best_win_streak: number;
  created_at: string;
};

/** v2: 両替方向 */
export type ExchangeDirection = "in" | "out"; // in = 第一→第二, out = 第二→第一

export type CurrencyExchange = {
  id: number;
  user_id: string;
  direction: ExchangeDirection;
  source_amount: number;   // 投入した側の額
  received_amount: number; // 受け取った側の額
  fee_amount: number;      // 奉納された額（第二通貨基準）
  rate: number;            // 適用された為替レート
  created_at: string;
};

export type ServerConfig = {
  guild_id: string;
  initial_balance: number;
  daily_base: number;
  daily_rich: number;
  bankruptcy_aid: number;
  balance_cap: number;
  house_edge_offset: number;
  min_bet: number;
  jackpot_pool: number;
  relief_pool: number;
  casino_channel_id: string | null;
  jackpot_channel_id: string | null;
  stock_channel_id: string | null;
  games_enabled: string;
  lucky_game: string | null;
  lucky_game_date: string | null;
  /**
   * v2 新規: 為替レート手動補正（管理者介入）。
   * 自動レート = 基準10.0 × (1 + 動的補正) + exchange_rate_offset。
   * 例: 暴落イベントで -2.0 を設定すると、コイン安に強制誘導される。
   */
  exchange_rate_offset: number;
  /** v2 Iter.2: 賭場の板の議題立て手数料 */
  board_fee: number;
  /** v2 為替: この額以上の両替は管理者承認を要する */
  exchange_threshold: number;
  /** v2 為替: 承認ボタンを流すチャンネル（未設定なら実行チャンネル） */
  exchange_approval_channel_id: string | null;
};

export type Title = {
  id: number;
  user_id: string;
  title_key: string;
  title_name: string;
  earned_at: string;
};

export type EasterEggProgress = {
  user_id: string;
  egg_key: string;
  progress: number;
  completed: number;
  last_triggered: string | null;
};

export type ExchangeLog = {
  id: number;
  admin_id: string;
  target_user_id: string;
  action: "mint" | "burn";
  amount: number;
  memo: string | null;
  created_at: string;
};

// ─── Seed Data ─────────────────────────────────────────

const HORSE_SEEDS: Array<Omit<KeibaHorse, "id">> = [
  { name: "サクラブレイズ", base_speed: 1.9, style: "nige" },
  { name: "ゴールドコメット", base_speed: 1.8, style: "senko" },
  { name: "ミッドナイトスター", base_speed: 1.75, style: "sashi" },
  { name: "ブルーサンダー", base_speed: 1.7, style: "oikomi" },
  { name: "クリムゾンレイン", base_speed: 1.85, style: "senko" },
  { name: "ホワイトアロー", base_speed: 1.82, style: "nige" },
  { name: "ノーブルリーフ", base_speed: 1.72, style: "sashi" },
  { name: "ヴェロシティキング", base_speed: 1.76, style: "oikomi" },
  { name: "ルミナスハート", base_speed: 1.81, style: "senko" },
  { name: "ナイトファルコン", base_speed: 1.74, style: "sashi" },
];

// ─── Database Init ─────────────────────────────────────

function ensureDataDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDataDirectory(config.dbPath);

export const db: any = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ─── Transaction Helper ────────────────────────────────
// node:sqlite has no .transaction() — manual BEGIN/COMMIT/ROLLBACK

let transactionDepth = 0;

export function runTransaction<T>(fn: () => T): T {
  transactionDepth++;
  const isTopLevel = transactionDepth === 1;
  const spName = `sp_${transactionDepth}`;

  if (isTopLevel) {
    db.exec("BEGIN");
  } else {
    db.exec(`SAVEPOINT ${spName}`);
  }

  try {
    const result = fn();
    if (isTopLevel) {
      db.exec("COMMIT");
    } else {
      db.exec(`RELEASE SAVEPOINT ${spName}`);
    }
    return result;
  } catch (err) {
    if (isTopLevel) {
      db.exec("ROLLBACK");
    } else {
      db.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
    }
    throw err;
  } finally {
    transactionDepth--;
  }
}

// ─── Schema ────────────────────────────────────────────

export function initializeDatabase(): void {
  db.exec(`
    -- ═══ Core: User Profiles ═══
    -- v2: balance = カジノコイン（第二通貨）残高
    --     currency1_balance = 第一通貨残高（Iter.4 で従業員給与から流入予定）
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 3000 CHECK(balance >= 0),
      currency1_balance INTEGER NOT NULL DEFAULT 0 CHECK(currency1_balance >= 0),
      exchange_in_total INTEGER NOT NULL DEFAULT 0,
      exchange_out_total INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      exp INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'human',
      daily_streak INTEGER NOT NULL DEFAULT 0,
      last_daily TEXT,
      total_wins INTEGER NOT NULL DEFAULT 0,
      total_losses INTEGER NOT NULL DEFAULT 0,
      total_wagered INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      biggest_win INTEGER NOT NULL DEFAULT 0,
      current_win_streak INTEGER NOT NULL DEFAULT 0,
      current_lose_streak INTEGER NOT NULL DEFAULT 0,
      best_win_streak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ Core: Transaction Logs ═══
    -- v2: currency カラムで通貨を区別（'currency2' = カジノコイン、'currency1' = 第一通貨）
    CREATE TABLE IF NOT EXISTS transaction_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      game TEXT,
      currency TEXT NOT NULL DEFAULT 'currency2' CHECK(currency IN ('currency1', 'currency2')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ Core: Server Config (per-guild settings) ═══
    CREATE TABLE IF NOT EXISTS server_config (
      guild_id TEXT PRIMARY KEY,
      initial_balance INTEGER NOT NULL DEFAULT 3000,
      daily_base INTEGER NOT NULL DEFAULT 300,
      daily_rich INTEGER NOT NULL DEFAULT 100,
      bankruptcy_aid INTEGER NOT NULL DEFAULT 500,
      balance_cap INTEGER NOT NULL DEFAULT 300000,
      house_edge_offset REAL NOT NULL DEFAULT 0,
      min_bet INTEGER NOT NULL DEFAULT 50,
      jackpot_pool INTEGER NOT NULL DEFAULT 0,
      relief_pool INTEGER NOT NULL DEFAULT 0,
      casino_channel_id TEXT,
      jackpot_channel_id TEXT,
      stock_channel_id TEXT,
      games_enabled TEXT NOT NULL DEFAULT '{"slots":true,"blackjack":true,"crash":true,"highlow":true,"roulette":true,"keiba":true,"stocks":true}',
      lucky_game TEXT,
      lucky_game_date TEXT,
      exchange_rate_offset REAL NOT NULL DEFAULT 0.0
    );

    -- ═══ v2: Currency Exchange Log ═══
    -- プレイヤーの両替履歴。exchange_logs（管理者 mint/burn）とは別。
    CREATE TABLE IF NOT EXISTS currency_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      source_amount INTEGER NOT NULL CHECK(source_amount > 0),
      received_amount INTEGER NOT NULL CHECK(received_amount >= 0),
      fee_amount INTEGER NOT NULL DEFAULT 0,
      rate REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ Progression: Titles (二つ名) ═══
    CREATE TABLE IF NOT EXISTS titles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title_key TEXT NOT NULL,
      title_name TEXT NOT NULL,
      earned_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, title_key)
    );

    -- ═══ Active title selection ═══
    CREATE TABLE IF NOT EXISTS active_titles (
      user_id TEXT PRIMARY KEY,
      title_key TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS affection (
      user_id TEXT PRIMARY KEY,
      level INTEGER DEFAULT 0,
      stage INTEGER DEFAULT 0,
      mode TEXT DEFAULT 'default',
      element TEXT,
      element_change_used INTEGER DEFAULT 0,
      last_decay_date TEXT,
      daily_game_plays INTEGER DEFAULT 0,
      daily_tip_count INTEGER DEFAULT 0,
      daily_counter_date TEXT
    );

    -- ═══ Easter Egg Progress ═══
    CREATE TABLE IF NOT EXISTS easter_egg_progress (
      user_id TEXT NOT NULL,
      egg_key TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      last_triggered TEXT,
      PRIMARY KEY(user_id, egg_key)
    );

    -- ═══ Exchange Logs (mint/burn for 為替) ═══
    CREATE TABLE IF NOT EXISTS exchange_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('mint', 'burn', 'refund')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      memo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ Rate Memos (為替レート記録) ═══
    CREATE TABLE IF NOT EXISTS rate_memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id TEXT NOT NULL,
      memo TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ Keiba: System Status ═══
    CREATE TABLE IF NOT EXISTS system_status (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      is_racing INTEGER NOT NULL DEFAULT 0,
      keiba_carryover_win INTEGER NOT NULL DEFAULT 0,
      keiba_carryover_place INTEGER NOT NULL DEFAULT 0
    );

    -- ═══ Keiba: Horses ═══
    CREATE TABLE IF NOT EXISTS keiba_horses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      base_speed REAL NOT NULL,
      style TEXT NOT NULL CHECK(style IN ('nige', 'senko', 'sashi', 'oikomi'))
    );

    -- ═══ Keiba: Bets ═══
    CREATE TABLE IF NOT EXISTS keiba_bets (
      user_id TEXT NOT NULL,
      horse_id INTEGER NOT NULL,
      bet_type TEXT NOT NULL CHECK(bet_type IN ('win', 'place')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      PRIMARY KEY(user_id, bet_type),
      FOREIGN KEY(horse_id) REFERENCES keiba_horses(id) ON DELETE CASCADE
    );

    -- ═══ Game: Session locks (prevent double-play) ═══
    CREATE TABLE IF NOT EXISTS game_sessions (
      user_id TEXT PRIMARY KEY,
      game TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ Quest System: 受領記録 ═══
    -- period: daily="YYYY-MM-DD", weekly="YYYY-Www", event="event_key" の汎用文字列
    CREATE TABLE IF NOT EXISTS quest_claims (
      user_id TEXT NOT NULL,
      quest_key TEXT NOT NULL,
      period TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, quest_key, period)
    );

    -- ═══ v2 Iter.2: 賭場の板（公開市場） ═══
    CREATE TABLE IF NOT EXISTS betting_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      options TEXT NOT NULL,                 -- JSON string[]
      payout_mode TEXT NOT NULL CHECK(payout_mode IN ('parimutuel','winner_take_all')),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','closed','reported','settled','disputed','void')),
      deadline TEXT,
      result_option INTEGER,
      channel_id TEXT,
      message_id TEXT,
      thread_id TEXT,
      fee INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS market_bets (
      market_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (market_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS market_approvals (
      market_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      vote TEXT NOT NULL CHECK(vote IN ('approve','dispute')),
      PRIMARY KEY (market_id, user_id)
    );

    -- ═══ v2 Iter.2: サシ星約（1v1 PvP） ═══
    CREATE TABLE IF NOT EXISTS pvp_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      challenger_id TEXT NOT NULL,
      opponent_id TEXT NOT NULL,
      title TEXT,
      stake INTEGER NOT NULL CHECK(stake > 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','active','reported','settled','disputed','declined','void')),
      reported_winner_id TEXT,
      reported_by TEXT,
      channel_id TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ v2: 為替API連携（Gil-bot）操作ログ ═══
    -- direction: 'internal_to_external'(入庫 Gil→エテル) / 'external_to_internal'(出庫 エテル→Gil)
    -- status: pending_approval / pending_commit / pending_credit / done / failed / cancelled
    CREATE TABLE IF NOT EXISTS api_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      external_amount INTEGER,
      internal_amount INTEGER,
      fee_internal INTEGER,
      ether_delta INTEGER,
      memo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ v2: 使い切り景品 在庫 & 装備中効果 ═══
    CREATE TABLE IF NOT EXISTS consumable_items (
      user_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      PRIMARY KEY (user_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS active_effects (
      user_id TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      armed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, effect_key)
    );

    -- ═══ v2 §7.4: 卓を立てる（複製VC） ═══
    -- パネルから生成した一時VCを追跡。最後の1人退出 or 空のまま放置で自動削除。
    CREATE TABLE IF NOT EXISTS temp_voice_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      table_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── Migration: exchange_logs CHECK 制約に 'refund' を許可 ──────
  // 既存DBで CHECK(action IN ('mint','burn')) のままだと /管理 返金 が SQL エラーになる。
  // CHECK 制約は ALTER できないため、テーブルを作り直してデータを移行する。
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='exchange_logs'").get() as { sql: string } | undefined;
    if (row && row.sql && !row.sql.includes("'refund'")) {
      db.exec(`
        BEGIN;
        CREATE TABLE exchange_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id TEXT NOT NULL,
          target_user_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('mint', 'burn', 'refund')),
          amount INTEGER NOT NULL CHECK(amount > 0),
          memo TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO exchange_logs_new (id, admin_id, target_user_id, action, amount, memo, created_at)
          SELECT id, admin_id, target_user_id, action, amount, memo, created_at FROM exchange_logs;
        DROP TABLE exchange_logs;
        ALTER TABLE exchange_logs_new RENAME TO exchange_logs;
        COMMIT;
      `);
      console.log("[migrate] exchange_logs: CHECK 制約を ('mint','burn','refund') に拡張");
    }
  } catch (e) {
    console.warn("[migrate] exchange_logs migration failed:", e);
  }

  // Seed system_status
  db.prepare(
    `INSERT INTO system_status (id, is_racing, keiba_carryover_win, keiba_carryover_place)
     VALUES (1, 0, 0, 0)
     ON CONFLICT(id) DO NOTHING`
  ).run();

  // Seed horses
  const horseCount = db.prepare("SELECT COUNT(*) as count FROM keiba_horses").get() as { count: number };
  if (horseCount.count === 0) {
    const insertHorse = db.prepare(
      "INSERT INTO keiba_horses (name, base_speed, style) VALUES (?, ?, ?)"
    );
    for (const horse of HORSE_SEEDS) {
      insertHorse.run(horse.name, horse.base_speed, horse.style);
    }
  }

  // ─── Migration: affection table columns ──────────────
  const migrationCols = [
    { name: "stage", sql: "ALTER TABLE affection ADD COLUMN stage INTEGER DEFAULT 0" },
    { name: "mode", sql: "ALTER TABLE affection ADD COLUMN mode TEXT DEFAULT 'default'" },
    { name: "last_decay_date", sql: "ALTER TABLE affection ADD COLUMN last_decay_date TEXT" },
    { name: "daily_game_plays", sql: "ALTER TABLE affection ADD COLUMN daily_game_plays INTEGER DEFAULT 0" },
    { name: "daily_tip_count", sql: "ALTER TABLE affection ADD COLUMN daily_tip_count INTEGER DEFAULT 0" },
    { name: "daily_counter_date", sql: "ALTER TABLE affection ADD COLUMN daily_counter_date TEXT" },
    { name: "element", sql: "ALTER TABLE affection ADD COLUMN element TEXT" },
    { name: "element_change_used", sql: "ALTER TABLE affection ADD COLUMN element_change_used INTEGER DEFAULT 0" },
  ];
  for (const col of migrationCols) {
    try {
      db.exec(col.sql);
    } catch {
      // Column already exists — ignore
    }
  }

  // ─── v2 Migration: users / transaction_logs / server_config ──
  // 既存DBに対する追加カラム（空振り許容）。
  const v2MigrationCols = [
    "ALTER TABLE users ADD COLUMN currency1_balance INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN exchange_in_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN exchange_out_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaction_logs ADD COLUMN currency TEXT NOT NULL DEFAULT 'currency2'",
    "ALTER TABLE server_config ADD COLUMN exchange_rate_offset REAL NOT NULL DEFAULT 0.0",
    "ALTER TABLE server_config ADD COLUMN board_fee INTEGER NOT NULL DEFAULT 500",
    "ALTER TABLE server_config ADD COLUMN exchange_threshold INTEGER NOT NULL DEFAULT 50000",
    "ALTER TABLE server_config ADD COLUMN exchange_approval_channel_id TEXT",
  ];
  for (const sql of v2MigrationCols) {
    try { db.exec(sql); } catch { /* column exists */ }
  }
}

// ─── Server Config Helpers ─────────────────────────────

export function getServerConfig(guildId: string): ServerConfig {
  let cfg = db.prepare("SELECT * FROM server_config WHERE guild_id = ?").get(guildId) as ServerConfig | undefined;
  if (!cfg) {
    db.prepare("INSERT INTO server_config (guild_id) VALUES (?)").run(guildId);
    cfg = db.prepare("SELECT * FROM server_config WHERE guild_id = ?").get(guildId) as ServerConfig;
  }
  return cfg;
}

export function updateServerConfig(guildId: string, updates: Partial<Omit<ServerConfig, "guild_id">>): void {
  getServerConfig(guildId); // ensure exists
  const allowed = [
    "initial_balance", "daily_base", "daily_rich", "bankruptcy_aid",
    "balance_cap", "house_edge_offset", "min_bet", "jackpot_pool", "relief_pool",
    "casino_channel_id", "jackpot_channel_id", "stock_channel_id",
    "games_enabled", "lucky_game", "lucky_game_date",
    "exchange_rate_offset", "board_fee",
    "exchange_threshold", "exchange_approval_channel_id",
  ] as const;

  for (const key of allowed) {
    if (key in updates && updates[key] !== undefined) {
      db.prepare(`UPDATE server_config SET ${key} = ? WHERE guild_id = ?`).run(updates[key], guildId);
    }
  }
}

// ─── System Status (keiba compat) ──────────────────────

export function getSystemStatus(): {
  is_racing: number;
  keiba_carryover_win: number;
  keiba_carryover_place: number;
} {
  return db
    .prepare(
      "SELECT is_racing, keiba_carryover_win, keiba_carryover_place FROM system_status WHERE id = 1"
    )
    .get() as {
    is_racing: number;
    keiba_carryover_win: number;
    keiba_carryover_place: number;
  };
}

export function updateSystemStatus(
  payload: Partial<{ is_racing: number; keiba_carryover_win: number; keiba_carryover_place: number }>
): void {
  const current = getSystemStatus();
  db.prepare(
    `UPDATE system_status
     SET is_racing = ?, keiba_carryover_win = ?, keiba_carryover_place = ?
     WHERE id = 1`
  ).run(
    payload.is_racing ?? current.is_racing,
    payload.keiba_carryover_win ?? current.keiba_carryover_win,
    payload.keiba_carryover_place ?? current.keiba_carryover_place
  );
}

export function tryAcquireRaceLock(): boolean {
  const result = db
    .prepare(
      `UPDATE system_status
       SET is_racing = 1
       WHERE id = 1 AND is_racing = 0`
    )
    .run();
  return result.changes === 1;
}

export function releaseRaceLock(): void {
  db.prepare("UPDATE system_status SET is_racing = 0 WHERE id = 1").run();
}

export function getRandomRaceHorses(min: number, max: number): KeibaHorse[] {
  const count = Math.floor(Math.random() * (max - min + 1)) + min;
  const horses = db.prepare("SELECT id, name, base_speed, style FROM keiba_horses ORDER BY RANDOM() LIMIT ?").all(count) as KeibaHorse[];
  return horses;
}

// ─── Game Session Lock ─────────────────────────────────

export function acquireGameLock(userId: string, game: string): boolean {
  try {
    db.prepare("INSERT INTO game_sessions (user_id, game) VALUES (?, ?)").run(userId, game);
    return true;
  } catch {
    return false;
  }
}

export function releaseGameLock(userId: string): void {
  db.prepare("DELETE FROM game_sessions WHERE user_id = ?").run(userId);
}

export function getGameLock(userId: string): string | null {
  const row = db.prepare("SELECT game FROM game_sessions WHERE user_id = ?").get(userId) as { game: string } | undefined;
  return row?.game ?? null;
}

// ─── Stale session cleanup (5 min timeout) ─────────────

export function cleanStaleSessions(): number {
  const result = db.prepare(
    "DELETE FROM game_sessions WHERE datetime(started_at, '+5 minutes') < datetime('now')"
  ).run();
  return result.changes;
}

// ─── Affection (Bond) ────────────────────────────────────

export type AffectionRow = {
  user_id: string;
  level: number;
  stage: number;
  mode: string;
  element: string | null;
  element_change_used: number;
  last_decay_date: string | null;
  daily_game_plays: number;
  daily_tip_count: number;
  daily_counter_date: string | null;
};

function ensureAffection(userId: string): AffectionRow {
  let row = db.prepare("SELECT * FROM affection WHERE user_id = ?").get(userId) as AffectionRow | undefined;
  if (!row) {
    db.prepare("INSERT INTO affection (user_id, level) VALUES (?, 0)").run(userId);
    row = db.prepare("SELECT * FROM affection WHERE user_id = ?").get(userId) as AffectionRow;
  }
  return row;
}

export function getAffection(userId: string): number {
  const row = db.prepare("SELECT level FROM affection WHERE user_id = ?").get(userId) as { level: number } | undefined;
  return row ? row.level : 0;
}

export function getAffectionFull(userId: string): AffectionRow {
  return ensureAffection(userId);
}

export function addAffection(userId: string, amount: number): number {
  ensureAffection(userId);
  db.prepare(`
    UPDATE affection SET level = MAX(0, level + ?) WHERE user_id = ?
  `).run(amount, userId);
  const newLevel = getAffection(userId);

  // Update cached stage
  const { getStage } = require("./zashikiStage");
  const stage = getStage(newLevel);
  db.prepare("UPDATE affection SET stage = ? WHERE user_id = ?").run(stage.level, userId);

  return newLevel;
}

export function setAffectionMode(userId: string, mode: string): void {
  ensureAffection(userId);
  db.prepare("UPDATE affection SET mode = ? WHERE user_id = ?").run(mode, userId);
}

export function getAffectionMode(userId: string): string {
  const row = ensureAffection(userId);
  return row.mode || "default";
}

/**
 * 日次の好感度減衰を適用する。
 * 1日1回だけ実行される（last_decay_dateで制御）。
 * 戻り値: 減衰が発生したか
 */
export function applyDailyDecay(userId: string): boolean {
  const row = ensureAffection(userId);
  const today = new Date().toISOString().slice(0, 10);
  if (row.last_decay_date === today) return false;

  const { calculateDecay } = require("./zashikiStage");
  const decay = calculateDecay(row.level);

  if (decay > 0) {
    db.prepare(`
      UPDATE affection SET level = MAX(0, level - ?), last_decay_date = ? WHERE user_id = ?
    `).run(decay, today, userId);
  } else {
    db.prepare("UPDATE affection SET last_decay_date = ? WHERE user_id = ?").run(today, userId);
  }

  // Update cached stage
  const newLevel = getAffection(userId);
  const { getStage } = require("./zashikiStage");
  const stage = getStage(newLevel);
  db.prepare("UPDATE affection SET stage = ? WHERE user_id = ?").run(stage.level, userId);

  return decay > 0;
}

/**
 * ゲームプレイによる好感度加算（1日10回まで）
 * 戻り値: 実際に加算されたか
 */
export function addGamePlayAffection(userId: string): boolean {
  const row = ensureAffection(userId);
  const today = new Date().toISOString().slice(0, 10);

  // 日付が変わったらカウンターリセット
  if (row.daily_counter_date !== today) {
    db.prepare("UPDATE affection SET daily_game_plays = 0, daily_tip_count = 0, daily_counter_date = ? WHERE user_id = ?").run(today, userId);
  }

  const current = row.daily_counter_date === today ? row.daily_game_plays : 0;
  if (current >= 10) return false;

  db.prepare("UPDATE affection SET daily_game_plays = daily_game_plays + 1 WHERE user_id = ?").run(userId);
  // +0.5 per game, but stored as integer → add 1 every 2 games
  if ((current + 1) % 2 === 0) {
    addAffection(userId, 1);
  }
  return true;
}

/**
 * tip による好感度加算（1日3回まで）
 * 戻り値: 実際に加算されたか
 */
export function addTipAffection(userId: string): boolean {
  const row = ensureAffection(userId);
  const today = new Date().toISOString().slice(0, 10);

  if (row.daily_counter_date !== today) {
    db.prepare("UPDATE affection SET daily_game_plays = 0, daily_tip_count = 0, daily_counter_date = ? WHERE user_id = ?").run(today, userId);
  }

  const current = row.daily_counter_date === today ? row.daily_tip_count : 0;
  if (current >= 3) return false;

  db.prepare("UPDATE affection SET daily_tip_count = daily_tip_count + 1 WHERE user_id = ?").run(userId);
  addAffection(userId, 2);
  return true;
}

// ─── Element (五行属性) ──────────────────────────────────

export function getElement(userId: string): string | null {
  const row = ensureAffection(userId);
  return row.element;
}

export function setElement(userId: string, element: string): void {
  ensureAffection(userId);
  db.prepare("UPDATE affection SET element = ? WHERE user_id = ?").run(element, userId);
}

/**
 * 属性変更が可能かチェック（1回だけ変更可能）
 */
export function canChangeElement(userId: string): boolean {
  const row = ensureAffection(userId);
  return row.element_change_used === 0 && row.element != null;
}

/**
 * 属性変更を実行（1回限りフラグを立てる）
 */
export function changeElement(userId: string, newElement: string): boolean {
  const row = ensureAffection(userId);
  if (row.element_change_used !== 0) return false;
  if (row.element == null) return false;
  db.prepare("UPDATE affection SET element = ?, element_change_used = 1 WHERE user_id = ?")
    .run(newElement, userId);
  return true;
}

/**
 * 属性が未設定かつ覚醒段階3以上かを判定する。
 * trueなら属性選択UIを表示すべき。
 */
export function needsElementChoice(userId: string): boolean {
  const row = ensureAffection(userId);
  if (row.element != null) return false;
  const { getStage } = require("./zashikiStage");
  const stage = getStage(row.level);
  return stage.level >= 3;
}
