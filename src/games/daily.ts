/**
 * /daily — デイリー福分け
 * 座敷童から毎日のエテルを受け取る。連続ログインでセリフが変化。
 * 覚醒システム統合: 段階ボーナス、減衰、レアイベント、段階UP通知
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { db } from "../core/db";
import { adjustBalance, ensureUser } from "../core/bank";
import { calculateDailyBonus, addExp, drawFromReliefPool } from "../core/economy";
import { dialogueDaily } from "../core/dialogue";
import { addressOwner } from "../core/ownerAddress";
import { gameResultEmbed, infoEmbed, COLORS } from "../ui/embeds";
import {
  getStage,
  getNextStage,
  affectionToNextStage,
  rollRareEvent,
  getStageUpDialogue,
  getStageDownDialogue,
  AFFECTION_GAINS,
} from "../core/zashikiStage";
import type { ZashikiStageLevel } from "../core/zashikiStage";

// ─── Command ───────────────────────────────────────────

export const dailyCommand = new SlashCommandBuilder()
  .setName("福分け")
  .setDescription("📅 アステルから毎日の福分けを受け取る");

export async function handleDailyCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const profile = ensureUser(userId, guildId);

  // Check if already claimed today
  const today = new Date().toISOString().slice(0, 10);
  if (profile.last_daily === today) {
    await interaction.reply({
      content: "今日の福分けは、もう渡したよ。また明日来てね。",
      ephemeral: true,
    });
    return;
  }

  // Calculate streak
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const isConsecutive = profile.last_daily === yesterday;
  const newStreak = isConsecutive ? profile.daily_streak + 1 : 1;

  // ─── Affection: Decay & Streak Break ─────────────────
  const { getAffection, addAffection, applyDailyDecay, getAffectionMode, getAffectionFull } = require("../core/db");
  const affectionBefore = getAffection(userId);
  const stageBefore = getStage(affectionBefore);

  // Apply daily decay
  applyDailyDecay(userId);

  // Streak break penalty (on top of decay)
  if (!isConsecutive && profile.last_daily) {
    const breakPenalty = 10;
    const currentAffection = getAffection(userId);
    if (currentAffection > 0) {
      addAffection(userId, -Math.min(breakPenalty, currentAffection));
    }
  }

  // ─── Affection: Daily Gain ───────────────────────────
  addAffection(userId, AFFECTION_GAINS.daily);

  // Weekly streak bonus
  if (newStreak > 0 && newStreak % 7 === 0) {
    addAffection(userId, AFFECTION_GAINS.weekStreak);
  }

  const affection = getAffection(userId);
  const stageAfter = getStage(affection);
  const mode = getAffectionMode(userId);

  // ─── Calculate Daily Bonus ───────────────────────────
  const baseAmount = Math.floor(calculateDailyBonus(guildId, userId) * stageAfter.dailyMultiplier);
  const streakBonus = Math.min(Math.floor(newStreak / 7) * 50, 200);

  // 巡りの光（救済）: 困窮者（残高 ≤ 1,000）には救済プールから施しが回る
  const reliefBonus = profile.balance <= 1_000 ? drawFromReliefPool(guildId, 500) : 0;

  let totalAmount = baseAmount + streakBonus + reliefBonus;

  // Apply
  adjustBalance(userId, totalAmount, "daily_bonus", "daily", guildId);

  // Update streak
  db.prepare(
    "UPDATE users SET daily_streak = ?, last_daily = ? WHERE user_id = ?"
  ).run(newStreak, today, userId);

  // 連続ログイン系の称号（賭場の常連/通い詰める者）を冪等付与
  try {
    const { checkDailyMilestones } = require("../core/milestoneTitles");
    checkDailyMilestones(userId);
  } catch { /* silent */ }

  addExp(userId, 20);

  // ─── Dialogue ────────────────────────────────────────
  let dialogue = addressOwner(dialogueDaily(newStreak, affection, userId, mode as any), userId);

  // ─── Insider Info (20% chance) ───────────────────────
  if (Math.random() < 0.2) {
    try {
      const stocks = db.prepare("SELECT name, emoji, trend FROM stocks ORDER BY ABS(trend) DESC LIMIT 1").all() as { name: string; emoji: string; trend: number }[];
      if (stocks.length > 0) {
        const target = stocks[0];
        const isUp = target.trend > 0;
        dialogue += `\n\n*(こっそりと)*\n「ここだけの話。次の刻は『${target.emoji}${target.name}』が${isUp ? "熱い" : "落ちる"}らしいよ。誰にも言わないでね？」`;
      }
    } catch {
      // ignore
    }
  }

  // ─── Rare Event ──────────────────────────────────────
  const rareEvent = rollRareEvent(affection, "daily");
  let rareEventText = "";
  if (rareEvent) {
    rareEventText = `\n\n${rareEvent.emoji} **${rareEvent.name}**\n*${rareEvent.dialogue}*`;
    if (rareEvent.effect === "bonus_coins") {
      adjustBalance(userId, rareEvent.value, "rare_event_bonus", "daily", guildId);
      totalAmount += rareEvent.value;
      rareEventText += `\n💰 +◈${rareEvent.value.toLocaleString()} ボーナス！`;
    } else if (rareEvent.effect === "affection_surge") {
      addAffection(userId, rareEvent.value);
      rareEventText += `\n💖 好感度 +${rareEvent.value}！`;
    }
  }

  // ─── Build Embed ─────────────────────────────────────
  const nextStage = getNextStage(affection);
  const remaining = affectionToNextStage(affection);

  const descLines = [
    `*${dialogue}*`,
    "",
    `💰 +◈${totalAmount.toLocaleString()}`,
    `  ├ 基本: ◈${baseAmount}${stageAfter.dailyMultiplier > 1.0 ? ` (覚醒ボーナス x${stageAfter.dailyMultiplier})` : ""}`,
    streakBonus > 0 ? `  ├ 連続ボーナス: +◈${streakBonus}` : "",
    reliefBonus > 0 ? `  └ 🕊 巡りの光（救済）: +◈${reliefBonus.toLocaleString()}` : "",
    "",
    `🔥 連続ログイン: **${newStreak}日**`,
    `${stageAfter.emoji} 覚醒: **${stageAfter.title}**`,
    affection >= 10 ? `💖 好感度: **${affection}**${remaining != null ? ` (次の覚醒まで ${remaining})` : " (最大覚醒)"}` : "",
    rareEventText,
  ].filter(Boolean).join("\n");

  const embed = gameResultEmbed({
    title: "📅 アステルの福分け",
    description: descLines,
    result: "win",
    userId,
    guildId,
  });

  const embeds: EmbedBuilder[] = [embed];

  // ─── Stage Transition Notification ───────────────────
  if (stageAfter.level > stageBefore.level) {
    // Stage UP! ✨🎆 ドラマチックな祝祭
    const unlocks: string[] = [];
    if (stageAfter.dailyMultiplier > (stageBefore.dailyMultiplier ?? 1)) {
      unlocks.push(`📅 デイリー倍率: x${stageBefore.dailyMultiplier ?? 1} → **x${stageAfter.dailyMultiplier}**`);
    }
    if (stageAfter.guardChance > (stageBefore.guardChance ?? 0)) {
      unlocks.push(`🛡️ 身代わりの加護: **${(stageAfter.guardChance * 100).toFixed(1)}%** に向上`);
    }
    if (stageAfter.jpBonus > (stageBefore.jpBonus ?? 0)) {
      unlocks.push(`🎰 JP当選率: **+${(stageAfter.jpBonus * 100).toFixed(1)}%**`);
    }
    if (stageAfter.fukuDiscount > (stageBefore.fukuDiscount ?? 0)) {
      unlocks.push(`⚖️ 福の重み軽減: **${(stageAfter.fukuDiscount * 100)}%**`);
    }
    if (stageAfter.unlockedModes.length > (stageBefore.unlockedModes?.length ?? 1)) {
      const newModes = stageAfter.unlockedModes.filter((m) => !(stageBefore.unlockedModes ?? []).includes(m));
      if (newModes.length > 0) unlocks.push(`🎭 新モード解放: **${newModes.join(" / ")}**`);
    }

    const stageUpEmbed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle(`✨🎆 覚醒 — ${stageAfter.emoji} ${stageAfter.title} 🎆✨`)
      .setDescription(
        [
          `**${stageBefore.name}** → **${stageAfter.name}** へ目覚めた！`,
          "",
          `*${getStageUpDialogue(stageAfter.level as ZashikiStageLevel)}*`,
          unlocks.length > 0 ? "\n── 解放されたもの ──\n" + unlocks.join("\n") : "",
        ].filter(Boolean).join("\n"),
      )
      .setFooter({ text: "詳細は /アステル status で確認できる" });
    embeds.push(stageUpEmbed);
  } else if (stageAfter.level < stageBefore.level) {
    // Stage DOWN
    const stageDownEmbed = new EmbedBuilder()
      .setColor(0x555555)
      .setTitle(`${stageAfter.emoji} 覚醒低下 — ${stageAfter.title}`)
      .setDescription(getStageDownDialogue(stageAfter.level as ZashikiStageLevel))
      .setFooter({ text: `アステルとの星約が ${stageBefore.name} → ${stageAfter.name} に下がった…` });
    embeds.push(stageDownEmbed);
  }

  // 任務パネルへの誘導ボタン
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("home_quests").setLabel("📋 今日の任務を見る").setStyle(ButtonStyle.Success),
  );

  await interaction.reply({
    embeds,
    components: [row],
    ephemeral: true,
  });
}
