import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config";
import { initializeDatabase, db, updateSystemStatus, cleanStaleSessions, runTransaction } from "./core/db";
import { adjustBalance } from "./core/bank";
import { handleAsobuCommand } from "./games/asobu";
import { handleRaceCommand } from "./games/keiba/command";
import { handleKeibaCancel, handleKeibaCancelOne, handleKeibaModalSubmit, handleKeibaSelect, handleKeibaStatus, handleKeibaRestart } from "./games/keiba/logic";
import { registerSchedulers } from "./core/scheduler";

// ─── New: Casino Commands ──────────────────────────────

import { handleDailyCommand } from "./games/daily";
import { handleProfileCommand } from "./games/profile";
import { handleThanksCommand } from "./games/thanks";
import { handleCasinoCommand, handleHomeButton, handleHomeModal } from "./ui/home";
import { handleRankingCommand } from "./ui/ranking";
import { handleStocksCommand, handleStocksButton, handleStocksSelect, handleStocksModal } from "./games/stocks";
import { handleAdminCommand } from "./admin/commands";
import { handleShoutenCommand } from "./games/shouten";
import { handleZashikiCommand } from "./games/zashiki";
import { handleExchangeCommand, handleExchangeApproval } from "./games/exchange";
import { reconcileStaleExchangesOnStartup } from "./core/exchange";
import { handleBoardCommand, handleBoardButton, handleBoardSelect, handleBoardModal, refundStaleMarketsOnStartup } from "./games/board";
import { handleSashiCommand, handleSashiButton, refundStaleSashiOnStartup } from "./games/sashi";
import { handleCheerCommand } from "./games/cheer";
import { handleTakuCommand, handleTakuButton, handleTableVoiceState, sweepStaleTempVCs } from "./games/takutate";
import { handleChohanCommand, handleChohanButton, handleChohanModal, refundStaleChohanOnStartup } from "./games/chohan";
import { handleSaiCommand, handleSaiButton, refundStaleDuelsOnStartup } from "./games/saishoubu";

// ─── Startup Cleanup ───────────────────────────────────

function refundStaleBetsOnStartup(): void {
  const stale = db
    .prepare("SELECT user_id, SUM(amount) AS total FROM keiba_bets GROUP BY user_id")
    .all() as Array<{ user_id: string; total: number }>;
  if (stale.length === 0) {
    updateSystemStatus({ is_racing: 0 });
    return;
  }

  runTransaction(() => {
    for (const row of stale) {
      const refund = adjustBalance(row.user_id, Math.floor(row.total), "システムエラー返金");
      if (!refund.ok) {
        throw new Error(`Failed to refund stale bet for ${row.user_id}`);
      }
    }
    db.prepare("DELETE FROM keiba_bets").run();
    updateSystemStatus({ is_racing: 0 });
  });
}

// ─── Bootstrap ─────────────────────────────────────────

async function bootstrap(): Promise<void> {
  initializeDatabase();
  try {
    refundStaleBetsOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleBetsOnStartup failed:", err);
  }
  try {
    refundStaleMarketsOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleMarketsOnStartup failed:", err);
  }
  try {
    refundStaleSashiOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleSashiOnStartup failed:", err);
  }
  try {
    refundStaleChohanOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleChohanOnStartup failed:", err);
  }
  try {
    refundStaleDuelsOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleDuelsOnStartup failed:", err);
  }
  // 為替の中断分を回収（API有効時のみ・非同期で投げっぱなし）
  reconcileStaleExchangesOnStartup().catch((err) =>
    console.error("[bootstrap] reconcileStaleExchangesOnStartup failed:", err),
  );
  // 起動時は全ゲームロックを開放する（プロセス再起動でメモリ上のセッションは消えている）
  const cleared = db.prepare("DELETE FROM game_sessions").run();
  if (cleared.changes > 0) {
    console.log(`[bootstrap] cleared ${cleared.changes} stale game lock(s)`);
  }
  cleanStaleSessions();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`✦ 星約の賭場 起動 — ${ready.user.tag}`);
    registerSchedulers(client);
    // 卓を立てる: 再起動前に空のまま残った一時VCを掃除（grace 0 = 即時）
    sweepStaleTempVCs(client, 0).catch((err) =>
      console.error("[bootstrap] sweepStaleTempVCs failed:", err),
    );
  });

  // 卓を立てる: 最後の1人が抜けたVCを自動削除
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleTableVoiceState(oldState, newState).catch((err) =>
      console.error("[voiceState] handleTableVoiceState failed:", err),
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // ── Slash Commands ──
      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case "遊ぶ":
            return await handleAsobuCommand(interaction);
          case "競馬":
            return await handleRaceCommand(interaction);
          case "星脈":
            return await handleStocksCommand(interaction);
          case "福分け":
            return await handleDailyCommand(interaction);
          case "通行証":
            return await handleProfileCommand(interaction);
          case "番付":
            return await handleRankingCommand(interaction);
          case "案内":
            return await handleCasinoCommand(interaction);
          case "管理":
            return await handleAdminCommand(interaction);
          case "商店":
            return await handleShoutenCommand(interaction);
          case "アステル":
            return await handleZashikiCommand(interaction);
          case "感謝":
            return await handleThanksCommand(interaction);
          case "両替":
            return await handleExchangeCommand(interaction);
          case "板":
            return await handleBoardCommand(interaction);
          case "サシ":
            return await handleSashiCommand(interaction);
          case "囃子":
            return await handleCheerCommand(interaction);
          case "卓":
            return await handleTakuCommand(interaction);
          case "盆":
            return await handleChohanCommand(interaction);
          case "賽勝負":
            return await handleSaiCommand(interaction);
        }
      }

      // ── 賭場の板 (plate:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("plate:")) {
        await handleBoardButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("plate:")) {
        await handleBoardSelect(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("plate:")) {
        await handleBoardModal(interaction);
        return;
      }

      // ── サシ星約 (sashi:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("sashi:")) {
        await handleSashiButton(interaction);
        return;
      }

      // ── 卓を立てる (taku:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("taku:")) {
        await handleTakuButton(interaction);
        return;
      }

      // ── 盆 (丁半 PvP / bon:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("bon:")) {
        await handleChohanButton(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("bon:")) {
        await handleChohanModal(interaction);
        return;
      }

      // ── 賽勝負 (チンチロ 1v1 / sai:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("sai:")) {
        await handleSaiButton(interaction);
        return;
      }

      // ── 両替承認 (exapprove:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("exapprove:")) {
        await handleExchangeApproval(interaction);
        return;
      }

      // ── Home UI Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("home_")) {
        await handleHomeButton(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("bet_modal_")) {
        await handleHomeModal(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("history_")) {
        const { handleHistoryButton } = require("./ui/panels/history");
        await handleHistoryButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId === "help_section_select") {
        const { handleHelpSectionSelect } = require("./ui/panels/help");
        await handleHelpSectionSelect(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("quest_claim_")) {
        const { handleQuestButton } = require("./ui/panels/quests");
        await handleQuestButton(interaction);
        return;
      }

      // ── Stocks Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("stocks_")) {
        await handleStocksButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("stocks_")) {
        await handleStocksSelect(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("stocks_")) {
        await handleStocksModal(interaction);
        return;
      }

      // ── Keiba Interactions ──
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("keiba:select:")) {
        await handleKeibaSelect(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("keiba:modal:")) {
        await handleKeibaModalSubmit(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("keiba:cancel_one:")) {
        await handleKeibaCancelOne(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("keiba:cancel:")) {
        await handleKeibaCancel(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("keiba:status:")) {
        await handleKeibaStatus(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("keiba:restart:")) {
        await handleKeibaRestart(interaction);
        return;
      }
    } catch (error) {
      console.error("[interaction] Unexpected error:", error);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "予期せぬエラーが発生しました。", ephemeral: true });
        }
      } catch (replyErr) {
        // 二重例外（既に応答済み・タイムアウト等）は握り潰す
        console.warn("[interaction] reply on error failed:", (replyErr as Error)?.message ?? replyErr);
      }
    }
  });

  // Discord クライアントのエラーをキャッチして、1リクエスト失敗で Bot 全体が落ちるのを防ぐ
  client.on(Events.Error, (err) => {
    console.error("[client] Discord client error:", err);
  });

  await client.login(config.discordToken);
}

// 未捕捉のプロミス拒否・例外でプロセスを落とさない（ログのみ）
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
});

bootstrap().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
