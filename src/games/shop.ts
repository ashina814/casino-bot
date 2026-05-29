import { ChatInputCommandInteraction, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuInteraction, ComponentType } from "discord.js";
import { adjustBalance, ensureUser, getBalance } from "../core/bank";
import { db, runTransaction } from "../core/db";
import { infoEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";

const SHOP_ITEMS = [
  // 称号
  { id: "title_patron", type: "title", name: "【称号】賭場のパトロン", cost: 100_000, desc: "賭場を支える太客の証。" },
  { id: "title_gold", type: "title", name: "【称号】黄金の成金", cost: 500_000, desc: "黄金のオーラを纏う金持ちの証。" },
  { id: "title_zashiki", type: "title", name: "【称号】座敷童の飼い主", cost: 1_000_000, desc: "座敷童すら手なずける大富豪。" },
  // 実用品
  { id: "hint_stock", type: "consumable", name: "【秘匿】龍脈相場の裏情報", cost: 5_000, desc: "現在の相場のトレンドをこっそり教えてもらう。" },
  // プレゼント（好感度）
  { id: "present_dango", type: "present", name: "🍡 三色団子（座敷童へ）", cost: 1_000, desc: "座敷童にプレゼントする。少しだけ喜ぶ。（好感度+1）", affection: 1 },
  { id: "present_sake", type: "present", name: "🍶 特上お神酒（座敷童へ）", cost: 10_000, desc: "座敷童にプレゼントする。かなり喜ぶ。（好感度+15）", affection: 15 },
  { id: "present_kimono", type: "present", name: "👘 絹の着物（座敷童へ）", cost: 100_000, desc: "座敷童にプレゼントする。飛び跳ねて喜ぶ。（好感度+200）", affection: 200 },
];

export async function handleShopCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  ensureUser(userId, guildId);

  const balance = getBalance(userId, guildId);

  const embed = infoEmbed(
    "🛍️ 奉納ショップ",
    "「ようこそ、客人。余った小判で特別な品と交換してやろう。\nただし、一度買ったものは返品できぬぞ？」",
    COLORS.GOLD
  ).addFields({
    name: `あなたの所持金: ◈${balance.toLocaleString()}`,
    value: "購入したい品を下のメニューから選ぶのじゃ。",
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

  const reply = await interaction.reply({ embeds: [embed], components: [row] });

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
        } else if (item.type === "present") {
          adjustBalance(userId, -item.cost, "shop_present");
          const { addAffection } = require("../core/db");
          addAffection(userId, item.affection!);
          
          // 愛弟子称号の自動付与チェック
          const { getAffection } = require("../core/db");
          if (getAffection(userId) >= 500) {
             db.prepare("INSERT OR IGNORE INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)").run(userId, "title_disciple", "座敷童の愛弟子");
          }
        }

        return { ok: true };
      });

      if (!result.ok) {
        if (result.reason === "INSUFFICIENT_FUNDS") {
          await i.followUp({ embeds: [errorEmbed("小判が足りぬぞ。冷やかしなら帰るのじゃ。")], ephemeral: true });
        } else if (result.reason === "ALREADY_OWNED") {
          await i.followUp({ embeds: [errorEmbed("それはすでに持っておるじゃろ。")], ephemeral: true });
        }
        return;
      }

      // 購入成功の演出
      if (item.id === "hint_stock") {
        const stocks = db.prepare("SELECT name, emoji, trend FROM stocks ORDER BY ABS(trend) DESC LIMIT 1").all() as { name: string; emoji: string; trend: number }[];
        let hintMsg = "今は特に動きがないようじゃの。";
        if (stocks.length > 0) {
          const target = stocks[0];
          hintMsg = `「…いいじゃろう。『${target.emoji}${target.name}』が${target.trend > 0 ? "これから上がる" : "これから落ちる"}はずじゃ。誰にも言うなよ？」`;
        }
        await reply.edit({ components: [] });
        await i.followUp({ embeds: [successEmbed(`**${item.name}** を購入しました！\n\n${hintMsg}`)] });
      } else if (item.type === "present") {
        let zashikiReply = "";
        if (item.id === "present_dango") zashikiReply = "「おや、団子か。ありがたく貰っておこう。…むぐむぐ。悪くない味じゃ。」";
        if (item.id === "present_sake") zashikiReply = "「おおっ！これは上等な酒じゃな！…かぁ～っ！五臓六腑に染み渡るわい！お主、分かっておるのう！」";
        if (item.id === "present_kimono") zashikiReply = "「こ、これは…絹の着物！？こんな高価なものをわしに…！？\n……あ、ありがと、な。大切に着させてもらうぞ。」";
        
        await reply.edit({ components: [] });
        await i.followUp({ embeds: [successEmbed(`**${item.name}** を座敷童に贈りました！\n\n${zashikiReply}`)] });
      } else {
        await reply.edit({ components: [] });
        await i.followUp({ embeds: [successEmbed(`**${item.name}** を購入しました！\n\n「毎度あり！ /通行証 で確認できるぞ。」`)] });
      }
    } catch (error) {
      console.error("[shop] Error:", error);
      await i.followUp({ embeds: [errorEmbed("処理に失敗したぞ。")], ephemeral: true });
    }
  });

  collector.on("end", async () => {
    try { await reply.edit({ components: [] }); } catch {}
  });
}
