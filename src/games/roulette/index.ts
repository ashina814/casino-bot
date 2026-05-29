/**
 * 🎡 運命の水鏡（ルーレット）
 *
 * みんなで参加する共有型ゲーム。
 * 60秒の受付 → 一斉結果発表。ソーシャル体験の核。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
  TextChannel,
} from "discord.js";
import { adjustBalance, getBalance, recordWin, recordLoss, recordWager, ensureUser, getProfile } from "../../core/bank";
import { getServerConfig } from "../../core/db";
import {
  getEffectiveHouseEdge,
  getFukuWeight,
  distributeHouseEarnings,
  distributeFukuTax,
  addExp,
  getTierByKey,
} from "../../core/economy";
import { baseEmbed, gameResultEmbed, COLORS } from "../../ui/embeds";

// ─── Roulette Layout ───────────────────────────────────

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const BLACK_NUMBERS = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

type BetType = "red" | "black" | "green" | "odd" | "even" | "high" | "low";

type PlayerBet = {
  userId: string;
  betType: BetType;
  amount: number;
};

const BET_LABELS: Record<BetType, string> = {
  red: "🔴 赤",
  black: "⚫ 黒",
  green: "🟢 零",
  odd: "奇数",
  even: "偶数",
  high: "大(19-36)",
  low: "小(1-18)",
};

const PAYOUTS: Record<BetType, number> = {
  red: 2,
  black: 2,
  green: 36,
  odd: 2,
  even: 2,
  high: 2,
  low: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Active Sessions (per-channel) ─────────────────────

export const activeSessions = new Map<string, boolean>();

// ─── Command ───────────────────────────────────────────

export async function handleRouletteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;

  // Check if session already running in this channel
  if (activeSessions.get(channelId)) {
    await interaction.reply({ content: "この水鏡、もう揺れてる。結果を待ってね。", ephemeral: true });
    return;
  }

  const cfg = getServerConfig(guildId);
  const bet = interaction.options.getInteger("bet") ?? cfg.min_bet;
  const userId = interaction.user.id;
  const profile = ensureUser(userId, guildId);
  const tier = getTierByKey(profile.tier);

  if (bet < cfg.min_bet) {
    await interaction.reply({ content: `最低ベットは ◈${cfg.min_bet} からだよ。`, ephemeral: true });
    return;
  }
  if (bet > tier.betCap) {
    await interaction.reply({ content: `きみの星位だと ◈${tier.betCap.toLocaleString()} までだよ。`, ephemeral: true });
    return;
  }

  activeSessions.set(channelId, true);

  try {
    await runRouletteSession(interaction, guildId, channelId, userId, bet);
  } finally {
    activeSessions.delete(channelId);
  }
}

// ─── Session ───────────────────────────────────────────

export async function runRouletteSession(
  interaction: ChatInputCommandInteraction | ButtonInteraction | import("discord.js").ModalSubmitInteraction,
  guildId: string,
  channelId: string,
  initiatorId: string,
  defaultBet: number,
): Promise<void> {
  const bets: PlayerBet[] = [];
  const DURATION = 45; // seconds
  const startTime = Date.now();

  const buildLobbyEmbed = (secondsLeft: number) => {
    const betSummary = bets.length > 0
      ? bets.map((b) => `<@${b.userId}>: ${BET_LABELS[b.betType]} ◈${b.amount.toLocaleString()}`).join("\n")
      : "まだ誰も賭けてないよ……";
    const totalBet = bets.reduce((s, b) => s + b.amount, 0);

    return baseEmbed(`🎡 運命の水鏡 — 受付中（残り${secondsLeft}秒）`, COLORS.GOLD)
      .setDescription(
        [
          `*「水鏡に数字が映る…さぁ、何処に賭ける？」*`,
          "",
          `参加者: ${bets.length}人 / 総ベット: ◈${totalBet.toLocaleString()}`,
          "",
          betSummary,
        ].join("\n"),
      );
  };

  const betRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rl_red").setLabel("🔴 赤").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rl_black").setLabel("⚫ 黒").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rl_green").setLabel("🟢 零").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rl_odd").setLabel("奇数").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rl_even").setLabel("偶数").setStyle(ButtonStyle.Primary),
  );
  const infoRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rl_paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
  );

  const reply = await interaction.reply({
    embeds: [buildLobbyEmbed(DURATION)],
    components: [betRow, infoRow],
    fetchReply: true,
  });

  // Collector for bets
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: DURATION * 1000,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    if (btn.customId === "rl_paytable") {
      await btn.reply({ embeds: [roulettePaytableEmbed()], ephemeral: true });
      return;
    }
    const userId = btn.user.id;
    const betTypeKey = btn.customId.replace("rl_", "") as BetType;

    // Check if already bet
    if (bets.find((b) => b.userId === userId)) {
      await btn.reply({ content: "もう賭けておるぞ。1回の水鏡につき1つじゃ。", ephemeral: true });
      return;
    }

    const cfg = getServerConfig(guildId);
    const profile = ensureUser(userId, guildId);
    const tier = getTierByKey(profile.tier);
    const betAmount = Math.min(defaultBet, tier.betCap);

    // Deduct
    const result = adjustBalance(userId, -betAmount, "roulette_bet", "roulette");
    if (!result.ok) {
      await btn.reply({ content: "エテルが足りないみたい。", ephemeral: true });
      return;
    }
    recordWager(userId, betAmount);
    try { require("../../core/db").addGamePlayAffection(userId); } catch {}

    bets.push({ userId, betType: betTypeKey, amount: betAmount });
    await btn.reply({ content: `${BET_LABELS[betTypeKey]} に ◈${betAmount.toLocaleString()} を賭けたぞ！`, ephemeral: true });

    // Update lobby
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const left = Math.max(0, DURATION - elapsed);
    try {
      await reply.edit({ embeds: [buildLobbyEmbed(left)] });
    } catch { /* */ }
  });

  // Wait for duration
  await sleep(DURATION * 1000);
  collector.stop();

  if (bets.length === 0) {
    await reply.edit({
      embeds: [baseEmbed("🎡 運命の水鏡 — 中止", COLORS.BASE).setDescription("誰も賭けなかったので水鏡は閉じたぞ。")],
      components: [],
    });
    return;
  }

  // ── Spin ──
  const spinEmbed = baseEmbed("🎡 運命の水鏡 — 回転中…", COLORS.EVENT)
    .setDescription("*「水鏡が揺れる……」*\n\n✨ ？？？ ✨");
  await reply.edit({ embeds: [spinEmbed], components: [] });

  await sleep(2000);

  // ── Result ──
  const winningNumber = Math.floor(Math.random() * 37); // 0-36
  const isRed = RED_NUMBERS.has(winningNumber);
  const isBlack = BLACK_NUMBERS.has(winningNumber);
  const isGreen = winningNumber === 0;
  const colorEmoji = isRed ? "🔴" : isBlack ? "⚫" : "🟢";
  const colorLabel = isRed ? "赤" : isBlack ? "黒" : "零";

  // Resolve bets
  const results: string[] = [];
  for (const b of bets) {
    const won = checkWin(b.betType, winningNumber);
    const profile = getProfile(b.userId, guildId);

    if (won) {
      const rawPayout = Math.floor(b.amount * PAYOUTS[b.betType]);
      const net = rawPayout - b.amount;
      const newBal = getBalance(b.userId, guildId) + rawPayout;
      const fukuRate = getFukuWeight(newBal);
      const fukuTax = Math.floor(net * fukuRate);
      const actualPayout = rawPayout - fukuTax;

      adjustBalance(b.userId, actualPayout, "roulette_win", "roulette", guildId);
      recordWin(b.userId, net - fukuTax);
      if (fukuTax > 0) distributeFukuTax(guildId, fukuTax);
      addExp(b.userId, 15);

      const emoji = b.betType === "green" ? "🎯" : "👑";
      results.push(`${emoji} <@${b.userId}>: ${BET_LABELS[b.betType]} ◈${b.amount} → **+◈${(net - fukuTax).toLocaleString()}**`);
    } else {
      recordLoss(b.userId);
      distributeHouseEarnings(guildId, b.amount);
      addExp(b.userId, 5);
      results.push(`😭 <@${b.userId}>: ${BET_LABELS[b.betType]} ◈${b.amount} → -◈${b.amount.toLocaleString()}`);
    }
  }

  const resultEmbed = baseEmbed("🎡 運命の水鏡 — 結果発表", winningNumber === 0 ? COLORS.WIN : isRed ? COLORS.MAIN : COLORS.BASE)
    .setDescription(
      [
        `*「水鏡が揺れる……映ったのは…」*`,
        "",
        `✨ **【 ${winningNumber} — ${colorEmoji} ${colorLabel} 】** ✨`,
        "",
        ...results,
        "",
        `次の水鏡: \`/遊ぶ 輪盤\` または \`/案内\` から開始`,
      ].join("\n"),
    );

  await reply.edit({ embeds: [resultEmbed], components: [] });
}

// ─── Win Check ─────────────────────────────────────────

function checkWin(betType: BetType, number: number): boolean {
  switch (betType) {
    case "red": return RED_NUMBERS.has(number);
    case "black": return BLACK_NUMBERS.has(number);
    case "green": return number === 0;
    case "odd": return number > 0 && number % 2 === 1;
    case "even": return number > 0 && number % 2 === 0;
    case "high": return number >= 19;
    case "low": return number >= 1 && number <= 18;
  }
}

// ─── Paytable ──────────────────────────────────────────

function roulettePaytableEmbed(): import("discord.js").EmbedBuilder {
  return baseEmbed("📖 百鬼輪盤 — ルール", COLORS.GOLD).setDescription(
    [
      "*「水鏡に映る数字に賭けよ。皆で参加できる遊びじゃ。」*",
      "",
      "**遊び方**",
      "・**45秒間** の受付中、各自が1つだけ賭けられる",
      "・受付終了後、0〜36 の数字が抽選される",
      "・的中した賭けには配当が支払われる",
      "",
      "**賭けの種類と配当**",
      "・🔴 赤 / ⚫ 黒（1〜36の色）→ **2倍**",
      "・奇数 / 偶数（1〜36）→ **2倍**",
      "・🟢 零（0が出る）→ **14倍**（大穴）",
      "",
      "**ハウスエッジ**",
      "・0は色や奇偶判定の対象外。プレイヤーが少しだけ不利な配当構造",
      "・ハウスエッジ 約 2.7%（標準ヨーロピアンルーレット相当）",
      "",
      "**特徴**",
      "・**みんなで賭けられる** — 同じセッションに複数人が参加",
      "・1回の輪盤に1賭けまで（賭け直し不可）",
      "・賭金は段位上限まで（超過分は自動で段位上限にクランプ）",
    ].join("\n")
  );
}
