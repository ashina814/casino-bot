/**
 * 二つ名（タイトル）一覧パネル
 *
 * カタログの全タイトルを表示し、取得済み / 未取得 を可視化する。
 * `/案内` パネルから「タイトル」ボタンで開く。
 */
import {
  ButtonInteraction,
  EmbedBuilder,
} from "discord.js";
import {
  TITLES_CATALOG,
  RARITY_LABEL,
  getUserTitleKeys,
  getActiveTitleKey,
  TitleRarity,
} from "../../core/titlesCatalog";
import { baseEmbed, COLORS } from "../embeds";
import { safeReply } from "../../core/safeReply";

const CATEGORY_LABEL: Record<string, string> = {
  easter_egg: "🥚 隠し",
  shop: "🛍️ 奉納",
  milestone: "🎯 偉業",
  tribute: "🌸 贈り名",
};

const RARITY_ORDER: TitleRarity[] = ["myth", "legend", "rare", "common"];

export async function showTitlesPanel(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const owned = getUserTitleKeys(userId);
  const active = getActiveTitleKey(userId);

  const totalCount = TITLES_CATALOG.length;
  const ownedCount = TITLES_CATALOG.filter((t) => owned.has(t.key)).length;

  // カテゴリ別 → レアリティ降順 にグループ
  const byCategory = new Map<string, typeof TITLES_CATALOG>();
  for (const t of TITLES_CATALOG) {
    const arr = byCategory.get(t.category) ?? [];
    arr.push(t);
    byCategory.set(t.category, arr);
  }
  for (const [, arr] of byCategory) {
    arr.sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
  }

  const embed = baseEmbed("📜 二つ名 一覧", COLORS.GOLD)
    .setDescription(
      [
        `*「きみが積み上げてきたもの、見せてあげる。」*`,
        "",
        `**取得状況: ${ownedCount} / ${totalCount}**`,
        `**装着中: ${active ? TITLES_CATALOG.find((t) => t.key === active)?.name ?? active : "（なし）"}**`,
      ].join("\n"),
    );

  for (const [cat, arr] of byCategory) {
    const lines = arr.map((t) => {
      const has = owned.has(t.key);
      const mark = has ? "✅" : "🔒";
      const rarity = RARITY_LABEL[t.rarity];
      const display = has ? `**${t.name}**` : `||${t.name}||`;
      const hint = has ? "" : `\n　└ *${t.hint}*`;
      return `${mark} [${rarity}] ${display}${hint}`;
    }).join("\n");
    embed.addFields({ name: CATEGORY_LABEL[cat] ?? cat, value: lines || "(無し)" });
  }

  embed.setFooter({ text: "🔒 未取得は名前が伏せ字（タップで反転表示）。ヒントを頼りに探してみてね。" });

  await safeReply(interaction, { embeds: [embed], ephemeral: true });
}
