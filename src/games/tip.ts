import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { adjustBalance, ensureUser } from "../core/bank";
import { db, runTransaction } from "../core/db";
import { infoEmbed, errorEmbed, successEmbed, COLORS } from "../ui/embeds";
import { memberName, memberNameOfCached } from "../core/names";

// 折衷化: 賭けの精算には使わない "気持ち程度のチップ"。
// RMT・経済横流しの温床にならないよう、1日1回・1回◈500 までに絞る。
const TIP_MAX_AMOUNT = 500;

export const tipCommand = new SlashCommandBuilder()
  .setName("心付け")
  .setDescription("💸 気持ちを贈る（1日1回・◈500 まで）")
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

  // 1日1回 CD（既存 last_daily の流儀に合わせ UTC 日付で判定）
  ensureUser(senderId, guildId);
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT last_tip_date FROM users WHERE user_id = ?").get(senderId) as { last_tip_date: string | null } | undefined;
  if (row?.last_tip_date === today) {
    await interaction.reply({ embeds: [errorEmbed("今日はもう渡してるよ。気持ちは明日また。")], ephemeral: true });
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

      // CD 記録（同一トランザクション内）
      db.prepare("UPDATE users SET last_tip_date = ? WHERE user_id = ?").run(today, senderId);
      return true;
    });

    if (!success) {
      await interaction.reply({ embeds: [errorEmbed("残高が足りないみたい。まずは稼いでこ。")], ephemeral: true });
      return;
    }

    const msgDesc = message ? `\n\n📝 **メッセージ:**\n「${message}」` : "";

    // 座敷童の好感度: tipの心遣いに座敷童が喜ぶ
    let affectionNote = "";
    try {
      const { addTipAffection } = require("../core/db");
      if (addTipAffection(senderId)) {
        affectionNote = "\n\n*（アステルがこちらを見て微笑んでいる…💖）*";
      }
    } catch {}

    const embed = successEmbed(
      `💸 **${memberName(interaction)}** が **${memberNameOfCached(interaction.guild, targetUser)}** に ◈${amount.toLocaleString()} エテルを贈りました！${msgDesc}${affectionNote}`
    );

    await interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });

  } catch (error) {
    console.error("[tip] Transfer failed:", error);
    await interaction.reply({ embeds: [errorEmbed("送金処理に失敗しちゃった。")], ephemeral: true });
  }
}
