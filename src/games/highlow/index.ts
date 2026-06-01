/**
 * 🎴 丁半（ハイ＆ロー）
 *
 * テンポ重視。5秒で1ゲーム。連勝チャレンジ。
 * 倍プッシュと勝ち逃げの判断が熱い。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import { adjustBalance, getBalance, recordWin, recordLoss, recordWager, ensureUser, getProfile } from "../../core/bank";
import { consumeWinBonus, consumeLossProtection } from "../../core/items";
import { effectiveBetCap } from "../../core/vip";
import { getServerConfig, acquireGameLock, releaseGameLock } from "../../core/db";
import {
  getEffectiveHouseEdge,
  getFukuWeight,
  distributeHouseEarnings,
  distributeFukuTax,
  addExp,
  getTierByKey,
} from "../../core/economy";
import { dialogueWin, dialogueLose, type DialogueContext } from "../../core/dialogue";
import { gameResultEmbed, baseEmbed, COLORS } from "../../ui/embeds";

// ─── Dice Logic ────────────────────────────────────────

function rollDice(): [number, number] {
  return [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
  ];
}

const DICE_EMOJI: Record<number, string> = {
  1: "①", 2: "②", 3: "③", 4: "④", 5: "⑤", 6: "⑥",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Command Handler ───────────────────────────────────

export async function handleHighlowCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  if (!acquireGameLock(userId, "chohan")) {
    await interaction.reply({ content: "もう遊んでる最中だよ。", ephemeral: true });
    return;
  }

  try {
    const cfg = getServerConfig(guildId);
    const bet = interaction.options.getInteger("bet") ?? cfg.min_bet;
    await startChohan(interaction, guildId, userId, bet);
  } finally {
    releaseGameLock(userId);
  }
}

export async function startChohan(
  interaction: ChatInputCommandInteraction | ButtonInteraction | import("discord.js").ModalSubmitInteraction,
  guildId: string,
  userId: string,
  bet: number,
): Promise<void> {
  // 全エントリ（slash / home modal / 等）でここを通るため、tier 上限と賭金控除はここで行う
  const cfg = getServerConfig(guildId);
  const profile = ensureUser(userId, guildId);
  const tier = getTierByKey(profile.tier);

  const replyText = async (content: string) => {
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content, ephemeral: true });
    else await interaction.reply({ content, ephemeral: true });
  };

  if (bet < cfg.min_bet) {
    await replyText(`最低ベットは ◈${cfg.min_bet} からだよ。`);
    return;
  }
  const betCap = effectiveBetCap(tier.betCap, userId, guildId);
  if (bet > betCap) {
    await replyText(`きみの賭け上限は ◈${betCap.toLocaleString()}（${tier.emoji}${tier.name}${betCap > tier.betCap ? "・💎VIP×2" : ""}）までだね。`);
    return;
  }

  // Deduct bet
  const deductResult = adjustBalance(userId, -bet, "chohan_bet", "chohan");
  if (!deductResult.ok) {
    await replyText("エテルが足りないみたい。");
    return;
  }
  recordWager(userId, bet);
  try { require("../../core/db").addGamePlayAffection(userId); } catch {}

  // Show betting UI
  const betEmbed = baseEmbed("🎴 丁半", COLORS.GOLD)
    .setDescription(
      `*「丁か、半か。さぁ張りな。」*\n\n` +
      `🎲🎲 サイコロの出目は…？\n\n` +
      `ベット: ◈${bet.toLocaleString()}`
    );

  const choiceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("chohan_cho")
      .setLabel("丁（偶数）")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("chohan_han")
      .setLabel("半（奇数）")
      .setStyle(ButtonStyle.Danger),
  );

  let reply: any;
  if (interaction.deferred || interaction.replied) {
    reply = await interaction.followUp({ embeds: [betEmbed], components: [choiceRow], fetchReply: true });
  } else {
    reply = await interaction.reply({ embeds: [betEmbed], components: [choiceRow], fetchReply: true });
  }

  // Wait for choice
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 15_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });

  let chosen = false;

  collector.on("collect", async (btn: ButtonInteraction) => {
    if (chosen) return;
    chosen = true;
    collector.stop();

    const playerChoice = btn.customId === "chohan_cho" ? "cho" : "han";
    await btn.deferUpdate();

    // Roll dice
    const [d1, d2] = rollDice();
    const total = d1 + d2;
    const result = total % 2 === 0 ? "cho" : "han";
    const won = playerChoice === result;

    // Calculate payout
    const houseEdge = getEffectiveHouseEdge(guildId, 0.03);
    let payout = 0;
    let fukuTax = 0;

    const profile = getProfile(userId, guildId);
    const ctx: DialogueContext & { userId: string } = {
      userId,
      tier: profile.tier as any,
      balance: getBalance(userId, guildId),
      winStreak: profile.current_win_streak,
      loseStreak: profile.current_lose_streak,
    };

    let isBlessed = false;
    let itemNote = "";

    if (won) {
      let rawPayout = Math.floor(bet * 2 * (1 - houseEdge));
      const wb = consumeWinBonus(userId);
      if (wb.mult !== 1) { rawPayout = Math.floor(rawPayout * wb.mult); itemNote = wb.note ?? ""; }
      const newBalance = getBalance(userId, guildId) + rawPayout;
      const fukuRate = getFukuWeight(newBalance);
      fukuTax = Math.floor(rawPayout * fukuRate);
      payout = rawPayout - fukuTax;

      adjustBalance(userId, payout, "chohan_win", "chohan", guildId);
      recordWin(userId, payout);
      if (fukuTax > 0) distributeFukuTax(guildId, fukuTax);
    } else {
      const { checkSubstituteBlessing } = require("../../core/economy");
      if (checkSubstituteBlessing(userId)) {
        adjustBalance(userId, bet, "blessing_refund", "chohan", guildId);
        isBlessed = true;
      } else {
        const prot = consumeLossProtection(userId);
        if (prot.refundRate > 0) {
          const refund = Math.floor(bet * prot.refundRate);
          adjustBalance(userId, refund, "item_refund", "chohan", guildId);
          itemNote = prot.note ?? "";
          if (prot.refundRate < 1) { recordLoss(userId); distributeHouseEarnings(guildId, bet - refund); }
        } else {
          recordLoss(userId);
          distributeHouseEarnings(guildId, bet);
        }
      }
    }

    addExp(userId, won ? 10 : 5);

    const updatedProfile = getProfile(userId, guildId);
    let dialogue = won
      ? dialogueWin(ctx, payout, bet)
      : dialogueLose(ctx, bet);

    if (isBlessed) {
      dialogue = "「あぶない。……今のは、わたしが庇っといたよ。（身代わりの加護で賭け金が戻った！）」";
    } else if (itemNote) {
      dialogue += `\n（${itemNote}）`;
    }

    const choLabel = result === "cho" ? "丁（偶数）" : "半（奇数）";
    const playerLabel = playerChoice === "cho" ? "丁" : "半";
    const streakText = won && updatedProfile.current_win_streak >= 2
      ? `\n🔥 連勝: ${updatedProfile.current_win_streak}回`
      : "";

    const resultEmbed = gameResultEmbed({
      title: `🎴 丁半${won ? " — 的中！" : ""}`,
      description: [
        `*${dialogue}*`,
        "",
        `🎲${DICE_EMOJI[d1]} + 🎲${DICE_EMOJI[d2]} = ${total} → **${choLabel}**`,
        "",
        `あなたの賭け: ${playerLabel} → ${won ? "✅ 的中！" : "❌ 外れ"}`,
        won ? `💰 +◈${payout.toLocaleString()}` : (isBlessed ? `✨ ◈${bet.toLocaleString()} が返還された` : `💸 -◈${bet.toLocaleString()}`),
        streakText,
      ].join("\n"),
      result: won || isBlessed ? "win" : "lose",
      userId,
      guildId,
    });

    // Buttons
    const nextBet = bet;
    const doubleBet = bet * 2;
    const nextRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`chohan_retry_${nextBet}`)
        .setLabel(`🎰 もう一回 ◈${nextBet.toLocaleString()}`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`chohan_retry_${doubleBet}`)
        .setLabel(`⚡ 倍プッシュ ◈${doubleBet.toLocaleString()}`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("chohan_paytable")
        .setLabel("📖 配当表")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("chohan_quit")
        .setLabel("🚪 退席")
        .setStyle(ButtonStyle.Secondary),
    );

    await reply.edit({ embeds: [resultEmbed], components: [nextRow] });

    // Next round collector
    const nextCollector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 20_000,
      filter: (i: ButtonInteraction) => i.user.id === userId,
    });

    nextCollector.on("collect", async (nextBtn: ButtonInteraction) => {
      if (nextBtn.customId === "chohan_paytable") {
        await nextBtn.reply({ embeds: [chohanPaytableEmbed()], ephemeral: true });
        return;
      }
      nextCollector.stop();

      if (nextBtn.customId === "chohan_quit") {
        await nextBtn.deferUpdate();
        await reply.edit({ components: [] });
        return;
      }

      if (nextBtn.customId.startsWith("chohan_retry_")) {
        const retryBet = parseInt(nextBtn.customId.split("_")[2]);
        await nextBtn.deferUpdate();
        if (acquireGameLock(userId, "chohan")) {
          try {
            await startChohan(nextBtn, guildId, userId, retryBet);
          } finally {
            releaseGameLock(userId);
          }
        }
      }
    });

    nextCollector.on("end", async (_: any, reason: string) => {
      if (reason === "time") {
        try { await reply.edit({ components: [] }); } catch { /* */ }
      }
    });
  });

  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time" && !chosen) {
      // Refund on timeout
      adjustBalance(userId, bet, "chohan_timeout_refund", "chohan", guildId);
      try { await reply.edit({ content: "時間切れだね。賭け金は返すよ。", components: [] }); } catch { /* */ }
    }
  });
}

// ─── Paytable ──────────────────────────────────────────

function chohanPaytableEmbed(): import("discord.js").EmbedBuilder {
  return baseEmbed("📖 丁半 — ルール", COLORS.GOLD).setDescription(
    [
      "*「丁か半か。それだけ。さあ、どっち？」*",
      "",
      "**遊び方**",
      "・サイコロ2つの合計が **丁（偶数）** か **半（奇数）** かを当てる",
      "・的中したら賭金 **× 2倍** 払戻し（ハウスエッジで実質1.96倍前後）",
      "",
      "**連勝**",
      "・勝った後「もう一回」or「⚡ 倍プッシュ」を選べる",
      "・倍プッシュは賭金倍にして次の勝負（ハイリスク・ハイリターン）",
      "・勝ち逃げ（退席）でその場の利益確定",
      "",
      "**配当**",
      "・的中 → 賭金 × 2倍（福の重みで一部奉納）",
      "・外れ → 賭金没収",
      "・身代わりの加護（覚醒で稀に発動）→ 賭金返却",
    ].join("\n")
  );
}
