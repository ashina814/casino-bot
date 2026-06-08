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
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import * as fs from "node:fs";
import { db, getServerConfig, runTransaction } from "../core/db";
import { adjustBalance } from "../core/bank";
import { baseEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";
import { PALETTE } from "../world.config";
import { config } from "../config";

const OWNER_ID_FALLBACK = "1436392582635847691";
function isOwner(userId: string): boolean {
  const owner = config.ownerId ?? OWNER_ID_FALLBACK;
  return userId === owner;
}

export const ownerCommand = new SlashCommandBuilder()
  .setName("オーナー")
  .setDescription("👑 Bot オーナー専用（dev/ops）")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sc) =>
    sc.setName("状態").setDescription("📊 Bot 稼働・DB・guild の状態をひと目で見る"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("db")
      .setDescription("🔍 読み取り専用 SQL を実行（SELECT/PRAGMA/EXPLAIN）")
      .addStringOption((o) => o.setName("sql").setDescription("実行する SQL").setRequired(true).setMaxLength(900)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("流星群")
      .setDescription("🌠 直近24h アクティブな全プレイヤーに少額をランダム配布")
      .addIntegerOption((o) => o.setName("基本額").setDescription("中央値（既定 200・±50%でばらつく）").setRequired(false).setMinValue(10).setMaxValue(10000)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("jp放出")
      .setDescription("💸 JPプールを 直近24h アクティブから抽選で N人に山分け")
      .addIntegerOption((o) => o.setName("人数").setDescription("当選者数（既定 3）").setRequired(false).setMinValue(1).setMaxValue(20))
      .addIntegerOption((o) => o.setName("放出率").setDescription("放出する割合%（既定 50・1〜100）").setRequired(false).setMinValue(1).setMaxValue(100)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("jp削除")
      .setDescription("🗑️ JPプールから配布せず純粋に削る（誤発行修正用）")
      .addIntegerOption((o) => o.setName("金額").setDescription("削る額（◈）").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("jp強制清算")
      .setDescription("🔥 JPバーン清算を即発火（閾値・確率を無視）"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("アステル")
      .setDescription("✦ アステル口調で任意のセリフを投稿")
      .addStringOption((o) => o.setName("セリフ").setDescription("発言内容").setRequired(true).setMaxLength(1500)),
  );

export async function handleOwnerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("オーナー専用コマンドだよ。")], ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "状態") return handleStatus(interaction);
  if (sub === "db") return handleDB(interaction);
  if (sub === "流星群") return handleMeteor(interaction);
  if (sub === "jp放出") return handleJPRelease(interaction);
  if (sub === "jp削除") return handleJPDelete(interaction);
  if (sub === "jp強制清算") return handleJPForceBurn(interaction);
  if (sub === "アステル") return handleAstelSay(interaction);
}

// ─── JP 削除（純粋に消す・配布なし） ─────────────────
async function handleJPDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ embeds: [errorEmbed("サーバー内でのみ使えるよ。")], ephemeral: true });
    return;
  }
  const amount = interaction.options.getInteger("金額", true);
  const { pureBurnJackpot } = require("../core/jackpotBurn");
  const { burned, remaining } = pureBurnJackpot(guildId, amount);
  if (burned <= 0) {
    await interaction.reply({ embeds: [errorEmbed(`削れなかった（プール floor 到達 or 0）。現在: ◈${remaining.toLocaleString()}`)], ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [successEmbed(`🗑️ JP プールから **◈${burned.toLocaleString()}** を削除しました。\n残: ◈${remaining.toLocaleString()}`)],
    ephemeral: true,
  });
}

// ─── JP 強制清算（バーンを即発火） ─────────────────
async function handleJPForceBurn(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ embeds: [errorEmbed("サーバー内でのみ使えるよ。")], ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const cfg = getServerConfig(guildId);
  const { fireBurn } = require("../core/jackpotBurn");
  const result = await fireBurn(interaction.client, guildId, cfg.jackpot_channel_id ?? null);
  if (!result) {
    await interaction.editReply({ embeds: [errorEmbed("発火しなかった（候補なし or プール不足）。")] });
    return;
  }
  await interaction.editReply({
    embeds: [successEmbed(`🔥 バーン清算を発火しました。\n放出: ◈${result.released.toLocaleString()} / 当選 ${result.winners.length}名`)],
  });
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

// ─── 🌠 流星群（直近24h アクティブに少額バラ撒き） ──────
async function handleMeteor(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ embeds: [errorEmbed("サーバー内でのみ使えるよ。")], ephemeral: true }); return; }
  await interaction.deferReply({ ephemeral: true });

  const base = interaction.options.getInteger("基本額") ?? 200;
  // 直近24h でゲーム関連の取引があったユーザー
  const users = db.prepare(
    `SELECT DISTINCT user_id FROM transaction_logs
     WHERE created_at >= datetime('now', '-1 day') AND game IS NOT NULL`,
  ).all() as Array<{ user_id: string }>;

  if (users.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed("直近24h にアクティブなプレイヤーがいないみたい。")] });
    return;
  }

  let totalGranted = 0;
  const grants: Array<{ user_id: string; amount: number }> = [];
  runTransaction(() => {
    for (const u of users) {
      // base ±50% で乱数
      const amount = Math.max(1, Math.floor(base * (0.5 + Math.random())));
      adjustBalance(u.user_id, amount, "流星群: オーナー発火", "owner_event", guildId);
      grants.push({ user_id: u.user_id, amount });
      totalGranted += amount;
    }
  });

  // 公開アナウンス（実行チャンネルに投稿）
  const ch = interaction.channel;
  if (ch && "send" in ch) {
    const top3 = [...grants].sort((a, b) => b.amount - a.amount).slice(0, 3);
    const announce = baseEmbed("🌠 流星群が降ってきた", PALETTE.STARGOLD).setDescription([
      "*「ほら、見て。今夜は星が降ってる。」*",
      "*「みんなに、ひとかけらずつ。」*",
      "",
      `🌟 **${users.length}人** に総額 **◈${totalGranted.toLocaleString()}** を授けたよ。`,
      "",
      "🥇 最大の幸運:",
      ...top3.map((g, i) => `${["🥇", "🥈", "🥉"][i]} <@${g.user_id}>: ◈${g.amount.toLocaleString()}`),
    ].join("\n"));
    await (ch as any).send({
      embeds: [announce],
      allowedMentions: { users: top3.map((g) => g.user_id) },
    }).catch(() => {});
  }

  await interaction.editReply({ embeds: [successEmbed(`🌠 流星群完了。**${users.length}人** に総額 **◈${totalGranted.toLocaleString()}** を配ったよ。`)] });
}

// ─── 💸 JP放出（プール一部を当選者で山分け） ─────────
async function handleJPRelease(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ embeds: [errorEmbed("サーバー内でのみ使えるよ。")], ephemeral: true }); return; }
  await interaction.deferReply({ ephemeral: true });

  const winners = interaction.options.getInteger("人数") ?? 3;
  const ratio = (interaction.options.getInteger("放出率") ?? 50) / 100;

  const cfg = getServerConfig(guildId);
  const pool = cfg.jackpot_pool;
  if (pool <= 0) {
    await interaction.editReply({ embeds: [errorEmbed("JPプールが空っぽだよ。")] });
    return;
  }

  // 直近24h アクティブ
  const active = (db.prepare(
    `SELECT DISTINCT user_id FROM transaction_logs
     WHERE created_at >= datetime('now', '-1 day') AND game IS NOT NULL`,
  ).all() as Array<{ user_id: string }>).map((r) => r.user_id);

  if (active.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed("直近24h にアクティブな人がいないよ。")] });
    return;
  }

  // ランダム抽選（重複なし）
  const picked: string[] = [];
  const pool_users = [...active];
  while (picked.length < Math.min(winners, active.length) && pool_users.length > 0) {
    const idx = Math.floor(Math.random() * pool_users.length);
    picked.push(pool_users.splice(idx, 1)[0]);
  }

  const release = Math.floor(pool * ratio);
  const per = Math.floor(release / picked.length);
  const leftover = release - per * picked.length;

  runTransaction(() => {
    db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool - ? WHERE guild_id = ?").run(release, guildId);
    for (const uid of picked) {
      adjustBalance(uid, per, "JP放出: オーナー発火", "owner_event", guildId);
    }
    // 端数は救済プールへ
    if (leftover > 0) db.prepare("UPDATE server_config SET relief_pool = relief_pool + ? WHERE guild_id = ?").run(leftover, guildId);
  });

  // 公開アナウンス
  const ch = interaction.channel;
  if (ch && "send" in ch) {
    const embed = baseEmbed("💸 星溜まりが弾けた！", PALETTE.STARGOLD).setDescription([
      "*「JPプールから、ひとときの放出。」*",
      "*「選ばれたのは…この子たち。」*",
      "",
      `💰 放出額: **◈${release.toLocaleString()}**（プール ${Math.round(ratio * 100)}%）`,
      `👥 当選: **${picked.length}人** に **◈${per.toLocaleString()}** ずつ`,
      "",
      ...picked.map((u) => `🎉 <@${u}>`),
    ].join("\n"));
    await (ch as any).send({
      content: picked.map((u) => `<@${u}>`).join(" "),
      embeds: [embed],
      allowedMentions: { users: picked },
    }).catch(() => {});
  }

  await interaction.editReply({ embeds: [successEmbed(`💸 JP放出完了。**${picked.length}人** に **◈${per.toLocaleString()}** ずつ（計 ◈${release.toLocaleString()}）。`)] });
}

// ─── ✦ アステル口調で任意発言 ───────────────────
async function handleAstelSay(interaction: ChatInputCommandInteraction): Promise<void> {
  const line = interaction.options.getString("セリフ", true).trim();
  const ch = interaction.channel;
  if (!ch || !("send" in ch)) {
    await interaction.reply({ embeds: [errorEmbed("このチャンネルでは送れないよ。")], ephemeral: true });
    return;
  }
  const embed = baseEmbed("", PALETTE.STARGOLD).setDescription(`*「${line}」*`);
  try {
    await (ch as any).send({ embeds: [embed] });
    await interaction.reply({ embeds: [successEmbed("アステルが喋ったよ。")], ephemeral: true });
  } catch (err) {
    await interaction.reply({ embeds: [errorEmbed("送信に失敗しちゃった。")], ephemeral: true });
  }
}
