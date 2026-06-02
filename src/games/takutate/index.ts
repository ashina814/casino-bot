/**
 * 卓を立てる（複製VC） — DESIGN_v2 §7.4
 * ─────────────────────────────────────────────────────────
 * パネルのボタンから用途別の一時VCを生成する。
 *   - 種類ごとに名前・人数上限・アイコンが変わる
 *   - 最後の1人が退出すると自動削除（handleTableVoiceState）
 *   - 誰も入らず放置されたVCは定期/起動時 sweep で回収
 *
 * 追跡テーブル: temp_voice_channels（再起動を跨いでも掃除できる）
 * 必要 intent: GatewayIntentBits.GuildVoiceStates
 * 必要 Bot 権限: ManageChannels（生成/削除）, MoveMembers（任意・入室済みなら移動）
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  Client,
  VoiceState,
  type VoiceChannel,
  type CategoryChannel,
} from "discord.js";
import { db } from "../../core/db";
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { PALETTE } from "../../world.config";

// ─── 卓の種類定義 ─────────────────────────────────────
// userLimit 0 = 無制限
type TableType = {
  key: string;
  label: string;       // ボタン表示
  emoji: string;
  vcName: string;      // 生成VC名（{name} は立てた人の表示名に置換）
  userLimit: number;
  style: ButtonStyle;
};

const TABLE_TYPES: TableType[] = [
  { key: "sashi",   label: "サシ勝負卓 (2人)", emoji: "⚔️", vcName: "⚔️ サシの間・{name}",   userLimit: 2, style: ButtonStyle.Danger },
  { key: "mahjong", label: "麻雀卓 (4人)",     emoji: "🀄", vcName: "🀄 四人の卓・{name}",   userLimit: 4, style: ButtonStyle.Primary },
  { key: "versus",  label: "対戦卓 (可変)",     emoji: "🎮", vcName: "🎮 対戦の間・{name}",   userLimit: 0, style: ButtonStyle.Primary },
  { key: "watch",   label: "観戦卓",            emoji: "👀", vcName: "👀 観戦の間・{name}",   userLimit: 0, style: ButtonStyle.Secondary },
  { key: "chat",    label: "雑談卓",            emoji: "💬", vcName: "💬 語らいの間・{name}", userLimit: 0, style: ButtonStyle.Secondary },
];

function getType(key: string): TableType | undefined {
  return TABLE_TYPES.find((t) => t.key === key);
}

// ─── 連打防止（プロセス内） ───────────────────────────
const COOLDOWN_MS = 30_000;
const lastCreate = new Map<string, number>();

// ─── DB ヘルパ ────────────────────────────────────────
type TempVCRow = {
  channel_id: string;
  guild_id: string;
  owner_id: string;
  table_type: string;
  created_at: string;
};

function trackVC(channelId: string, guildId: string, ownerId: string, type: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO temp_voice_channels (channel_id, guild_id, owner_id, table_type) VALUES (?, ?, ?, ?)",
  ).run(channelId, guildId, ownerId, type);
}

function untrackVC(channelId: string): void {
  db.prepare("DELETE FROM temp_voice_channels WHERE channel_id = ?").run(channelId);
}

function isTrackedVC(channelId: string): boolean {
  return !!db.prepare("SELECT 1 FROM temp_voice_channels WHERE channel_id = ?").get(channelId);
}

function countOwnerVCs(ownerId: string, guildId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM temp_voice_channels WHERE owner_id = ? AND guild_id = ?",
  ).get(ownerId, guildId) as { c: number };
  return row.c;
}

// ─── コマンド ─────────────────────────────────────────
export const takuCommand = new SlashCommandBuilder()
  .setName("卓")
  .setDescription("🎴 卓を立てる（用途別の一時VCを生成）")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((sc) =>
    sc.setName("設置").setDescription("このチャンネルに「卓を立てる」パネルを設置（管理者）"),
  )
  .addSubcommand((sc) =>
    sc.setName("片付け").setDescription("空になった卓VCをいま掃除する（管理者）"),
  );

export async function handleTakuCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "設置") return postPanel(interaction);
  if (sub === "片付け") return manualSweep(interaction);
}

async function postPanel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ embeds: [errorEmbed("このコマンドは管理者だけが使えるよ。")], ephemeral: true });
    return;
  }

  const embed = baseEmbed("🎴 卓を立てる", PALETTE.STARGOLD).setDescription(
    [
      "*「どの卓をお立てになる？」*",
      "",
      "用途を選ぶと、専用のVC（卓）が立つよ。",
      "**最後のひとりが抜けると、卓はそっと片付けるね。**",
      "",
      "⚔️ サシ勝負卓 … 2人用の決闘の間",
      "🀄 麻雀卓 … 4人用",
      "🎮 対戦卓 … GF/Apex など、人数自由",
      "👀 観戦卓 … 眺めるための席",
      "💬 雑談卓 … ただ語らうための間",
    ].join("\n"),
  );

  // 5ボタン → 1行に収まる（max 5/row）
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TABLE_TYPES.map((t) =>
      new ButtonBuilder().setCustomId(`taku:create:${t.key}`).setLabel(t.label).setEmoji(t.emoji).setStyle(t.style),
    ),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ─── ボタン: 卓生成 ───────────────────────────────────
export async function handleTakuButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, typeKey] = interaction.customId.split(":");
  if (action !== "create") return;
  await createTable(interaction, typeKey);
}

async function createTable(interaction: ButtonInteraction, typeKey: string): Promise<void> {
  const type = getType(typeKey);
  const guild = interaction.guild;
  if (!type || !guild) {
    await interaction.reply({ embeds: [errorEmbed("その卓は立てられないみたい。")], ephemeral: true });
    return;
  }

  // Bot 権限チェック
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      embeds: [errorEmbed("VCを立てる権限（チャンネルの管理）がわたしに無いみたい。サーバー管理者に頼んでね。")],
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;

  // 連打防止
  const now = Date.now();
  const last = lastCreate.get(userId) ?? 0;
  const remain = COOLDOWN_MS - (now - last);
  if (remain > 0) {
    await interaction.reply({
      embeds: [errorEmbed(`続けては立てられないよ。あと ${Math.ceil(remain / 1000)} 秒待ってね。`)],
      ephemeral: true,
    });
    return;
  }

  // 1人あたり同時2卓まで（放置乱立を防ぐ）
  if (countOwnerVCs(userId, guild.id) >= 2) {
    await interaction.reply({
      embeds: [errorEmbed("きみが立てた卓がもう2つあるよ。使い終わった卓を片付けてからにしてね。")],
      ephemeral: true,
    });
    return;
  }

  // 設置先カテゴリ = パネルが置かれたチャンネルの親カテゴリ
  const panelChannel = interaction.channel;
  const parent: CategoryChannel | null =
    panelChannel && "parent" in panelChannel ? (panelChannel.parent as CategoryChannel | null) : null;

  // 入室権限はパネルを置いたテキストチャンネルに追従させる。
  // そのテキストチャンネルの上書きをコピーすれば「このチャンネルを見られる人＝卓に入れる人」になる。
  // （ViewChannel が許可された者だけがVCを見て入れる／拒否された者は入れない）
  const overwrites =
    panelChannel && "permissionOverwrites" in panelChannel
      ? panelChannel.permissionOverwrites.cache.map((o) => ({
          id: o.id,
          type: o.type,
          allow: o.allow.bitfield,
          deny: o.deny.bitfield,
        }))
      : undefined;

  lastCreate.set(userId, now);

  let vc: VoiceChannel;
  try {
    vc = await guild.channels.create({
      name: type.vcName.replace("{name}", interaction.user.displayName).slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: parent ?? undefined,
      userLimit: type.userLimit,
      permissionOverwrites: overwrites,
      reason: `卓を立てる: ${interaction.user.tag} (${type.label})`,
    });
  } catch (err) {
    console.error("[taku] VC create failed:", err);
    await interaction.reply({ embeds: [errorEmbed("卓を立てるのに失敗しちゃった。もう一度試してみて。")], ephemeral: true });
    return;
  }

  trackVC(vc.id, guild.id, userId, type.key);

  // 立てた人が既にVCにいれば、新しい卓へ移動してあげる
  let moved = false;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member?.voice.channelId && me.permissions.has(PermissionFlagsBits.MoveMembers)) {
    moved = await member.voice.setChannel(vc).then(() => true).catch(() => false);
  }

  await interaction.reply({
    embeds: [
      baseEmbed(`${type.emoji} 卓を立てたよ`, PALETTE.JADE).setDescription(
        [
          `<#${vc.id}> を用意したよ。${moved ? "きみはもう座ってる。" : "VCに入って始めてね。"}`,
          type.userLimit > 0 ? `定員: **${type.userLimit}人**` : "定員: なし",
          "",
          "*最後のひとりが抜けたら、わたしが片付けておくね。*",
        ].join("\n"),
      ),
    ],
    ephemeral: true,
  });
}

// ─── VoiceState: 最後の1人退出で自動削除 ─────────────
export async function handleTableVoiceState(oldState: VoiceState, newState: VoiceState): Promise<void> {
  // 退出 or 移動元になったチャンネルだけ気にする
  const leftChannelId = oldState.channelId;
  if (!leftChannelId || leftChannelId === newState.channelId) return;
  if (!isTrackedVC(leftChannelId)) return;

  const channel = oldState.guild.channels.cache.get(leftChannelId)
    ?? (await oldState.guild.channels.fetch(leftChannelId).catch(() => null));
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    untrackVC(leftChannelId);
    return;
  }
  if ((channel as VoiceChannel).members.size > 0) return;

  await (channel as VoiceChannel).delete("卓を立てる: 最後の利用者が退出").catch(() => {});
  untrackVC(leftChannelId);
}

// ─── 空VCの掃除（起動時 / 定期 / 手動） ───────────────
/**
 * 追跡中の一時VCを点検し、空のものを削除する。
 * @param graceMs これより新しい（＝立てたばかり）VCは未入室でも残す。起動時は 0 を渡して即掃除。
 * @returns 削除した数
 */
export async function sweepStaleTempVCs(client: Client, graceMs = 0): Promise<number> {
  const rows = db.prepare("SELECT * FROM temp_voice_channels").all() as TempVCRow[];
  if (rows.length === 0) return 0;

  let removed = 0;
  for (const r of rows) {
    try {
      const channel = await client.channels.fetch(r.channel_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        untrackVC(r.channel_id);
        removed++;
        continue;
      }
      const vc = channel as VoiceChannel;
      if (vc.members.size > 0) continue;

      // 立てたばかりで未入室のものは grace 内なら残す
      const ageMs = Date.now() - new Date(r.created_at + "Z").getTime();
      if (graceMs > 0 && ageMs < graceMs) continue;

      await vc.delete("卓を立てる: 空き卓の掃除").catch(() => {});
      untrackVC(r.channel_id);
      removed++;
    } catch (e) {
      console.warn(`[taku] sweep failed for ${r.channel_id}:`, e);
    }
  }
  if (removed > 0) console.log(`[taku] swept ${removed} empty table VC(s)`);
  return removed;
}

async function manualSweep(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ embeds: [errorEmbed("このコマンドは管理者だけが使えるよ。")], ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const n = await sweepStaleTempVCs(interaction.client, 0);
  await interaction.editReply({ embeds: [baseEmbed("🧹 片付け完了", PALETTE.JADE).setDescription(`空いてた卓を **${n}** 個 片付けたよ。`)] });
}
