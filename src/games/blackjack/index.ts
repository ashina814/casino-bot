/**
 * 🃏 花札勝負（ブラックジャック）
 *
 * 花札の図柄を使った21勝負。ディーラーは座敷童。
 * Hit / Stand / Double / Surrender のフルルール。
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

// ─── Card System ───────────────────────────────────────

const SUITS = ["🌸松", "🎴桜", "🏵️梅", "🍂藤", "🌿萩", "🌙芒", "🎋柳", "🍁紅葉"] as const;

type Card = { display: string; value: number };

function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    // 2-10, J(10), Q(10), K(10), A(11/1)
    for (let v = 2; v <= 10; v++) {
      deck.push({ display: `${suit}${v}`, value: v });
    }
    deck.push({ display: `${suit}J`, value: 10 });
    deck.push({ display: `${suit}Q`, value: 10 });
    deck.push({ display: `${suit}K`, value: 10 });
    deck.push({ display: `${suit}A`, value: 11 }); // Ace starts as 11
  }
  return shuffle(deck);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function handValue(hand: Card[]): number {
  let total = hand.reduce((s, c) => s + c.value, 0);
  let aces = hand.filter((c) => c.display.endsWith("A")).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function handDisplay(hand: Card[]): string {
  return hand.map((c) => c.display).join(" ");
}

function isBlackjack(hand: Card[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Command ───────────────────────────────────────────

export async function handleBlackjackCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  if (!acquireGameLock(userId, "blackjack")) {
    await interaction.reply({ content: "既にゲーム中じゃ。", ephemeral: true });
    return;
  }

  let lockReleased = false;
  try {
    const cfg = getServerConfig(guildId);
    const bet = interaction.options.getInteger("bet") ?? cfg.min_bet;
    await playBlackjack(interaction, guildId, userId, bet);
  } catch (err) {
    console.error("[blackjack] handleBlackjackCommand failed:", err);
    releaseGameLock(userId);
    lockReleased = true;
  } finally {
    if (!lockReleased) releaseGameLock(userId);
  }
}

// ─── Game Flow ─────────────────────────────────────────

export async function playBlackjack(
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
    await replyText(`最低ベットは ◈${cfg.min_bet} じゃ。`);
    return;
  }
  if (bet > tier.betCap) {
    await replyText(`お主の格(${tier.emoji}${tier.name})では ◈${tier.betCap.toLocaleString()} まで。`);
    return;
  }

  const deduct = adjustBalance(userId, -bet, "bj_bet", "blackjack");
  if (!deduct.ok) {
    await replyText("エテルが足りぬぞ…。");
    return;
  }
  recordWager(userId, bet);
  try { require("../../core/db").addGamePlayAffection(userId); } catch {}

  const deck = createDeck();
  const playerHand: Card[] = [deck.pop()!, deck.pop()!];
  const dealerHand: Card[] = [deck.pop()!, deck.pop()!];
  let doubled = false;
  let surrendered = false;

  // Check natural blackjack
  if (isBlackjack(playerHand)) {
    releaseGameLock(userId);
    const payout = Math.floor(bet * 2.5);
    return await resolveGame(interaction, guildId, userId, bet, playerHand, dealerHand, payout, "blackjack");
  }

  // Show initial hands
  const buildGameEmbed = (showDealerHole: boolean) => {
    const pVal = handValue(playerHand);
    const dDisplay = showDealerHole
      ? handDisplay(dealerHand)
      : `${dealerHand[0].display} 🎴❓`;
    const dVal = showDealerHole ? handValue(dealerHand) : "？";

    return baseEmbed("🃏 花札勝負", COLORS.GOLD).setDescription(
      [
        `*「さぁ、次の手はどうする？」*`,
        "",
        `┌─ あなたの手 ─────────┐`,
        `│  ${handDisplay(playerHand)} = **${pVal}**`,
        `└──────────────────────┘`,
        `┌─ 座敷童の手 ──────────┐`,
        `│  ${dDisplay} = **${dVal}**`,
        `└──────────────────────┘`,
        "",
        `ベット: ◈${(doubled ? bet * 2 : bet).toLocaleString()}`,
      ].join("\n"),
    );
  };

  const canDouble = getBalance(userId, guildId) >= bet && playerHand.length === 2;

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bj_hit").setLabel("🎴 引く(Hit)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bj_stand").setLabel("✋ 止める(Stand)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bj_double").setLabel("⚡ 倍賭け(Double)").setStyle(ButtonStyle.Danger).setDisabled(!canDouble),
    new ButtonBuilder().setCustomId("bj_surrender").setLabel("🏳️ 降りる").setStyle(ButtonStyle.Secondary),
  );

  const reply = await interaction.reply({
    embeds: [buildGameEmbed(false)],
    components: [actionRow],
    fetchReply: true,
  });

  // ── Collector ──
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    await btn.deferUpdate();

    if (btn.customId === "bj_hit") {
      playerHand.push(deck.pop()!);
      const val = handValue(playerHand);

      if (val > 21) {
        // Bust
        collector.stop("bust");
        releaseGameLock(userId);
        return await resolveGame(btn, guildId, userId, bet, playerHand, dealerHand, 0, "bust");
      }
      if (val === 21) {
        collector.stop("stand");
        return await dealerPlay(btn, reply, deck, guildId, userId, bet, playerHand, dealerHand, false);
      }

      // Update UI, disable double & surrender after first hit
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("bj_hit").setLabel("🎴 引く(Hit)").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("bj_stand").setLabel("✋ 止める(Stand)").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("bj_double").setLabel("⚡ 倍賭け").setStyle(ButtonStyle.Danger).setDisabled(true),
        new ButtonBuilder().setCustomId("bj_surrender").setLabel("🏳️ 降りる").setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      await reply.edit({ embeds: [buildGameEmbed(false)], components: [row] });

    } else if (btn.customId === "bj_stand") {
      collector.stop("stand");
      await dealerPlay(btn, reply, deck, guildId, userId, bet, playerHand, dealerHand, false);

    } else if (btn.customId === "bj_double") {
      adjustBalance(userId, -bet, "bj_double", "blackjack");
      recordWager(userId, bet);
      doubled = true;
      playerHand.push(deck.pop()!);

      if (handValue(playerHand) > 21) {
        collector.stop("bust");
        releaseGameLock(userId);
        return await resolveGame(btn, guildId, userId, bet * 2, playerHand, dealerHand, 0, "bust");
      }

      collector.stop("stand");
      await dealerPlay(btn, reply, deck, guildId, userId, bet * 2, playerHand, dealerHand, false);

    } else if (btn.customId === "bj_surrender") {
      collector.stop("surrender");
      surrendered = true;
      const refund = Math.floor(bet / 2);
      adjustBalance(userId, refund, "bj_surrender_refund", "blackjack", guildId);
      releaseGameLock(userId);

      const profile = getProfile(userId, guildId);
      recordLoss(userId);
      distributeHouseEarnings(guildId, bet - refund);
      addExp(userId, 5);

      const embed = gameResultEmbed({
        title: "🃏 花札勝負 — 降参",
        description: `*「降りるか…賢い判断かもしれぬな。」*\n\n半額の ◈${refund.toLocaleString()} を返すぞ。`,
        result: "lose",
        userId,
        guildId,
      });

      const retryRow = makeRetryRow(bet, guildId, userId);
      await reply.edit({ embeds: [embed], components: [retryRow] });
      setupRetryCollector(reply, guildId, userId, bet);
    }
  });

  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      // Timeout = auto-stand
      releaseGameLock(userId);
      adjustBalance(userId, bet, "bj_timeout_refund", "blackjack", guildId);
      try { await reply.edit({ content: "時間切れじゃ…賭け金は返すぞ。", components: [], embeds: [] }); } catch { /* */ }
    }
  });
}

// ─── Dealer AI ─────────────────────────────────────────

async function dealerPlay(
  interaction: ButtonInteraction,
  reply: any,
  deck: Card[],
  guildId: string,
  userId: string,
  totalBet: number,
  playerHand: Card[],
  dealerHand: Card[],
  _doubled: boolean,
): Promise<void> {
  // Dealer draws until 17+
  while (handValue(dealerHand) < 17) {
    dealerHand.push(deck.pop()!);
    await sleep(600);
  }

  const pVal = handValue(playerHand);
  const dVal = handValue(dealerHand);

  let payout = 0;
  let resultLabel: string;

  if (dVal > 21) {
    // Dealer bust
    payout = totalBet * 2;
    resultLabel = "dealer_bust";
  } else if (pVal > dVal) {
    payout = totalBet * 2;
    resultLabel = "win";
  } else if (pVal === dVal) {
    payout = totalBet; // Push - return bet
    resultLabel = "draw";
  } else {
    payout = 0;
    resultLabel = "lose";
  }

  releaseGameLock(userId);
  await resolveGame(interaction, guildId, userId, totalBet, playerHand, dealerHand, payout, resultLabel);
}

// ─── Resolve & Display ─────────────────────────────────

async function resolveGame(
  interaction: ChatInputCommandInteraction | ButtonInteraction | import("discord.js").ModalSubmitInteraction,
  guildId: string,
  userId: string,
  totalBet: number,
  playerHand: Card[],
  dealerHand: Card[],
  payout: number,
  resultLabel: string,
): Promise<void> {
  const profile = getProfile(userId, guildId);
  const ctx: DialogueContext & { userId: string } = {
    userId,
    tier: profile.tier as any,
    balance: getBalance(userId, guildId),
    winStreak: profile.current_win_streak,
    loseStreak: profile.current_lose_streak,
  };

  let actualPayout = payout;
  let fukuTax = 0;
  const net = payout - totalBet;

  if (net > 0) {
    const newBal = getBalance(userId, guildId) + payout;
    const rate = getFukuWeight(newBal);
    fukuTax = Math.floor(net * rate);
    actualPayout = payout - fukuTax;

    adjustBalance(userId, actualPayout, "bj_win", "blackjack", guildId);
    recordWin(userId, net - fukuTax);
    if (fukuTax > 0) distributeFukuTax(guildId, fukuTax);
  } else if (net === 0) {
    adjustBalance(userId, totalBet, "bj_push", "blackjack", guildId);
  } else {
    recordLoss(userId);
    distributeHouseEarnings(guildId, totalBet);
  }

  addExp(userId, net > 0 ? 20 : net === 0 ? 10 : 5);

  const pVal = handValue(playerHand);
  const dVal = handValue(dealerHand);

  const resultMap: Record<string, string> = {
    blackjack: "ナチュラルBJ！",
    bust: "バースト💥",
    dealer_bust: "座敷童バースト💥",
    win: "勝利！",
    lose: "",
    draw: "引き分け",
  };

  const dialogue = net > 0
    ? dialogueWin(ctx, net, totalBet)
    : net === 0
    ? "「引き分けか。悪くないぞ。」"
    : dialogueLose(ctx, totalBet);

  const embed = gameResultEmbed({
    title: `🃏 花札勝負${net >= 0 ? ` — ${resultMap[resultLabel] ?? ""}` : ""}`,
    description: [
      `*${dialogue}*`,
      "",
      `あなた: ${handDisplay(playerHand)} = **${pVal}**${pVal > 21 ? " 💥" : ""}`,
      `座敷童: ${handDisplay(dealerHand)} = **${dVal}**${dVal > 21 ? " 💥" : ""}`,
      "",
      net > 0 ? `💰 +◈${(net - fukuTax).toLocaleString()}` : net === 0 ? "→ 賭け金返還" : `💸 -◈${totalBet.toLocaleString()}`,
    ].join("\n"),
    result: net > 0 ? "win" : net === 0 ? "draw" : "lose",
    userId,
    guildId,
  });

  const retryRow = makeRetryRow(totalBet, guildId, userId);

  if ("message" in interaction && interaction.message) {
    try {
      const msg = await interaction.message.fetch();
      await msg.edit({ embeds: [embed], components: [retryRow] });
    } catch {
      await interaction.followUp({ embeds: [embed], components: [retryRow] });
    }
  } else {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ embeds: [embed], components: [retryRow] });
    } else {
      await interaction.reply({ embeds: [embed], components: [retryRow] });
    }
  }
}

// ─── Retry ─────────────────────────────────────────────

function makeRetryRow(bet: number, guildId?: string, userId?: string): ActionRowBuilder<ButtonBuilder> {
  let minB = 50;
  let maxB = bet;
  let balance = bet;
  try {
    if (guildId && userId) {
      const cfg = getServerConfig(guildId);
      const profile = getProfile(userId, guildId);
      const tier = getTierByKey(profile.tier);
      minB = cfg.min_bet;
      balance = profile.balance;
      maxB = Math.min(tier.betCap, balance);
    }
  } catch { /* fallback to simple row */ }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj_retry_${minB}_min`)
      .setLabel(`最低 ◈${minB.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(balance < minB),
    new ButtonBuilder()
      .setCustomId(`bj_retry_${bet}_same`)
      .setLabel(`🎰 もう一回 ◈${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(balance < bet),
    new ButtonBuilder()
      .setCustomId(`bj_retry_${maxB}_max`)
      .setLabel(`最大 ◈${maxB.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(maxB < minB),
    new ButtonBuilder()
      .setCustomId("bj_paytable")
      .setLabel("📖 配当表")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bj_quit")
      .setLabel("🚪 退席")
      .setStyle(ButtonStyle.Secondary),
  );
}

function setupRetryCollector(reply: any, guildId: string, userId: string, bet: number): void {
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    if (btn.customId === "bj_paytable") {
      await btn.reply({ embeds: [blackjackPaytableEmbed()], ephemeral: true });
      return;
    }
    collector.stop();
    if (btn.customId === "bj_quit") {
      await btn.deferUpdate();
      await reply.edit({ components: [] });
      return;
    }
    if (btn.customId.startsWith("bj_retry_")) {
      const retryBet = parseInt(btn.customId.split("_")[2]);
      if (!Number.isFinite(retryBet) || retryBet <= 0) return;
      await btn.deferUpdate();
      await reply.edit({ components: [] });
      // playBlackjack は自前で tier 上限・賭金控除を行う。ロックも再取得
      if (acquireGameLock(userId, "blackjack")) {
        try {
          await playBlackjack(btn, guildId, userId, retryBet);
        } catch (err) {
          console.error("[blackjack] retry failed:", err);
          releaseGameLock(userId);
        }
      } else {
        await btn.followUp({ content: "既にゲーム中じゃ。", ephemeral: true });
      }
    }
  });

  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      try { await reply.edit({ components: [] }); } catch { /* */ }
    }
  });
}

// ─── Paytable ──────────────────────────────────────────

function blackjackPaytableEmbed(): import("discord.js").EmbedBuilder {
  return baseEmbed("📖 花札勝負 — ルール", COLORS.GOLD).setDescription(
    [
      "*「21を目指して札を引け。座敷童（ディーラー）に勝てば配当じゃ。」*",
      "",
      "**役と配当**",
      "・**ブラックジャック**（最初の2枚で21）→ 賭金 × **2.5倍**",
      "・通常勝利 → 賭金 × **2倍**",
      "・引き分け（同じ点数）→ プッシュ（賭金返却）",
      "・敗北 → 賭金没収",
      "",
      "**操作**",
      "・🎴 引く (Hit) — 札を1枚追加",
      "・✋ 止める (Stand) — 現在の点数で勝負",
      "・⚡ 倍賭け (Double) — 賭金倍にしてもう1枚だけ引く（最初の手のみ）",
      "・🏳️ 降りる (Surrender) — 賭金の半額を返してもらって降りる",
      "",
      "**点数**",
      "・数札 2〜10: そのままの点数",
      "・J・Q・K: 10",
      "・A: 11（21を超える場合は1として扱う）",
      "",
      "**座敷童のルール**",
      "・17以上で必ず止める（標準ブラックジャック）",
      "・座敷童がバストすると、プレイヤーの勝ち",
    ].join("\n")
  );
}
