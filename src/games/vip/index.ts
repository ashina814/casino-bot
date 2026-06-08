/**
 * /vip — 奥座敷VIP（月課金エテル）
 * ─────────────────────────────────────────────────────────
 * /vip … VIP状態を表示＋[加入/更新]ボタン
 * 加入: エテルを VIP_PRICE 支払い → VIP_DAYS 日延長 → VIPロール付与（設定時）
 *
 * 期限切れのロール剥奪はスケジューラ（sweepExpiredVips）が担当。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Client,
} from "discord.js";
import { getServerConfig } from "../../core/db";
import { adjustBalance, ensureUser, getBalance } from "../../core/bank";
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { PALETTE, formatEther, WORLD } from "../../world.config";
import {
  isVip, vipDaysLeft, grantVip, getExpiredVips, removeVip,
  VIP_PRICE, VIP_DAYS, VIP_BETCAP_MULT,
} from "../../core/vip";

export const vipCommand = new SlashCommandBuilder()
  .setName("vip")
  .setDescription(`💎 ${WORLD.AREA_BACK}のVIP会員（月会費エテル）`);

export async function handleVipCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }
  ensureUser(interaction.user.id, guildId);
  await interaction.reply({ ...renderStatus(interaction.user.id, guildId), ephemeral: true });
}

function renderStatus(userId: string, guildId: string) {
  const active = isVip(userId, guildId);
  const left = vipDaysLeft(userId, guildId);

  const lines = [
    active
      ? `✅ いまきみは **VIP会員**。残り **${left}日**。`
      : `きみはまだVIPじゃないみたい。`,
    "",
    `**月会費**: ${formatEther(VIP_PRICE)} / ${VIP_DAYS}日`,
    "",
    "**特権**",
    `・💎 ${WORLD.AREA_BACK}（VIP談話・VIP遊戯）への入室`,
    `・🎲 賭け上限が **×${VIP_BETCAP_MULT}**`,
    "・👑 通行証などで VIP として表示",
  ];
  const embed = baseEmbed(`💎 ${WORLD.AREA_BACK} — VIP`, active ? PALETTE.STARGOLD : PALETTE.NIGHT)
    .setDescription(lines.join("\n"))
    .setFooter({ text: active ? "更新すると今の期限に日数が足されるよ。" : "加入すると即日VIP。期限が切れると自動で解除されるよ。" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("vip:join").setLabel(active ? "更新する" : "加入する").setStyle(ButtonStyle.Success).setEmoji("💎"),
  );
  return { embeds: [embed], components: [row] };
}

export async function handleVipButton(interaction: ButtonInteraction): Promise<void> {
  const [, action] = interaction.customId.split(":");
  if (action !== "join") return;
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }
  const userId = interaction.user.id;
  ensureUser(userId, guildId);

  if (getBalance(userId, guildId) < VIP_PRICE) {
    await interaction.reply({ embeds: [errorEmbed(`月会費 ${formatEther(VIP_PRICE)} に足りないみたい。`)], ephemeral: true });
    return;
  }

  const debit = adjustBalance(userId, -VIP_PRICE, "VIP月会費", "vip", guildId);
  if (!debit.ok) { await interaction.reply({ embeds: [errorEmbed("支払いに失敗しちゃった。")], ephemeral: true }); return; }

  grantVip(userId, guildId, VIP_DAYS);

  // ロール付与（設定があり、Bot権限があれば）
  let roleNote = "";
  const cfg = getServerConfig(guildId);
  if (cfg.vip_role_id) {
    const me = interaction.guild?.members.me;
    if (me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      const member = await interaction.guild!.members.fetch(userId).catch(() => null);
      const ok = await member?.roles.add(cfg.vip_role_id).then(() => true).catch(() => false);
      if (!ok) roleNote = "\n*（VIPロールの付与に失敗。ロール位置/権限を管理者に確認してね）*";
    } else {
      roleNote = "\n*（Botに「ロールの管理」権限が無くてロールを付けられなかったよ）*";
    }
  } else {
    roleNote = "\n*（VIPロール未設定。管理者が /管理 設定 で登録してね）*";
  }

  const left = vipDaysLeft(userId, guildId);
  await interaction.reply({
    embeds: [baseEmbed("💎 VIP加入", PALETTE.STARGOLD).setDescription(
      `${formatEther(VIP_PRICE)} を納めて、VIP会員になったよ。残り **${left}日**。\n${WORLD.AREA_BACK}へようこそ。${roleNote}`,
    )],
    ephemeral: true,
  });
}

// ─── 期限切れVIPのロール剥奪（スケジューラから定期実行） ──
export async function sweepExpiredVips(client: Client): Promise<number> {
  const expired = getExpiredVips();
  if (expired.length === 0) return 0;
  let removed = 0;
  for (const v of expired) {
    try {
      const cfg = getServerConfig(v.guild_id);
      if (cfg.vip_role_id) {
        const guild = await client.guilds.fetch(v.guild_id).catch(() => null);
        const member = guild ? await guild.members.fetch(v.user_id).catch(() => null) : null;
        await member?.roles.remove(cfg.vip_role_id).catch(() => {});
      }
      removeVip(v.user_id, v.guild_id);
      removed++;
    } catch (e) {
      console.warn(`[vip] expire sweep failed for ${v.user_id}:`, e);
    }
  }
  if (removed > 0) console.log(`[vip] expired ${removed} VIP member(s)`);
  return removed;
}
