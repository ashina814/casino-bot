import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db, getSystemStatus } from "../../core/db";

export const raceCommand = new SlashCommandBuilder()
  .setName("競馬")
  .setDescription("🏇 競馬 — レース関連コマンド")
  .addSubcommand((sub) => sub.setName("start").setDescription("競馬レースを今すぐ開始"))
  .addSubcommand((sub) => sub.setName("audit").setDescription("資金監査サマリーを表示"));

function formatNum(value: number): string {
  return Math.floor(value).toLocaleString();
}

export async function handleRaceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "audit") {
    try {
      const users = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total FROM users").get() as {
        count: number;
        total: number;
      };
      const logs = db
        .prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM transaction_logs")
        .get() as { total: number; count: number };
      const bets = db
        .prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM keiba_bets")
        .get() as { total: number; count: number };
      const status = getSystemStatus();

      await interaction.reply({
        ephemeral: true,
        content: [
          "📒 資金監査サマリー",
          `- ユーザー数: ${users.count}`,
          `- users残高合計: ${formatNum(users.total)} エテル`,
          `- transaction_logs件数: ${logs.count}`,
          `- transaction_logs金額合計: ${formatNum(logs.total)} エテル`,
          `- 未精算賭け件数: ${bets.count}`,
          `- 未精算賭け金合計: ${formatNum(bets.total)} エテル`,
          `- 進行中フラグ(is_racing): ${status.is_racing}`,
          `- 単勝キャリー: ${formatNum(status.keiba_carryover_win)} エテル`,
          `- 複勝キャリー: ${formatNum(status.keiba_carryover_place)} エテル`
        ].join("\n")
      });
    } catch (error) {
      console.error("[command] /race audit failed:", error);
      await interaction.reply({ content: "監査情報の取得に失敗しました。", ephemeral: true });
    }
    return;
  }

  if (subcommand !== "start") {
    await interaction.reply({ content: "未対応のサブコマンドです。", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "レースを準備しています...", ephemeral: true });
  try {
    const { startRace } = await import("./logic");
    await startRace(interaction.client, {
      channelId: interaction.channelId,
      initiatedBy: interaction.user.tag,
      isScheduled: false
    });
    await interaction.editReply("レース受付パネルを作成しました。");
  } catch (error) {
    console.error("[command] /race start failed:", error);
    await interaction.editReply("現在レースを開始できませんでした。進行中レースがあるか、権限を確認してください。");
  }
}
