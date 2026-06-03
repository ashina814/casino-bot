/**
 * /アステル — アステルとの関わり（状態・モード・贈り物・お礼）に集約
 *
 * サブコマンド:
 *   status   — 星約段階・好感度を表示
 *   mode     — セリフモード切替 (default / tsundere / yami / zense)
 *   贈り物    — エテルで贈り物 → 好感度UP
 *   お礼      — アステルにお礼を言う（旧 /感謝）
 *
 * 注: 旧「五行属性」は廃止（WORLD.md で三星＝星の盟約に統合、派閥はシーズン2送り）。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import {
  getAffection, getAffectionMode, setAffectionMode, addAffection, db, runTransaction,
} from "../core/db";
import { adjustBalance, ensureUser, getBalance } from "../core/bank";
import {
  getStage, getNextStage, affectionToNextStage,
} from "../core/zashikiStage";
import { handleThanksCommand } from "./thanks";
import { baseEmbed, errorEmbed, successEmbed, infoEmbed, COLORS } from "../ui/embeds";
import { formatEther } from "../world.config";

// アステルへの贈り物（旧・商店の present を移植）
const GIFTS = [
  { id: "dango", name: "🍡 星屑の菓子", cost: 1_000, affection: 1, reply: "わ、お菓子だ。ありがと、もらうね。……んむ。うん、悪くない。" },
  { id: "sake", name: "🍶 月光の雫", cost: 10_000, affection: 15, reply: "わ、月光の雫……！ きれい。……んく。あー、五臓六腑に染みる。きみ、わかってるなあ。" },
  { id: "kimono", name: "✨ 星織の衣", cost: 100_000, affection: 200, reply: "これ、星織の衣……！？ こんな高価なもの、わたしに……？\n……あ、ありがと。大事に着るね。" },
];

// ─── Command ───────────────────────────────────────────

export const zashikiCommand = new SlashCommandBuilder()
  .setName("アステル")
  .setDescription("アステルとの関わり（状態・モード・贈り物・お礼）をまとめたパネル");

const MODE_LABELS: Record<string, string> = {
  default: "☾ 常", tsundere: "✦ 拗ね", yami: "☄ 蝕", zense: "◌ 前世（座敷童）",
};

// ─── Handlers ──────────────────────────────────────────

export async function handleZashikiCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  return openAstelPanel(interaction);
}

/** /アステル パネル（自分だけに見える）。状態サマリー＋モード/贈り物/お礼ボタン。 */
export async function openAstelPanel(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const embeds = buildStatusEmbeds(interaction.user.id);
  const stage = getStage(getAffection(interaction.user.id));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("aste:mode").setLabel("モード").setStyle(ButtonStyle.Secondary).setEmoji("🎭").setDisabled(stage.unlockedModes.length <= 1),
    new ButtonBuilder().setCustomId("aste:gift").setLabel("贈り物").setStyle(ButtonStyle.Primary).setEmoji("🎁"),
    new ButtonBuilder().setCustomId("aste:thanks").setLabel("お礼").setStyle(ButtonStyle.Secondary).setEmoji("🙏"),
  );
  await interaction.reply({ embeds, components: [row], ephemeral: true });
}

export async function handleAstelButton(interaction: ButtonInteraction): Promise<void> {
  const [, action] = interaction.customId.split(":");
  if (action === "mode") return openModeSelect(interaction);
  if (action === "gift") return handleGift(interaction);
  if (action === "thanks") return handleThanksCommand(interaction);
}

export async function handleAstelSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, action] = interaction.customId.split(":");
  if (action === "setmode") return applyMode(interaction, interaction.values[0] as ModeKey);
}

// ─── 贈り物 ────────────────────────────────────────────
async function handleGift(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  ensureUser(userId, guildId);

  const embed = infoEmbed("🎁 アステルへの贈り物", "*「わたしに……？ ……ふふ、なに？ 開けていい？」*\n\n下から選んでね。喜ぶと好感度が上がるよ。", COLORS.GOLD)
    .addFields({ name: `所持金: ${formatEther(getBalance(userId, guildId))}`, value: GIFTS.map((g) => `${g.name} — ${formatEther(g.cost)}（好感度+${g.affection}）`).join("\n") });
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`gift_select_${userId}`).setPlaceholder("贈り物を選ぶ…")
      .addOptions(GIFTS.map((g) => ({ label: `${g.name}（${formatEther(g.cost)}）`, value: g.id, description: `好感度+${g.affection}` }))),
  );
  const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });

  const collector = reply.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60_000, filter: (i) => i.user.id === userId });
  collector.on("collect", async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    const gift = GIFTS.find((g) => g.id === sel.values[0]);
    if (!gift) return;
    const res = runTransaction<{ ok: boolean }>(() => {
      const bal = (db.prepare("SELECT balance FROM users WHERE user_id = ?").get(userId) as { balance: number }).balance;
      if (bal < gift.cost) return { ok: false };
      adjustBalance(userId, -gift.cost, "アステルへの贈り物", "gift", guildId);
      addAffection(userId, gift.affection);
      if (getAffection(userId) >= 500) {
        db.prepare("INSERT OR IGNORE INTO titles (user_id, title_key, title_name) VALUES (?, ?, ?)").run(userId, "title_disciple", "アステルの愛弟子");
      }
      return { ok: true };
    });
    if (!res.ok) { await sel.followUp({ embeds: [errorEmbed("エテルが足りないみたい。")], ephemeral: true }); return; }
    await reply.edit({ components: [] }).catch(() => {});
    await sel.followUp({ embeds: [successEmbed(`**${gift.name}** を贈ったよ。\n\n*「${gift.reply}」*\n\n（好感度 +${gift.affection}）`)], ephemeral: true });
  });
  collector.on("end", async () => { try { await reply.edit({ components: [] }); } catch {} });
}

// ─── Status（パネルの中身を組み立てる） ────────────────

function buildStatusEmbeds(userId: string): EmbedBuilder[] {
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
    .setFooter({ text: "毎日 福分け（案内パネル）で好感度が上がる" });

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

  return embeds;
}

// ─── Mode Switch（パネルのボタン → セレクト） ──────────
type ModeKey = "default" | "tsundere" | "yami" | "zense";

async function openModeSelect(interaction: ButtonInteraction): Promise<void> {
  const stage = getStage(getAffection(interaction.user.id));
  const current = getAffectionMode(interaction.user.id);
  const options = (["default", "tsundere", "yami", "zense"] as ModeKey[])
    .filter((m) => stage.unlockedModes.includes(m))
    .map((m) => ({ label: MODE_LABELS[m], value: m, default: m === current }));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("aste:setmode").setPlaceholder("モードを選ぶ…").addOptions(options),
  );
  await interaction.reply({ embeds: [baseEmbed("🎭 モード切替", COLORS.BASE).setDescription("アステルの声色を選んでね。")], components: [row], ephemeral: true });
}

async function applyMode(interaction: StringSelectMenuInteraction, targetMode: ModeKey): Promise<void> {
  const userId = interaction.user.id;
  const stage = getStage(getAffection(userId));
  if (!stage.unlockedModes.includes(targetMode)) {
    await interaction.update({ content: "そのモードはまだ解放されてないよ。", embeds: [], components: [] }).catch(() => {});
    return;
  }
  if (getAffectionMode(userId) === targetMode) {
    await interaction.update({ embeds: [baseEmbed("🎭 モード", COLORS.BASE).setDescription(`もう **${MODE_LABELS[targetMode]}** だよ。`)], components: [] });
    return;
  }
  setAffectionMode(userId, targetMode);
  const dialogues: Record<ModeKey, string> = {
    default: "「ふう。やっと、いつもの調子に戻れる。」",
    tsundere: "「べ、べつにきみのために変えたわけじゃないからね。\n　頼まれたから、しょうがなく。」",
    yami: "「……ふふ。この貌がお好み？\n　いいよ。わたしのぜんぶ、見せてあげる。\n　……どこにも、逃がさないけどね。」",
    zense: "「……あれ。なんだか、懐かしい喋り方が出てくるのう。\n　ふふ、これが前世のわたし……『座敷童』じゃ。\n　久方ぶりじゃな、客人。」",
  };
  const modeColor: Record<ModeKey, number> = { default: 0x0b1026, tsundere: 0x3a6ea5, yami: 0x2c003e, zense: 0xc0392b };
  const embed = new EmbedBuilder()
    .setColor(modeColor[targetMode])
    .setTitle(`${MODE_LABELS[targetMode]} — モード切替`)
    .setDescription(`*${dialogues[targetMode]}*\n\nモードを **${MODE_LABELS[targetMode]}** に変更したよ。`);
  await interaction.update({ embeds: [embed], components: [] });
}
