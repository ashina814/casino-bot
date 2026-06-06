import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config";
import { initializeDatabase, db, updateSystemStatus, cleanStaleSessions, runTransaction } from "./core/db";
import { adjustBalance } from "./core/bank";
import { handleAsobuCommand } from "./games/asobu";
import { handleRaceCommand } from "./games/keiba/command";
import { handleKeibaCancel, handleKeibaCancelOne, handleKeibaModalSubmit, handleKeibaSelect, handleKeibaStatus, handleKeibaRestart, handleKeibaGo } from "./games/keiba/logic";
import { registerSchedulers } from "./core/scheduler";

// ─── New: Casino Commands ──────────────────────────────

import { handleDailyCommand } from "./games/daily";
import { handleProfileCommand } from "./games/profile";
import { handleCasinoCommand, handleHomeButton, handleHomeModal } from "./ui/home";
import { handleStocksCommand, handleStocksButton, handleStocksSelect, handleStocksModal } from "./games/stocks";
import { handleAdminCommand } from "./admin/commands";
import { handleOwnerCommand } from "./admin/owner";
import { handleShakaCommand } from "./admin/shaka";
import { handleBlackjackButton } from "./games/blackjack";
import { handleShoutenCommand, handleShoutenButton, handleShoutenSelect } from "./games/shouten";
import { handleShopSelect } from "./games/shop";
import { handleZashikiCommand, handleAstelButton, handleAstelSelect } from "./games/zashiki";
import { handleExchangeCommand, handleExchangeApproval } from "./games/exchange";
import { reconcileStaleExchangesOnStartup } from "./core/exchange";
import { handleBoardCommand, handleBoardButton, handleBoardSelect, handleBoardModal, refundStaleMarketsOnStartup } from "./games/board";
import { handleSashiButton, refundStaleSashiOnStartup, bootSashiTimeouts } from "./games/sashi";
import { handleTipCommand } from "./games/tip";
import { handleTakuButton, handleTableVoiceState, sweepStaleTempVCs, refundAllVCDepositsOnStartup } from "./games/takutate";
import { handleChohanButton, handleChohanModal, refundStaleChohanOnStartup } from "./games/chohan";
import { handleSaiButton, refundStaleDuelsOnStartup, bootSaiTimeouts } from "./games/saishoubu";
import { handleBjDuelButton, refundStaleBjDuelsOnStartup, bootBjDuelTimeouts } from "./games/bjduel";
import { handleIndianButton, refundStaleIndianOnStartup, bootIndianTimeouts } from "./games/indian";
import { handlePokerButton, handlePokerSelect, refundStalePokerOnStartup, bootPokerTimeouts } from "./games/poker";
import { handleShoubuCommand } from "./games/shoubu";
import { handleVipCommand, handleVipButton } from "./games/vip";
import { handleNagareCommand } from "./games/nagareboshi";
import { bootDecisionPanels, handleDecisionButton } from "./games/decisionPanel";
import { setTxFeedHandler, type TxEvent } from "./core/txfeed";

// ─── Transaction Feed Posting ──────────────────────────
// adjustBalance のたびに該当 guild の tx_feed_channel_id に1行流す。
// 取引が連続する時の rate-limit 回避のため、guild ごとに 1.5秒バッファでまとめ送りする。
const feedBuffers = new Map<string, { lines: string[]; flushAt: NodeJS.Timeout | null; channelId: string }>();
const FEED_FLUSH_MS = 1500;
const FEED_MAX_LINES_PER_MSG = 10;

function fmtTxLine(e: TxEvent): string {
  const ts = new Date().toISOString().slice(11, 19);
  const sign = e.amount >= 0 ? "+" : "";
  const game = e.game ? `[${e.game}]` : "";
  return `\`${ts}\` <@${e.userId}> ${sign}◈${e.amount.toLocaleString()} ${game} ${e.reason}`;
}

async function postTxFeedLine(client: import("discord.js").Client, e: TxEvent): Promise<void> {
  if (!e.guildId) return;
  let cfg;
  try {
    cfg = db.prepare("SELECT tx_feed_channel_id FROM server_config WHERE guild_id = ?").get(e.guildId) as { tx_feed_channel_id: string | null } | undefined;
  } catch { return; }
  const channelId = cfg?.tx_feed_channel_id;
  if (!channelId) return;

  const buf = feedBuffers.get(e.guildId) ?? { lines: [], flushAt: null, channelId };
  buf.channelId = channelId;
  buf.lines.push(fmtTxLine(e));
  feedBuffers.set(e.guildId, buf);

  if (!buf.flushAt) {
    buf.flushAt = setTimeout(() => { void flushTxFeed(client, e.guildId!); }, FEED_FLUSH_MS);
  }
}

async function flushTxFeed(client: import("discord.js").Client, guildId: string): Promise<void> {
  const buf = feedBuffers.get(guildId);
  if (!buf || buf.lines.length === 0) return;
  buf.flushAt = null;
  const lines = buf.lines.splice(0, buf.lines.length);

  try {
    const channel = await client.channels.fetch(buf.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    for (let i = 0; i < lines.length; i += FEED_MAX_LINES_PER_MSG) {
      const chunk = lines.slice(i, i + FEED_MAX_LINES_PER_MSG).join("\n");
      await (channel as any).send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {});
    }
  } catch (err) {
    console.warn("[txfeed] flush failed:", err);
  }
}

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
  // 卓デポジットは最初に保護返金（後続の void / VC 削除で没収扱いになる前に）
  try {
    refundAllVCDepositsOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundAllVCDepositsOnStartup failed:", err);
  }
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
  try {
    refundStaleBjDuelsOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleBjDuelsOnStartup failed:", err);
  }
  try {
    refundStaleIndianOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStaleIndianOnStartup failed:", err);
  }
  try {
    refundStalePokerOnStartup();
  } catch (err) {
    console.error("[bootstrap] refundStalePokerOnStartup failed:", err);
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
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // ⚠ Discord Dev Portal で privileged intent を有効化必要
    ],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`✦ 星約の賭場 起動 — ${ready.user.tag}`);
    registerSchedulers(client);
    // 卓を立てる: 再起動前に空のまま残った一時VCを掃除（grace 0 = 即時）
    sweepStaleTempVCs(client, 0).catch((err) =>
      console.error("[bootstrap] sweepStaleTempVCs failed:", err),
    );
    // 続行/やめる パネルの再開・期限切れの掃除・tick 開始
    try {
      bootDecisionPanels(client);
    } catch (err) {
      console.error("[bootstrap] bootDecisionPanels failed:", err);
    }
    // サシ: 報告フェーズ10分 / アクティブ6時間 / pending 1時間 の自動タイムアウト
    try {
      bootSashiTimeouts(client);
    } catch (err) {
      console.error("[bootstrap] bootSashiTimeouts failed:", err);
    }
    // チンチロ対戦: pending 1時間 の自動辞退
    try {
      bootSaiTimeouts(client);
    } catch (err) {
      console.error("[bootstrap] bootSaiTimeouts failed:", err);
    }
    // BJ 対人戦: pending 1時間 / active 6時間 の自動タイムアウト
    try {
      bootBjDuelTimeouts(client);
    } catch (err) {
      console.error("[bootstrap] bootBjDuelTimeouts failed:", err);
    }
    // インディアンポーカー: pending 1時間 / active 6時間
    try {
      bootIndianTimeouts(client);
    } catch (err) {
      console.error("[bootstrap] bootIndianTimeouts failed:", err);
    }
    // 5枚交換ポーカー
    try {
      bootPokerTimeouts(client);
    } catch (err) {
      console.error("[bootstrap] bootPokerTimeouts failed:", err);
    }
    // 通貨ログのライブフィード（adjustBalance 毎にチャットへ1行）
    setTxFeedHandler((e: TxEvent) => { void postTxFeedLine(client, e); });
  });

  // 卓を立てる: 最後の1人が抜けたVCを自動削除
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleTableVoiceState(oldState, newState).catch((err) =>
      console.error("[voiceState] handleTableVoiceState failed:", err),
    );
  });

  // ─── アステル: 「飽きた」リアクション（1/3 で反応） ──
  const TIRED_LINES = [
    "飽きるなんて、もったいないよ。",
    "じゃあ、わたしに何かしてみる？",
    "そういう時こそ、何もしないのがいいんだよ。",
    "わたしも、たまにはそうなる。",
    "ふぅん。…じゃあ、座って話そっか。",
    "賭場の風に当たってみる？気分変わるよ。",
    "そっか。じゃあ星でも見てよ。",
  ];
  client.on(Events.MessageCreate, (message) => {
    try {
      if (message.author.bot || !message.guild) return;
      const content = message.content ?? "";
      if (!content.includes("飽きた")) return;
      if (Math.random() >= 1 / 3) return;
      const line = TIRED_LINES[Math.floor(Math.random() * TIRED_LINES.length)];
      void message.reply({ content: `*「${line}」*`, allowedMentions: { repliedUser: false } }).catch(() => {});
    } catch (err) {
      console.warn("[message] tired reaction failed:", err);
    }
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
          case "株":
            return await handleStocksCommand(interaction);
          case "通行証":
            return await handleProfileCommand(interaction);
          case "案内":
            return await handleCasinoCommand(interaction);
          case "管理":
            return await handleAdminCommand(interaction);
          case "オーナー":
            return await handleOwnerCommand(interaction);
          case "釈迦の心づけ":
            return await handleShakaCommand(interaction);
          case "商店":
            return await handleShoutenCommand(interaction);
          case "アステル":
            return await handleZashikiCommand(interaction);
          case "両替":
            return await handleExchangeCommand(interaction);
          case "勝負":
            return await handleShoubuCommand(interaction);
          case "心付け":
            return await handleTipCommand(interaction);
          case "vip":
            return await handleVipCommand(interaction);
          case "流れ星":
            return await handleNagareCommand(interaction);
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

      // ── 商店パネル (shouten:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("shouten:")) {
        await handleShoutenButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("shouten:")) {
        await handleShoutenSelect(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId === "shop_select") {
        await handleShopSelect(interaction);
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

      // ── BJ対戦 (bjd:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("bjd:")) {
        await handleBjDuelButton(interaction);
        return;
      }

      // ── インディアン (ind:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("ind:")) {
        await handleIndianButton(interaction);
        return;
      }

      // ── 5枚交換ポーカー (pkr:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("pkr:")) {
        await handlePokerButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("pkr:")) {
        await handlePokerSelect(interaction);
        return;
      }

      // ── 続行/やめる パネル (decision:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("decision:")) {
        await handleDecisionButton(interaction);
        return;
      }

      // ── VIP (vip:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("vip:")) {
        await handleVipButton(interaction);
        return;
      }

      // ── アステル パネル (aste:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("aste:")) {
        await handleAstelButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("aste:")) {
        await handleAstelSelect(interaction);
        return;
      }

      // ── 両替承認 (exapprove:) Interactions ──
      if (interaction.isButton() && interaction.customId.startsWith("exapprove:")) {
        await handleExchangeApproval(interaction);
        return;
      }

      // ── ブラックジャック もう一回 / 配当表 / 退席（時間制限なし global） ──
      if (interaction.isButton() && (
        interaction.customId.startsWith("bj_retry_") ||
        interaction.customId === "bj_paytable" ||
        interaction.customId.startsWith("bj_quit")
      )) {
        await handleBlackjackButton(interaction);
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
      if (interaction.isButton() && interaction.customId.startsWith("keiba:go:")) {
        await handleKeibaGo(interaction);
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
