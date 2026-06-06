/**
 * サシ星約（1v1 PvP エスクロー）
 * ─────────────────────────────────────────────────────────
 * 私的決闘: 申込 → 相手承認(両者エスクロー) → 結果報告 → 相手承認 → 精算
 *   勝者が 2×stake 総取り / 引分は両者返金 / 異議は管理者裁定
 *   当事者以外は介入不可。
 *
 * 安全設計: 再起動時 refundStaleSashiOnStartup() で active/reported を全額返金 void。
 *   pending（未承認＝未徴収）は void のみ。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  Client,
  type TextChannel,
} from "discord.js";
import { db, getServerConfig, runTransaction } from "../../core/db";
import { adjustBalance, ensureUser, getBalance, getProfile } from "../../core/bank";
import { getTierByKey } from "../../core/economy";
import { effectiveBetCap } from "../../core/vip";
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { WORLD, formatEther, PALETTE } from "../../world.config";
import { createLinkedTable, findLinkedVC } from "../takutate/index";
import { mentionAdminRole } from "../../admin/commands";

const DRAW = "draw";

// 自動タイムアウト
const PENDING_AUTO_DECLINE_MS = 5 * 60_000;        // 申込みから5分で自動辞退
const REPORT_AUTO_FINALIZE_MS = 10 * 60_000;        // 報告後10分で自動承認
const ACTIVE_AUTO_VOID_MS = 6 * 60 * 60_000;        // 両者エスクロー後6時間で自動void
const SASHI_TICK_INTERVAL_MS = 60_000;              // 1分ごとに点検

type MatchRow = {
  id: number;
  guild_id: string;
  challenger_id: string;
  opponent_id: string;
  title: string | null;
  stake: number;
  status: "pending" | "active" | "reported" | "settled" | "disputed" | "declined" | "void";
  reported_winner_id: string | null;
  reported_by: string | null;
  channel_id: string | null;
  message_id: string | null;
  reported_at: string | null;
  created_at: string;
};

function getMatch(id: number): MatchRow | undefined {
  return db.prepare("SELECT * FROM pvp_matches WHERE id = ?").get(id) as MatchRow | undefined;
}

// ─── Command ──────────────────────────────────────────
export const sashiCommand = new SlashCommandBuilder()
  .setName("サシ")
  .setDescription(`⚔️ ${WORLD.GAME_SASHI} — 1対1の私的決闘`)
  .addSubcommand((sc) =>
    sc
      .setName("申込み")
      .setDescription("相手にサシ星約を申し込む")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額）").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("内容").setDescription("勝負の内容（GF/麻雀など）").setRequired(false).setMaxLength(80)),
  );

export async function handleSashiCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommand() === "申込み") return challenge(interaction);
}

export async function challenge(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }

  const challengerId = interaction.user.id;
  const opponent = interaction.options.getUser("相手", true);
  const stake = interaction.options.getInteger("額", true);
  const title = interaction.options.getString("内容") ?? "サシ星約";

  if (opponent.bot || opponent.id === challengerId) {
    await interaction.reply({ embeds: [errorEmbed("自分やボットには挑めないよ。")], ephemeral: true });
    return;
  }

  ensureUser(challengerId, guildId);
  ensureUser(opponent.id, guildId);
  const cfg = getServerConfig(guildId);
  const tier = getTierByKey(getProfile(challengerId, guildId).tier);
  if (stake < cfg.min_bet) { await interaction.reply({ embeds: [errorEmbed(`最低 ${formatEther(cfg.min_bet)} からだよ。`)], ephemeral: true }); return; }
  { const cap = effectiveBetCap(tier.betCap, challengerId, guildId); if (stake > cap) { await interaction.reply({ embeds: [errorEmbed(`上限 ${formatEther(cap)}${cap > tier.betCap ? "（💎VIP×2）" : ""} までだよ。`)], ephemeral: true }); return; } }
  if (getBalance(challengerId, guildId) < stake) { await interaction.reply({ embeds: [errorEmbed("自分の残高が足りないみたい。")], ephemeral: true }); return; }

  const matchId = Number(db.prepare(
    `INSERT INTO pvp_matches (guild_id, challenger_id, opponent_id, title, stake, channel_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(guildId, challengerId, opponent.id, title, stake, interaction.channelId).lastInsertRowid);

  const embed = baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${matchId}`, PALETTE.VERMILION)
    .setDescription([
      `**${interaction.user.displayName}** が <@${opponent.id}> に決闘を申し込んだ。`,
      `内容: **${title}**`,
      `賭け金: **${formatEther(stake)}**（両者同額・勝者総取り）`,
      "",
      `<@${opponent.id}> — 受けるなら「承認」を。`,
    ].join("\n"));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sashi:accept:${matchId}`).setLabel("承認して受ける").setStyle(ButtonStyle.Success).setEmoji("⚔️"),
    new ButtonBuilder().setCustomId(`sashi:decline:${matchId}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row] });
  const msg = await interaction.fetchReply();
  db.prepare("UPDATE pvp_matches SET message_id = ? WHERE id = ?").run(msg.id, matchId);
}

// ─── ボタンハンドラ ───────────────────────────────────
export async function handleSashiButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr, winnerArg] = interaction.customId.split(":");
  const matchId = Number(idStr);
  const m = getMatch(matchId);
  if (!m) { await interaction.reply({ content: "その決闘はもう無いみたい。", ephemeral: true }); return; }

  switch (action) {
    case "accept": return accept(interaction, m);
    case "decline": return decline(interaction, m);
    case "report": return report(interaction, m, winnerArg);
    case "approve": return approve(interaction, m);
    case "dispute": return dispute(interaction, m);
    case "admin_win": return adminResolve(interaction, m, winnerArg);
    case "admin_void": return adminVoid(interaction, m);
    case "linkvc": return linkVc(interaction, m);
  }
}

// ─── 紐付きVC生成（[この勝負用の卓を立てる]） ───────
async function linkVc(interaction: ButtonInteraction, m: MatchRow): Promise<void> {
  if (!isParticipant(m, interaction.user.id)) {
    await interaction.reply({ content: "当事者だけが立てられるよ。", ephemeral: true });
    return;
  }
  if (m.status !== "active" && m.status !== "reported") {
    await interaction.reply({ content: "勝負が成立してる時だけ立てられるよ。", ephemeral: true });
    return;
  }
  // 既に立ってればそちらへ
  const existing = findLinkedVC("sashi", String(m.id));
  if (existing) {
    await interaction.reply({
      embeds: [baseEmbed("⚔️ もう立ってるよ", PALETTE.JADE).setDescription(`卓は <#${existing.channel_id}> にあるよ。`)],
      ephemeral: true,
    });
    return;
  }
  await createLinkedTable(interaction, {
    linkType: "sashi",
    linkId: String(m.id),
    userLimit: 2,
    allowedUserIds: [m.challenger_id, m.opponent_id],
    vcName: `⚔️ サシの卓 #${m.id}`,
  });
}

function isParticipant(m: MatchRow, userId: string): boolean {
  return userId === m.challenger_id || userId === m.opponent_id;
}

// ─── 承認（両者エスクロー） ───────────────────────────
async function accept(interaction: ButtonInteraction, m: MatchRow): Promise<void> {
  if (interaction.user.id !== m.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが承認できるよ。", ephemeral: true }); return; }
  if (m.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }

  const result = runTransaction<{ ok: boolean; reason?: string }>(() => {
    const cur = getMatch(m.id);
    if (!cur || cur.status !== "pending") return { ok: false, reason: "GONE" };
    const dc = adjustBalance(m.challenger_id, -m.stake, "サシ: エスクロー", "sashi", m.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(m.opponent_id, -m.stake, "サシ: エスクロー", "sashi", m.guild_id);
    if (!dop.ok) return { ok: false, reason: "OPPONENT_FUNDS" };
    db.prepare("UPDATE pvp_matches SET status = 'active' WHERE id = ?").run(m.id);
    return { ok: true };
  });

  if (!result.ok) {
    const msg = result.reason === "OPPONENT_FUNDS" ? "きみの残高が足りないみたい。"
      : result.reason === "CHALLENGER_FUNDS" ? "申込者の残高が足りなくなってたよ。" : "もう受付が終わってたよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  const embed = baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${m.id} — 成立`, PALETTE.VERMILION)
    .setDescription([
      `<@${m.challenger_id}> vs <@${m.opponent_id}>`,
      `内容: **${m.title}**　賭け金: **${formatEther(m.stake)}** ずつ（総取り ${formatEther(m.stake * 2)}）`,
      "",
      "勝負がついたら、どちらかが結果を報告してね。",
    ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sashi:report:${m.id}:${m.challenger_id}`).setLabel("申込者の勝ち").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sashi:report:${m.id}:${m.opponent_id}`).setLabel("相手の勝ち").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sashi:report:${m.id}:${DRAW}`).setLabel("引き分け").setStyle(ButtonStyle.Secondary),
  );
  const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sashi:linkvc:${m.id}`).setLabel("この勝負用の卓を立てる").setStyle(ButtonStyle.Secondary).setEmoji("⚔️"),
  );
  await interaction.update({ content: "", embeds: [embed], components: [row, linkRow] });
}

async function decline(interaction: ButtonInteraction, m: MatchRow): Promise<void> {
  if (interaction.user.id !== m.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが操作できるよ。", ephemeral: true }); return; }
  if (m.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE pvp_matches SET status = 'declined' WHERE id = ?").run(m.id);
  await interaction.update({ content: "", embeds: [baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${m.id} — 辞退`, PALETTE.NIGHT).setDescription("この決闘は見送られたよ。")], components: [] });
}

// ─── 結果報告 ─────────────────────────────────────────
async function report(interaction: ButtonInteraction, m: MatchRow, winnerId: string): Promise<void> {
  if (!isParticipant(m, interaction.user.id)) { await interaction.reply({ content: "当事者だけが報告できるよ。", ephemeral: true }); return; }
  if (m.status !== "active") { await interaction.reply({ content: "いまは報告できないよ。", ephemeral: true }); return; }
  if (winnerId !== DRAW && winnerId !== m.challenger_id && winnerId !== m.opponent_id) {
    await interaction.reply({ content: "不正な勝者だよ。", ephemeral: true }); return;
  }
  const reportedAt = new Date().toISOString();
  db.prepare("UPDATE pvp_matches SET status = 'reported', reported_winner_id = ?, reported_by = ?, reported_at = ? WHERE id = ?")
    .run(winnerId, interaction.user.id, reportedAt, m.id);

  const reporter = interaction.user.id;
  const other = reporter === m.challenger_id ? m.opponent_id : m.challenger_id;
  const winnerLabel = winnerId === DRAW ? "引き分け" : `<@${winnerId}> の勝ち`;
  const autoAt = Math.floor((Date.now() + REPORT_AUTO_FINALIZE_MS) / 1000);
  const embed = baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${m.id} — 結果報告`, PALETTE.STARGOLD)
    .setDescription([
      `**${interaction.user.displayName}** が報告: **${winnerLabel}**`,
      "",
      `<@${other}> — 異議なければ「承認」を。違うなら「異議」を。`,
      `*<t:${autoAt}:R> に何も無ければ自動承認するよ。*`,
    ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sashi:approve:${m.id}`).setLabel("承認").setStyle(ButtonStyle.Success).setEmoji("✅"),
    new ButtonBuilder().setCustomId(`sashi:dispute:${m.id}`).setLabel("異議あり").setStyle(ButtonStyle.Danger).setEmoji("⚠️"),
  );
  await interaction.update({ content: `<@${other}>`, embeds: [embed], components: [row] });
}

async function approve(interaction: ButtonInteraction, m: MatchRow): Promise<void> {
  if (m.status !== "reported") { await interaction.reply({ content: "いまは承認の時間じゃないよ。", ephemeral: true }); return; }
  if (!isParticipant(m, interaction.user.id)) { await interaction.reply({ content: "当事者だけが承認できるよ。", ephemeral: true }); return; }
  // 報告者の自己承認を防ぐ → 報告していない側だけが承認できる
  if (interaction.user.id === m.reported_by) {
    await interaction.reply({ content: "報告した本人は承認できないよ。相手の承認を待ってね。", ephemeral: true });
    return;
  }
  await settleMatch(interaction.client, m.id);
  await interaction.update({ components: [] }).catch(() => {});
}

async function dispute(interaction: ButtonInteraction, m: MatchRow): Promise<void> {
  if (m.status !== "reported") { await interaction.reply({ content: "いまは異議の時間じゃないよ。", ephemeral: true }); return; }
  if (!isParticipant(m, interaction.user.id)) { await interaction.reply({ content: "当事者だけが異議を出せるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE pvp_matches SET status = 'disputed' WHERE id = ?").run(m.id);

  const embed = baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${m.id} — 異議`, PALETTE.CRIMSON)
    .setDescription("当事者から異議が出たよ。運営が裁定してね。");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sashi:admin_win:${m.id}:${m.challenger_id}`).setLabel("申込者の勝ち(管理者)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sashi:admin_win:${m.id}:${m.opponent_id}`).setLabel("相手の勝ち(管理者)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sashi:admin_void:${m.id}`).setLabel("無効・返金(管理者)").setStyle(ButtonStyle.Danger),
  );
  const mention = mentionAdminRole(m.guild_id);
  await interaction.update({ content: mention || "", embeds: [embed], components: [row] });
}

// ─── 精算 ─────────────────────────────────────────────
async function settleMatch(client: Client, matchId: number): Promise<void> {
  const m = getMatch(matchId);
  if (!m || (m.status !== "reported" && m.status !== "disputed")) return;
  const winner = m.reported_winner_id;
  const pot = m.stake * 2;

  runTransaction(() => {
    const cur = getMatch(matchId);
    if (!cur) return;
    if (winner === DRAW) {
      adjustBalance(m.challenger_id, m.stake, "サシ: 引分返金", "sashi", m.guild_id);
      adjustBalance(m.opponent_id, m.stake, "サシ: 引分返金", "sashi", m.guild_id);
    } else if (winner) {
      adjustBalance(winner, pot, "サシ: 勝者総取り", "sashi", m.guild_id);
    }
    db.prepare("UPDATE pvp_matches SET status = 'settled' WHERE id = ?").run(matchId);
  });

  const text = winner === DRAW
    ? `🤝 引き分け。賭け金 ${formatEther(m.stake)} を両者に返したよ。`
    : `🎉 <@${winner}> の勝ち！ ${formatEther(pot)} を総取り。`;
  await announce(client, m, `⚔️ #${m.id} 決着 — ${text}`);

  // 紐付きVCがあれば 続行/やめる パネルを投下
  try {
    const { postDecisionPanel } = require("../decisionPanel");
    await postDecisionPanel(client, m.guild_id, "sashi", String(m.id), m.challenger_id, [m.challenger_id, m.opponent_id]);
  } catch (err) {
    console.warn("[sashi] decisionPanel post failed:", err);
  }
}

// ─── 再戦立て（decisionPanel から呼ばれる） ───────────
/**
 * 続行成立時に同条件で新しいサシを active 状態で立てる。
 * 両者は既に decisionPanel で合意済みなので accept ダンスは省略し、
 * いきなりエスクロー → active → 報告ボタンを VC に出す。
 *
 * @returns 成功時は新 matchId（文字列）。残高不足等で立てられなければ null。
 */
export async function restartSashi(client: Client, oldMatchId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getMatch(oldMatchId);
  if (!old) return null;

  const result = runTransaction<{ ok: boolean; newId?: number; reason?: string }>(() => {
    // 残高チェック → 両者エスクロー
    const dc = adjustBalance(old.challenger_id, -old.stake, "サシ: 再戦エスクロー", "sashi", old.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(old.opponent_id, -old.stake, "サシ: 再戦エスクロー", "sashi", old.guild_id);
    if (!dop.ok) {
      // 返金して中止
      adjustBalance(old.challenger_id, old.stake, "サシ: 再戦失敗・返金", "sashi", old.guild_id);
      return { ok: false, reason: "OPPONENT_FUNDS" };
    }

    const res = db.prepare(
      `INSERT INTO pvp_matches (guild_id, challenger_id, opponent_id, title, stake, channel_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    ).run(old.guild_id, old.challenger_id, old.opponent_id, old.title, old.stake, vcId ?? old.channel_id);
    return { ok: true, newId: Number(res.lastInsertRowid) };
  });

  if (!result.ok || !result.newId) return null;

  // 新マッチを VC に出す
  const newId = result.newId;
  const embed = baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${newId} — もう一勝負`, PALETTE.VERMILION).setDescription([
    `<@${old.challenger_id}> vs <@${old.opponent_id}>`,
    `内容: **${old.title}**　賭け金: **${formatEther(old.stake)}** ずつ（総取り ${formatEther(old.stake * 2)}）`,
    "",
    "勝負がついたら、どちらかが結果を報告してね。",
  ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sashi:report:${newId}:${old.challenger_id}`).setLabel("申込者の勝ち").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sashi:report:${newId}:${old.opponent_id}`).setLabel("相手の勝ち").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sashi:report:${newId}:${DRAW}`).setLabel("引き分け").setStyle(ButtonStyle.Secondary),
  );
  try {
    const target = vcId ?? old.channel_id;
    if (target) {
      const ch = await client.channels.fetch(target).catch(() => null);
      if (ch && "send" in ch) {
        const msg = await (ch as any).send({ embeds: [embed], components: [row] });
        db.prepare("UPDATE pvp_matches SET message_id = ?, channel_id = ? WHERE id = ?").run(msg.id, target, newId);
      }
    }
  } catch (err) {
    console.warn("[sashi] restart announce failed:", err);
  }
  return String(newId);
}

async function adminResolve(interaction: ButtonInteraction, m: MatchRow, winnerId: string): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) { await interaction.reply({ content: "管理者だけが裁定できるよ。", ephemeral: true }); return; }
  if (m.status !== "disputed") { await interaction.reply({ content: "裁定待ちじゃないよ。", ephemeral: true }); return; }
  if (winnerId !== m.challenger_id && winnerId !== m.opponent_id) { await interaction.reply({ content: "不正な勝者だよ。", ephemeral: true }); return; }
  db.prepare("UPDATE pvp_matches SET reported_winner_id = ? WHERE id = ?").run(winnerId, m.id);
  await settleMatch(interaction.client, m.id);
  await interaction.update({ components: [] }).catch(() => {});
}

async function adminVoid(interaction: ButtonInteraction, m: MatchRow): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) { await interaction.reply({ content: "管理者だけが無効にできるよ。", ephemeral: true }); return; }
  if (m.status !== "disputed") { await interaction.reply({ content: "裁定待ちじゃないよ。", ephemeral: true }); return; }
  runTransaction(() => {
    adjustBalance(m.challenger_id, m.stake, "サシ: 裁定無効・返金", "sashi", m.guild_id);
    adjustBalance(m.opponent_id, m.stake, "サシ: 裁定無効・返金", "sashi", m.guild_id);
    db.prepare("UPDATE pvp_matches SET status = 'void' WHERE id = ?").run(m.id);
  });
  await interaction.update({ content: "", embeds: [baseEmbed(`⚔️ #${m.id} — 無効`, PALETTE.NIGHT).setDescription("管理者が無効と裁定。両者に返金したよ。")], components: [] }).catch(() => {});
}

async function announce(client: Client, m: MatchRow, content: string): Promise<void> {
  if (!m.channel_id) return;
  try {
    const ch = await client.channels.fetch(m.channel_id);
    if (ch && ch.type === ChannelType.GuildText) await (ch as TextChannel).send(content);
  } catch { /* ignore */ }
}

// ─── タイムアウト自動処理 ───────────────────────────
/**
 * 1分ごとに走らせる。
 *  - status='reported' && reported_at + 10分 経過 → 報告された結果で自動精算
 *  - status='active'   && created_at  + 6時間 経過 → 両者返金で void
 *  - status='disputed' は人間判断が要るのでスキップ
 */
async function sweepStaleSashi(client: Client): Promise<void> {
  const now = Date.now();

  // pending の自動辞退（申込みから1時間）— 未徴収なので返金不要
  const pending = db.prepare("SELECT * FROM pvp_matches WHERE status = 'pending'").all() as MatchRow[];
  for (const m of pending) {
    const createdTs = new Date(m.created_at + "Z").getTime();
    if (now - createdTs >= PENDING_AUTO_DECLINE_MS) {
      try {
        db.prepare("UPDATE pvp_matches SET status = 'void' WHERE id = ? AND status = 'pending'").run(m.id);
        await clearPanelComponents(client, m, "⚔️ 申込みが5分放置されたから流したよ。また気が向いたら声かけて。");
      } catch (err) {
        console.warn(`[sashi sweep] pending auto-decline failed for #${m.id}:`, err);
      }
    }
  }

  // reported の自動承認
  const reported = db.prepare(
    "SELECT * FROM pvp_matches WHERE status = 'reported' AND reported_at IS NOT NULL",
  ).all() as MatchRow[];
  for (const m of reported) {
    const reportedTs = new Date(m.reported_at!).getTime();
    if (now - reportedTs >= REPORT_AUTO_FINALIZE_MS) {
      try {
        await settleMatch(client, m.id);
        await clearPanelComponents(client, m, "⚔️ 時間切れで自動承認したよ。");
      } catch (err) {
        console.warn(`[sashi sweep] auto-finalize failed for #${m.id}:`, err);
      }
    }
  }

  // active の塩漬け解除（両者返金）
  const active = db.prepare("SELECT * FROM pvp_matches WHERE status = 'active'").all() as MatchRow[];
  for (const m of active) {
    const createdTs = new Date(m.created_at + "Z").getTime();
    if (now - createdTs >= ACTIVE_AUTO_VOID_MS) {
      try {
        runTransaction(() => {
          const cur = getMatch(m.id);
          if (!cur || cur.status !== "active") return;
          adjustBalance(m.challenger_id, m.stake, "サシ: 長時間未報告で自動返金", "sashi", m.guild_id);
          adjustBalance(m.opponent_id, m.stake, "サシ: 長時間未報告で自動返金", "sashi", m.guild_id);
          db.prepare("UPDATE pvp_matches SET status = 'void' WHERE id = ?").run(m.id);
        });
        await announce(client, m, `⚔️ #${m.id} 長時間 結果報告が無かったので、両者に返金して無効にしたよ。`);
        await clearPanelComponents(client, m, "⚔️ 時間切れで無効にしたよ。両者へ返金済み。");
      } catch (err) {
        console.warn(`[sashi sweep] auto-void failed for #${m.id}:`, err);
      }
    }
  }
}

async function clearPanelComponents(client: Client, m: MatchRow, replaceContent?: string): Promise<void> {
  if (!m.channel_id || !m.message_id) return;
  try {
    const ch = await client.channels.fetch(m.channel_id).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    const msg = await (ch as TextChannel).messages.fetch(m.message_id).catch(() => null);
    if (!msg) return;
    if (replaceContent) {
      await msg.edit({
        embeds: [baseEmbed(`⚔️ ${WORLD.GAME_SASHI} #${m.id}`, PALETTE.NIGHT).setDescription(replaceContent)],
        components: [],
      }).catch(() => {});
    } else {
      await msg.edit({ components: [] }).catch(() => {});
    }
  } catch { /* ignore */ }
}

let sashiTickHandle: NodeJS.Timeout | null = null;

/** 起動時に呼ぶ。1分ごとに sweepStaleSashi を回す。 */
export function bootSashiTimeouts(client: Client): void {
  if (sashiTickHandle) clearInterval(sashiTickHandle);
  // 起動直後にも1回走らせて、Bot 落ちてる間に過ぎたやつを片付ける
  void sweepStaleSashi(client).catch((err) => console.error("[sashi] initial sweep failed:", err));
  sashiTickHandle = setInterval(() => {
    void sweepStaleSashi(client).catch((err) => console.error("[sashi] tick sweep failed:", err));
  }, SASHI_TICK_INTERVAL_MS);
  console.log("[sashi] timeout sweep started (1min interval)");
}

// ─── 起動時返金 ───────────────────────────────────────
export function refundStaleSashiOnStartup(): void {
  const stale = db.prepare("SELECT * FROM pvp_matches WHERE status IN ('active','reported','disputed')").all() as MatchRow[];
  if (stale.length === 0) return;
  runTransaction(() => {
    for (const m of stale) {
      adjustBalance(m.challenger_id, m.stake, "サシ: 再起動による返金", "sashi", m.guild_id);
      adjustBalance(m.opponent_id, m.stake, "サシ: 再起動による返金", "sashi", m.guild_id);
      db.prepare("UPDATE pvp_matches SET status = 'void' WHERE id = ?").run(m.id);
    }
    // pending（未徴収）は単に void
    db.prepare("UPDATE pvp_matches SET status = 'void' WHERE status = 'pending'").run();
  });
  console.log(`[bootstrap] refunded ${stale.length} stale sashi match(es)`);
}
