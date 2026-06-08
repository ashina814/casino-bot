/**
 * /釈迦の説法 — オーナー専用、所持金の15%を強制バーンする罰則コマンド
 * ─────────────────────────────────────────────────────────
 * 用途: ルール違反者への懲戒。荘厳に説き、財の15%を焼く（mintの逆 = supplyから消す）。
 *   - オーナーのみ実行可
 *   - 焼却額 = floor(対象残高 × 0.15)
 *   - 残高が極端に低い場合は最低1から（焼却額が0になるのを防ぐ）
 *   - 公開アナウンスで晒す（罰則は見せて初めて効く）
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "../core/db";
import { ensureUser, getBalance } from "../core/bank";
import { emitTxEvent } from "../core/txfeed";
import { baseEmbed, errorEmbed, COLORS } from "../ui/embeds";
import { isOwnerId } from "../core/ownerAddress";

const BURN_RATIO = 0.15;

export const seppouCommand = new SlashCommandBuilder()
  .setName("釈迦の説法")
  .setDescription("📿 戒めの説法。違反者の財の15%を焼き、星の塵へと還す。")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption((o) => o.setName("user").setDescription("説法を授ける相手").setRequired(true))
  .addStringOption((o) => o.setName("理由").setDescription("戒めの理由（公開アナウンス文に載る）").setRequired(true).setMaxLength(200));

export async function handleSeppouCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // 非オーナー拒絶
  if (!isOwnerId(interaction.user.id)) {
    const embed = baseEmbed("🌌 まだ、その時ではない", 0x4338CA).setDescription([
      "*「ふぅん…？」*",
      "*「まだきみは悟っていないようだ。」*",
      "",
      "釈迦の説法は、",
      "**真理の彼方** に至った者のみが",
      "授けることを許される秘儀。",
      "",
      "戻って、もう一度精進せよ。",
    ].join("\n")).setFooter({ text: "—— 第八の星より" });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const target = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("理由", true);
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }
  if (target.bot) {
    await interaction.reply({ embeds: [errorEmbed("ボットには説けないよ。")], ephemeral: true });
    return;
  }
  if (isOwnerId(target.id)) {
    await interaction.reply({ embeds: [errorEmbed("悟りし者に説法は届かない。")], ephemeral: true });
    return;
  }

  ensureUser(target.id, guildId);
  const before = getBalance(target.id);
  if (before <= 0) {
    await interaction.reply({ embeds: [errorEmbed("対象は既に無一文。説いても焼けない。")], ephemeral: true });
    return;
  }

  // 焼却額 = 15%（小数切り捨て、最低1）
  const burn = Math.max(1, Math.floor(before * BURN_RATIO));
  const actualBurn = Math.min(burn, before);

  // バーン（mint の逆）— users.balance を直接減らし、tx_log には負の amount で記録
  db.prepare("UPDATE users SET balance = balance - ? WHERE user_id = ?").run(actualBurn, target.id);
  const logReason = `釈迦の説法: ${reason}`;
  db.prepare("INSERT INTO transaction_logs (user_id, amount, reason, game) VALUES (?, ?, ?, ?)")
    .run(target.id, -actualBurn, logReason, "seppou");
  emitTxEvent({ userId: target.id, amount: -actualBurn, reason: logReason, game: "seppou", guildId, currency: "currency2" });

  const after = before - actualBurn;

  // 公開アナウンス（晒し）
  const ch = interaction.channel;
  const embed = baseEmbed("📿 釈迦の説法", COLORS.LOSE).setDescription([
    "*「——その業、見過ごせぬ。」*",
    "*「いま、戒めの説法を授ける。」*",
    "",
    `🔥 ${target} の財、**◈${actualBurn.toLocaleString()}**（15%）が星の塵へと還った。`,
    "",
    `**戒め**: ${reason}`,
    "",
    `*残: ◈${after.toLocaleString()}*`,
    "",
    "*煩悩は焼かれ、業は浄められる。再びの過ちなきよう、心を改めよ。*",
  ].filter(Boolean).join("\n")).setFooter({ text: "—— 第八の星より" });

  if (ch && "send" in ch) {
    await (ch as any).send({
      content: `<@${target.id}>`,
      embeds: [embed],
      allowedMentions: { users: [target.id] },
    }).catch(() => {});
  }

  await interaction.reply({
    embeds: [baseEmbed("📿 説法、完了", COLORS.GOLD).setDescription(
      `${target} の財から ◈${actualBurn.toLocaleString()} を焼いた。\n残: ◈${after.toLocaleString()}`,
    )],
    ephemeral: true,
  });
}
