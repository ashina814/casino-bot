/**
 * /管理 コマンド群（管理者専用）
 *
 * サブコマンド構成：
 *   📊 監視  — 経済監視ダッシュボード（オーナー除外）
 *   ⚙️ 設定  — 設定パネル（経済・チャンネル）
 *   💰 発行  — エテル発行 (mint)
 *   🔥 焼却  — エテル焼却 (burn)
 *   ♻️ 返金  — ユーザー返金（理由必須）
 *   🔍 調査  — ユーザー取引履歴
 *   📢 通知  — 座敷童アナウンス
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  Client,
} from "discord.js";
import { db, getServerConfig, updateServerConfig, runTransaction } from "../core/db";
import { adjustBalance, ensureUser } from "../core/bank";
import { getEconomyState } from "../core/economy";
import { infoEmbed, errorEmbed, successEmbed, baseEmbed, COLORS } from "../ui/embeds";
import { config } from "../config";

// ─── Command Definition ────────────────────────────────

export const adminCommand = new SlashCommandBuilder()
  .setName("管理")
  .setDescription("管理者パネル")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("監視")
      .setDescription("📊 経済監視ダッシュボード（オーナー除く）")
      .addStringOption((o) =>
        o.setName("区分").setDescription("見たいセクションだけに絞る（既定: 全て）").setRequired(false)
          .addChoices(
            { name: "全て", value: "all" },
            { name: "流通（量・プール・lifetime動量）", value: "flow" },
            { name: "動き（24hプレイ・大型取引）", value: "activity" },
            { name: "ランキング（残高TOP・流入/流出TOP）", value: "ranking" },
            { name: "分布（資産分布）", value: "dist" },
          ),
      )
  )
  .addSubcommand((sub) =>
    sub.setName("設定").setDescription("⚙️ サーバー設定パネル")
  )
  .addSubcommand((sub) =>
    sub
      .setName("発行")
      .setDescription("💰 エテルを発行する")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("発行額").setRequired(true).setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("memo").setDescription("メモ（任意）")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("焼却")
      .setDescription("🔥 エテルを焼却する")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("焼却額").setRequired(true).setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("memo").setDescription("メモ（任意）")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("返金")
      .setDescription("♻️ ユーザーに返金する（理由を記録）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("返金額").setRequired(true).setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("返金理由").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("調査")
      .setDescription("🔍 ユーザーの取引履歴を調べる")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("limit").setDescription("表示件数（既定 20、最大 50）").setMinValue(1).setMaxValue(50)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("通知")
      .setDescription("📢 アステルの口調でアナウンスを送信")
      .addStringOption((opt) =>
        opt.setName("message").setDescription("通知内容").setRequired(true)
      )
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("メンションするロール（任意）")
      )
      .addRoleOption((opt) =>
        opt.setName("role2").setDescription("追加メンション 2")
      )
      .addRoleOption((opt) =>
        opt.setName("role3").setDescription("追加メンション 3")
      )
      .addRoleOption((opt) =>
        opt.setName("role4").setDescription("追加メンション 4")
      )
      .addRoleOption((opt) =>
        opt.setName("role5").setDescription("追加メンション 5")
      )
  )
  .addSubcommand((sub) =>
    sub.setName("株速報").setDescription("📈 株価速報を今すぐ株式市場チャンネルに投稿（テスト用）")
  )
  .addSubcommand((sub) =>
    sub.setName("案内設置").setDescription("📌 このチャンネルに常設の案内パネルを置く")
  )
  .addSubcommand((sub) =>
    sub.setName("商店設置").setDescription("📌 このチャンネルに常設の商店パネルを置く")
  )
  .addSubcommand((sub) =>
    sub.setName("板一覧").setDescription("📋 進行中の議題を一覧（選択で取消可）")
  )
  .addSubcommand((sub) =>
    sub
      .setName("板掃除")
      .setDescription("🧹 長期放置された進行中議題をまとめて無効化＋全員返金")
      .addIntegerOption((opt) =>
        opt.setName("古さ").setDescription("これより古い議題を対象（日数・既定 7）").setRequired(false).setMinValue(1).setMaxValue(180)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("通貨ログ")
      .setDescription("📒 エテル取引ログを出力（直近N日・任意ユーザー/絞り込み）")
      .addIntegerOption((opt) =>
        opt.setName("日数").setDescription("対象期間（既定 1日・最大 30）").setRequired(false).setMinValue(1).setMaxValue(30)
      )
      .addUserOption((opt) =>
        opt.setName("user").setDescription("特定ユーザーで絞り込み（任意）").setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName("絞り込み").setDescription("reason に含まれる文字列で絞り込み（任意・例: 心付け）").setRequired(false).setMaxLength(60)
      )
  );

// ─── Admin Role Mention Helper ─────────────────────────
/**
 * 運営ロールメンション文字列を返す。未設定なら空文字。
 * 異議・トラブル通知時に content 先頭に差し込んで使う:
 *   await msg.send(`${mentionAdminRole(guildId)} 異議が出たよ...`)
 */
export function mentionAdminRole(guildId: string): string {
  const cfg = getServerConfig(guildId);
  return cfg.admin_role_id ? `<@&${cfg.admin_role_id}>` : "";
}

// ─── Owner Exclusion Helper ────────────────────────────

/**
 * オーナー除外条件と引数を返す。
 * 戻り値の clause を WHERE/AND に追加し、params をクエリ引数に展開する。
 */
function ownerExclusion(): { clause: string; params: string[] } {
  if (!config.ownerId) return { clause: "", params: [] };
  return { clause: "user_id != ?", params: [config.ownerId] };
}

// ─── Command Router ────────────────────────────────────

export async function handleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.user.id !== "1436392582635847691") {
    await interaction.reply({ embeds: [errorEmbed("このコマンドを実行する権限がありません。")], ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;

  switch (sub) {
    case "監視":  return handleMonitor(interaction, guildId);
    case "設定":  return handleConfig(interaction, guildId);
    case "発行":  return handleMint(interaction, guildId);
    case "焼却":  return handleBurn(interaction, guildId);
    case "返金":  return handleRefund(interaction, guildId);
    case "調査":  return handleInspect(interaction, guildId);
    case "通知":  return handleAnnounce(interaction, guildId);
    case "株速報": return handleStockBroadcast(interaction, guildId);
    case "板一覧": return handleBoardList(interaction, guildId);
    case "板掃除": return handleBoardSweep(interaction, guildId);
    case "通貨ログ": return handleTxLog(interaction, guildId);
    case "案内設置": {
      const { postHomePanel } = require("../ui/home");
      return postHomePanel(interaction);
    }
    case "商店設置": {
      const { postShopPanel } = require("../games/shouten");
      return postShopPanel(interaction);
    }
  }
}

// ─── 📈 株速報（手動投稿・テスト用） ──────────────────────
async function handleStockBroadcast(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const cfg = getServerConfig(guildId);
  if (!cfg.stock_channel_id) {
    await interaction.reply({ embeds: [errorEmbed("株 速報チャンネルが未設定だよ。`/管理 設定` → 📢 チャンネルを編集 で設定してね。")], ephemeral: true });
    return;
  }
  const { buildMarketBroadcast } = require("../games/stocks/index");
  try {
    const channel = await interaction.client.channels.fetch(cfg.stock_channel_id);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ embeds: [errorEmbed("設定されたチャンネルが見つからない/テキストチャンネルじゃないみたい。")], ephemeral: true });
      return;
    }
    await (channel as any).send({ embeds: [buildMarketBroadcast([])] });
    await interaction.reply({ content: `📈 <#${cfg.stock_channel_id}> に株価速報を投稿したよ。`, ephemeral: true });
  } catch (e) {
    console.error("[admin] stock broadcast failed:", e);
    await interaction.reply({ embeds: [errorEmbed("投稿に失敗しちゃった。Botにそのチャンネルへの送信権限があるか確認してね。")], ephemeral: true });
  }
}

// ─── 📊 監視（経済ダッシュボード、オーナー除外） ─────────

async function handleMonitor(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const cfg = getServerConfig(guildId);
  const owner = ownerExclusion();
  const where = owner.clause ? `WHERE ${owner.clause}` : "";

  // 流通量・参加者
  type AggRow = { c: number; total: number; avg: number; max: number; min: number };
  const agg = db.prepare(`
    SELECT COUNT(*) as c, IFNULL(SUM(balance),0) as total, IFNULL(AVG(balance),0) as avg,
           IFNULL(MAX(balance),0) as max, IFNULL(MIN(balance),0) as min
    FROM users ${where}
  `).all(...owner.params)[0] as AggRow;

  // 中央値
  const medianRow = db.prepare(`
    SELECT balance FROM users ${where}
    ORDER BY balance
    LIMIT 1 OFFSET (SELECT (COUNT(*) - 1) / 2 FROM users ${where})
  `).all(...owner.params, ...owner.params)[0] as { balance: number } | undefined;
  const median = medianRow?.balance ?? 0;

  // 経済状態（既存ヘルパ）
  const eco = getEconomyState(guildId);

  // 資産分布
  const bins = [
    { label: "破産 (0)",          min: 0,       max: 0 },
    { label: "1〜1k",             min: 1,       max: 1000 },
    { label: "1k〜10k",           min: 1001,    max: 10000 },
    { label: "10k〜100k",         min: 10001,   max: 100000 },
    { label: "100k〜1M",          min: 100001,  max: 1000000 },
    { label: "1M超",              min: 1000001, max: Number.MAX_SAFE_INTEGER },
  ];
  for (const bin of bins) {
    const r = db.prepare(`
      SELECT COUNT(*) as c FROM users
      ${where ? where + " AND" : "WHERE"} balance BETWEEN ? AND ?
    `).get(...owner.params, bin.min, bin.max) as { c: number };
    (bin as any).count = r.c;
  }
  const maxBinCount = Math.max(...bins.map((b: any) => b.count), 1);
  const chartLines = bins.map((bin: any) => {
    const barLen = Math.round((bin.count / maxBinCount) * 12);
    const bar = "█".repeat(barLen) + "░".repeat(12 - barLen);
    return `\`${bin.label.padEnd(12)}\` ${bar} ${bin.count}人`;
  }).join("\n");

  // 直近24h アクティビティ（ゲーム別）
  const activityRows = db.prepare(`
    SELECT game, COUNT(*) as plays, IFNULL(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) as wagered
    FROM transaction_logs
    WHERE created_at >= datetime('now', '-1 day')
      AND game IS NOT NULL
      AND (reason LIKE '%bet%' OR reason LIKE '%賭け%')
      ${owner.clause ? " AND " + owner.clause : ""}
    GROUP BY game
    ORDER BY plays DESC
  `).all(...owner.params) as Array<{ game: string; plays: number; wagered: number }>;
  const activityLine = activityRows.length === 0
    ? "*（直近24hの賭けなし）*"
    : activityRows.map((r) => `\`${r.game.padEnd(10)}\` ${r.plays}回 / 賭け ◈${r.wagered.toLocaleString()}`).join("\n");

  // 残高 TOP 5
  const topRows = db.prepare(`
    SELECT user_id, balance FROM users ${where}
    ORDER BY balance DESC LIMIT 5
  `).all(...owner.params) as Array<{ user_id: string; balance: number }>;
  const topLine = topRows.length === 0
    ? "*（プレイヤーなし）*"
    : topRows.map((r, i) => `${i + 1}. <@${r.user_id}> — ◈${r.balance.toLocaleString()}`).join("\n");

  // 大型取引（直近48h、絶対値5万以上）
  const bigTxRows = db.prepare(`
    SELECT created_at, user_id, amount, reason, game
    FROM transaction_logs
    WHERE ABS(amount) >= 50000
      AND created_at >= datetime('now', '-2 days')
      ${owner.clause ? " AND " + owner.clause : ""}
    ORDER BY created_at DESC LIMIT 5
  `).all(...owner.params) as Array<{ created_at: string; user_id: string; amount: number; reason: string; game: string | null }>;
  const bigTxLine = bigTxRows.length === 0
    ? "*（直近48hの大型取引なし）*"
    : bigTxRows.map((r) => {
        const ts = r.created_at.slice(5, 16).replace("T", " ");
        const sign = r.amount >= 0 ? "+" : "";
        return `\`${ts}\` <@${r.user_id}> ${sign}◈${r.amount.toLocaleString()} (${r.reason})`;
      }).join("\n");

  // Lifetime 取引動量集計（旧 /管理 流通 から統合）
  const flowAgg = db.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS total_in,
      IFNULL(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS total_out,
      COUNT(*) AS tx_count
    FROM transaction_logs
    WHERE currency = 'currency2'
  `).get() as { total_in: number; total_out: number; tx_count: number };
  const flowNet = flowAgg.total_in - flowAgg.total_out;
  const accountedFor = agg.total + cfg.jackpot_pool + cfg.relief_pool;
  const drift = flowNet - accountedFor;

  type RC = { reason: string; total: number; count: number };
  const inflowTop = db.prepare(`
    SELECT reason, SUM(amount) AS total, COUNT(*) AS count
    FROM transaction_logs
    WHERE currency = 'currency2' AND amount > 0
    GROUP BY reason ORDER BY total DESC LIMIT 5
  `).all() as RC[];
  const outflowTop = db.prepare(`
    SELECT reason, SUM(-amount) AS total, COUNT(*) AS count
    FROM transaction_logs
    WHERE currency = 'currency2' AND amount < 0
    GROUP BY reason ORDER BY total DESC LIMIT 5
  `).all() as RC[];
  const fmtRC = (rows: RC[]) =>
    rows.length === 0
      ? "*（記録なし）*"
      : rows.map((r) => `\`${r.reason.slice(0, 26).padEnd(26)}\` ◈${r.total.toLocaleString().padStart(10)} (${r.count}回)`).join("\n");

  const ownerNote = config.ownerId
    ? `*<@${config.ownerId}> をオーナーとして集計から除外*`
    : "*オーナーID 未設定（全ユーザーを集計）*";

  // 区分フィルタ
  const section = (interaction.options.getString("区分") as "all" | "flow" | "activity" | "ranking" | "dist" | null) ?? "all";
  const show = {
    flow: section === "all" || section === "flow",
    dist: section === "all" || section === "dist",
    activity: section === "all" || section === "activity",
    ranking: section === "all" || section === "ranking",
  };

  const titleSuffix = section === "all" ? "" : `（${{ flow: "流通", activity: "動き", ranking: "ランキング", dist: "分布" }[section]}）`;
  const embed = baseEmbed(`📊 経済監視ダッシュボード${titleSuffix}`, COLORS.MAIN).setDescription(ownerNote);

  if (show.flow) {
    embed.addFields(
      {
        name: "🏛 流通量",
        value: [
          `総発行: **◈${agg.total.toLocaleString()}** (${agg.c}人)`,
          `平均: ◈${Math.round(agg.avg).toLocaleString()} / 中央: ◈${median.toLocaleString()}`,
          `最大: ◈${agg.max.toLocaleString()} / 最小: ◈${agg.min.toLocaleString()}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: `${eco.emoji} 経済状態`,
        value: `**${eco.label}** （${eco.healthyLine.toLocaleString()} エテル基準）`,
        inline: false,
      },
      {
        name: "🏆 プール",
        value: [
          `JP: ◈${cfg.jackpot_pool.toLocaleString()}`,
          `救済: ◈${cfg.relief_pool.toLocaleString()}`,
        ].join("　"),
        inline: false,
      },
      {
        name: "📈 取引動量（lifetime）",
        value: [
          `流入合計: ◈${flowAgg.total_in.toLocaleString()}　/　流出合計: ◈${flowAgg.total_out.toLocaleString()}`,
          `純増減: **${flowNet >= 0 ? "+" : ""}◈${flowNet.toLocaleString()}**　|　取引: ${flowAgg.tx_count.toLocaleString()}件`,
          `所在合計: ◈${accountedFor.toLocaleString()}（プレイヤー残高+プール）`,
          drift === 0 ? "✅ 整合 OK" : `⚠️ 差分: ${drift >= 0 ? "+" : ""}◈${drift.toLocaleString()}（要監査）`,
        ].join("\n"),
        inline: false,
      },
    );
  }
  if (show.dist) {
    embed.addFields({ name: "📊 資産分布", value: chartLines, inline: false });
  }
  if (show.activity) {
    embed.addFields(
      { name: "🎰 直近24h アクティビティ", value: activityLine, inline: false },
      { name: "💸 大型取引（直近48h・5万以上）", value: bigTxLine, inline: false },
    );
  }
  if (show.ranking) {
    embed.addFields(
      { name: "👑 残高 TOP 5", value: topLine, inline: false },
      { name: "📥 流入TOP5（reason別・lifetime）", value: fmtRC(inflowTop), inline: false },
      { name: "📤 流出TOP5（reason別・lifetime）", value: fmtRC(outflowTop), inline: false },
    );
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── ⚙️ 設定 ─────────────────────────────────────────

async function handleConfig(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const cfg = getServerConfig(guildId);

  const embed = baseEmbed("⚙️ サーバー設定", COLORS.MAIN).addFields(
    {
      name: "💰 経済",
      value: [
        `初期支給: ◈${cfg.initial_balance.toLocaleString()}`,
        `デイリー基本: ◈${cfg.daily_base}`,
        `破産保護: ◈${cfg.bankruptcy_aid}`,
        `所持金上限(天井): ◈${cfg.balance_cap.toLocaleString()}`,
        `※通常はレベル(星位)別の上限が優先`,
        `ハウスエッジ補正: ${cfg.house_edge_offset >= 0 ? "+" : ""}${cfg.house_edge_offset}%`,
        `最低ベット: ◈${cfg.min_bet}`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "📢 チャンネル",
      value: [
        `アステル通知先: ${cfg.casino_channel_id ? `<#${cfg.casino_channel_id}>` : "*未設定*"}`,
        `大勝ち速報: ${cfg.jackpot_channel_id ? `<#${cfg.jackpot_channel_id}>` : "*未設定*"}`,
        `株 速報: ${cfg.stock_channel_id ? `<#${cfg.stock_channel_id}>` : "*未設定*"}`,
        `競馬（定期競馬の発火先）: ${cfg.race_channel_id ? `<#${cfg.race_channel_id}>` : "*未設定*"}`,
        `通貨ログ: ${cfg.tx_feed_channel_id ? `<#${cfg.tx_feed_channel_id}>` : "*未設定*"}`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "💱 両替",
      value: [
        `承認しきい値: ◈${cfg.exchange_threshold.toLocaleString()} 以上`,
        `承認チャンネル: ${cfg.exchange_approval_channel_id ? `<#${cfg.exchange_approval_channel_id}>` : "*未設定（申請chに表示）*"}`,
        `還光率（出庫バーン）: ${Math.round((cfg.ryuko_rate ?? 0.5) * 100)}%`,
      ].join("\n"),
      inline: true,
    },
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("admin_economy").setLabel("💰 経済を編集").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin_channels").setLabel("📢 チャンネルを編集").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_exchange").setLabel("💱 両替を編集").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_roles").setLabel("🎭 ロールを編集").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_logs").setLabel("📒 ログ設定").setStyle(ButtonStyle.Secondary),
  );

  const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    if (btn.customId === "admin_economy") {
      const modal = new ModalBuilder()
        .setCustomId("admin_economy_modal")
        .setTitle("💰 経済設定の変更")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("daily_base").setLabel("デイリーボーナス（基本）").setStyle(TextInputStyle.Short).setValue(String(cfg.daily_base)).setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("min_bet").setLabel("最低ベット額").setStyle(TextInputStyle.Short).setValue(String(cfg.min_bet)).setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("house_edge_offset").setLabel("ハウスエッジ補正（%） 例: 2 / -1").setStyle(TextInputStyle.Short).setValue(String(cfg.house_edge_offset)).setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("balance_cap").setLabel("所持金の最終上限（通常はレベル別が優先）").setStyle(TextInputStyle.Short).setValue(String(cfg.balance_cap)).setRequired(false),
          ),
        );

      await btn.showModal(modal);

      try {
        const m = await btn.awaitModalSubmit({ time: 60_000 });
        const daily_base = parseInt(m.fields.getTextInputValue("daily_base")) || cfg.daily_base;
        const min_bet = parseInt(m.fields.getTextInputValue("min_bet")) || cfg.min_bet;
        const edge = parseFloat(m.fields.getTextInputValue("house_edge_offset"));
        const house_edge_offset = Number.isFinite(edge) ? edge : cfg.house_edge_offset;
        const balance_cap = parseInt(m.fields.getTextInputValue("balance_cap")) || cfg.balance_cap;
        updateServerConfig(guildId, { daily_base, min_bet, house_edge_offset, balance_cap });
        await m.reply({
          embeds: [successEmbed(`設定を更新しました。\nデイリー: ◈${daily_base} / 最低ベット: ◈${min_bet} / エッジ補正: ${house_edge_offset}% / 上限: ◈${balance_cap.toLocaleString()}`)],
          ephemeral: true,
        });
      } catch { /* timeout */ }
    } else if (btn.customId === "admin_channels") {
      const modal = new ModalBuilder()
        .setCustomId("admin_channels_modal")
        .setTitle("📢 チャンネル設定")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("casino_channel").setLabel("アステル通知先 チャンネルID").setStyle(TextInputStyle.Short).setValue(cfg.casino_channel_id ?? "").setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("jackpot_channel").setLabel("大勝ち速報 チャンネルID").setStyle(TextInputStyle.Short).setValue(cfg.jackpot_channel_id ?? "").setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("stock_channel").setLabel("株 速報 チャンネルID").setStyle(TextInputStyle.Short).setValue(cfg.stock_channel_id ?? "").setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("race_channel").setLabel("競馬（定期競馬の発火先） チャンネルID").setStyle(TextInputStyle.Short).setValue(cfg.race_channel_id ?? "").setRequired(false),
          ),
        );

      await btn.showModal(modal);
      try {
        const m = await btn.awaitModalSubmit({ time: 60_000 });
        updateServerConfig(guildId, {
          casino_channel_id: m.fields.getTextInputValue("casino_channel") || null,
          jackpot_channel_id: m.fields.getTextInputValue("jackpot_channel") || null,
          stock_channel_id: m.fields.getTextInputValue("stock_channel") || null,
          race_channel_id: m.fields.getTextInputValue("race_channel") || null,
        });
        await m.reply({ embeds: [successEmbed("チャンネル設定を更新しました。")], ephemeral: true });
      } catch { /* timeout */ }
    } else if (btn.customId === "admin_exchange") {
      const modal = new ModalBuilder()
        .setCustomId("admin_exchange_modal")
        .setTitle("💱 両替設定")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("exchange_threshold").setLabel("承認が要る額（これ以上で承認待ち）").setStyle(TextInputStyle.Short).setValue(String(cfg.exchange_threshold)).setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("exchange_approval_channel").setLabel("承認パネルのチャンネルID（空=申請ch）").setStyle(TextInputStyle.Short).setValue(cfg.exchange_approval_channel_id ?? "").setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("ryuko_rate").setLabel("還光率%（出庫バーン・0〜100）").setStyle(TextInputStyle.Short).setValue(String(Math.round((cfg.ryuko_rate ?? 0.5) * 100))).setRequired(false),
          ),
        );
      await btn.showModal(modal);
      try {
        const m = await btn.awaitModalSubmit({ time: 60_000 });
        const threshold = parseInt(m.fields.getTextInputValue("exchange_threshold")) || cfg.exchange_threshold;
        const ratePct = parseFloat(m.fields.getTextInputValue("ryuko_rate"));
        const ryuko_rate = Number.isFinite(ratePct) ? Math.min(1, Math.max(0, ratePct / 100)) : cfg.ryuko_rate;
        updateServerConfig(guildId, {
          exchange_threshold: threshold,
          exchange_approval_channel_id: m.fields.getTextInputValue("exchange_approval_channel") || null,
          ryuko_rate,
        });
        await m.reply({
          embeds: [successEmbed(`両替設定を更新しました。\n承認しきい値: ◈${threshold.toLocaleString()} 以上 / 還光率: ${Math.round(ryuko_rate * 100)}%`)],
          ephemeral: true,
        });
      } catch { /* timeout */ }
    } else if (btn.customId === "admin_roles") {
      const modal = new ModalBuilder()
        .setCustomId("admin_roles_modal")
        .setTitle("🎭 ロール設定")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("vip_role").setLabel("VIPロールID（奥座敷）").setStyle(TextInputStyle.Short).setValue(cfg.vip_role_id ?? "").setRequired(false),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("admin_role").setLabel("運営ロールID（異議・通知のメンション先）").setStyle(TextInputStyle.Short).setValue(cfg.admin_role_id ?? "").setRequired(false),
          ),
        );
      await btn.showModal(modal);
      try {
        const m = await btn.awaitModalSubmit({ time: 60_000 });
        updateServerConfig(guildId, {
          vip_role_id: m.fields.getTextInputValue("vip_role") || null,
          admin_role_id: m.fields.getTextInputValue("admin_role") || null,
        });
        await m.reply({ embeds: [successEmbed("ロール設定を更新しました。")], ephemeral: true });
      } catch { /* timeout */ }
    } else if (btn.customId === "admin_logs") {
      const modal = new ModalBuilder()
        .setCustomId("admin_logs_modal")
        .setTitle("📒 ログ設定")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("tx_feed_channel").setLabel("通貨ログ送信先チャンネルID（空欄で無効）").setStyle(TextInputStyle.Short).setValue(cfg.tx_feed_channel_id ?? "").setRequired(false),
          ),
        );
      await btn.showModal(modal);
      try {
        const m = await btn.awaitModalSubmit({ time: 60_000 });
        updateServerConfig(guildId, {
          tx_feed_channel_id: m.fields.getTextInputValue("tx_feed_channel") || null,
        });
        await m.reply({ embeds: [successEmbed("ログ設定を更新しました。次回の取引から反映されるよ。")], ephemeral: true });
      } catch { /* timeout */ }
    }
  });
}

// ─── 💰 発行（mint） ──────────────────────────────────

async function handleMint(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const memo = interaction.options.getString("memo") ?? null;

  ensureUser(target.id, guildId);
  const result = adjustBalance(target.id, amount, "mint", "admin");

  if (!result.ok) {
    await interaction.reply({ embeds: [errorEmbed("発行に失敗しました。")], ephemeral: true });
    return;
  }

  db.prepare("INSERT INTO exchange_logs (admin_id, target_user_id, action, amount, memo) VALUES (?, ?, 'mint', ?, ?)")
    .run(interaction.user.id, target.id, amount, memo);

  await interaction.reply({
    embeds: [successEmbed(`**${target.displayName}** に ◈${amount.toLocaleString()} を発行しました。${memo ? `\nメモ: ${memo}` : ""}`)],
    ephemeral: true,
  });
}

// ─── 🔥 焼却（burn） ──────────────────────────────────

async function handleBurn(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const memo = interaction.options.getString("memo") ?? null;

  ensureUser(target.id, guildId);
  const result = adjustBalance(target.id, -amount, "burn", "admin");

  if (!result.ok) {
    await interaction.reply({ embeds: [errorEmbed("焼却に失敗しました。残高不足の可能性があります。")], ephemeral: true });
    return;
  }

  db.prepare("INSERT INTO exchange_logs (admin_id, target_user_id, action, amount, memo) VALUES (?, ?, 'burn', ?, ?)")
    .run(interaction.user.id, target.id, amount, memo);

  await interaction.reply({
    embeds: [successEmbed(`**${target.displayName}** から ◈${amount.toLocaleString()} を焼却しました。${memo ? `\nメモ: ${memo}` : ""}`)],
    ephemeral: true,
  });
}

// ─── ♻️ 返金 ────────────────────────────────────────

async function handleRefund(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const reason = interaction.options.getString("reason", true);

  ensureUser(target.id, guildId);
  const result = adjustBalance(target.id, amount, `返金: ${reason}`, "admin", guildId);
  if (!result.ok) {
    await interaction.reply({ embeds: [errorEmbed("返金に失敗しました。")], ephemeral: true });
    return;
  }

  db.prepare("INSERT INTO exchange_logs (admin_id, target_user_id, action, amount, memo) VALUES (?, ?, 'refund', ?, ?)")
    .run(interaction.user.id, target.id, amount, reason);

  await interaction.reply({
    embeds: [successEmbed(`**${target.displayName}** に ◈${amount.toLocaleString()} を返金しました。\n理由: ${reason}`)],
    ephemeral: true,
  });
}

// ─── 🔍 調査（ユーザー履歴） ────────────────────────

async function handleInspect(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const target = interaction.options.getUser("user", true);
  const limit = interaction.options.getInteger("limit") ?? 20;

  const profile = ensureUser(target.id, guildId);

  const rows = db.prepare(`
    SELECT amount, reason, game, created_at
    FROM transaction_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(target.id, limit) as Array<{ amount: number; reason: string; game: string | null; created_at: string }>;

  const lines = rows.length === 0
    ? "*取引履歴なし*"
    : rows.map((r) => {
        const sign = r.amount >= 0 ? "+" : "";
        const ts = r.created_at.slice(5, 16).replace("T", " ");
        const game = r.game ? ` [${r.game}]` : "";
        return `\`${ts}\` ${sign}◈${r.amount.toLocaleString()}　${r.reason}${game}`;
      }).join("\n");

  await interaction.reply({
    embeds: [
      infoEmbed(
        `🔍 ${target.displayName} の調査`,
        [
          `💰 残高: ◈${profile.balance.toLocaleString()}`,
          `📈 ${profile.total_wins.toLocaleString()}勝 / ${profile.total_losses.toLocaleString()}敗 ・ 累計賭け ◈${profile.total_wagered.toLocaleString()}`,
          "",
          `**直近 ${rows.length} 件**`,
          lines,
        ].join("\n"),
        COLORS.MAIN,
      ),
    ],
    ephemeral: true,
  });
}

// ─── 📢 通知（announce） ─────────────────────────────

async function handleAnnounce(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const message = interaction.options.getString("message", true);
  // 最大5ロールまでメンション可能。重複は除去。
  const roles = ["role", "role2", "role3", "role4", "role5"]
    .map((k) => interaction.options.getRole(k))
    .filter((r): r is NonNullable<typeof r> => r != null);
  const uniqueRoleIds = Array.from(new Set(roles.map((r) => r.id)));

  const cfg = getServerConfig(guildId);
  const channelId = cfg.casino_channel_id ?? interaction.channelId;

  const channel = await interaction.client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({ embeds: [errorEmbed("チャンネルが見つかりません。")], ephemeral: true });
    return;
  }

  const embed = infoEmbed("✦ アステルからのお知らせ", `*「${message}」*`, COLORS.GOLD);

  // サムネは bot アイコン（旧: idle.gif を添付してたが、お知らせは固定演出にする）
  const botAvatar = interaction.client.user?.displayAvatarURL({ size: 256 });
  if (botAvatar) embed.setThumbnail(botAvatar);

  const content = uniqueRoleIds.length > 0
    ? uniqueRoleIds.map((id) => `<@&${id}>`).join(" ")
    : undefined;

  await (channel as any).send({
    content,
    embeds: [embed],
    // 明示的に許可ロールだけメンション通知（@everyone 暴発を防ぐ）
    allowedMentions: { roles: uniqueRoleIds },
  });
  await interaction.reply({
    embeds: [successEmbed("アナウンスを送信しました。")],
    ephemeral: true,
  });
}

// ─── 📋 板救済 ────────────────────────────────────────

type BoardAdminRow = {
  id: number;
  guild_id: string;
  creator_id: string;
  title: string;
  status: string;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  created_at: string;
};

type BoardBetAdminRow = { user_id: string; amount: number };

async function handleBoardList(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const rows = db.prepare(
    `SELECT id, creator_id, title, status, created_at
     FROM betting_markets
     WHERE guild_id = ? AND status IN ('open','closed','reported','disputed')
     ORDER BY id DESC LIMIT 25`,
  ).all(guildId) as Array<Pick<BoardAdminRow, "id" | "creator_id" | "title" | "status" | "created_at">>;

  if (rows.length === 0) {
    await interaction.reply({ embeds: [infoEmbed("📋 板", "進行中の議題は無いよ。", COLORS.GOLD)], ephemeral: true });
    return;
  }

  const statusLabel: Record<string, string> = { open: "受付中", closed: "締切", reported: "承認待ち", disputed: "異議・裁定待ち" };
  const lines = rows.map((r) => {
    const ts = r.created_at.slice(5, 16).replace("T", " ");
    return `\`#${r.id}\` ${statusLabel[r.status] ?? r.status} — **${r.title}** / 立てた人: <@${r.creator_id}> (${ts})`;
  });

  const sel = new StringSelectMenuBuilder()
    .setCustomId("admin_board_cancel_pick")
    .setPlaceholder("🗑 取消する議題を選ぶ（任意）")
    .setMinValues(1).setMaxValues(1)
    .addOptions(
      rows.map((r) => ({
        label: `#${r.id} ${r.title}`.slice(0, 100),
        description: `${statusLabel[r.status] ?? r.status} — 立て主: ${r.creator_id}`.slice(0, 100),
        value: String(r.id),
      })),
    );

  const reply = await interaction.reply({
    embeds: [baseEmbed(`📋 板 — 進行中 ${rows.length}件`, COLORS.GOLD).setDescription(lines.join("\n"))],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
    ephemeral: true,
  });

  try {
    const picked = await reply.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: 120_000 });
    const marketId = Number(picked.values[0]);

    const modal = new ModalBuilder()
      .setCustomId(`admin_board_cancel_modal_${marketId}`)
      .setTitle(`📋 議題 #${marketId} を取消`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("reason").setLabel("取消理由").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(200),
        ),
      );
    await picked.showModal(modal);
    const mod = await picked.awaitModalSubmit({ time: 120_000 });
    const reason = mod.fields.getTextInputValue("reason");
    const result = await executeBoardCancel(mod.client, guildId, marketId, reason);
    await mod.reply({ embeds: [result.ok ? successEmbed(result.msg) : errorEmbed(result.msg)], ephemeral: true });
  } catch { /* timeout or user closed */ }
}

/** 板取消のコア。slash 直接 / 一覧→セレクト→モーダル の両方から呼ばれる。 */
async function executeBoardCancel(client: Client, guildId: string, marketId: number, reason: string): Promise<{ ok: boolean; msg: string }> {
  const m = db.prepare("SELECT * FROM betting_markets WHERE id = ? AND guild_id = ?").get(marketId, guildId) as BoardAdminRow | undefined;
  if (!m) return { ok: false, msg: `market #${marketId} が見つからないよ。` };
  if (m.status === "settled" || m.status === "void") {
    return { ok: false, msg: `market #${marketId} は既に終了（${m.status}）。取り消せないよ。` };
  }

  const bets = db.prepare("SELECT user_id, amount FROM market_bets WHERE market_id = ?").all(marketId) as BoardBetAdminRow[];
  const refunded = bets.length;
  runTransaction(() => {
    for (const b of bets) {
      adjustBalance(b.user_id, b.amount, `板取消(管理者): ${reason}`, "board", m.guild_id);
    }
    db.prepare("UPDATE betting_markets SET status = 'void', settled_at = datetime('now') WHERE id = ?").run(marketId);
  });

  // 紐付きVCのデポジットも保護返金
  let depositRefunded = false;
  try {
    const { refundLinkedVCDeposit } = require("../games/takutate");
    depositRefunded = refundLinkedVCDeposit("board", String(marketId));
  } catch (err) { console.warn("[admin board cancel] deposit refund failed:", err); }

  // 元メッセージ書き換え
  if (m.channel_id && m.message_id) {
    try {
      const ch = await client.channels.fetch(m.channel_id).catch(() => null);
      if (ch && "messages" in ch) {
        const msg = await (ch as any).messages.fetch(m.message_id).catch(() => null);
        if (msg) {
          await msg.edit({
            content: "",
            embeds: [baseEmbed(`📋 議題 #${marketId} — 取消（管理者）`, COLORS.LOSE).setDescription(`管理者により無効化されたよ。\n**理由**: ${reason}\n賭けた **${refunded}人** に全額返金したよ。`)],
            components: [],
          }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }

  return {
    ok: true,
    msg: `市場 #${marketId} を取り消したよ。${refunded}人に全額返金。${depositRefunded ? "\n紐付きVCのデポジットも返金。" : ""}`,
  };
}


// ─── 🧹 板掃除（長期放置議題の一括 void） ─────────────

async function handleBoardSweep(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const days = interaction.options.getInteger("古さ") ?? 7;
  await interaction.deferReply({ ephemeral: true });

  // 対象 = 進行中（open/closed/reported/disputed）かつ created_at が days日より古い
  const cutoffSql = `datetime('now', '-${days} days')`;
  const stale = db.prepare(
    `SELECT id, creator_id, title, status, channel_id, message_id
     FROM betting_markets
     WHERE guild_id = ?
       AND status IN ('open','closed','reported','disputed')
       AND created_at < ${cutoffSql}`,
  ).all(guildId) as Array<{ id: number; creator_id: string; title: string; status: string; channel_id: string | null; message_id: string | null }>;

  if (stale.length === 0) {
    await interaction.editReply({ embeds: [infoEmbed("🧹 板掃除", `${days}日より古い進行中議題は無いよ。`, COLORS.GOLD)] });
    return;
  }

  let totalRefunds = 0;
  let totalAmount = 0;

  // 紐付きVCのデポジット保護返金（admin sweep の責はユーザーにない）
  const { refundLinkedVCDeposit } = require("../games/takutate");

  for (const m of stale) {
    const bets = db.prepare("SELECT user_id, amount FROM market_bets WHERE market_id = ?").all(m.id) as Array<{ user_id: string; amount: number }>;
    runTransaction(() => {
      for (const b of bets) {
        adjustBalance(b.user_id, b.amount, `板掃除(管理者・${days}日超): 返金`, "board", guildId);
        totalRefunds += 1;
        totalAmount += b.amount;
      }
      db.prepare("UPDATE betting_markets SET status = 'void', settled_at = datetime('now') WHERE id = ?").run(m.id);
    });
    try { refundLinkedVCDeposit("board", String(m.id)); } catch (err) { console.warn("[admin board sweep] deposit refund failed:", err); }

    // 元メッセージ書き換え（あれば）
    if (m.channel_id && m.message_id) {
      try {
        const ch = await interaction.client.channels.fetch(m.channel_id).catch(() => null);
        if (ch && "messages" in ch) {
          const msg = await (ch as any).messages.fetch(m.message_id).catch(() => null);
          if (msg) {
            await msg.edit({
              content: "",
              embeds: [baseEmbed(`📋 議題 #${m.id} — 掃除`, COLORS.LOSE).setDescription(`${days}日以上動きが無いため管理者が無効化したよ。\n賭けてた人には全額返金済み。`)],
              components: [],
            }).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
  }

  const lines = stale.map((m) => `\`#${m.id}\` **${m.title}** (${m.status})`);
  await interaction.editReply({
    embeds: [successEmbed(`🧹 **${stale.length}件** の議題を掃除したよ。\n返金: **${totalRefunds}件** / 計 ◈${totalAmount.toLocaleString()}\n\n${lines.join("\n")}`)],
  });
}

// ─── 📒 通貨ログ ─────────────────────────────────────

async function handleTxLog(interaction: ChatInputCommandInteraction, _guildId: string): Promise<void> {
  const days = interaction.options.getInteger("日数") ?? 1;
  const targetUser = interaction.options.getUser("user");
  const filter = (interaction.options.getString("絞り込み") ?? "").trim();

  await interaction.deferReply({ ephemeral: true });

  // 条件構築
  const where: string[] = [`created_at >= datetime('now', '-${days} days')`];
  const params: any[] = [];
  if (targetUser) {
    where.push("user_id = ?");
    params.push(targetUser.id);
  }
  if (filter) {
    where.push("reason LIKE ?");
    params.push(`%${filter}%`);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  type TxRow = { id: number; user_id: string; amount: number; reason: string; game: string | null; currency: string; created_at: string };
  const rows = db.prepare(
    `SELECT id, user_id, amount, reason, game, currency, created_at
     FROM transaction_logs ${whereSql}
     ORDER BY id DESC`,
  ).all(...params) as TxRow[];

  if (rows.length === 0) {
    await interaction.editReply({ embeds: [infoEmbed("📒 通貨ログ", "対象期間内に取引が無いよ。", COLORS.GOLD)] });
    return;
  }

  // 集計
  let totalIn = 0, totalOut = 0;
  for (const r of rows) {
    if (r.amount >= 0) totalIn += r.amount;
    else totalOut += -r.amount;
  }
  const net = totalIn - totalOut;

  const targetLabel = targetUser ? `<@${targetUser.id}>` : "全ユーザー";
  const filterLabel = filter ? `\nフィルタ: \`${filter}\`` : "";
  const summary = [
    `**対象**: ${targetLabel}　|　**期間**: 直近 ${days}日　|　**件数**: ${rows.length}`,
    `**流入合計**: ◈${totalIn.toLocaleString()}　/　**流出合計**: ◈${totalOut.toLocaleString()}`,
    `**純増減**: ${net >= 0 ? "+" : ""}◈${net.toLocaleString()}${filterLabel}`,
  ].join("\n");

  // テキスト行（直近20件）
  const LINE_MAX = 20;
  const head = rows.slice(0, LINE_MAX);
  const lines = head.map((r) => {
    const ts = r.created_at.slice(5, 16).replace("T", " ");
    const sign = r.amount >= 0 ? "+" : "";
    const game = r.game ? `[${r.game}]` : "";
    return `\`${ts}\` ${sign}◈${r.amount.toLocaleString().padStart(8)} <@${r.user_id}> ${game} ${r.reason}`;
  }).join("\n");

  const embed = baseEmbed("📒 通貨ログ", COLORS.MAIN)
    .setDescription([summary, "", lines || "*(表示行なし)*"].join("\n"))
    .setFooter({ text: rows.length > LINE_MAX ? `…他 ${rows.length - LINE_MAX}件は添付ファイルを見て` : "全件表示" });

  // 全件は CSV っぽい TSV で添付
  let files: { attachment: Buffer; name: string }[] | undefined;
  if (rows.length > LINE_MAX) {
    const tsv = [
      "id\tcreated_at\tuser_id\tamount\tcurrency\tgame\treason",
      ...rows.map((r) => `${r.id}\t${r.created_at}\t${r.user_id}\t${r.amount}\t${r.currency}\t${r.game ?? ""}\t${r.reason}`),
    ].join("\n");
    files = [{ attachment: Buffer.from(tsv, "utf-8"), name: `tx_log_${days}d_${Date.now()}.tsv` }];
  }

  await interaction.editReply({ embeds: [embed], ...(files ? { files } : {}) });
}

