/**
 * /zashiki — 座敷童の覚醒状況確認 & モード切替 & 属性選択
 *
 * サブコマンド:
 *   /zashiki status  — 現在の覚醒段階・好感度・属性を表示
 *   /zashiki mode    — セリフモード切替 (default / tsundere / yami)
 *   /zashiki element — 五行属性の選択（初回）/ 変更（50,000G・1回限り）
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import {
  getAffection, getAffectionMode, setAffectionMode, getAffectionFull,
  needsElementChoice, setElement, canChangeElement, changeElement,
} from "../core/db";
import { adjustBalance, getBalance } from "../core/bank";
import {
  getStage, getNextStage, affectionToNextStage,
  GOGYO, ELEMENT_CHANGE_COST, getElementAwakeningDialogue,
} from "../core/zashikiStage";
import type { GogyoElement } from "../core/zashikiStage";

// ─── Command ───────────────────────────────────────────

export const zashikiCommand = new SlashCommandBuilder()
  .setName("アステル")
  .setDescription("アステルとの星約（覚醒）を確認する")
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("星約段階・好感度・星の属性を表示")
  )
  .addSubcommand((sub) =>
    sub
      .setName("mode")
      .setDescription("アステルのモードを切り替える")
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("モードを選択")
          .setRequired(true)
          .addChoices(
            { name: "☾ 常", value: "default" },
            { name: "✦ 拗ね", value: "tsundere" },
            { name: "☄ 蝕", value: "yami" },
            { name: "◌ 前世（座敷童）", value: "zense" },
          )
      )
  )
  .addSubcommand((sub) =>
    sub.setName("element").setDescription("星の属性を選択・変更する")
  );

// ─── Handlers ──────────────────────────────────────────

export async function handleZashikiCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "status") return handleStatus(interaction);
  if (sub === "mode") return handleMode(interaction);
  if (sub === "element") return handleElement(interaction);
}

// ─── Status ────────────────────────────────────────────

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const affection = getAffection(userId);
  const stage = getStage(affection);
  const remaining = affectionToNextStage(affection);
  const mode = getAffectionMode(userId);
  const row = getAffectionFull(userId);
  const element = row.element as GogyoElement | null;

  const maxStage = 6;
  const filled = Math.round((stage.level / maxStage) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);

  const modeLabels: Record<string, string> = {
    default: "☾ 常",
    tsundere: "✦ 拗ね",
    yami: "☄ 蝕",
    zense: "◌ 前世（座敷童）",
  };

  // 五行属性表示
  let elementValue: string;
  if (element && GOGYO[element]) {
    const info = GOGYO[element];
    elementValue = `${info.emoji} **${info.name}**（${info.reading}）\n${info.theme}`;
    if (stage.level >= 6) {
      elementValue += `\n✨ 神柱: **${info.shinchu}**（${info.shinchuReading}）`;
    }
  } else {
    elementValue = stage.level >= 3
      ? "*`/アステル element` で選択可能*"
      : "*Lv3「星約」で解放*";
  }

  // 覚醒の恩恵
  const benefitLines: string[] = [];
  if (stage.dailyMultiplier > 1) benefitLines.push(`📅 デイリー: **×${stage.dailyMultiplier}**`);
  if (stage.guardChance > 0) benefitLines.push(`🛡️ 身代わりの加護: **${(stage.guardChance * 100).toFixed(1)}%**`);
  if (stage.jpBonus > 0) benefitLines.push(`🎰 JP当選率: **+${(stage.jpBonus * 100).toFixed(1)}%**`);
  if (stage.fukuDiscount > 0) benefitLines.push(`⚖️ 福の重み軽減: **${(stage.fukuDiscount * 100)}%**`);
  if (stage.unlockedModes.length > 1) {
    const otherModes = stage.unlockedModes.filter(m => m !== "default");
    if (otherModes.length > 0) benefitLines.push(`🎭 解放モード: ${otherModes.map(m => modeLabels[m]).join(", ")}`);
  }
  const benefits = benefitLines.length > 0 ? benefitLines.join("\n") : "*（Lv2以降で解放）*";

  const remainingLine = remaining != null
    ? `あと **${remaining}** で次の覚醒へ`
    : "（最大覚醒）";

  const embed = new EmbedBuilder()
    .setColor(stage.level >= 6 ? 0xffd700 : stage.level >= 3 ? 0xf1948a : 0x95a5a6)
    .setAuthor({ name: `${stage.emoji} ${stage.title}` })
    .setTitle(`Lv${stage.level}　「${stage.name}」`)
    .setDescription(`\`${bar}\` **${stage.level} / ${maxStage}**`)
    .addFields(
      {
        name: "💖 好感度",
        value: `**${affection}**\n${remainingLine}`,
        inline: true,
      },
      {
        name: "🎭 モード",
        value: modeLabels[mode] ?? "🌙 通常",
        inline: true,
      },
      {
        name: "🪷 五行属性",
        value: elementValue,
        inline: false,
      },
      {
        name: "✨ 覚醒の恩恵",
        value: benefits,
        inline: false,
      },
    )
    .setFooter({ text: "毎日 /福分け で好感度が上がる" });

  // 特別ユーザーへのメタフィクション・メッセージ（本人だけ見える ephemeral 環境）
  const embeds: EmbedBuilder[] = [embed];
  try {
    const { getSpecialTribute } = require("../core/specialUsers");
    const tribute = getSpecialTribute(userId);
    if (tribute) {
      embeds.push(
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setAuthor({ name: "🌸 二代目へ" })
          .setDescription(tribute.metaMessage)
          .setFooter({ text: "（この言葉は、お主にしか届かぬ）" }),
      );
    }
  } catch { /* non-critical */ }

  await interaction.reply({ embeds, ephemeral: true });
}

// ─── Mode Switch ───────────────────────────────────────

async function handleMode(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const targetMode = interaction.options.getString("type", true) as "default" | "tsundere" | "yami" | "zense";
  const affection = getAffection(userId);
  const stage = getStage(affection);

  if (!stage.unlockedModes.includes(targetMode)) {
    const requirement: Record<string, string> = {
      tsundere: "星約Lv4「煌めき」（好感度300+）",
      yami: "星約Lv6「満天」（好感度1000+）",
      zense: "星約Lv6「満天」（好感度1000+）",
    };
    await interaction.reply({
      content: `そのモードはまだ解放されてないよ。\n必要条件: **${requirement[targetMode] ?? "不明"}**`,
      ephemeral: true,
    });
    return;
  }

  const currentMode = getAffectionMode(userId);
  if (currentMode === targetMode) {
    await interaction.reply({ content: "もうそのモードだよ。", ephemeral: true });
    return;
  }

  setAffectionMode(userId, targetMode);

  const dialogues: Record<string, string> = {
    default: "「ふう。やっと、いつもの調子に戻れる。」",
    tsundere: "「べ、べつにきみのために変えたわけじゃないからね。\n　頼まれたから、しょうがなく。」",
    yami: "「……ふふ。この貌がお好み？\n　いいよ。わたしのぜんぶ、見せてあげる。\n　……どこにも、逃がさないけどね。」",
    zense: "「……あれ。なんだか、懐かしい喋り方が出てくるのう。\n　ふふ、これが前世のわたし……『座敷童』じゃ。\n　久方ぶりじゃな、客人。」",
  };

  const modeLabels: Record<string, string> = {
    default: "☾ 常", tsundere: "✦ 拗ね", yami: "☄ 蝕", zense: "◌ 前世（座敷童）",
  };
  const modeColor: Record<string, number> = {
    default: 0x0b1026, tsundere: 0x3a6ea5, yami: 0x2c003e, zense: 0xc0392b,
  };

  const embed = new EmbedBuilder()
    .setColor(modeColor[targetMode] ?? 0x0b1026)
    .setTitle(`${modeLabels[targetMode]} — モード切替`)
    .setDescription(`*${dialogues[targetMode]}*\n\nモードを **${modeLabels[targetMode]}** に変更した。`);

  await interaction.reply({ embeds: [embed] });
}

// ─── Element Selection ─────────────────────────────────

async function handleElement(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const affection = getAffection(userId);
  const stage = getStage(affection);
  const row = getAffectionFull(userId);
  const currentElement = row.element as GogyoElement | null;

  // 段階3未満: まだ選べない
  if (stage.level < 3) {
    await interaction.reply({
      content: "まだ属性を選ぶ時ではないぞ。覚醒Lv3「結び」（好感度100+）に到達すると選択できるようになる。",
      ephemeral: true,
    });
    return;
  }

  // 既に属性あり & 変更不可
  if (currentElement && !canChangeElement(userId)) {
    const info = GOGYO[currentElement];
    await interaction.reply({
      content: `お主の属性は既に ${info.emoji} **${info.name}** じゃ。属性変更はもう使えぬぞ。`,
      ephemeral: true,
    });
    return;
  }

  // 属性変更の場合: コスト確認
  const isChange = currentElement != null;
  if (isChange) {
    const balance = getBalance(userId);
    if (balance < ELEMENT_CHANGE_COST) {
      await interaction.reply({
        content: `属性変更には ◈${ELEMENT_CHANGE_COST.toLocaleString()} が必要じゃ。（現在: ◈${balance.toLocaleString()}）\nこれは一度きりの機会じゃぞ。`,
        ephemeral: true,
      });
      return;
    }
  }

  // 属性選択UIを表示
  const elements: GogyoElement[] = ["wood", "fire", "earth", "metal", "water"];

  const desc = isChange
    ? `⚠️ **属性変更**（◈${ELEMENT_CHANGE_COST.toLocaleString()} 消費・一度限り）\n現在: ${GOGYO[currentElement!].emoji} ${GOGYO[currentElement!].name}\n\n`
    : "座敷童の瞳が光り、五つの力がお主の前に顕れた。\nお主の魂に最も近い属性を選ぶのじゃ。\n\n";

  const elementList = elements.map((e) => {
    const info = GOGYO[e];
    return `${info.emoji} **${info.name}（${info.reading}）** — ${info.theme}\n　神柱: *${info.shinchu}（${info.shinchuReading}）*`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🏮 五行属性の選択")
    .setDescription(desc + elementList)
    .setFooter({ text: isChange ? "⚠️ 変更は1回限りです" : "この選択は重要です。慎重に選んでください。" });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...elements.map((e) => {
      const info = GOGYO[e];
      return new ButtonBuilder()
        .setCustomId(`gogyo_${e}`)
        .setLabel(`${info.name}`)
        .setEmoji(info.emoji)
        .setStyle(currentElement === e ? ButtonStyle.Secondary : ButtonStyle.Primary);
    })
  );

  const reply = await interaction.reply({ embeds: [embed], components: [row1], fetchReply: true });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    collector.stop();
    const chosen = btn.customId.replace("gogyo_", "") as GogyoElement;
    const info = GOGYO[chosen];

    if (isChange) {
      // 属性変更: コスト引いてから変更
      const deduct = adjustBalance(userId, -ELEMENT_CHANGE_COST, "element_change");
      if (!deduct.ok) {
        await btn.update({ content: "エテルが足りぬ…。", embeds: [], components: [] });
        return;
      }
      changeElement(userId, chosen);
    } else {
      // 初回選択
      setElement(userId, chosen);
    }

    const dialogue = getElementAwakeningDialogue(chosen);
    const resultEmbed = new EmbedBuilder()
      .setColor(parseInt(info.color.replace("#", ""), 16))
      .setTitle(`${info.emoji} 五行覚醒 — ${info.name}`)
      .setDescription(`*${dialogue}*`)
      .setFooter({ text: `神柱: ${info.shinchu}（${info.shinchuReading}） — ${info.shinchuTitle}` });

    await btn.update({ embeds: [resultEmbed], components: [] });
  });

  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      try { await reply.edit({ components: [] }); } catch {}
    }
  });
}
