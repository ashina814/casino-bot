/**
 * 任務パネル — 日次クエスト UI
 *
 * `/案内` の「📋 任務」または `/福分け` 後の「📋 今日の任務」から開く。
 * 将来は週次・イベントを追加できるよう、セクション構造で設計。
 */
import {
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import {
  pickDailyQuests,
  getDailyPeriod,
  getQuestProgress,
  isClaimed,
  claimQuest,
  formatDescription,
  formatProgress,
  QuestDef,
} from "../../core/quests";
import { baseEmbed, COLORS } from "../embeds";
import { safeReply, safeEditReply } from "../../core/safeReply";

const SLOT_LABELS = ["1️⃣", "2️⃣", "3️⃣"] as const;
const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "🟢 簡単",
  normal: "🟡 普通",
  hard: "🔴 難",
};

function buildEmbed(userId: string, guildId: string, period: string): { embed: EmbedBuilder; quests: QuestDef[]; rewards: number[] } {
  const quests = pickDailyQuests(userId, period);
  const rewards: number[] = [];
  const blocks: string[] = [];
  let totalAvailable = 0;
  let totalClaimed = 0;

  for (let i = 0; i < quests.length; i += 1) {
    const q = quests[i];
    const desc = formatDescription(q, guildId);
    const prog = getQuestProgress(userId, q, period, guildId);
    const claimed = isClaimed(userId, q.key, period);
    rewards[i] = q.reward.coins;

    let status: string;
    if (claimed) {
      status = "✅ 受領済";
      totalClaimed += q.reward.coins;
    } else if (prog.completed) {
      status = "🎁 **受領可能**";
      totalAvailable += q.reward.coins;
    } else {
      status = "🔄 進行中";
    }

    blocks.push(
      [
        `${SLOT_LABELS[i]} **${q.title}**　${DIFFICULTY_LABEL[q.difficulty]}　${status}`,
        `*${desc}*`,
        formatProgress(prog.progress, prog.target),
        `🎁 報酬: ◉${q.reward.coins.toLocaleString()} + 妖力 ${q.reward.exp}`,
      ].join("\n"),
    );
  }

  const footerNote = totalAvailable > 0
    ? `💎 受領可能合計: ◉${totalAvailable.toLocaleString()} — 下のボタンで受け取れる`
    : totalClaimed === quests.reduce((s, q) => s + q.reward.coins, 0)
      ? "🎉 今日の任務はすべて受領済み！"
      : "進めて受領しよう。**当日中に受領しないと逸する**ぞ。";

  const embed = baseEmbed(`📋 今日の任務 — ${period}`, COLORS.GOLD)
    .setDescription(
      [
        "*「これが今日の任務じゃ。果たして報酬を取りに来い。」*",
        "",
        blocks.join("\n\n"),
      ].join("\n"),
    )
    .setFooter({ text: footerNote });

  return { embed, quests, rewards };
}

function buildButtons(userId: string, guildId: string, period: string, quests: QuestDef[]): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  let anyAvailable = false;

  for (let i = 0; i < quests.length; i += 1) {
    const q = quests[i];
    const claimed = isClaimed(userId, q.key, period);
    const prog = getQuestProgress(userId, q, period, guildId);
    const canClaim = !claimed && prog.completed;
    if (canClaim) anyAvailable = true;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`quest_claim_${q.key}`)
        .setLabel(`${SLOT_LABELS[i]} ${claimed ? "受領済" : canClaim ? "受領" : "未達"}`)
        .setStyle(claimed ? ButtonStyle.Secondary : canClaim ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!canClaim),
    );
  }

  // 一括受領
  row.addComponents(
    new ButtonBuilder()
      .setCustomId("quest_claim_all")
      .setLabel("💎 全て受領")
      .setStyle(anyAvailable ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!anyAvailable),
  );

  return row;
}

// ─── Public Entry ──────────────────────────────────────

export async function showQuestsPanel(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;
  const period = getDailyPeriod();
  const { embed, quests } = buildEmbed(userId, guildId, period);
  const buttons = buildButtons(userId, guildId, period, quests);
  await safeReply(interaction, { embeds: [embed], components: [buttons], ephemeral: true });
}

export async function handleQuestButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith("quest_claim_")) return;
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;
  const period = getDailyPeriod();
  const { quests } = buildEmbed(userId, guildId, period);

  // 一括受領
  if (interaction.customId === "quest_claim_all") {
    let totalCoins = 0;
    let totalExp = 0;
    const claimedTitles: string[] = [];
    for (const q of quests) {
      const r = claimQuest(userId, q, period, guildId);
      if (r.ok) {
        totalCoins += r.reward.coins;
        totalExp += r.reward.exp;
        claimedTitles.push(q.title);
      }
    }
    if (totalCoins === 0) {
      await interaction.reply({ content: "受領できる任務がない。", ephemeral: true });
      return;
    }
    // パネル全体を再描画
    const fresh = buildEmbed(userId, guildId, period);
    const buttons = buildButtons(userId, guildId, period, fresh.quests);
    await interaction.update({ embeds: [fresh.embed], components: [buttons] });
    // 受領通知（follow-up）
    await interaction.followUp({
      content: `✨ 受領完了：**${claimedTitles.join(" / ")}**\n💰 +◉${totalCoins.toLocaleString()}　🌀 +妖力 ${totalExp}`,
      ephemeral: true,
    });
    return;
  }

  // 個別受領
  const key = interaction.customId.replace("quest_claim_", "");
  const q = quests.find((x) => x.key === key);
  if (!q) {
    await interaction.reply({ content: "任務が見つからぬ。", ephemeral: true });
    return;
  }
  const r = claimQuest(userId, q, period, guildId);
  if (!r.ok) {
    const msg =
      r.reason === "already_claimed" ? "既に受領済みじゃ。"
        : r.reason === "not_completed" ? "まだ達成しておらぬぞ。"
          : "受領に失敗した（残高エラー等）。";
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }
  // パネル再描画
  const fresh = buildEmbed(userId, guildId, period);
  const buttons = buildButtons(userId, guildId, period, fresh.quests);
  await interaction.update({ embeds: [fresh.embed], components: [buttons] });
  await interaction.followUp({
    content: `✨ **${q.title}** を受領！\n💰 +◉${r.reward.coins.toLocaleString()}　🌀 +妖力 ${r.reward.exp}`,
    ephemeral: true,
  });
}
