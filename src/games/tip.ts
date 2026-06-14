import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { adjustBalance, ensureUser } from "../core/bank";
import { db, runTransaction } from "../core/db";
import { infoEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";
import { memberName, memberNameOfCached } from "../core/names";

// 折衷化: 賭けの精算には使わない "気持ち程度のチップ"。
// RMT・経済横流しの温床にならないよう、1日3回・1回◈500 までに絞る。
const TIP_MAX_AMOUNT = 500;
const TIP_DAILY_CAP = 3;

export const tipCommand = new SlashCommandBuilder()
  .setName("心付け")
  .setDescription(`💸 気持ちを贈る（1日${TIP_DAILY_CAP}回まで・1回◈${TIP_MAX_AMOUNT}）`)
  .addUserOption((o) => o.setName("user").setDescription("贈る相手").setRequired(true))
  .addIntegerOption((o) =>
    // setMaxValue を付けると Discord 側で先に弾かれて素っ気ないエラーが出るので、
    // ボット内で判定して親切な文言を返す。
    o.setName("amount").setDescription("贈る額（◈100 〜 ◈500）").setRequired(true).setMinValue(1),
  )
  .addStringOption((o) => o.setName("message").setDescription("メッセージ（任意）").setRequired(false));

export async function handleTipCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const message = interaction.options.getString("message") || "";
  const guildId = interaction.guildId!;
  const senderId = interaction.user.id;

  if (targetUser.bot) {
    await interaction.reply({ embeds: [errorEmbed("ボットにエテルは送れないよ。")], ephemeral: true });
    return;
  }

  if (targetUser.id === senderId) {
    await interaction.reply({ embeds: [errorEmbed("自分自身には送れぬわ。")], ephemeral: true });
    return;
  }

  // 上限ガード（親切な文言で返す）
  if (amount > TIP_MAX_AMOUNT) {
    await interaction.reply({
      embeds: [errorEmbed(`気持ちはうれしいけど、心付けは ◈${TIP_MAX_AMOUNT} までだよ。\n大きく動かしたいなら \`/サシ\` や \`/板\` の勝負で。`)],
      ephemeral: true,
    });
    return;
  }
  if (amount < 100) {
    await interaction.reply({ embeds: [errorEmbed("最低 ◈100 から贈れるよ。")], ephemeral: true });
    return;
  }

  // 1日3回 CD（affection.daily_tip_count を共通カウンタとして使う）
  ensureUser(senderId, guildId);
  const today = new Date().toISOString().slice(0, 10);
  const tipCountRow = db.prepare(
    "SELECT daily_tip_count, daily_counter_date FROM affection WHERE user_id = ?",
  ).get(senderId) as { daily_tip_count: number; daily_counter_date: string | null } | undefined;
  const tipsUsedToday = (tipCountRow && tipCountRow.daily_counter_date === today)
    ? tipCountRow.daily_tip_count : 0;
  if (tipsUsedToday >= TIP_DAILY_CAP) {
    await interaction.reply({
      embeds: [errorEmbed(`今日はもう ${TIP_DAILY_CAP} 回渡したよ。気持ちは明日また。`)],
      ephemeral: true,
    });
    return;
  }

  try {
    const success = runTransaction(() => {
      // 送信元の残高確認と引き落とし
      const deduct = adjustBalance(senderId, -amount, "tip_send");
      if (!deduct.ok) {
        return false;
      }

      // 送信先のアカウントを作成・加算
      ensureUser(targetUser.id, guildId);
      const add = adjustBalance(targetUser.id, amount, "tip_receive", undefined, guildId);
      if (!add.ok) {
        throw new Error("Failed to add tip to receiver.");
      }

      // CD は affection.daily_tip_count（addTipAffection が +1 する）に集約。
      // 旧 users.last_tip_date は使わない（カラム自体は残置）。
      return true;
    });

    if (!success) {
      await interaction.reply({ embeds: [errorEmbed("残高が足りないみたい。まずは稼いでこ。")], ephemeral: true });
      return;
    }

    const msgDesc = message ? `\n\n📝 **メッセージ:**\n「${message}」` : "";

    // 座敷童の好感度: tipの心遣いに座敷童が喜ぶ（同時に daily_tip_count を +1）
    let affectionNote = "";
    let usedAfter = tipsUsedToday + 1; // 失敗しても画面上の残数表示には使う
    try {
      const { addTipAffection } = require("../core/db");
      if (addTipAffection(senderId)) {
        affectionNote = "\n\n*（アステルがこちらを見て微笑んでいる…💖）*";
      }
    } catch {}
    const remaining = Math.max(0, TIP_DAILY_CAP - usedAfter);
    const remainNote = remaining > 0
      ? `\n*（今日はあと ${remaining} 回まで贈れるよ）*`
      : `\n*（今日の心付けはこれで打ち止め。また明日ね）*`;

    const embed = successEmbed(
      `💸 **${memberName(interaction)}** が **${memberNameOfCached(interaction.guild, targetUser)}** に ◈${amount.toLocaleString()} エテルを贈りました！${msgDesc}${affectionNote}${remainNote}`
    );

    await interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });

  } catch (error) {
    console.error("[tip] Transfer failed:", error);
    await interaction.reply({ embeds: [errorEmbed("送金処理に失敗しちゃった。")], ephemeral: true });
  }
}
