/**
 * /商店 — ショップ & 心付け & 持ち物 & 使う（統合コマンド）
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { handleShopCommand } from "./shop";
import { CONSUMABLES, getConsumableDef, getInventory, getArmed, armItem } from "../core/items";
import { baseEmbed, errorEmbed } from "../ui/embeds";
import { PALETTE } from "../world.config";

export const shoutenCommand = new SlashCommandBuilder()
  .setName("商店")
  .setDescription("🛍️ アステルの商店（買い物・持ち物・心付け）")
  .addSubcommand((sub) =>
    sub.setName("購入").setDescription("🛍️ 称号・使い切り景品を買う（アステルへの贈り物は /アステル 贈り物）")
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
  );

export async function handleShoutenCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "購入") return handleShopCommand(interaction);
  if (sub === "持ち物") return handleInventory(interaction);
  if (sub === "使う") return handleUse(interaction);
}

// ─── 常設パネル ─────────────────────────────────────── /管理 商店設置 から呼ばれる
export async function postShopPanel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "このコマンドは管理者だけが使えるよ。", ephemeral: true });
    return;
  }
  const embed = baseEmbed("🛍️ アステルの商店", PALETTE.STARGOLD).setDescription(
    [
      "*「いらっしゃい。余ったエテルで、特別な品と交換できるよ。」*",
      "",
      "🛍️ **購入** … 称号・使い切り景品（アステルへの贈り物は `/アステル 贈り物`）",
      "🎒 **持ち物** … 手持ちと装備中の効果を見る",
      "✨ **使う** … 使い切り景品を装備（次の勝負で発動）",
      "",
      "下のボタンからどうぞ。表示はあなたにだけ見えるよ。",
    ].join("\n"),
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shouten:buy").setLabel("購入").setStyle(ButtonStyle.Success).setEmoji("🛍️"),
    new ButtonBuilder().setCustomId("shouten:inv").setLabel("持ち物").setStyle(ButtonStyle.Secondary).setEmoji("🎒"),
    new ButtonBuilder().setCustomId("shouten:use").setLabel("使う").setStyle(ButtonStyle.Primary).setEmoji("✨"),
  );
  await interaction.reply({ embeds: [embed], components: [row] });
}

// ─── パネルのボタン ───────────────────────────────────
export async function handleShoutenButton(interaction: ButtonInteraction): Promise<void> {
  const [, action] = interaction.customId.split(":");
  if (action === "buy") return handleShopCommand(interaction);
  if (action === "inv") return handleInventory(interaction);
  if (action === "use") return openUseSelect(interaction);
}

// 「使う」: 手持ちの使い切り景品をセレクトで選んで装備
async function openUseSelect(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const inv = getInventory(userId);
  if (inv.length === 0) {
    await interaction.reply({ embeds: [errorEmbed("装備できる景品を持ってないよ。先に「購入」で手に入れてね。")], ephemeral: true });
    return;
  }
  const armed = new Set(getArmed(userId));
  const options = inv.map((r) => {
    const def = getConsumableDef(r.key);
    return {
      label: `${def?.name ?? r.key} ×${r.quantity}`,
      value: r.key,
      description: armed.has(r.key) ? "装備中" : (def?.desc ?? "").slice(0, 90),
    };
  });
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("shouten:use_select").setPlaceholder("装備する景品を選ぶ…").addOptions(options),
  );
  await interaction.reply({ embeds: [baseEmbed("✨ 使う景品を選んで", PALETTE.JADE)], components: [row], ephemeral: true });
}

/** 商店パネルのセレクト（グローバル処理） */
export async function handleShoutenSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, action] = interaction.customId.split(":");
  if (action !== "use_select") return;
  const userId = interaction.user.id;
  const key = interaction.values[0];
  const def = getConsumableDef(key);
  const res = armItem(userId, key);
  if (!res.ok) {
    const msg = res.reason === "NO_STOCK" ? `**${def?.name ?? key}** を持ってないよ。`
      : res.reason === "ALREADY_ARMED" ? `**${def?.name ?? key}** はもう装備してるよ。` : "装備できなかったよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }
  await interaction.update({ components: [] }).catch(() => {});
  await interaction.followUp({ embeds: [baseEmbed(`✨ ${def?.name ?? key} を装備した`, PALETTE.JADE).setDescription(`${def?.desc ?? ""}\n\n次の勝負で自動発動して消費されるよ。`)], ephemeral: true });
}

// ─── 持ち物 ───────────────────────────────────────────
async function handleInventory(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
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
