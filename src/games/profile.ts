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
  .setDescription("👤 通行証を表示する")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("他の人の通行証を見る").setRequired(false)
  );

export async function handleProfileCommand(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  // ボタン（案内パネル）から呼ばれた時は options が無いので自分の通行証を出す
  const target = (interaction.isChatInputCommand() ? interaction.options.getUser("user") : null) ?? interaction.user;
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
      name: target.displayName,
      iconURL: target.displayAvatarURL(),
    });

  // 自分の通行証は本人のみに見える（ephemeral）。他人を指定した場合も同様にチラ見せ。
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
