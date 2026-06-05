/**
 * インディアンポーカー（1v1心理戦）
 * ─────────────────────────────────────────────────────────
 * 互いに1枚カード（A=1〜K=13）を引き、**自分の手は見えず、相手の手は見える**。
 * 各自が ステイ / フォールド を選ぶ。
 *   - 両者ステイ → 開示、数値高い方が勝ち（同値=ドロー返金）
 *   - 片方フォールド → もう片方の勝ち（フォールド側はante没収）
 *   - 両者フォールド → 両者返金
 *
 * 賭け金 stake は両者から徴収。勝者総取り 2×stake − 場代3% → JP。
 * 「相手の低い手を見て勝負したい / 高い手を見たから降りる」の駆け引きが肝。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
} from "discord.js";
import { db, getServerConfig, runTransaction } from "../../core/db";
import { adjustBalance, ensureUser, getBalance, getProfile } from "../../core/bank";
import { getTierByKey } from "../../core/economy";
import { effectiveBetCap } from "../../core/vip";
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { WORLD, formatEther, PALETTE } from "../../world.config";
import { createLinkedTable, findLinkedVC } from "../takutate/index";

const RAKE_PCT = 0.03;
const PENDING_AUTO_DECLINE_MS = 60 * 60_000;
const ACTIVE_AUTO_VOID_MS = 6 * 60 * 60_000;
const TICK_INTERVAL_MS = 60_000;

type Action = "stay" | "fold";
type DuelRow = {
  id: number;
  guild_id: string;
  challenger_id: string;
  opponent_id: string;
  stake: number;
  status: "pending" | "active" | "settled" | "declined" | "void";
  challenger_card: number;
  opponent_card: number;
  challenger_action: Action | null;
  opponent_action: Action | null;
  winner_id: string | null;
  rake: number;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
};

function getDuel(id: number): DuelRow | undefined {
  return db.prepare("SELECT * FROM indian_duels WHERE id = ?").get(id) as DuelRow | undefined;
}

const RANK_NAMES = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function rankName(n: number): string { return RANK_NAMES[n] ?? "?"; }
function isParticipant(d: DuelRow, userId: string): boolean { return userId === d.challenger_id || userId === d.opponent_id; }
function opponentOf(d: DuelRow, userId: string): string {
  return userId === d.challenger_id ? d.opponent_id : d.challenger_id;
}
function cardOf(d: DuelRow, userId: string): number {
  return userId === d.challenger_id ? d.challenger_card : d.opponent_card;
}
function opponentCardOf(d: DuelRow, userId: string): number {
  return userId === d.challenger_id ? d.opponent_card : d.challenger_card;
}

// ─── Command ─────────────────────────────────────────
export const indianCommand = new SlashCommandBuilder()
  .setName("インディアン")
  .setDescription("🪶 インディアンポーカー — 相手の手は見えて自分の手は見えない心理戦（1v1）")
  .addSubcommand((sc) =>
    sc
      .setName("申込み")
      .setDescription("相手に勝負を申し込む")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額・勝者総取り）").setRequired(true).setMinValue(1)),
  );

export async function handleIndianCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommand() === "申込み") return challenge(interaction);
}

export async function challenge(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }
  const challengerId = interaction.user.id;
  const opponent = interaction.options.getUser("相手", true);
  const stake = interaction.options.getInteger("額", true);
  if (opponent.bot || opponent.id === challengerId) {
    await interaction.reply({ embeds: [errorEmbed("自分やボットには挑めないよ。")], ephemeral: true });
    return;
  }
  ensureUser(challengerId, guildId);
  ensureUser(opponent.id, guildId);
  const cfg = getServerConfig(guildId);
  const tier = getTierByKey(getProfile(challengerId, guildId).tier);
  if (stake < cfg.min_bet) { await interaction.reply({ embeds: [errorEmbed(`最低 ${formatEther(cfg.min_bet)} からだよ。`)], ephemeral: true }); return; }
  const cap = effectiveBetCap(tier.betCap, challengerId, guildId);
  if (stake > cap) { await interaction.reply({ embeds: [errorEmbed(`上限 ${formatEther(cap)}${cap > tier.betCap ? "（💎VIP×2）" : ""} までだよ。`)], ephemeral: true }); return; }
  if (getBalance(challengerId, guildId) < stake) { await interaction.reply({ embeds: [errorEmbed("自分の残高が足りないみたい。")], ephemeral: true }); return; }

  const duelId = Number(db.prepare(
    "INSERT INTO indian_duels (guild_id, challenger_id, opponent_id, stake, channel_id) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, challengerId, opponent.id, stake, interaction.channelId).lastInsertRowid);

  const embed = baseEmbed(`🪶 インディアン #${duelId}`, PALETTE.VERMILION).setDescription([
    `**${interaction.user.displayName}** が <@${opponent.id}> にインディアンポーカーを申し込んだ。`,
    `賭け金: **${formatEther(stake)}**（両者同額・勝者総取り）`,
    `*場代 ${Math.round(RAKE_PCT * 100)}% は ${WORLD.POOL_JACKPOT} へ。*`,
    "",
    "🪶 ルール: 自分の手は見えず、相手の手だけ見える。",
    "「ステイ（勝負）」か「フォールド（降りる）」を選ぶよ。",
    "",
    `<@${opponent.id}> — 受けるなら「受ける」を押してね。`,
  ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ind:accept:${duelId}`).setLabel("受ける").setStyle(ButtonStyle.Success).setEmoji("🪶"),
    new ButtonBuilder().setCustomId(`ind:decline:${duelId}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
  );
  const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ind:linkvc:${duelId}`).setLabel("この勝負用の卓を立てる").setStyle(ButtonStyle.Secondary).setEmoji("🪶"),
  );
  await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row, linkRow] });
  const msg = await interaction.fetchReply();
  db.prepare("UPDATE indian_duels SET message_id = ? WHERE id = ?").run(msg.id, duelId);
}

// ─── ボタン ─────────────────────────────────────────
export async function handleIndianButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const d = getDuel(Number(idStr));
  if (!d) { await interaction.reply({ content: "その勝負はもう無いみたい。", ephemeral: true }); return; }
  switch (action) {
    case "accept": return accept(interaction, d);
    case "decline": return decline(interaction, d);
    case "peek": return peek(interaction, d);
    case "stay": return act(interaction, d, "stay");
    case "fold": return act(interaction, d, "fold");
    case "linkvc": return linkVc(interaction, d);
  }
}

async function linkVc(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (!isParticipant(d, interaction.user.id)) {
    await interaction.reply({ content: "当事者だけが立てられるよ。", ephemeral: true }); return;
  }
  if (d.status !== "pending" && d.status !== "active") {
    await interaction.reply({ content: "勝負が成立してる時だけ立てられるよ。", ephemeral: true }); return;
  }
  const existing = findLinkedVC("indian", String(d.id));
  if (existing) {
    await interaction.reply({
      embeds: [baseEmbed("🪶 もう立ってるよ", PALETTE.JADE).setDescription(`卓は <#${existing.channel_id}> にあるよ。`)],
      ephemeral: true,
    });
    return;
  }
  await createLinkedTable(interaction, {
    linkType: "indian", linkId: String(d.id),
    userLimit: 2, allowedUserIds: [d.challenger_id, d.opponent_id],
    vcName: `🪶 インディアンの卓 #${d.id}`,
  });
}

async function decline(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが操作できるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE indian_duels SET status = 'declined' WHERE id = ?").run(d.id);
  await interaction.update({ content: "", embeds: [baseEmbed(`🪶 インディアン #${d.id} — 辞退`, PALETTE.NIGHT).setDescription("この勝負は見送られたよ。")], components: [] });
}

async function accept(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが受けられるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  const result = runTransaction<{ ok: boolean; reason?: string; cCard?: number; oCard?: number }>(() => {
    const cur = getDuel(d.id);
    if (!cur || cur.status !== "pending") return { ok: false, reason: "GONE" };
    const dc = adjustBalance(d.challenger_id, -d.stake, "インディアン: エスクロー", "indian", d.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(d.opponent_id, -d.stake, "インディアン: エスクロー", "indian", d.guild_id);
    if (!dop.ok) return { ok: false, reason: "OPPONENT_FUNDS" };
    const cCard = 1 + Math.floor(Math.random() * 13);
    const oCard = 1 + Math.floor(Math.random() * 13);
    db.prepare(
      "UPDATE indian_duels SET status = 'active', challenger_card = ?, opponent_card = ? WHERE id = ?",
    ).run(cCard, oCard, d.id);
    return { ok: true, cCard, oCard };
  });
  if (!result.ok) {
    const msg = result.reason === "OPPONENT_FUNDS" ? "きみの残高が足りないみたい。"
      : result.reason === "CHALLENGER_FUNDS" ? "申込者の残高が足りなくなってたよ。" : "もう受付が終わってたよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }
  await interaction.update(renderPanel(d.id, false));
}

async function peek(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (d.status !== "active") { await interaction.reply({ content: "いまは見られないよ。", ephemeral: true }); return; }
  if (!isParticipant(d, interaction.user.id)) { await interaction.reply({ content: "当事者だけが見れるよ。", ephemeral: true }); return; }
  const oppCard = opponentCardOf(d, interaction.user.id);
  await interaction.reply({
    embeds: [baseEmbed("🔍 相手の手", PALETTE.AZURE).setDescription(`相手の手: **${rankName(oppCard)}**\n*（きみ自身の手は見えないよ）*`)],
    ephemeral: true,
  });
}

async function act(interaction: ButtonInteraction, d: DuelRow, action: Action): Promise<void> {
  if (d.status !== "active") { await interaction.reply({ content: "いまは行動できないよ。", ephemeral: true }); return; }
  if (!isParticipant(d, interaction.user.id)) { await interaction.reply({ content: "当事者だけが行動できるよ。", ephemeral: true }); return; }
  const userId = interaction.user.id;
  const isChallenger = userId === d.challenger_id;
  const alreadyActed = isChallenger ? d.challenger_action !== null : d.opponent_action !== null;
  if (alreadyActed) { await interaction.reply({ content: "もう行動済みだよ。相手を待って。", ephemeral: true }); return; }

  // 行動を原子的に記録（同時押下対策）
  const result = runTransaction<{ bothDone: boolean }>(() => {
    const cur = getDuel(d.id);
    if (!cur) return { bothDone: false };
    if (isChallenger) {
      if (cur.challenger_action !== null) return { bothDone: false };
      db.prepare("UPDATE indian_duels SET challenger_action = ? WHERE id = ?").run(action, d.id);
    } else {
      if (cur.opponent_action !== null) return { bothDone: false };
      db.prepare("UPDATE indian_duels SET opponent_action = ? WHERE id = ?").run(action, d.id);
    }
    const fresh = getDuel(d.id)!;
    return { bothDone: fresh.challenger_action !== null && fresh.opponent_action !== null };
  });

  if (result.bothDone) {
    await interaction.update({ components: [] }).catch(() => {});
    await settleDuel(interaction.client, d.id);
  } else {
    await interaction.update(renderPanel(d.id, false));
  }
}

// ─── 描画 ──────────────────────────────────────────
function renderPanel(duelId: number, reveal: boolean): { embeds: ReturnType<typeof baseEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const d = getDuel(duelId)!;
  const cAct = d.challenger_action === "stay" ? "✋ ステイ" : d.challenger_action === "fold" ? "🏳 フォールド" : "…考え中";
  const oAct = d.opponent_action === "stay" ? "✋ ステイ" : d.opponent_action === "fold" ? "🏳 フォールド" : "…考え中";

  const lines = [
    `**<@${d.challenger_id}>** vs **<@${d.opponent_id}>**`,
    "",
    reveal
      ? `<@${d.challenger_id}>: **${rankName(d.challenger_card)}** ${cAct}\n<@${d.opponent_id}>: **${rankName(d.opponent_card)}** ${oAct}`
      : `<@${d.challenger_id}>: 🂠 ${cAct}\n<@${d.opponent_id}>: 🂠 ${oAct}`,
    "",
    `賭け金: ${formatEther(d.stake)} ずつ（総取り ${formatEther(d.stake * 2)} − 場代 ${Math.round(RAKE_PCT * 100)}%）`,
  ].join("\n");

  const embed = baseEmbed(`🪶 インディアン #${d.id}`, reveal ? PALETTE.STARGOLD : PALETTE.VERMILION).setDescription(lines);
  if (reveal) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ind:peek:${d.id}`).setLabel("🔍 相手の手を見る").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ind:stay:${d.id}`).setLabel("✋ ステイ（勝負）").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ind:fold:${d.id}`).setLabel("🏳 フォールド").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// ─── 精算 ──────────────────────────────────────────
async function settleDuel(client: Client, duelId: number): Promise<void> {
  const d = getDuel(duelId);
  if (!d || d.status !== "active") return;
  let winnerId: string | null = null;
  let rake = 0;
  let payout = 0;
  let note = "";

  runTransaction(() => {
    const cur = getDuel(duelId);
    if (!cur || cur.status !== "active") return;
    const cAct = cur.challenger_action, oAct = cur.opponent_action;
    if (cAct === "fold" && oAct === "fold") {
      // 両者降り → 両者返金
      adjustBalance(d.challenger_id, d.stake, "インディアン: 両者降り返金", "indian", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "インディアン: 両者降り返金", "indian", d.guild_id);
      db.prepare("UPDATE indian_duels SET status = 'settled' WHERE id = ?").run(duelId);
      note = "🏳 両者フォールド。引き分けで両者返金。";
      return;
    }
    if (cAct === "fold") { winnerId = d.opponent_id; note = `<@${d.challenger_id}> がフォールド。`; }
    else if (oAct === "fold") { winnerId = d.challenger_id; note = `<@${d.opponent_id}> がフォールド。`; }
    else {
      // 両者ステイ → 開示判定
      if (d.challenger_card > d.opponent_card) { winnerId = d.challenger_id; note = `**${rankName(d.challenger_card)}** vs **${rankName(d.opponent_card)}**。`; }
      else if (d.opponent_card > d.challenger_card) { winnerId = d.opponent_id; note = `**${rankName(d.challenger_card)}** vs **${rankName(d.opponent_card)}**。`; }
      else {
        // 同値 → 引き分け返金
        adjustBalance(d.challenger_id, d.stake, "インディアン: 同値返金", "indian", d.guild_id);
        adjustBalance(d.opponent_id, d.stake, "インディアン: 同値返金", "indian", d.guild_id);
        db.prepare("UPDATE indian_duels SET status = 'settled' WHERE id = ?").run(duelId);
        note = `🤝 両者 ${rankName(d.challenger_card)} で同値ドロー。`;
        return;
      }
    }
    rake = Math.floor(d.stake * RAKE_PCT);
    payout = d.stake * 2 - rake;
    adjustBalance(winnerId!, payout, "インディアン: 勝者総取り", "indian", d.guild_id);
    if (rake > 0) db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(rake, d.guild_id);
    db.prepare("UPDATE indian_duels SET status = 'settled', winner_id = ?, rake = ? WHERE id = ?")
      .run(winnerId!, rake, duelId);
  });

  const render = renderPanel(duelId, true);
  const tail = [
    note,
    "",
    winnerId ? `🎉 <@${winnerId}> の勝ち！ ${formatEther(payout)} を総取り。` : `🤝 賭け金 ${formatEther(d.stake)} を両者に返したよ。`,
    winnerId && rake > 0 ? `*場代 ${formatEther(rake)} を ${WORLD.POOL_JACKPOT} に納めた。*` : "",
  ].filter(Boolean).join("\n");
  render.embeds[0].setDescription(((render.embeds[0].data as any).description ?? "") + "\n\n" + tail);

  try {
    if (d.channel_id && d.message_id) {
      const ch = await client.channels.fetch(d.channel_id).catch(() => null);
      if (ch && "messages" in ch) {
        const msg = await (ch as any).messages.fetch(d.message_id).catch(() => null);
        if (msg) await msg.edit({ content: "", embeds: render.embeds, components: [] }).catch(() => {});
      }
    }
  } catch { /* ignore */ }

  // 紐付きVCがあれば 続行/やめる パネル
  try {
    const { postDecisionPanel } = require("../decisionPanel");
    await postDecisionPanel(client, d.guild_id, "indian", String(d.id), d.challenger_id, [d.challenger_id, d.opponent_id]);
  } catch (err) { console.warn("[indian] decisionPanel post failed:", err); }
}

// ─── 再戦立て ──────────────────────────────────────
export async function restartIndian(client: Client, oldDuelId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getDuel(oldDuelId);
  if (!old) return null;
  const inserted = runTransaction<{ ok: boolean; newId?: number }>(() => {
    const dc = adjustBalance(old.challenger_id, -old.stake, "インディアン: 再戦エスクロー", "indian", old.guild_id);
    if (!dc.ok) return { ok: false };
    const dop = adjustBalance(old.opponent_id, -old.stake, "インディアン: 再戦エスクロー", "indian", old.guild_id);
    if (!dop.ok) { adjustBalance(old.challenger_id, old.stake, "インディアン: 再戦失敗・返金", "indian", old.guild_id); return { ok: false }; }
    const cCard = 1 + Math.floor(Math.random() * 13);
    const oCard = 1 + Math.floor(Math.random() * 13);
    const res = db.prepare(
      `INSERT INTO indian_duels (guild_id, challenger_id, opponent_id, stake, status, challenger_card, opponent_card, channel_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(old.guild_id, old.challenger_id, old.opponent_id, old.stake, cCard, oCard, vcId ?? old.channel_id);
    return { ok: true, newId: Number(res.lastInsertRowid) };
  });
  if (!inserted.ok || !inserted.newId) return null;
  const target = vcId ?? old.channel_id;
  if (target) {
    try {
      const ch = await client.channels.fetch(target).catch(() => null);
      if (ch && "send" in ch) {
        const render = renderPanel(inserted.newId, false);
        const msg = await (ch as any).send({ embeds: render.embeds, components: render.components });
        db.prepare("UPDATE indian_duels SET message_id = ?, channel_id = ? WHERE id = ?").run(msg.id, target, inserted.newId);
      }
    } catch (err) { console.warn("[indian] restart announce failed:", err); }
  }
  return String(inserted.newId);
}

// ─── タイムアウト sweep ─────────────────────────────
async function sweepStaleIndian(client: Client): Promise<void> {
  const now = Date.now();
  const pending = db.prepare("SELECT * FROM indian_duels WHERE status = 'pending'").all() as DuelRow[];
  for (const d of pending) {
    const ts = new Date(d.created_at + "Z").getTime();
    if (now - ts >= PENDING_AUTO_DECLINE_MS) {
      try {
        db.prepare("UPDATE indian_duels SET status = 'void' WHERE id = ? AND status = 'pending'").run(d.id);
        await clearPanel(client, d, "🪶 申込みが1時間放置されたから流したよ。");
      } catch (err) { console.warn(`[indian sweep] pending decline failed for #${d.id}:`, err); }
    }
  }
  const active = db.prepare("SELECT * FROM indian_duels WHERE status = 'active'").all() as DuelRow[];
  for (const d of active) {
    const ts = new Date(d.created_at + "Z").getTime();
    if (now - ts >= ACTIVE_AUTO_VOID_MS) {
      try {
        runTransaction(() => {
          const cur = getDuel(d.id);
          if (!cur || cur.status !== "active") return;
          adjustBalance(d.challenger_id, d.stake, "インディアン: 長時間放置で自動返金", "indian", d.guild_id);
          adjustBalance(d.opponent_id, d.stake, "インディアン: 長時間放置で自動返金", "indian", d.guild_id);
          db.prepare("UPDATE indian_duels SET status = 'void' WHERE id = ?").run(d.id);
        });
        await clearPanel(client, d, "🪶 長時間放置されたから両者に返金して無効にしたよ。");
      } catch (err) { console.warn(`[indian sweep] active void failed for #${d.id}:`, err); }
    }
  }
}

async function clearPanel(client: Client, d: DuelRow, msg: string): Promise<void> {
  if (!d.channel_id || !d.message_id) return;
  try {
    const ch = await client.channels.fetch(d.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const m = await (ch as any).messages.fetch(d.message_id).catch(() => null);
    if (!m) return;
    await m.edit({ content: "", embeds: [baseEmbed(`🪶 インディアン #${d.id}`, PALETTE.NIGHT).setDescription(msg)], components: [] }).catch(() => {});
  } catch { /* ignore */ }
}

let tickHandle: NodeJS.Timeout | null = null;
export function bootIndianTimeouts(client: Client): void {
  if (tickHandle) clearInterval(tickHandle);
  void sweepStaleIndian(client).catch((err) => console.error("[indian] initial sweep failed:", err));
  tickHandle = setInterval(() => {
    void sweepStaleIndian(client).catch((err) => console.error("[indian] tick sweep failed:", err));
  }, TICK_INTERVAL_MS);
  console.log("[indian] timeout sweep started (1min interval)");
}

export function refundStaleIndianOnStartup(): void {
  const stale = db.prepare("SELECT * FROM indian_duels WHERE status = 'active'").all() as DuelRow[];
  runTransaction(() => {
    for (const d of stale) {
      adjustBalance(d.challenger_id, d.stake, "インディアン: 再起動による返金", "indian", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "インディアン: 再起動による返金", "indian", d.guild_id);
      db.prepare("UPDATE indian_duels SET status = 'void' WHERE id = ?").run(d.id);
    }
    db.prepare("UPDATE indian_duels SET status = 'void' WHERE status = 'pending'").run();
  });
  if (stale.length > 0) console.log(`[bootstrap] refunded ${stale.length} stale indian duel(s)`);
}
