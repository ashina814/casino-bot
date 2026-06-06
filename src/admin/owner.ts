/**
 * /オーナー — Bot オーナー専用コマンド（dev/ops 系）
 * ─────────────────────────────────────────────────────────
 * /管理 はサーバー運営者（経済操作）、/オーナー は Bot 開発者の dev/ops。
 * オーナー判定は config.ownerId（無ければハードコード fallback）。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import * as fs from "node:fs";
import { db } from "../core/db";
import { baseEmbed, errorEmbed, COLORS } from "../ui/embeds";
import { config } from "../config";

const OWNER_ID_FALLBACK = "1436392582635847691";
function isOwner(userId: string): boolean {
  const owner = config.ownerId ?? OWNER_ID_FALLBACK;
  return userId === owner;
}

export const ownerCommand = new SlashCommandBuilder()
  .setName("オーナー")
  .setDescription("👑 Bot オーナー専用（dev/ops）")
  .addSubcommand((sc) =>
    sc.setName("状態").setDescription("📊 Bot 稼働・DB・guild の状態をひと目で見る"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("db")
      .setDescription("🔍 読み取り専用 SQL を実行（SELECT/PRAGMA/EXPLAIN）")
      .addStringOption((o) => o.setName("sql").setDescription("実行する SQL").setRequired(true).setMaxLength(900)),
  );

export async function handleOwnerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("オーナー専用コマンドだよ。")], ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "状態") return handleStatus(interaction);
  if (sub === "db") return handleDB(interaction);
}

// ─── 状態 ─────────────────────────────────────────
async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const fmtSec = (s: number) => {
    if (s < 60) return `${Math.floor(s)}秒`;
    if (s < 3600) return `${Math.floor(s / 60)}分${Math.floor(s % 60)}秒`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
    return `${Math.floor(s / 86400)}日${Math.floor((s % 86400) / 3600)}時間`;
  };

  // プロセス情報
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const nodeVer = process.version;

  // DB 統計
  const dbPath = "data/database.sqlite";
  let dbSize = 0;
  try { dbSize = fs.statSync(dbPath).size; } catch { /* ignore */ }

  type CountRow = { c: number };
  const safeCount = (sql: string): number => {
    try { return (db.prepare(sql).get() as CountRow).c; } catch { return 0; }
  };
  const tables: Array<{ name: string; count: number }> = [
    { name: "users", count: safeCount("SELECT COUNT(*) AS c FROM users") },
    { name: "transaction_logs", count: safeCount("SELECT COUNT(*) AS c FROM transaction_logs") },
    { name: "server_config", count: safeCount("SELECT COUNT(*) AS c FROM server_config") },
    { name: "pvp_matches", count: safeCount("SELECT COUNT(*) AS c FROM pvp_matches") },
    { name: "betting_markets", count: safeCount("SELECT COUNT(*) AS c FROM betting_markets") },
    { name: "chohan_games", count: safeCount("SELECT COUNT(*) AS c FROM chohan_games") },
    { name: "dice_duels", count: safeCount("SELECT COUNT(*) AS c FROM dice_duels") },
    { name: "bj_duels", count: safeCount("SELECT COUNT(*) AS c FROM bj_duels") },
    { name: "indian_duels", count: safeCount("SELECT COUNT(*) AS c FROM indian_duels") },
    { name: "poker_games", count: safeCount("SELECT COUNT(*) AS c FROM poker_games") },
    { name: "temp_voice_channels", count: safeCount("SELECT COUNT(*) AS c FROM temp_voice_channels") },
    { name: "decision_panels", count: safeCount("SELECT COUNT(*) AS c FROM decision_panels") },
  ];

  // Discord 状況
  const guildCount = interaction.client.guilds.cache.size;
  const totalMembers = interaction.client.guilds.cache.reduce((s, g) => s + (g.memberCount ?? 0), 0);
  const guildLines = Array.from(interaction.client.guilds.cache.values())
    .slice(0, 10)
    .map((g) => `・**${g.name}** (id:\`${g.id}\`) — ${g.memberCount ?? "?"}人`)
    .join("\n");

  // 最終取引時刻
  const lastTx = db.prepare("SELECT created_at FROM transaction_logs ORDER BY id DESC LIMIT 1").get() as { created_at: string } | undefined;

  const embed = baseEmbed("👑 Bot ステータス", COLORS.MAIN).addFields(
    {
      name: "🖥 プロセス",
      value: [
        `稼働時間: **${fmtSec(uptime)}**`,
        `Node: ${nodeVer}`,
        `PID: ${process.pid}`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "💾 メモリ",
      value: [
        `RSS: ${fmtMb(mem.rss)}`,
        `Heap使用: ${fmtMb(mem.heapUsed)} / ${fmtMb(mem.heapTotal)}`,
        `外部: ${fmtMb(mem.external)}`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "🗄 DB",
      value: [
        `ファイル: \`${dbPath}\``,
        `サイズ: **${fmtMb(dbSize)}**`,
        `最終取引: ${lastTx?.created_at ?? "—"}`,
      ].join("\n"),
      inline: false,
    },
    {
      name: "📑 テーブル行数",
      value: tables.map((t) => `\`${t.name.padEnd(20)}\` ${t.count.toLocaleString()}`).join("\n"),
      inline: false,
    },
    {
      name: `🌐 接続中 guild (${guildCount}個・${totalMembers}人合計)`,
      value: guildLines || "*（接続なし）*",
      inline: false,
    },
  );

  await interaction.editReply({ embeds: [embed] });
}

// ─── DB ──────────────────────────────────────────
async function handleDB(interaction: ChatInputCommandInteraction): Promise<void> {
  const sql = interaction.options.getString("sql", true).trim();
  // 読み取り専用ホワイトリスト（先頭キーワード）
  const head = sql.replace(/^\s*(--[^\n]*\n)*/g, "").trimStart().toUpperCase();
  const allowedPrefixes = ["SELECT", "PRAGMA", "EXPLAIN", "WITH"];
  const blockedKeywords = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|CREATE|ATTACH|DETACH|REINDEX|VACUUM|ANALYZE)\b/;

  if (!allowedPrefixes.some((p) => head.startsWith(p))) {
    await interaction.reply({ embeds: [errorEmbed(`SELECT/PRAGMA/EXPLAIN/WITH のみ実行可能だよ。先頭: \`${head.slice(0, 20)}…\``)], ephemeral: true });
    return;
  }
  if (blockedKeywords.test(head)) {
    await interaction.reply({ embeds: [errorEmbed("書き換え系キーワード（INSERT/UPDATE/DELETE/DROP/ALTER/REPLACE/CREATE/ATTACH/REINDEX/VACUUM/ANALYZE）は禁止だよ。")], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const start = Date.now();
    const stmt = db.prepare(sql);
    const rows = stmt.all() as Array<Record<string, unknown>>;
    const elapsed = Date.now() - start;

    if (rows.length === 0) {
      await interaction.editReply({ embeds: [baseEmbed("🔍 結果: 0 件", COLORS.GOLD).setDescription(`\`${elapsed}ms\``)] });
      return;
    }

    // 結果を整形（最大 50 行を embed、超過分は TSV 添付）
    const SHOW = 50;
    const head50 = rows.slice(0, SHOW);
    const cols = Object.keys(head50[0]);
    const tsv = [cols.join("\t"), ...rows.map((r) => cols.map((c) => String(r[c] ?? "")).join("\t"))].join("\n");

    const preview = head50
      .map((r) => cols.map((c) => `\`${String(r[c] ?? "").slice(0, 40)}\``).join(" "))
      .join("\n");

    const embed = baseEmbed(`🔍 結果: ${rows.length} 件（先頭${Math.min(SHOW, rows.length)}件表示）`, COLORS.GOLD)
      .setDescription([
        `\`${elapsed}ms\`　列: ${cols.join(", ")}`,
        "",
        preview.slice(0, 3500),
      ].join("\n"))
      .setFooter({ text: rows.length > SHOW ? `…他 ${rows.length - SHOW} 件は添付ファイルを見て` : "全件表示" });

    const files = rows.length > SHOW ? [new AttachmentBuilder(Buffer.from(tsv, "utf-8"), { name: `query_${Date.now()}.tsv` })] : [];
    await interaction.editReply({ embeds: [embed], files });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(`SQLエラー: ${(err as Error).message}`)] });
  }
}
