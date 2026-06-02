import { ChatInputCommandInteraction, ButtonInteraction, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuInteraction, ComponentType } from "discord.js";
import { adjustBalance, ensureUser, getBalance } from "../core/bank";
import { db, runTransaction } from "../core/db";
import { infoEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";
import { CONSUMABLES, grantItem } from "../core/items";

const SHOP_ITEMS = [
  // 称号
  // 価格は為替OFF（Gil流入なし）でも到達可能な帯に調整。最上位=残高上限◈300,000を頂点に。
  { id: "title_patron", type: "title", name: "【称号】賭場のパトロン", cost: 30_000, desc: "賭場を支える太客の証。" },
  { id: "title_gold", type: "title", name: "【称号】黄金の成金", cost: 100_000, desc: "黄金のオーラを纏う金持ちの証。" },
  { id: "title_zashiki", type: "title", name: "【称号】アステルの寵児", cost: 300_000, desc: "アステルすら手なずける大富豪。" },
  // 使い切り景品（在庫に入る。/商店 使う で装備）
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
      .setCustomId(`shop_select_${userId}`)
      .setPlaceholder("購入する品を選択...")
      .addOptions(options)
  );

  const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 60_000,
    filter: (i) => i.user.id === userId,
  });

  collector.on("collect", async (i: StringSelectMenuInteraction) => {
    const itemId = i.values[0];
    const item = SHOP_ITEMS.find((x) => x.id === itemId)!;

    await i.deferUpdate();

    try {
      const result = runTransaction(() => {
        // 残高チェック
        const currentBalance = (db.prepare("SELECT balance FROM users WHERE user_id = ?").get(userId) as { balance: number }).balance;
        if (currentBalance < item.cost) {
          return { ok: false, reason: "INSUFFICIENT_FUNDS" };
        }

        if (item.type === "title") {
          // すでに持っているかチェック
          const hasTitle = db.prepare("SELECT 1 FROM titles WHERE user_id = ? AND title_key = ?").get(userId, item.id);
          if (hasTitle) {
            return { ok: false, reason: "ALREADY_OWNED" };
          }
          // 購入処理
          adjustBalance(userId, -item.cost, "shop_buy");
          db.prepare("INSERT INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)").run(userId, item.id, item.name.replace("【称号】", ""));
        } else if (item.type === "consumable") {
          adjustBalance(userId, -item.cost, "shop_buy");
          grantItem(userId, item.id, 1);
        }

        return { ok: true };
      });

      if (!result.ok) {
        if (result.reason === "INSUFFICIENT_FUNDS") {
          await i.followUp({ embeds: [errorEmbed("エテルが足りないよ。冷やかしなら、また今度ね。")], ephemeral: true });
        } else if (result.reason === "ALREADY_OWNED") {
          await i.followUp({ embeds: [errorEmbed("それはもう持ってるよ。")], ephemeral: true });
        }
        return;
      }

      // 購入成功の演出
      if (item.type === "consumable") {
        await reply.edit({ components: [] });
        await i.followUp({ embeds: [successEmbed(`**${item.name}** を手に入れたよ。\n\n`+"商店の **「使う」** で装備すると、次の勝負で効くよ。")], ephemeral: true });
      } else {
        await reply.edit({ components: [] });
        await i.followUp({ embeds: [successEmbed(`**${item.name}** を購入しました！\n\n「毎度あり。/通行証 で確認できるよ。」`)], ephemeral: true });
      }
    } catch (error) {
      console.error("[shop] Error:", error);
      await i.followUp({ embeds: [errorEmbed("処理に失敗しちゃった。")], ephemeral: true });
    }
  });

  collector.on("end", async () => {
    try { await reply.edit({ components: [] }); } catch {}
  });
}
