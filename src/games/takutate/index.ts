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
import { adjustBalance, getBalance } from "../../core/bank";
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { PALETTE, WORLD, formatEther } from "../../world.config";
import { memberName } from "../../core/names";

// 紐付きVC のデポジット: 立てるとき◈X 預け、勝負が 1回でも成立すれば返却、
// 一度も成立せず VC が消えたら JP没収。雑談VC化の心理障壁＋経済的ペナルティ。
const VC_DEPOSIT = 500;

// ─── DB ヘルパ ────────────────────────────────────────
type TempVCRow = {
  channel_id: string;
  guild_id: string;
  owner_id: string;
  table_type: string;
  created_at: string;
  link_type?: string | null;
  link_id?: string | null;
  deposit_holder?: string | null;
  deposit_amount?: number;
  settle_count?: number;
  last_settled_at?: string | null;
};

function trackVC(
  channelId: string,
  guildId: string,
  ownerId: string,
  type: string,
  linkType: string | null = null,
  linkId: string | null = null,
  depositHolder: string | null = null,
  depositAmount = 0,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO temp_voice_channels
       (channel_id, guild_id, owner_id, table_type, link_type, link_id, deposit_holder, deposit_amount, settle_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(channelId, guildId, ownerId, type, linkType, linkId, depositHolder, depositAmount);
}

/** 紐付き勝負の精算が走ったら呼ぶ（デポジット返却条件をクリア＋アイドル時計のリセット）。idempotent。 */
export function markLinkedVCSettled(linkType: string, linkId: string): void {
  db.prepare(
    "UPDATE temp_voice_channels SET settle_count = settle_count + 1, last_settled_at = datetime('now') WHERE link_type = ? AND link_id = ?",
  ).run(linkType, linkId);
}

// 紐付きVCのアイドル上限: 最終 settle（または settle 0回なら created_at）から
// これだけ経った卓は、人がいても sweep で片付ける（雑談化防止）。
const LINKED_VC_IDLE_LIMIT_MS = 15 * 60_000;

/**
 * 特定の link 対象に紐付く VC デポジットを保有者へ即返金（idempotent）。
 * 管理者が cancel/sweep する時に呼ぶ — ユーザー責でない事由で没収するのを防ぐ。
 */
export function refundLinkedVCDeposit(linkType: string, linkId: string): boolean {
  const row = db.prepare(
    `SELECT channel_id, deposit_holder, deposit_amount, guild_id
     FROM temp_voice_channels
     WHERE link_type = ? AND link_id = ? AND deposit_amount > 0 AND deposit_holder IS NOT NULL`,
  ).get(linkType, linkId) as { channel_id: string; deposit_holder: string; deposit_amount: number; guild_id: string } | undefined;
  if (!row) return false;
  adjustBalance(row.deposit_holder, row.deposit_amount, "卓: 管理者取消による保護返金", "takutate", row.guild_id);
  db.prepare("UPDATE temp_voice_channels SET deposit_amount = 0 WHERE channel_id = ?").run(row.channel_id);
  return true;
}

/**
 * 起動時に呼ぶ: 保有中のデポジットを全て即返金。
 * 再起動でゲームが void になり settle_count=0 のまま VC が消されてデポが没収される
 * 不公正を防ぐ。返金後 deposit_amount=0 なので、生き残った VC が後で settle/close しても
 * 二重返金は発生しない。
 */
export function refundAllVCDepositsOnStartup(): void {
  const rows = db.prepare(
    `SELECT channel_id, deposit_holder, deposit_amount, guild_id
     FROM temp_voice_channels
     WHERE deposit_amount > 0 AND deposit_holder IS NOT NULL`,
  ).all() as Array<{ channel_id: string; deposit_holder: string; deposit_amount: number; guild_id: string }>;
  if (rows.length === 0) return;

  let refunded = 0;
  for (const r of rows) {
    adjustBalance(r.deposit_holder, r.deposit_amount, "卓: 再起動による保護返金", "takutate", r.guild_id);
    db.prepare("UPDATE temp_voice_channels SET deposit_amount = 0 WHERE channel_id = ?").run(r.channel_id);
    refunded++;
  }
  console.log(`[bootstrap] refunded ${refunded} VC deposit(s) for safety on restart`);
}

/**
 * デポジット精算（VC が閉じられる直前に呼ぶ）。
 *  settle_count > 0 → 返却
 *  settle_count = 0 → JP没収
 * 二重精算を防ぐため deposit_amount を 0 に書き戻す。
 */
function resolveDepositOnClose(channelId: string): void {
  const row = db.prepare(
    "SELECT deposit_holder, deposit_amount, settle_count, guild_id FROM temp_voice_channels WHERE channel_id = ?",
  ).get(channelId) as { deposit_holder: string | null; deposit_amount: number; settle_count: number; guild_id: string } | undefined;
  if (!row || !row.deposit_holder || row.deposit_amount <= 0) return;

  if (row.settle_count > 0) {
    adjustBalance(row.deposit_holder, row.deposit_amount, "卓: デポジット返却", "takutate", row.guild_id);
  } else {
    // 一度も settle せず消える卓 → 没収して JP へ
    db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?")
      .run(row.deposit_amount, row.guild_id);
  }
  db.prepare("UPDATE temp_voice_channels SET deposit_amount = 0 WHERE channel_id = ?").run(channelId);
}

/** 紐付きVC（linkType×linkId）が既に立っているか調べる。 */
export function findLinkedVC(linkType: string, linkId: string): { channel_id: string; guild_id: string } | null {
  const r = db.prepare(
    "SELECT channel_id, guild_id FROM temp_voice_channels WHERE link_type = ? AND link_id = ?",
  ).get(linkType, linkId) as { channel_id: string; guild_id: string } | undefined;
  return r ?? null;
}

/** 紐付きVCを link_id で差し替える（再戦時に立て主の紐付け先を新勝負IDへ更新）。 */
export function updateLinkedVCLinkId(channelId: string, newLinkId: string): void {
  db.prepare("UPDATE temp_voice_channels SET link_id = ? WHERE channel_id = ?").run(newLinkId, channelId);
}

/** 紐付きVCを即削除（やめる/期限切れで呼ぶ）。デポジット精算してから消す。 */
export async function deleteLinkedVC(client: Client, channelId: string, reason = "decisionPanel: 解散"): Promise<void> {
  try {
    resolveDepositOnClose(channelId);
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildVoice) {
      await (ch as VoiceChannel).delete(reason).catch(() => {});
    }
  } finally {
    untrackVC(channelId);
  }
}

function untrackVC(channelId: string): void {
  db.prepare("DELETE FROM temp_voice_channels WHERE channel_id = ?").run(channelId);
}

function isTrackedVC(channelId: string): boolean {
  return !!db.prepare("SELECT 1 FROM temp_voice_channels WHERE channel_id = ?").get(channelId);
}

// 方針: 卓は **賭けから派生してしか立たない**（/勝負 サシ /勝負 板 のボタンから生成）。
// /卓 コマンドそのものを廃止。自動 sweep（scheduler）と最後の1人退出での自動削除に任せる。

// ─── 旧パネルの遺存ボタン処理（古いパネルを残してる人向けの案内のみ） ───
export async function handleTakuButton(interaction: ButtonInteraction): Promise<void> {
  // 旧 /卓 設置 パネルは廃止済み。残骸を押された場合は案内だけ返す。
  await interaction.reply({
    embeds: [errorEmbed("卓は勝負から立てるようになったよ。`/勝負 サシ` か `/勝負 板 立てる` の中の「卓を立てる」ボタンから生成してね。")],
    ephemeral: true,
  });
}

// ─── 紐付きVC（賭けから派生する卓） ──────────────────
/**
 * サシ・板など、特定の勝負に紐付くVCを立てる低レベル関数。
 * 呼び出し側（sashi/board ボタン処理）で勝負レコードの存在と参加者を
 * 検証してから渡す前提。
 *
 * opts.userLimit … 0=無制限
 * opts.allowedUserIds … null=パネルchの権限を継承（公開）, 配列=その人だけ入れる（プライベート）
 * opts.vcName … 省略時は linkType ごとの既定名
 */
export type LinkedTableOpts = {
  linkType: "sashi" | "board" | string;
  linkId: string;
  userLimit?: number;
  allowedUserIds?: string[] | null;
  vcName?: string;
};

export async function createLinkedTable(interaction: ButtonInteraction, opts: LinkedTableOpts): Promise<VoiceChannel | null> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ embeds: [errorEmbed("サーバー内でのみ使えるよ。")], ephemeral: true });
    return null;
  }
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      embeds: [errorEmbed("VCを立てる権限（チャンネルの管理）がわたしに無いみたい。サーバー管理者に頼んでね。")],
      ephemeral: true,
    });
    return null;
  }

  // 既に紐付き卓があれば再生成しない
  const existing = findLinkedVC(opts.linkType, opts.linkId);
  if (existing) {
    await interaction.reply({
      embeds: [baseEmbed("🎴 もう立ってるよ", PALETTE.JADE).setDescription(`この勝負の卓は <#${existing.channel_id}> にあるよ。`)],
      ephemeral: true,
    });
    return null;
  }

  // デポジット事前チェック
  const userId = interaction.user.id;
  if (getBalance(userId, guild.id) < VC_DEPOSIT) {
    await interaction.reply({
      embeds: [errorEmbed(`卓を立てるには **${formatEther(VC_DEPOSIT)}** のデポジットが要るよ。残高が足りないみたい。\n*勝負を1回でもすれば返却するから、雑談用に立てるとそのまま消えるよ。*`)],
      ephemeral: true,
    });
    return null;
  }

  // パネルchの親カテゴリに置く
  const panelChannel = interaction.channel;
  const parent: CategoryChannel | null =
    panelChannel && "parent" in panelChannel ? (panelChannel.parent as CategoryChannel | null) : null;

  // 入室権限
  let overwrites: { id: string; type: number; allow: bigint; deny: bigint }[] | undefined;
  if (opts.allowedUserIds && opts.allowedUserIds.length > 0) {
    // プライベート: 指定ユーザーだけ Connect/View/Speak/Stream/UseVAD/SendMessages/履歴 を許可、@everyone は拒否
    const View = PermissionFlagsBits.ViewChannel;
    const Connect = PermissionFlagsBits.Connect;
    const Speak = PermissionFlagsBits.Speak;
    const Stream = PermissionFlagsBits.Stream;
    const UseVAD = PermissionFlagsBits.UseVAD;
    const SendMessages = PermissionFlagsBits.SendMessages;
    const ReadHistory = PermissionFlagsBits.ReadMessageHistory;
    const AllowMask = View | Connect | Speak | Stream | UseVAD | SendMessages | ReadHistory;
    overwrites = [
      { id: guild.roles.everyone.id, type: 0, allow: 0n, deny: View | Connect },
      ...opts.allowedUserIds.map((uid) => ({ id: uid, type: 1, allow: AllowMask, deny: 0n })),
    ];
  } else if (panelChannel && "permissionOverwrites" in panelChannel) {
    // 公開（パネルchの権限継承）
    overwrites = panelChannel.permissionOverwrites.cache.map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield,
      deny: o.deny.bitfield,
    }));
  }

  const labelByType: Record<string, { emoji: string; name: string }> = {
    sashi: { emoji: "⚔️", name: "サシの卓" },
    board: { emoji: "📋", name: "議題の卓" },
    chohan: { emoji: "🎴", name: "丁半の卓" },
    saishoubu: { emoji: "🎲", name: "賽勝負の卓" },
  };
  const tag = labelByType[opts.linkType] ?? { emoji: "🎴", name: "勝負の卓" };
  const vcName = (opts.vcName ?? `${tag.emoji} ${tag.name}・${memberName(interaction)}`).slice(0, 100);

  // デポジット徴収（VC作成前。作成失敗したら返金する）
  const debit = adjustBalance(userId, -VC_DEPOSIT, "卓: デポジット預け", "takutate", guild.id);
  if (!debit.ok) {
    await interaction.reply({ embeds: [errorEmbed("デポジットの引き落としに失敗しちゃった。残高を確かめて。")], ephemeral: true });
    return null;
  }

  let vc: VoiceChannel;
  try {
    vc = await guild.channels.create({
      name: vcName,
      type: ChannelType.GuildVoice,
      parent: parent ?? undefined,
      userLimit: opts.userLimit ?? 0,
      permissionOverwrites: overwrites,
      reason: `卓を立てる(紐付): ${interaction.user.tag} (${opts.linkType}:${opts.linkId})`,
    });
  } catch (err) {
    console.error("[taku] linked VC create failed:", err);
    // 作成失敗 → デポジット返金
    adjustBalance(userId, VC_DEPOSIT, "卓: VC作成失敗・デポジット返金", "takutate", guild.id);
    await interaction.reply({ embeds: [errorEmbed("卓を立てるのに失敗しちゃった。預けた分は返したよ。")], ephemeral: true });
    return null;
  }

  trackVC(vc.id, guild.id, userId, opts.linkType, opts.linkType, opts.linkId, userId, VC_DEPOSIT);

  // 立てた人が既にVCにいれば移動してあげる
  let moved = false;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member?.voice.channelId && me.permissions.has(PermissionFlagsBits.MoveMembers)) {
    moved = await member.voice.setChannel(vc).then(() => true).catch(() => false);
  }

  await interaction.reply({
    embeds: [
      baseEmbed(`${tag.emoji} 卓を立てたよ`, PALETTE.JADE).setDescription(
        [
          `<#${vc.id}> を用意したよ。${moved ? "きみはもう座ってる。" : "VCに入って始めてね。"}`,
          (opts.userLimit ?? 0) > 0 ? `定員: **${opts.userLimit}人**` : "定員: なし",
          `デポジット: **${formatEther(VC_DEPOSIT)}**（勝負が1回でも成立すれば返却。雑談だけで終わると ${WORLD.POOL_JACKPOT} へ）`,
          "",
          "*勝負が終わったあと、続けるかどうか選ぶよ。何もしないと卓は片付けるね。*",
        ].join("\n"),
      ),
    ],
    ephemeral: true,
  });
  return vc;
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
    resolveDepositOnClose(leftChannelId);
    untrackVC(leftChannelId);
    return;
  }
  if ((channel as VoiceChannel).members.size > 0) return;

  resolveDepositOnClose(leftChannelId);
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
        resolveDepositOnClose(r.channel_id);
        untrackVC(r.channel_id);
        removed++;
        continue;
      }
      const vc = channel as VoiceChannel;

      // ポーカー open だけは決定パネルを使わず「最終勝負から N分」のアイドル判定で片付ける。
      // 他の紐付きVC（sashi/board/chohan/saishoubu/bjduel/highlow_duel/poker sashi）は decisionPanel の
      // 続行/やめる/期限切れに任せるので、ここでは触らない（=雑談化判定は適用しない）。
      if (r.link_type === "poker" && r.link_id && vc.members.size > 0) {
        const mode = (db.prepare("SELECT mode FROM poker_games WHERE id = ?").get(Number(r.link_id)) as { mode?: string } | undefined)?.mode;
        if (mode === "open") {
          const baseTs = r.last_settled_at ?? r.created_at;
          const idleMs = Date.now() - new Date(baseTs + "Z").getTime();
          if (idleMs >= LINKED_VC_IDLE_LIMIT_MS) {
            try {
              await (vc as VoiceChannel & { send?: (m: any) => Promise<any> }).send?.(
                "*しばらく勝負が無かったから卓を片付けるよ。続きは新しく立ててね。*",
              );
            } catch { /* ignore */ }
            resolveDepositOnClose(r.channel_id);
            await vc.delete("卓を立てる: アイドル超過（poker open）").catch(() => {});
            untrackVC(r.channel_id);
            removed++;
            continue;
          }
          continue; // open 中はアイドル上限内なら残す
        }
        // poker sashi は下の通常フロー（人いれば残す）
      }

      if (vc.members.size > 0) continue;

      // 立てたばかりで未入室のものは grace 内なら残す
      const ageMs = Date.now() - new Date(r.created_at + "Z").getTime();
      if (graceMs > 0 && ageMs < graceMs) continue;

      resolveDepositOnClose(r.channel_id);
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

// 旧 /卓 片付け の手動 sweep は廃止（scheduler の定期 sweep + VoiceState フックで十分）。
// 必要なら sweepStaleTempVCs を /管理 から呼べる薄いラッパを後から足す。
async function _manualSweep_DEPRECATED(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ embeds: [errorEmbed("このコマンドは管理者だけが使えるよ。")], ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const n = await sweepStaleTempVCs(interaction.client, 0);
  await interaction.editReply({ embeds: [baseEmbed("🧹 片付け完了", PALETTE.JADE).setDescription(`空いてた卓を **${n}** 個 片付けたよ。`)] });
}
