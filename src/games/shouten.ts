/**
 * /商店 — 奉納ショップ & 心付け（統合コマンド）
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { handleShopCommand } from "./shop";
import { handleTipCommand } from "./tip";

export const shoutenCommand = new SlashCommandBuilder()
  .setName("商店")
  .setDescription("🛍️ 座敷童の商店（買い物・心付け）")
  .addSubcommand((sub) =>
    sub.setName("購入").setDescription("🛍️ 奉納ショップを開き、称号や特権、座敷童への貢物を購入する")
  )
  .addSubcommand((sub) =>
    sub
      .setName("心付け")
      .setDescription("💸 他のプレイヤーに小判を送る（心づけ）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("送金先").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("送る金額").setRequired(true).setMinValue(100)
      )
      .addStringOption((opt) =>
        opt.setName("message").setDescription("メッセージ（任意）").setRequired(false)
      )
  );

export async function handleShoutenCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "購入") {
    return handleShopCommand(interaction);
  } else if (sub === "心付け") {
    return handleTipCommand(interaction);
  }
}
