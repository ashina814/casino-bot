/**
 * /両替 — 為替コマンド (v2)
 * ─────────────────────────────────────────────────────────
 * サブコマンド:
 *   - レート: 現在の為替レートと経済状態を表示
 *   - 第一→第二: currency1 → カジノコイン（手数料0%）
 *   - 第二→第一: カジノコイン → currency1（手数料20%、奉納）
 *   - 履歴: 自分の両替履歴
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { ensureUser, getBalance, getCurrency1Balance } from "../core/bank";
import {
  computeExchangeRate,
  exchangeIn,
  exchangeOut,
  EXCHANGE_OUT_FEE,
  BASE_RATE,
} from "../core/exchange";
import { db } from "../core/db";
import { baseEmbed, infoEmbed, errorEmbed, COLORS } from "../ui/embeds";
import { WORLD, formatCurrency1 } from "../world.config";

const C1 = WORLD.CURRENCY_1_NAME;
const C2 = WORLD.CURRENCY_2_NAME;
const C1E = WORLD.CURRENCY_1_EMOJI;
const C2E = WORLD.CURRENCY_2_SYMBOL;

// ─── Command Builder ───────────────────────────────────

export const exchangeCommand = new SlashCommandBuilder()
  .setName("両替")
  .setDescription(`💱 ${C1} と ${C2} を両替する`)
  .addSubcommand((sc) =>
    sc.setName("レート").setDescription(`現在の為替レートを表示`),
  )
  .addSubcommand((sc) =>
    sc
      .setName("入庫")
      .setDescription(`${C1} → ${C2} に両替（手数料 0%）`)
      .addIntegerOption((o) =>
        o.setName("額").setDescription(`投入する ${C1} の額`).setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("出庫")
      .setDescription(`${C2} → ${C1} に両替（${Math.round(EXCHANGE_OUT_FEE * 100)}% を ${WORLD.EXCHANGE_TRIBUTE}）`)
      .addIntegerOption((o) =>
        o.setName("額").setDescription(`投入する ${C2} の額`).setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sc) =>
    sc.setName("履歴").setDescription(`自分の両替履歴（直近10件）`),
  );

// ─── Handlers ───────────────────────────────────────────

export async function handleExchangeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "サーバー内でのみ利用できる。", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "レート":
      return handleRate(interaction, guildId);
    case "入庫":
      return handleIn(interaction, guildId);
    case "出庫":
      return handleOut(interaction, guildId);
    case "履歴":
      return handleHistory(interaction);
  }
}

// ─── レート表示 ────────────────────────────────────────

async function handleRate(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const info = computeExchangeRate(guildId);

  const trendEmoji =
    info.trend === "コイン高" ? "📈" :
    info.trend === "コイン安" ? "📉" : "➖";

  const embed = baseEmbed(`💱 為替レート — ${WORLD.CASINO_NAME}`, COLORS.GOLD)
    .setDescription(
      [
        `**1 ${C1E} ${C1} = ${C2E}${info.rate.toLocaleString()} ${C2}**`,
        ``,
        `${trendEmoji} ${info.trend}`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "📊 経済指標",
        value: [
          `${C2} 総供給量: ${C2E}${info.totalSupply.toLocaleString()}`,
          `プレイヤー数: ${info.playerCount}人`,
          `健全ライン: ${C2E}${info.healthyLine.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "🎯 レート内訳",
        value: [
          `基準: ${info.base.toFixed(2)}`,
          `自動補正: ${info.autoOffset >= 0 ? "+" : ""}${info.autoOffset.toFixed(2)}`,
          `手動補正: ${info.manualOffset >= 0 ? "+" : ""}${info.manualOffset.toFixed(2)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "💸 両替手数料",
        value: [
          `${C1E} → ${C2E}: **0%**`,
          `${C2E} → ${C1E}: **${Math.round(EXCHANGE_OUT_FEE * 100)}%** (${WORLD.EXCHANGE_TRIBUTE})`,
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: "[仮: レートはプール総量に応じて自動変動する。換金時の奉納は半分がJP、半分が救済プールへ。]" });

  await interaction.reply({ embeds: [embed] });
}

// ─── 第一 → 第二 ────────────────────────────────────

async function handleIn(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const userId = interaction.user.id;
  const amount = interaction.options.getInteger("額", true);

  ensureUser(userId, guildId);
  const currency1Before = getCurrency1Balance(userId, guildId);

  if (currency1Before < amount) {
    await interaction.reply({
      embeds: [errorEmbed(`${C1} の残高が足りぬ。\n所持: ${formatCurrency1(currency1Before)} / 必要: ${formatCurrency1(amount)}`)],
      ephemeral: true,
    });
    return;
  }

  const result = exchangeIn(userId, amount, guildId);

  if (!result.ok) {
    const msg =
      result.reason === "INSUFFICIENT_FUNDS" ? `${C1} の残高が足りぬ。` :
      result.reason === "RECEIVED_TOO_SMALL" ? "受取額が小さすぎる。もっと多く入れよ。" :
      "両替できぬ額じゃ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  const balanceAfter = getBalance(userId, guildId);
  const currency1After = getCurrency1Balance(userId, guildId);

  const embed = baseEmbed(`✅ 両替 — ${C1} → ${C2}`, COLORS.WIN)
    .setDescription(
      [
        `**${formatCurrency1(result.sourceAmount)} を ${C2E}${result.receivedAmount.toLocaleString()} に両替した。**`,
        `適用レート: 1 ${C1E} = ${C2E}${result.rate.toLocaleString()}`,
      ].join("\n"),
    )
    .addFields(
      { name: `${C1E} ${C1}`, value: formatCurrency1(currency1After), inline: true },
      { name: `${C2E} ${C2}`, value: `${C2E}${balanceAfter.toLocaleString()}`, inline: true },
    )
    .setFooter({ text: "[仮: 賭場へようこそ。たくさん遊んでいくがよい。]" });

  await interaction.reply({ embeds: [embed] });
}

// ─── 第二 → 第一 ────────────────────────────────────

async function handleOut(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const userId = interaction.user.id;
  const amount = interaction.options.getInteger("額", true);

  ensureUser(userId, guildId);
  const balanceBefore = getBalance(userId, guildId);

  if (balanceBefore < amount) {
    await interaction.reply({
      embeds: [errorEmbed(`${C2} の残高が足りぬ。\n所持: ${C2E}${balanceBefore.toLocaleString()} / 必要: ${C2E}${amount.toLocaleString()}`)],
      ephemeral: true,
    });
    return;
  }

  const result = exchangeOut(userId, amount, guildId);

  if (!result.ok) {
    const msg =
      result.reason === "INSUFFICIENT_FUNDS" ? `${C2} の残高が足りぬ。` :
      result.reason === "RECEIVED_TOO_SMALL" ? "受取額が小さすぎる。もっと多く入れよ。" :
      "両替できぬ額じゃ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  const balanceAfter = getBalance(userId, guildId);
  const currency1After = getCurrency1Balance(userId, guildId);

  const embed = baseEmbed(`✅ 両替 — ${C2} → ${C1}`, COLORS.GOLD)
    .setDescription(
      [
        `**${C2E}${result.sourceAmount.toLocaleString()} を ${formatCurrency1(result.receivedAmount)} に両替した。**`,
        `適用レート: 1 ${C1E} = ${C2E}${result.rate.toLocaleString()}`,
        ``,
        `🏮 **${WORLD.EXCHANGE_TRIBUTE}**: ${C2E}${result.feeAmount.toLocaleString()}`,
        `└ 半分は ${WORLD.POOL_JACKPOT} へ、もう半分は ${WORLD.POOL_RELIEF} へ。`,
      ].join("\n"),
    )
    .addFields(
      { name: `${C2E} ${C2}`, value: `${C2E}${balanceAfter.toLocaleString()}`, inline: true },
      { name: `${C1E} ${C1}`, value: formatCurrency1(currency1After), inline: true },
    )
    .setFooter({ text: "[仮: 賭場の外へお戻りか。またいつでも来るとよい。]" });

  await interaction.reply({ embeds: [embed] });
}

// ─── 履歴 ──────────────────────────────────────────────

async function handleHistory(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const rows = db
    .prepare(
      `SELECT direction, source_amount, received_amount, fee_amount, rate, created_at
       FROM currency_exchanges
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 10`,
    )
    .all(userId) as Array<{
      direction: "in" | "out";
      source_amount: number;
      received_amount: number;
      fee_amount: number;
      rate: number;
      created_at: string;
    }>;

  if (rows.length === 0) {
    await interaction.reply({
      embeds: [infoEmbed("📜 両替履歴", "まだ両替したことがないようじゃ。\n`/両替 入庫` または `/両替 出庫` で始めるがよい。")],
      ephemeral: true,
    });
    return;
  }

  const lines = rows.map((r, i) => {
    const arrow = r.direction === "in" ? `${C1E} → ${C2E}` : `${C2E} → ${C1E}`;
    const fee = r.fee_amount > 0 ? ` (奉納 ${C2E}${r.fee_amount.toLocaleString()})` : "";
    return `${i + 1}. ${arrow} ${r.source_amount.toLocaleString()} → ${r.received_amount.toLocaleString()}${fee} \`@${r.rate}\``;
  });

  const embed = baseEmbed("📜 両替履歴 — 直近10件", COLORS.BASE)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `累計: ${rows.length}件表示` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
