import { ChatInputCommandInteraction } from "discord.js";
import { adjustBalance, ensureUser } from "../core/bank";
import { runTransaction } from "../core/db";
import { infoEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";

export async function handleTipCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const message = interaction.options.getString("message") || "";
  const guildId = interaction.guildId!;
  const senderId = interaction.user.id;

  if (targetUser.bot) {
    await interaction.reply({ embeds: [errorEmbed("ボットにエテルは送れないよ。")], ephemeral: true });
    return;
  }

  if (targetUser.id === senderId) {
    await interaction.reply({ embeds: [errorEmbed("自分自身には送れぬわ。")], ephemeral: true });
    return;
  }

  try {
    const success = runTransaction(() => {
      // 送信元の残高確認と引き落とし
      ensureUser(senderId, guildId);
      const deduct = adjustBalance(senderId, -amount, "tip_send");
      if (!deduct.ok) {
        return false;
      }

      // 送信先のアカウントを作成・加算
      ensureUser(targetUser.id, guildId);
      const add = adjustBalance(targetUser.id, amount, "tip_receive", undefined, guildId);
      if (!add.ok) {
        throw new Error("Failed to add tip to receiver.");
      }
      return true;
    });

    if (!success) {
      await interaction.reply({ embeds: [errorEmbed("残高が足りないみたい。まずは稼いでこ。")], ephemeral: true });
      return;
    }

    const msgDesc = message ? `\n\n📝 **メッセージ:**\n「${message}」` : "";

    // 座敷童の好感度: tipの心遣いに座敷童が喜ぶ
    let affectionNote = "";
    try {
      const { addTipAffection } = require("../core/db");
      if (addTipAffection(senderId)) {
        affectionNote = "\n\n*（座敷童がこちらを見て微笑んでいる…💖）*";
      }
    } catch {}

    const embed = successEmbed(
      `💸 **${interaction.user.displayName}** が **${targetUser.displayName}** に ◈${amount.toLocaleString()} エテルを贈りました！${msgDesc}${affectionNote}`
    );

    await interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });

  } catch (error) {
    console.error("[tip] Transfer failed:", error);
    await interaction.reply({ embeds: [errorEmbed("送金処理に失敗しちゃった。")], ephemeral: true });
  }
}
