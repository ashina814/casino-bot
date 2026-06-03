/**
 * /profile — 通行証
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
} from "discord.js";
import { ensureUser } from "../core/bank";
import { db } from "../core/db";
import { profileEmbed } from "../ui/embeds";

// ─── Command ───────────────────────────────────────────

export const profileCommand = new SlashCommandBuilder()
  .setName("通行証")
  .setDescription("👤 自分の通行証（状態・戦績）を表示する");

export async function handleProfileCommand(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const target = interaction.user; // 自分専用（他人の通行証は表示しない）
  const profile = ensureUser(target.id, guildId);

  // Get active title
  const activeTitle = db.prepare(
    `SELECT t.title_name FROM active_titles a
     JOIN titles t ON a.user_id = t.user_id AND a.title_key = t.title_key
     WHERE a.user_id = ?`
  ).get(target.id) as { title_name: string } | undefined;

  const { isVip } = require("../core/vip");
  const embed = profileEmbed(profile, activeTitle?.title_name, isVip(target.id, guildId))
    .setAuthor({
      name: `${target.displayName} の通行証`,
      iconURL: target.displayAvatarURL(),
    })
    .setThumbnail(target.displayAvatarURL());

  // 自分の通行証は本人のみに見える（ephemeral）。他人を指定した場合も同様にチラ見せ。
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
