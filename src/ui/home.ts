/**
 * /casino — ホーム画面
 * 全ゲームへのワンタップ入口 + 状態表示
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
} from "discord.js";
import { playSlots } from "../games/slots/index";
import { startChohan } from "../games/highlow/index";
import { playBlackjack } from "../games/blackjack/index";
import { playCrash } from "../games/crash/index";
import { runRouletteSession, activeSessions } from "../games/roulette/index";
import { playChinchiro } from "../games/chinchiro/index";
import { handleDailyCommand } from "../games/daily";
import { handleProfileCommand } from "../games/profile";
import { renderDashboard } from "../games/stocks/index";
import { ensureUser } from "../core/bank";
import { getServerConfig } from "../core/db";
import { getEconomyState, getTierByKey } from "../core/economy";
import { dialogueUshimitsudoki } from "../core/dialogue";
import { baseEmbed, COLORS } from "./embeds";
import { showTitlesPanel } from "./panels/titles";
import { showHistoryPanel } from "./panels/history";
import { showHelpPanel } from "./panels/help";
import { showQuestsPanel } from "./panels/quests";

// ─── Lucky Game Rotation ───────────────────────────────

const ALL_GAMES = ["slots", "chohan", "blackjack", "crash", "roulette", "keiba", "chinchiro"] as const;
const GAME_NAMES: Record<string, string> = {
  slots: "百鬼夜行巻物",
  chohan: "丁半博打",
  blackjack: "花札勝負",
  crash: "龍脈昇り",
  roulette: "運命の水鏡",
  keiba: "神馬競走",
  chinchiro: "チンチロ",
};

export function getTodayLuckyGame(guildId: string): string {
  const cfg = getServerConfig(guildId);
  const today = new Date().toISOString().slice(0, 10);

  if (cfg.lucky_game && cfg.lucky_game_date === today) {
    return cfg.lucky_game;
  }

  // Rotate based on day
  const dayIndex = Math.floor(Date.now() / 86400000) % ALL_GAMES.length;
  const lucky = ALL_GAMES[dayIndex];

  // Update in DB (lazy update)
  try {
    const { updateServerConfig } = require("../core/db");
    updateServerConfig(guildId, { lucky_game: lucky, lucky_game_date: today });
  } catch { /* ignore */ }

  return lucky;
}

// ─── Command ───────────────────────────────────────────

export const casinoCommand = new SlashCommandBuilder()
  .setName("案内")
  .setDescription("🏮 座敷童の賭場 — ホーム");

export async function handleCasinoCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const profile = ensureUser(userId, guildId);
  const tier = getTierByKey(profile.tier);
  const eco = getEconomyState(guildId);
  const luckyGame = getTodayLuckyGame(guildId);

  // 初回 / 新規（戦績ゼロ）判定
  const isNewbie = profile.total_wins + profile.total_losses === 0;

  const ushimitsu = dialogueUshimitsudoki();
  const greeting = ushimitsu ?? (isNewbie
    ? "「ようこそ…座敷童の賭場へ。お主、見ない顔じゃな。」"
    : "「いらっしゃい。今日は何で遊ぶ？」");

  const newbieBanner = isNewbie
    ? [
        "",
        "🌱 **初めての方へ** — まずは下の **「📅 福分け」** を押してみよ。",
        "　毎日の小判と、わしとの最初の出会いがそこにある。",
        "",
      ]
    : [];

  const embed = baseEmbed("🏮 座敷童の賭場", COLORS.GOLD)
    .setDescription(
      [
        `*${greeting}*`,
        ...newbieBanner,
        `💰 所持金: **◉${profile.balance.toLocaleString()}**`,
        `${tier.emoji} 格: **${tier.name}** (Lv.${profile.level})`,
        `🔥 連続ログイン: ${profile.daily_streak}日目`,
        "",
        `🎯 本日のラッキーゲーム: **${GAME_NAMES[luckyGame] ?? luckyGame}**（配当1.2倍）`,
        `${eco.emoji} 妖気: *${eco.label}*`,
      ].join("\n"),
    );

  // Row 1 — 日常アクション（最重要、目立たせる）
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("home_daily").setLabel("📅 福分け").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("home_quests").setLabel("📋 任務").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("home_profile").setLabel("👤 通行証").setStyle(ButtonStyle.Secondary),
  );

  // Row 2 — メインゲーム（単独プレイ）
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("home_slots").setLabel("🎰 巻物").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("home_chohan").setLabel("🎴 丁半").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("home_blackjack").setLabel("🃏 花札").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("home_chinchiro").setLabel("🎲 チンチロ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("home_crash").setLabel("📈 龍脈昇り").setStyle(ButtonStyle.Primary),
  );

  // Row 3 — みんなで遊ぶ + 投資
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("home_roulette").setLabel("🎡 水鏡").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("home_keiba").setLabel("🏇 神馬競走").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("home_stocks").setLabel("📈 龍脈相場").setStyle(ButtonStyle.Primary),
  );

  // Row 4 — 情報・参考
  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("home_history").setLabel("📒 履歴").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("home_titles").setLabel("📜 二つ名").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("home_help").setLabel("📖 ヘルプ").setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row1, row2, row3, row4], ephemeral: true });
}

// ─── Button Handlers ───────────────────────────────────

export async function handleHomeButton(interaction: ButtonInteraction): Promise<void> {
  const game = interaction.customId.replace("home_", "");

  if (game === "daily") {
    return handleDailyCommand(interaction as any);
  }
  if (game === "profile") {
    return handleProfileCommand(interaction as any);
  }
  if (game === "history") {
    return showHistoryPanel(interaction, 0);
  }
  if (game === "titles") {
    return showTitlesPanel(interaction);
  }
  if (game === "help") {
    return showHelpPanel(interaction);
  }
  if (game === "quests") {
    return showQuestsPanel(interaction);
  }
  if (game === "stocks") {
    return renderDashboard(interaction, interaction.user.id, interaction.guildId!);
  }
  if (game === "keiba") {
    await interaction.reply({ content: "競馬は `/競馬 start` コマンドから開始してくれ！", ephemeral: true });
    return;
  }
  if (game === "roulette") {
    const channelId = interaction.channelId;
    if (activeSessions.get(channelId)) {
      await interaction.reply({ content: "この水鏡は既に揺れておる。結果を待つのじゃ。", ephemeral: true });
      return;
    }
  }

  // Show bet input modal for slots, chohan, blackjack, crash, roulette
  const modal = new ModalBuilder()
    .setCustomId(`bet_modal_${game}`)
    .setTitle(`賭け額を入力 (${GAME_NAMES[game] ?? game})`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("bet_amount")
          .setLabel("賭ける小判の額 (空欄なら最低額)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("例: 100")
      )
    );
  
  await interaction.showModal(modal);
}

// ─── Modal Handlers ────────────────────────────────────

export async function handleHomeModal(interaction: ModalSubmitInteraction): Promise<void> {
  const game = interaction.customId.replace("bet_modal_", "");
  const betInput = interaction.fields.getTextInputValue("bet_amount");
  const bet = betInput ? parseInt(betInput, 10) : undefined;
  
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const cfg = getServerConfig(guildId);
  const finalBet = bet && !isNaN(bet) ? bet : cfg.min_bet;

  try {
    switch (game) {
      case "slots":
        const { acquireGameLock: l1, releaseGameLock: r1 } = require("../core/db");
        if (!l1(userId, "slots")) {
          await interaction.reply({ content: "既にゲーム中じゃ。", ephemeral: true });
          return;
        }
        try { await playSlots(interaction, guildId, userId, finalBet); } finally { r1(userId); }
        break;

      case "chohan":
        const { acquireGameLock: l2, releaseGameLock: r2 } = require("../core/db");
        if (!l2(userId, "chohan")) {
          await interaction.reply({ content: "既にゲーム中じゃ。", ephemeral: true });
          return;
        }
        try { await startChohan(interaction, guildId, userId, finalBet); } finally { r2(userId); }
        break;

      case "blackjack":
        const { acquireGameLock: l3, releaseGameLock: r3 } = require("../core/db");
        if (!l3(userId, "blackjack")) {
          await interaction.reply({ content: "既にゲーム中じゃ。", ephemeral: true });
          return;
        }
        try { await playBlackjack(interaction, guildId, userId, finalBet); } finally { r3(userId); }
        break;

      case "crash":
        const { acquireGameLock: l4, releaseGameLock: r4 } = require("../core/db");
        if (!l4(userId, "crash")) {
          await interaction.reply({ content: "既にゲーム中じゃ。", ephemeral: true });
          return;
        }
        try { await playCrash(interaction, guildId, userId, finalBet); } finally { r4(userId); }
        break;

      case "roulette":
        const channelId = interaction.channelId;
        if (activeSessions.get(channelId!)) {
          await interaction.reply({ content: "この水鏡は既に揺れておる。結果を待つのじゃ。", ephemeral: true });
          return;
        }
        activeSessions.set(channelId!, true);
        try {
          await runRouletteSession(interaction, guildId, channelId!, userId, finalBet);
        } finally {
          activeSessions.delete(channelId!);
        }
        break;

      case "chinchiro":
        const { acquireGameLock: l5, releaseGameLock: r5 } = require("../core/db");
        if (!l5(userId, "chinchiro")) {
          await interaction.reply({ content: "既にゲーム中じゃ。", ephemeral: true });
          return;
        }
        try { await playChinchiro(interaction, guildId, userId, finalBet); } finally { r5(userId); }
        break;
    }
  } catch (error) {
    console.error(`[Home Modal] Error starting game ${game}:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "ゲームの開始中にエラーが発生しました。", ephemeral: true });
    }
  }
}

