/**
 * /両替 — Gil ⇄ エテル（Gil-bot API 連携）
 * ─────────────────────────────────────────────────────────
 *   残高 : Gil(API) ＋ エテル(local) を表示
 *   入庫 : Gil → エテル（賭場に入る / internal_to_external）
 *   出庫 : エテル → Gil（換金 / external_to_internal）
 *   履歴 : 直近の両替
 * しきい値以上は管理者承認を挟む（server_config.exchange_threshold）。
 * レート/手数料/上限は Gil-bot 側が決定。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
  type TextChannel,
} from "discord.js";
import { ensureUser, getBalance } from "../core/bank";
import { getServerConfig, db } from "../core/db";
import {
  createExchange, executeExchange, getExchangeRow, isExchangeApiAvailable,
} from "../core/exchange";
import { gilBalance } from "../core/gilApi";
import type { GilDirection } from "../core/gilApi";
import { baseEmbed, errorEmbed } from "../ui/embeds";
import { WORLD, formatEther, PALETTE } from "../world.config";
import { memberName } from "../core/names";

const C1 = WORLD.CURRENCY_1_NAME;   // Gil
const C2 = WORLD.CURRENCY_2_NAME;   // エテル
const fmtGil = (n: number) => `${n.toLocaleString()} ${C1}`;

// ─── Command ──────────────────────────────────────────
export const exchangeCommand = new SlashCommandBuilder()
  .setName("両替")
  .setDescription(`💱 ${C1} と ${C2} を両替する`)
  .addSubcommand((sc) => sc.setName("残高").setDescription(`${C1} と ${C2} の残高を見る`))
  .addSubcommand((sc) =>
    sc.setName("入庫").setDescription(`${C1} → ${C2}（賭場に入る）`)
      .addIntegerOption((o) => o.setName("額").setDescription(`投入する ${C1} の額`).setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sc) =>
    sc.setName("出庫").setDescription(`${C2} → ${C1}（換金する）`)
      .addIntegerOption((o) => o.setName("額").setDescription(`投入する ${C2} の額`).setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sc) => sc.setName("履歴").setDescription("自分の両替履歴（直近10件）"));

export async function handleExchangeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }

  if (!isExchangeApiAvailable()) {
    await interaction.reply({ embeds: [errorEmbed(`両替はいま準備中だよ。（${C1}連携の設定待ち）`)], ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === "残高") return showBalance(interaction, guildId);
  if (sub === "入庫") return startExchange(interaction, guildId, "internal_to_external");
  if (sub === "出庫") return startExchange(interaction, guildId, "external_to_internal");
  if (sub === "履歴") return showHistory(interaction);
}

// ─── 残高 ─────────────────────────────────────────────
async function showBalance(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const userId = interaction.user.id;
  ensureUser(userId, guildId);
  await interaction.deferReply({ ephemeral: true });

  const ether = getBalance(userId, guildId);
  const gil = await gilBalance(guildId, userId);
  const gilText = gil.ok ? fmtGil((gil.data as any).balance ?? 0) : `取得できなかった（${gil.message}）`;

  const embed = baseEmbed("💱 残高", PALETTE.STARGOLD)
    .addFields(
      { name: `✦ ${C1}`, value: gilText, inline: true },
      { name: `${WORLD.CURRENCY_2_SYMBOL} ${C2}`, value: formatEther(ether), inline: true },
    )
    .setFooter({ text: `入庫=${C1}→${C2} / 出庫=${C2}→${C1}。レートや手数料は ${C1} 側で決まるよ。` });
  await interaction.editReply({ embeds: [embed] });
}

// ─── 入庫 / 出庫 開始 ─────────────────────────────────
async function startExchange(interaction: ChatInputCommandInteraction, guildId: string, direction: GilDirection): Promise<void> {
  const userId = interaction.user.id;
  const amount = interaction.options.getInteger("額", true);
  ensureUser(userId, guildId);
  const cfg = getServerConfig(guildId);

  // 出庫はローカルのエテル残高を事前チェック
  if (direction === "external_to_internal") {
    const bal = getBalance(userId, guildId);
    if (bal < amount) {
      await interaction.reply({ embeds: [errorEmbed(`${C2} が足りないよ。所持: ${formatEther(bal)}`)], ephemeral: true });
      return;
    }
  }

  const isInflow = direction === "internal_to_external";
  const label = isInflow ? `入庫（${C1}→${C2}）` : `出庫（${C2}→${C1}）`;
  const { id } = createExchange(guildId, userId, direction, amount, label);

  const needsApproval = amount >= (cfg.exchange_threshold ?? 50000);

  if (!needsApproval) {
    await interaction.deferReply({ ephemeral: true });
    const res = await executeExchange(id);
    if (!res.ok) {
      await interaction.editReply({ embeds: [errorEmbed(`両替できなかったよ。\n理由: ${res.message}`)] });
      return;
    }
    await interaction.editReply({ embeds: [successEmbed(interaction, guildId, direction, amount, res.etherDelta)] });
    return;
  }

  // しきい値以上 → 管理者承認
  const approvalChannelId = cfg.exchange_approval_channel_id || interaction.channelId;
  const embed = baseEmbed("💱 両替の承認待ち", PALETTE.VERMILION)
    .setDescription([
      `**${memberName(interaction)}** の両替申請（#${id}）`,
      `種別: **${label}**　額: **${amount.toLocaleString()}**`,
      "",
      "管理者の承認で実行されるよ。",
    ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`exapprove:approve:${id}`).setLabel("承認して実行").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`exapprove:reject:${id}`).setLabel("却下").setStyle(ButtonStyle.Danger),
  );

  try {
    const ch = await interaction.client.channels.fetch(approvalChannelId);
    if (ch && ch.type === ChannelType.GuildText) {
      await (ch as TextChannel).send({ embeds: [embed], components: [row] });
    }
  } catch { /* チャンネル取得失敗 */ }

  await interaction.reply({ content: `この額（${amount.toLocaleString()}）は承認が必要だよ。申請 #${id} を出したから、承認を待ってね。`, ephemeral: true });
}

function successEmbed(interaction: ChatInputCommandInteraction | ButtonInteraction, guildId: string, direction: GilDirection, amount: number, etherDelta: number) {
  const isInflow = direction === "internal_to_external";
  const userId = interaction.user.id;
  const etherAfter = getBalance(userId, guildId);
  const deltaText = `${etherDelta >= 0 ? "+" : "−"}${formatEther(Math.abs(etherDelta))}`;
  return baseEmbed(`✅ 両替完了 — ${isInflow ? `${C1}→${C2}` : `${C2}→${C1}`}`, isInflow ? PALETTE.JADE : PALETTE.STARGOLD)
    .setDescription(
      isInflow
        ? `${fmtGil(amount)} を ${C2} に両替したよ。`
        : `${formatEther(amount)} を ${C1} に両替したよ。`,
    )
    .addFields(
      { name: `${C2} の増減`, value: deltaText, inline: true },
      { name: `${WORLD.CURRENCY_2_SYMBOL} ${C2} 残高`, value: formatEther(etherAfter), inline: true },
    )
    .setFooter({ text: isInflow ? "ようこそ、星約の賭場へ。" : "またいつでもおいで。" });
}

// ─── 承認ボタン ───────────────────────────────────────
export async function handleExchangeApproval(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "承認できるのは管理者だけだよ。", ephemeral: true });
    return;
  }
  const [, action, idStr] = interaction.customId.split(":");
  const id = Number(idStr);
  const row = getExchangeRow(id);
  if (!row) { await interaction.reply({ content: "その申請は見つからないよ。", ephemeral: true }); return; }
  if (row.status !== "pending_approval") {
    await interaction.update({ content: `この申請は既に処理済み（${row.status}）。`, embeds: [], components: [] }).catch(() => {});
    return;
  }

  if (action === "reject") {
    db.prepare("UPDATE api_exchanges SET status='failed', updated_at=datetime('now') WHERE id=?").run(id);
    await interaction.update({ content: `申請 #${id} を却下したよ。`, embeds: [], components: [] }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();
  const res = await executeExchange(id);
  const text = res.ok
    ? `✅ 申請 #${id} を承認・実行したよ。`
    : `⚠️ 申請 #${id} の実行に失敗: ${res.message}`;
  await interaction.editReply({ content: text, embeds: [], components: [] }).catch(() => {});
}

// ─── 履歴 ─────────────────────────────────────────────
async function showHistory(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const rows = db.prepare(
    `SELECT id, direction, amount, status, ether_delta, internal_amount, created_at
     FROM api_exchanges WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
  ).all(userId) as Array<{ id: number; direction: string; amount: number; status: string; ether_delta: number | null; internal_amount: number | null }>;

  if (rows.length === 0) {
    await interaction.reply({ embeds: [baseEmbed("📜 両替履歴", PALETTE.NIGHT).setDescription("まだ両替したことがないみたい。")], ephemeral: true });
    return;
  }
  const statusLabel: Record<string, string> = { done: "✅", failed: "✖", cancelled: "♻", pending_approval: "⏳", pending_commit: "⏳" };
  const lines = rows.map((r) => {
    const dir = r.direction === "internal_to_external" ? `${C1}→${C2}` : `${C2}→${C1}`;
    return `${statusLabel[r.status] ?? "・"} #${r.id} ${dir} ${r.amount.toLocaleString()}`;
  });
  await interaction.reply({ embeds: [baseEmbed("📜 両替履歴 — 直近10件", PALETTE.STARGOLD).setDescription(lines.join("\n"))], ephemeral: true });
}
