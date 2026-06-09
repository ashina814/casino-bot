import { ChatInputCommandInteraction, ButtonInteraction, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuInteraction } from "discord.js";
import { adjustBalance, ensureUser, getBalance } from "../core/bank";
import { db, runTransaction } from "../core/db";
import { infoEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";
import { CONSUMABLES, grantItem } from "../core/items";

const SHOP_ITEMS = [
  // ─── 称号（奉納 = 一度購入で恒久取得） ───
  // 価格帯は新しいティア上限（北極星=◈500万）と連動。最上位は cap いっぱい。
  { id: "title_patron",   type: "title", name: "【称号】賭場のパトロン",   cost:    30_000, desc: "賭場を支える太客の証。" },
  { id: "title_gold",     type: "title", name: "【称号】黄金の成金",       cost:   100_000, desc: "黄金のオーラを纏う金持ちの証。" },
  { id: "title_zashiki",  type: "title", name: "【称号】アステルの寵児",   cost:   300_000, desc: "アステルすら手なずける大富豪。" },
  { id: "title_warden",   type: "title", name: "【称号】星溜まりの番人",   cost:   800_000, desc: "JPプールに大きく奉納し続けた者。" },
  { id: "title_master",   type: "title", name: "【称号】賭場の主",         cost: 2_000_000, desc: "この賭場を支配せんとする太客。" },
  { id: "title_polestar", type: "title", name: "【称号】北極星の使徒",     cost: 5_000_000, desc: "頂点に至りし者だけが纏える光。" },

  // ─── 使い切り景品（在庫に入る。/商店 使う で装備） ───
  ...CONSUMABLES.map((c) => ({ id: c.key, type: "consumable" as const, name: `🎴 ${c.name}`, cost: c.price, desc: `${c.desc}（/商店 使う で装備）` })),
  // ※ アステルへの贈り物は /アステル 贈り物 に移設
];

export async function handleShopCommand(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  ensureUser(userId, guildId);

  const balance = getBalance(userId, guildId);

  const embed = infoEmbed(
    "🛍️ 奉納ショップ",
    "「いらっしゃい。余ったエテルで、特別な品と交換できるよ。\nただし、一度買ったものは返品できないからね？」",
    COLORS.GOLD
  ).addFields({
    name: `あなたの所持金: ◈${balance.toLocaleString()}`,
    value: "買いたい品を下のメニューから選んでね。",
  });

  const options = SHOP_ITEMS.map((item) => ({
    label: `${item.name} (◈${item.cost.toLocaleString()})`,
    value: item.id,
    description: item.desc,
  }));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("shop_select")
      .setPlaceholder("購入する品を選択...")
      .addOptions(options)
  );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

/** 商店セレクト（グローバル処理・コレクター不使用で堅牢に） */
export async function handleShopSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const itemId = interaction.values[0];
  const item = SHOP_ITEMS.find((x) => x.id === itemId);
  if (!item) { await interaction.reply({ embeds: [errorEmbed("その品は見つからないや。")], ephemeral: true }); return; }

  const result = runTransaction<{ ok: boolean; reason?: string }>(() => {
    const currentBalance = (db.prepare("SELECT balance FROM users WHERE user_id = ?").get(userId) as { balance: number } | undefined)?.balance ?? 0;
    if (currentBalance < item.cost) return { ok: false, reason: "INSUFFICIENT_FUNDS" };

    if (item.type === "title") {
      const hasTitle = db.prepare("SELECT 1 FROM titles WHERE user_id = ? AND title_key = ?").get(userId, item.id);
      if (hasTitle) return { ok: false, reason: "ALREADY_OWNED" };
      adjustBalance(userId, -item.cost, "shop_buy", undefined, guildId);
      db.prepare("INSERT INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)").run(userId, item.id, item.name.replace("【称号】", ""));
    } else if (item.type === "consumable") {
      adjustBalance(userId, -item.cost, "shop_buy", undefined, guildId);
      grantItem(userId, item.id, 1);
    }
    return { ok: true };
  });

  if (!result.ok) {
    const msg = result.reason === "INSUFFICIENT_FUNDS" ? "エテルが足りないよ。冷やかしなら、また今度ね。"
      : result.reason === "ALREADY_OWNED" ? "それはもう持ってるよ。" : "処理に失敗しちゃった。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  const text = item.type === "consumable"
    ? `**${item.name}** を手に入れたよ。\n\n商店の **「使う」** で装備すると、次の勝負で効くよ。`
    : `**${item.name}** を購入しました！\n\n「毎度あり。/通行証 で確認できるよ。」`;
  // 元のセレクトを消費済みにする（任意・失敗は無視）
  await interaction.update({ components: [] }).catch(() => {});
  await interaction.followUp({ embeds: [successEmbed(text)], ephemeral: true });
}
