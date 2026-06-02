/**
 * /zashiki — 座敷童の覚醒状況確認 & モード切替
 *
 * サブコマンド:
 *   /zashiki status  — 現在の覚醒段階・好感度を表示
 *   /zashiki mode    — セリフモード切替 (default / tsundere / yami / zense)
 *
 * 注: 旧「五行属性」は廃止（WORLD.md で三星＝星の盟約に統合、派閥はシーズン2送り）。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import {
  getAffection, getAffectionMode, setAffectionMode,
} from "../core/db";
import {
  getStage, getNextStage, affectionToNextStage,
} from "../core/zashikiStage";

// ─── Command ───────────────────────────────────────────

export const zashikiCommand = new SlashCommandBuilder()
  .setName("アステル")
  .setDescription("アステルとの星約（覚醒）を確認する")
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("星約段階・好感度を表示")
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
  );

// ─── Handlers ──────────────────────────────────────────

export async function handleZashikiCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "status") return handleStatus(interaction);
  if (sub === "mode") return handleMode(interaction);
}

// ─── Status ────────────────────────────────────────────

export async function handleStatus(interaction: ChatInputCommandInteraction | import("discord.js").ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const affection = getAffection(userId);
  const stage = getStage(affection);
  const remaining = affectionToNextStage(affection);
  const mode = getAffectionMode(userId);

  const maxStage = 6;
  const filled = Math.round((stage.level / maxStage) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);

  const modeLabels: Record<string, string> = {
    default: "☾ 常",
    tsundere: "✦ 拗ね",
    yami: "☄ 蝕",
    zense: "◌ 前世（座敷童）",
  };

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
          .setFooter({ text: "（この言葉は、きみにしか届かない）" }),
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
