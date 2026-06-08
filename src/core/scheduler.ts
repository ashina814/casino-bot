import cron from "node-cron";
import { Client } from "discord.js";
import { config } from "../config";
import { startRace } from "../games/keiba/logic";
import { initStockTables, updateAllPrices } from "../games/stocks/index";
import { getServerConfig, db } from "../core/db";
import { baseEmbed, COLORS } from "../ui/embeds";

export function registerSchedulers(client: Client): void {
  // 競馬: 土日21時 — 全ギルドの race_channel_id を見て発火（.env は fallback）
  cron.schedule("0 21 * * 6,0", async () => {
    const rows = db.prepare(
      "SELECT guild_id, race_channel_id FROM server_config WHERE race_channel_id IS NOT NULL AND race_channel_id != ''"
    ).all() as Array<{ guild_id: string; race_channel_id: string }>;

    const targets: string[] = rows.map((r) => r.race_channel_id);
    if (targets.length === 0 && config.raceChannelId) {
      targets.push(config.raceChannelId); // 旧 .env fallback（DB未設定guildのみ）
    }

    for (const channelId of targets) {
      try {
        await startRace(client, { channelId, initiatedBy: "system", isScheduled: true });
      } catch (error) {
        console.error(`[scheduler] Failed to start scheduled race (channel ${channelId}):`, error);
      }
    }
  });

  // 星脈相場: 3時間ごと（0/3/6/9/12/15/18/21時）に価格更新
  initStockTables();
  cron.schedule("0 */3 * * *", async () => {
    try {
      const { events } = updateAllPrices();
      console.log(`[scheduler] Stock prices updated. Events: ${events.length}`);

      // 株速報は毎回（全銘柄サマリー）投稿。イベント（サージ/暴落）があれば末尾に強調。
      const { buildMarketBroadcast } = require("../games/stocks/index");
      const { db } = require("../core/db");
      const rows = db.prepare(
        "SELECT guild_id, stock_channel_id FROM server_config WHERE stock_channel_id IS NOT NULL AND stock_channel_id != ''"
      ).all() as Array<{ guild_id: string; stock_channel_id: string }>;
      const embed = buildMarketBroadcast(events);
      for (const r of rows) {
        try {
          const channel = await client.channels.fetch(r.stock_channel_id);
          if (channel && channel.isTextBased()) {
            await (channel as any).send({ embeds: [embed] });
          }
        } catch (e) {
          console.warn(`[scheduler] stock broadcast failed for guild ${r.guild_id}:`, e);
        }
      }
    } catch (error) {
      console.error("[scheduler] Failed to update stock prices:", error);
    }
  });

  // VIP: 期限切れ会員のロール剥奪 ＋ 株: 保有期限超過の強制売却（毎時0分）
  cron.schedule("0 * * * *", async () => {
    try {
      const { sweepExpiredVips } = require("../games/vip");
      await sweepExpiredVips(client);
    } catch (error) {
      console.error("[scheduler] Failed to sweep expired VIPs:", error);
    }
    try {
      const { forceSellExpiredHoldings } = require("../games/stocks/index");
      await forceSellExpiredHoldings(client);
    } catch (error) {
      console.error("[scheduler] Failed to force-sell expired holdings:", error);
    }
  });

  // 卓を立てる: 空のまま放置された一時VCの定期掃除（10分ごと・grace 5分）
  cron.schedule("*/10 * * * *", async () => {
    try {
      const { sweepStaleTempVCs } = require("../games/takutate");
      await sweepStaleTempVCs(client, 5 * 60_000);
    } catch (error) {
      console.error("[scheduler] Failed to sweep temp VCs:", error);
    }
  });

  // 板: 精算/無効化から 24h 経った議題スレッドを削除（1時間ごと）
  cron.schedule("15 * * * *", async () => {
    try {
      const { sweepClosedBoardThreads } = require("../games/board");
      await sweepClosedBoardThreads(client);
    } catch (error) {
      console.error("[scheduler] Failed to sweep closed board threads:", error);
    }
  });

  // JPバーン清算: 5分ごとに閾値超のプールを RNG 判定で点火
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { tickJackpotBurn } = require("./jackpotBurn");
      await tickJackpotBurn(client);
    } catch (error) {
      console.error("[scheduler] jackpot burn tick failed:", error);
    }
  });

  // ゾンビセッション（5分以上経過した排他ロック）の定期クリーンアップ
  cron.schedule("*/5 * * * *", () => {
    try {
      const { cleanStaleSessions } = require("../core/db");
      const cleaned = cleanStaleSessions();
      if (cleaned > 0) {
        console.log(`[scheduler] Cleaned ${cleaned} stale game sessions.`);
      }
    } catch (error) {
      console.error("[scheduler] Failed to clean stale sessions:", error);
    }
  });
}
