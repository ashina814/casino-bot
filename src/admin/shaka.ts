/**
 * /釈迦の心づけ — オーナー専用、上限なし・cap無視の褒章送金
 * ─────────────────────────────────────────────────────────
 * 用途: 褒美・補填・イベント賞金など、自由額を任意ユーザーへ授ける。
 *   - オーナーのみ実行可（非オーナーには「まだ君悟ってないから無理だよ」）
 *   - 残高上限（balance_cap）も無視して直接付与（mint 動作）
 *   - 演出は荘厳に。embed と寒色＋金で
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { db } from "../core/db";
import { ensureUser } from "../core/bank";
import { emitTxEvent } from "../core/txfeed";
import { baseEmbed, errorEmbed, COLORS } from "../ui/embeds";
import { isOwnerId } from "../core/ownerAddress";

export const shakaCommand = new SlashCommandBuilder()
  .setName("釈迦の心づけ")
  .setDescription("🪷 悟りし者の褒章。任意ユーザーへ無制限の授け。")
  .addUserOption((o) => o.setName("user").setDescription("授ける相手").setRequired(true))
  .addIntegerOption((o) => o.setName("額").setDescription("授ける額").setRequired(true).setMinValue(1))
  .addStringOption((o) => o.setName("memo").setDescription("褒章の理由（公開アナウンス文に載る・任意）").setRequired(false).setMaxLength(200));

export async function handleShakaCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // 非オーナーへの応答 — 荘厳に拒絶
  if (!isOwnerId(interaction.user.id)) {
    const embed = baseEmbed("🌌 まだ、その時ではない", 0x4338CA).setDescription(
      [
        "*「ふぅん…？」*",
        "*「まだきみは悟っていないようだ。」*",
        "",
        "釈迦の心づけは、",
        "**真理の彼方** に至った者のみが",
        "授けることを許される秘儀。",
        "",
        "戻って、もう一度精進せよ。",
      ].join("\n"),
    ).setFooter({ text: "—— 第八の星より" });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("額", true);
  const memo = interaction.options.getString("memo");
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }
  if (target.bot) {
    await interaction.reply({ embeds: [errorEmbed("ボットには授けられないよ。")], ephemeral: true });
    return;
  }

  // cap 無視の直接 mint
  ensureUser(target.id, guildId);
  db.prepare("UPDATE users SET balance = balance + ? WHERE user_id = ?").run(amount, target.id);
  const reason = memo ? `釈迦の心づけ: ${memo}` : "釈迦の心づけ";
  db.prepare("INSERT INTO transaction_logs (user_id, amount, reason, game) VALUES (?, ?, ?, ?)").run(target.id, amount, reason, "shaka");
  emitTxEvent({ userId: target.id, amount, reason, game: "shaka", guildId, currency: "currency2" });

  // 公開アナウンス（実行chに荘厳投稿）
  const ch = interaction.channel;
  const embed = baseEmbed("🪷 釈迦の心づけ", COLORS.GOLD).setDescription([
    "*「七星のかなた、第八の星より授けの光が降りた。」*",
    "",
    `🌟 ${target} に **◈${amount.toLocaleString()}** の褒章。`,
    memo ? `\n*${memo}*` : "",
    "",
    "*受けし者は、感謝とともに歩み続けよ。*",
  ].filter(Boolean).join("\n")).setFooter({ text: "—— 悟りし者より" });

  if (ch && "send" in ch) {
    await (ch as any).send({
      content: `<@${target.id}>`,
      embeds: [embed],
      allowedMentions: { users: [target.id] },
    }).catch(() => {});
  }

  await interaction.reply({
    embeds: [baseEmbed("🪷 授けの儀、完了", COLORS.GOLD).setDescription(`${target} に ◈${amount.toLocaleString()} を授けた。`)],
    ephemeral: true,
  });
}
