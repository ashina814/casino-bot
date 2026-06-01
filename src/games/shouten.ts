/**
 * /商店 — ショップ & 心付け & 持ち物 & 使う（統合コマンド）
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { handleShopCommand } from "./shop";
import { handleTipCommand } from "./tip";
import { CONSUMABLES, getConsumableDef, getInventory, getArmed, armItem } from "../core/items";
import { baseEmbed, errorEmbed } from "../ui/embeds";
import { PALETTE } from "../world.config";

export const shoutenCommand = new SlashCommandBuilder()
  .setName("商店")
  .setDescription("🛍️ アステルの商店（買い物・持ち物・心付け）")
  .addSubcommand((sub) =>
    sub.setName("購入").setDescription("🛍️ 称号・使い切り景品・アステルへの贈り物を買う")
  )
  .addSubcommand((sub) =>
    sub.setName("持ち物").setDescription("🎒 手持ちの使い切り景品と装備中の効果を見る")
  )
  .addSubcommand((sub) =>
    sub
      .setName("使う")
      .setDescription("✨ 使い切り景品を装備する（次の勝負で発動）")
      .addStringOption((opt) =>
        opt.setName("アイテム").setDescription("装備するアイテム").setRequired(true)
          .addChoices(...CONSUMABLES.map((c) => ({ name: c.name, value: c.key })))
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("心付け")
      .setDescription("💸 他のプレイヤーにエテルを送る（心づけ）")
      .addUserOption((opt) => opt.setName("user").setDescription("送金先").setRequired(true))
      .addIntegerOption((opt) => opt.setName("amount").setDescription("送る金額").setRequired(true).setMinValue(100))
      .addStringOption((opt) => opt.setName("message").setDescription("メッセージ（任意）").setRequired(false))
  );

export async function handleShoutenCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "購入") return handleShopCommand(interaction);
  if (sub === "心付け") return handleTipCommand(interaction);
  if (sub === "持ち物") return handleInventory(interaction);
  if (sub === "使う") return handleUse(interaction);
}

// ─── 持ち物 ───────────────────────────────────────────
async function handleInventory(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const inv = getInventory(userId);
  const armed = new Set(getArmed(userId));

  const invLines = inv.length
    ? inv.map((r) => {
        const def = getConsumableDef(r.key);
        return `🎴 **${def?.name ?? r.key}** ×${r.quantity}`;
      }).join("\n")
    : "*手持ちなし*";

  const armedLines = armed.size
    ? [...armed].map((k) => `✨ **${getConsumableDef(k)?.name ?? k}**`).join("\n")
    : "*装備なし*";

  const embed = baseEmbed("🎒 持ち物", PALETTE.STARGOLD)
    .addFields(
      { name: "在庫", value: invLines, inline: false },
      { name: "装備中（発動待ち）", value: armedLines, inline: false },
    )
    .setFooter({ text: "`/商店 使う` で装備 → 次の勝負で自動発動して消費されるよ。" });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── 使う（装備） ─────────────────────────────────────
async function handleUse(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const key = interaction.options.getString("アイテム", true);
  const def = getConsumableDef(key);
  if (!def) { await interaction.reply({ embeds: [errorEmbed("そのアイテムは無いみたい。")], ephemeral: true }); return; }

  const res = armItem(userId, key);
  if (!res.ok) {
    const msg = res.reason === "NO_STOCK" ? `**${def.name}** を持ってないよ。先に \`/商店 購入\` で手に入れてね。`
      : res.reason === "ALREADY_ARMED" ? `**${def.name}** はもう装備してるよ。`
      : "装備できなかったよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  const when = def.kind === "armed_win" ? "次に勝った時に発動するよ。"
    : def.kind === "armed_loss" ? "次に負けた時に発動するよ。"
    : def.kind === "game_reroll" ? "次のチンチロで振り直せるよ。"
    : "次に株を開いた時に発動するよ。";
  const embed = baseEmbed(`✨ ${def.name} を装備した`, PALETTE.JADE)
    .setDescription(`${def.desc}\n\n${when}`);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
