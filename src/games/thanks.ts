/**
 * /thanks — 隠しコマンド（イースターエッグ）
 */
import { SlashCommandBuilder, ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import { checkThanks, thanksResponse } from "../easter-eggs/index";
import { adjustBalance } from "../core/bank";
import { infoEmbed, COLORS } from "../ui/embeds";

export const thanksCommand = new SlashCommandBuilder()
  .setName("感謝")
  .setDescription("✦ アステルにお礼を言う");

export async function handleThanksCommand(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;

  const result = checkThanks(userId);
  const text = result.triggered && result.message ? result.message : thanksResponse(userId);

  const color = result.triggered ? COLORS.GOLD : 0xE67E22; // warm color
  const embed = infoEmbed("✦ アステル", `*${text}*`, color);

  if (result.triggered && result.bonusAmount) {
    adjustBalance(userId, result.bonusAmount, "easter_egg_thanks", "easter_egg", interaction.guildId ?? undefined);
  }

  await interaction.reply({ embeds: [embed] });
}
