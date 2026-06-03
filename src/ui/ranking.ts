/**
 * 🏆 番付（ランキング）
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
import { db } from "../core/db";
import { getTierByKey } from "../core/economy";
import { baseEmbed, COLORS } from "../ui/embeds";

type RankRow = { user_id: string; balance: number; tier: string; level: number };

// ─── Command ───────────────────────────────────────────

export const rankingCommand = new SlashCommandBuilder()
  .setName("番付")
  .setDescription("🏆 番付表を表示");

type RankType = "balance" | "winrate" | "streak" | "biggest_win" | "total_earned" | "total_wagered";

export async function handleRankingCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  const buildEmbed = (type: RankType) => {
    let rows: any[];
    let title: string;

    switch (type) {
      case "balance":
        rows = db.prepare(
          "SELECT user_id, balance, tier, level FROM users ORDER BY balance DESC LIMIT 10"
        ).all() as RankRow[];
        title = "💰 資産番付";
        break;
      case "winrate":
        rows = db.prepare(
          `SELECT user_id, balance, tier, level,
           CASE WHEN (total_wins + total_losses) > 0
             THEN CAST(total_wins AS REAL) / (total_wins + total_losses) * 100
             ELSE 0 END as winrate,
           (total_wins + total_losses) as total_games
           FROM users WHERE (total_wins + total_losses) >= 10
           ORDER BY winrate DESC LIMIT 10`
        ).all() as any[];
        title = "📈 勝率番付";
        break;
      case "streak":
        rows = db.prepare(
          "SELECT user_id, balance, tier, level, best_win_streak FROM users ORDER BY best_win_streak DESC LIMIT 10"
        ).all() as any[];
        title = "🔥 連勝番付";
        break;
      case "biggest_win":
        rows = db.prepare(
          "SELECT user_id, balance, tier, level, biggest_win FROM users WHERE biggest_win > 0 ORDER BY biggest_win DESC LIMIT 10"
        ).all() as any[];
        title = "💎 最大一発勝ち番付";
        break;
      case "total_earned":
        rows = db.prepare(
          "SELECT user_id, balance, tier, level, total_earned FROM users WHERE total_earned > 0 ORDER BY total_earned DESC LIMIT 10"
        ).all() as any[];
        title = "🥇 累計獲得番付";
        break;
      case "total_wagered":
        rows = db.prepare(
          "SELECT user_id, balance, tier, level, total_wagered FROM users WHERE total_wagered > 0 ORDER BY total_wagered DESC LIMIT 10"
        ).all() as any[];
        title = "💴 累計賭け額番付";
        break;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = rows.map((r: any, i: number) => {
      const medal = i < 3 ? medals[i] : `${i + 1}.`;
      const tierInfo = getTierByKey(r.tier);
      let stat = "";
      switch (type) {
        case "balance":      stat = `◈${r.balance.toLocaleString()}`; break;
        case "winrate":      stat = `${r.winrate.toFixed(1)}% (${r.total_games}戦)`; break;
        case "streak":       stat = `${r.best_win_streak}連勝`; break;
        case "biggest_win":  stat = `◈${r.biggest_win.toLocaleString()}`; break;
        case "total_earned": stat = `◈${r.total_earned.toLocaleString()}`; break;
        case "total_wagered":stat = `◈${r.total_wagered.toLocaleString()}`; break;
      }
      return `${medal} <@${r.user_id}>  ${stat}  ${tierInfo.emoji}${tierInfo.name}`;
    });

    // Find user's rank in this category
    let userRank: string | null = null;
    const rankQuery: Partial<Record<RankType, string>> = {
      balance:       "SELECT COUNT(*) + 1 as rank FROM users WHERE balance > (SELECT balance FROM users WHERE user_id = ?)",
      streak:        "SELECT COUNT(*) + 1 as rank FROM users WHERE best_win_streak > (SELECT best_win_streak FROM users WHERE user_id = ?)",
      biggest_win:   "SELECT COUNT(*) + 1 as rank FROM users WHERE biggest_win > (SELECT biggest_win FROM users WHERE user_id = ?)",
      total_earned:  "SELECT COUNT(*) + 1 as rank FROM users WHERE total_earned > (SELECT total_earned FROM users WHERE user_id = ?)",
      total_wagered: "SELECT COUNT(*) + 1 as rank FROM users WHERE total_wagered > (SELECT total_wagered FROM users WHERE user_id = ?)",
    };
    const q = rankQuery[type];
    if (q) {
      const rank = db.prepare(q).get(userId) as { rank: number } | undefined;
      const total = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
      if (rank) userRank = `${rank.rank}位 / ${total.c}人中`;
    }

    return baseEmbed(`✦ 星約の賭場 — ${title}`, COLORS.GOLD)
      .setDescription(
        [
          lines.length === 0 ? "*対象者なし*" : lines.join("\n"),
          "",
          userRank ? `── あなた ──\n${userRank}` : "",
        ].filter(Boolean).join("\n"),
      );
  };

  // 2行構成（合計6カテゴリ）
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rank_balance").setLabel("💰 資産").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rank_winrate").setLabel("📈 勝率").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank_streak").setLabel("🔥 連勝").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rank_biggest_win").setLabel("💎 最大1発勝ち").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank_total_earned").setLabel("🥇 累計獲得").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank_total_wagered").setLabel("💴 累計賭け").setStyle(ButtonStyle.Secondary),
  );

  const reply = await interaction.reply({
    embeds: [buildEmbed("balance")],
    components: [row1, row2],
    ephemeral: true,
    fetchReply: true,
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i: ButtonInteraction) => i.user.id === interaction.user.id,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    const type = btn.customId.replace("rank_", "") as RankType;
    await btn.update({ embeds: [buildEmbed(type)] });
  });

  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      try { await reply.edit({ components: [] }); } catch { /* */ }
    }
  });
}
