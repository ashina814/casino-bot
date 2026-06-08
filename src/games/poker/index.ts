/**
 * 5枚交換ポーカー
 * ─────────────────────────────────────────────────────────
 * モード:
 *   - サシ: /勝負 ポーカー <相手指定> <額>  → 1v1。受諾でエスクロー → 配布
 *   - オープン: /勝負 ポーカー <相手なし> <額> → 募集モード。誰でも[参加]→ ante
 *
 * 流れ:
 *   配布(5枚 ephemeral) → 各自交換(0〜5枚) → 開示 → 役比較 → 最高役の人(達)で pot 山分け
 *   場代3% → JP。同役は均等山分け。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
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
import { createLinkedTable, findLinkedVC, markLinkedVCSettled } from "../takutate/index";
import { memberName } from "../../core/names";

const RAKE_PCT = 0.03;
const MIN_OPEN = 2;
const MAX_OPEN = 6;
const PENDING_AUTO_DECLINE_MS = 5 * 60_000;
const ACTIVE_AUTO_VOID_MS = 6 * 60 * 60_000;
const TICK_INTERVAL_MS = 60_000;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANK_NAMES = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const CAT_LABEL = ["", "ハイカード", "ワンペア", "ツーペア", "スリーカード", "ストレート", "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ", "ロイヤルフラッシュ"];

type Card = { suit: string; rank: number }; // rank 2-14 (A=14)
type GameRow = {
  id: number;
  guild_id: string;
  mode: "sashi" | "open";
  host_id: string;
  opponent_id: string | null;
  stake: number;
  status: "pending" | "open" | "dealt" | "settled" | "declined" | "void";
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
};
type PlayerRow = {
  game_id: number;
  user_id: string;
  hand: string;
  discarded: string;
  discard_done: number;
  final_hand: string;
  rank_category: number;
  rank_tiebreak: string;
  rank_label: string;
};

function getGame(id: number): GameRow | undefined {
  return db.prepare("SELECT * FROM poker_games WHERE id = ?").get(id) as GameRow | undefined;
}
function getPlayers(gameId: number): PlayerRow[] {
  return db.prepare("SELECT * FROM poker_players WHERE game_id = ?").all(gameId) as PlayerRow[];
}
function getPlayer(gameId: number, userId: string): PlayerRow | undefined {
  return db.prepare("SELECT * FROM poker_players WHERE game_id = ? AND user_id = ?").get(gameId, userId) as PlayerRow | undefined;
}
function parseHand(s: string): Card[] { try { return JSON.parse(s) as Card[]; } catch { return []; } }
function cardDisplay(c: Card): string { return `${c.suit}${RANK_NAMES[c.rank]}`; }
function handStr(hand: Card[]): string { return hand.map(cardDisplay).join(" "); }

// ─── deck/eval ─────────────────────────────────────
function createDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ suit: s, rank: r });
  // shuffle
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** 役判定。category 1=ハイカード 〜 10=ロイヤル, tiebreak は降順比較配列。 */
function evaluate(hand: Card[]): { category: number; tiebreak: number[]; label: string } {
  const ranks = hand.map((c) => c.rank).sort((a, b) => b - a);
  const suitCount: Record<string, number> = {};
  for (const c of hand) suitCount[c.suit] = (suitCount[c.suit] ?? 0) + 1;
  const isFlush = Object.values(suitCount).some((n) => n === 5);

  // straight: ranks consecutive 5, or A-2-3-4-5 (rank 14 treated as 1)
  const unique = Array.from(new Set(ranks)).sort((a, b) => b - a);
  let isStraight = false, straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) { isStraight = true; straightHigh = unique[0]; }
    else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      isStraight = true; straightHigh = 5; // A-2-3-4-5 wheel
    }
  }

  // group by rank for pair/trip/quad
  const rankCount: Record<number, number> = {};
  for (const r of ranks) rankCount[r] = (rankCount[r] ?? 0) + 1;
  const groups = Object.entries(rankCount)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  // helpers
  const buildTb = () => groups.flatMap((g) => Array(g.count).fill(g.rank)); // counts desc, then rank desc

  // Royal Flush
  if (isStraight && isFlush && straightHigh === 14) return { category: 10, tiebreak: [14], label: CAT_LABEL[10] };
  // Straight Flush
  if (isStraight && isFlush) return { category: 9, tiebreak: [straightHigh], label: CAT_LABEL[9] };
  // Four of a Kind
  if (groups[0].count === 4) return { category: 8, tiebreak: [groups[0].rank, groups[1].rank], label: CAT_LABEL[8] };
  // Full House
  if (groups[0].count === 3 && groups[1]?.count === 2) return { category: 7, tiebreak: [groups[0].rank, groups[1].rank], label: CAT_LABEL[7] };
  // Flush
  if (isFlush) return { category: 6, tiebreak: ranks, label: CAT_LABEL[6] };
  // Straight
  if (isStraight) return { category: 5, tiebreak: [straightHigh], label: CAT_LABEL[5] };
  // Three of a Kind
  if (groups[0].count === 3) return { category: 4, tiebreak: [groups[0].rank, ...groups.slice(1).map((g) => g.rank)], label: CAT_LABEL[4] };
  // Two Pair
  if (groups[0].count === 2 && groups[1]?.count === 2) return { category: 3, tiebreak: [groups[0].rank, groups[1].rank, groups[2].rank], label: CAT_LABEL[3] };
  // One Pair
  if (groups[0].count === 2) return { category: 2, tiebreak: [groups[0].rank, ...groups.slice(1).map((g) => g.rank)], label: CAT_LABEL[2] };
  // High Card
  return { category: 1, tiebreak: ranks, label: CAT_LABEL[1] };
}

function compareEval(a: { category: number; tiebreak: number[] }, b: { category: number; tiebreak: number[] }): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? 0, bv = b.tiebreak[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ─── Command ─────────────────────────────────────────
export const pokerCommand = new SlashCommandBuilder()
  .setName("ポーカー")
  .setDescription("🃏 5枚交換ポーカー — 相手指定でサシ、未指定でオープン募集")
  .addSubcommand((sc) =>
    sc
      .setName("申込み")
      .setDescription("ポーカー勝負を立てる")
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（参加者全員同額）").setRequired(true).setMinValue(1))
      .addUserOption((o) => o.setName("相手").setDescription("相手指定でサシ（未指定なら誰でも参加できるオープン）").setRequired(false)),
  );

export async function handlePokerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommand() === "申込み") return challenge(interaction);
}

export async function challenge(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }
  const hostId = interaction.user.id;
  const opponent = interaction.options.getUser("相手");
  const stake = interaction.options.getInteger("額", true);
  const mode: "sashi" | "open" = opponent ? "sashi" : "open";

  if (opponent && (opponent.bot || opponent.id === hostId)) {
    await interaction.reply({ embeds: [errorEmbed("自分やボットには挑めないよ。")], ephemeral: true });
    return;
  }
  ensureUser(hostId, guildId);
  if (opponent) ensureUser(opponent.id, guildId);

  const cfg = getServerConfig(guildId);
  const tier = getTierByKey(getProfile(hostId, guildId).tier);
  if (stake < cfg.min_bet) { await interaction.reply({ embeds: [errorEmbed(`最低 ${formatEther(cfg.min_bet)} からだよ。`)], ephemeral: true }); return; }
  const cap = effectiveBetCap(tier.betCap, hostId, guildId);
  if (stake > cap) { await interaction.reply({ embeds: [errorEmbed(`上限 ${formatEther(cap)}${cap > tier.betCap ? "（💎VIP×2）" : ""} までだよ。`)], ephemeral: true }); return; }
  if (getBalance(hostId, guildId) < stake) { await interaction.reply({ embeds: [errorEmbed("自分の残高が足りないみたい。")], ephemeral: true }); return; }

  if (mode === "sashi") {
    // pending、相手の[受ける]待ち
    const gameId = Number(db.prepare(
      "INSERT INTO poker_games (guild_id, mode, host_id, opponent_id, stake, status, channel_id) VALUES (?, 'sashi', ?, ?, ?, 'pending', ?)",
    ).run(guildId, hostId, opponent!.id, stake, interaction.channelId).lastInsertRowid);
    const embed = baseEmbed(`🃏 ポーカー（サシ）#${gameId}`, PALETTE.VERMILION).setDescription([
      `**${memberName(interaction)}** が <@${opponent!.id}> にポーカー対戦を申し込んだ。`,
      `賭け金: **${formatEther(stake)}**（両者同額・勝者総取り）`,
      `*場代 ${Math.round(RAKE_PCT * 100)}% は ${WORLD.POOL_JACKPOT} へ。*`,
      "",
      "🃏 5枚配布 → 0〜5枚交換 → 役比較で勝者総取り。",
      "",
      `<@${opponent!.id}> — 受けるなら「受ける」を押してね。`,
    ].join("\n"));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pkr:accept:${gameId}`).setLabel("受ける").setStyle(ButtonStyle.Success).setEmoji("🃏"),
      new ButtonBuilder().setCustomId(`pkr:decline:${gameId}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
    );
    const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pkr:linkvc:${gameId}`).setLabel("この勝負用の卓を立てる").setStyle(ButtonStyle.Secondary).setEmoji("🃏"),
    );
    await interaction.reply({ content: `<@${opponent!.id}>`, embeds: [embed], components: [row, linkRow] });
    const msg = await interaction.fetchReply();
    db.prepare("UPDATE poker_games SET message_id = ? WHERE id = ?").run(msg.id, gameId);
  } else {
    // open: 即募集モード。立て主はまだエスクローしない（参加ボタンで自分も含めて全員 ante）
    const gameId = Number(db.prepare(
      "INSERT INTO poker_games (guild_id, mode, host_id, stake, status, channel_id) VALUES (?, 'open', ?, ?, 'open', ?)",
    ).run(guildId, hostId, stake, interaction.channelId).lastInsertRowid);
    await interaction.reply({ embeds: [renderOpenLobby(gameId)], components: lobbyButtons(gameId) });
    const msg = await interaction.fetchReply();
    db.prepare("UPDATE poker_games SET message_id = ? WHERE id = ?").run(msg.id, gameId);
  }
}

// ─── オープン: ロビー描画 ────────────────────────────
function renderOpenLobby(gameId: number): ReturnType<typeof baseEmbed> {
  const g = getGame(gameId)!;
  const players = getPlayers(gameId);
  return baseEmbed(`🃏 ポーカー（オープン）#${gameId}`, PALETTE.VERMILION).setDescription([
    `立て主: <@${g.host_id}>　|　参加費: **${formatEther(g.stake)}**`,
    `現在の参加者（${players.length}/${MAX_OPEN}人）:`,
    players.length === 0 ? "（まだいない）" : players.map((p) => `・<@${p.user_id}>`).join("\n"),
    "",
    `参加なら「🃏 参加」（${formatEther(g.stake)} ante）。`,
    `**${MIN_OPEN}人以上**集まれば、立て主が「🎴 締切→配布」で開始できるよ。`,
  ].join("\n"));
}
function lobbyButtons(gameId: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pkr:join:${gameId}`).setLabel("🃏 参加").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pkr:leave:${gameId}`).setLabel("🚪 抜ける").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`pkr:deal:${gameId}`).setLabel("🎴 締切→配布").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`pkr:cancel:${gameId}`).setLabel("❌ 中止").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pkr:linkvc:${gameId}`).setLabel("この勝負用の卓を立てる").setStyle(ButtonStyle.Secondary).setEmoji("🃏"),
    ),
  ];
}

// ─── ボタン ─────────────────────────────────────────
export async function handlePokerButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const g = getGame(Number(idStr));
  if (!g) { await interaction.reply({ content: "その勝負はもう無いみたい。", ephemeral: true }); return; }
  switch (action) {
    case "accept": return acceptSashi(interaction, g);
    case "decline": return declineSashi(interaction, g);
    case "join": return joinOpen(interaction, g);
    case "leave": return leaveOpen(interaction, g);
    case "deal": return dealOpen(interaction, g);
    case "cancel": return cancelOpen(interaction, g);
    case "hand": return showHand(interaction, g);
    case "linkvc": return linkVc(interaction, g);
  }
}

async function linkVc(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  // サシ: 当事者2人のみ / オープン: 公開（パネルch継承）
  const userId = interaction.user.id;
  const players = getPlayers(g.id);
  if (g.mode === "sashi") {
    if (userId !== g.host_id && userId !== g.opponent_id) {
      await interaction.reply({ content: "当事者だけが立てられるよ。", ephemeral: true }); return;
    }
  } else {
    if (userId !== g.host_id && !players.some((p) => p.user_id === userId)) {
      await interaction.reply({ content: "立て主か参加者だけが立てられるよ。", ephemeral: true }); return;
    }
  }
  if (g.status !== "pending" && g.status !== "open" && g.status !== "dealt") {
    await interaction.reply({ content: "勝負中だけ立てられるよ。", ephemeral: true }); return;
  }
  const existing = findLinkedVC("poker", String(g.id));
  if (existing) {
    await interaction.reply({
      embeds: [baseEmbed("🃏 もう立ってるよ", PALETTE.JADE).setDescription(`卓は <#${existing.channel_id}> にあるよ。`)],
      ephemeral: true,
    });
    return;
  }
  if (g.mode === "sashi") {
    await createLinkedTable(interaction, {
      linkType: "poker", linkId: String(g.id),
      userLimit: 2, allowedUserIds: [g.host_id, g.opponent_id!],
      vcName: `🃏 ポーカーの卓 #${g.id}`,
    });
  } else {
    await createLinkedTable(interaction, {
      linkType: "poker", linkId: String(g.id),
      userLimit: 6, allowedUserIds: null,
      vcName: `🃏 ポーカー卓 #${g.id}`,
    });
  }
}

export async function handlePokerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  if (action !== "discard") return;
  const g = getGame(Number(idStr));
  if (!g) { await interaction.reply({ content: "その勝負はもう無いみたい。", ephemeral: true }); return; }
  return submitDiscard(interaction, g);
}

// ─── サシ: 受諾/辞退 ─────────────────────────────
async function declineSashi(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (interaction.user.id !== g.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが操作できるよ。", ephemeral: true }); return; }
  if (g.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE poker_games SET status = 'declined' WHERE id = ?").run(g.id);
  await interaction.update({ content: "", embeds: [baseEmbed(`🃏 ポーカー #${g.id} — 辞退`, PALETTE.NIGHT).setDescription("この勝負は見送られたよ。")], components: [] });
}

async function acceptSashi(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (interaction.user.id !== g.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが受けられるよ。", ephemeral: true }); return; }
  if (g.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  // 両者エスクロー & 配布
  const ok = runTransaction<{ ok: boolean; reason?: string }>(() => {
    const cur = getGame(g.id);
    if (!cur || cur.status !== "pending") return { ok: false, reason: "GONE" };
    const dc = adjustBalance(g.host_id, -g.stake, "ポーカー: エスクロー", "poker", g.guild_id);
    if (!dc.ok) return { ok: false, reason: "HOST_FUNDS" };
    const dop = adjustBalance(g.opponent_id!, -g.stake, "ポーカー: エスクロー", "poker", g.guild_id);
    if (!dop.ok) return { ok: false, reason: "OPP_FUNDS" };
    db.prepare("INSERT INTO poker_players (game_id, user_id) VALUES (?, ?), (?, ?)").run(g.id, g.host_id, g.id, g.opponent_id!);
    return { ok: true };
  });
  if (!ok.ok) {
    const m = ok.reason === "OPP_FUNDS" ? "きみの残高が足りないみたい。" : ok.reason === "HOST_FUNDS" ? "申込者の残高が足りなくなってたよ。" : "もう受付が終わってたよ。";
    await interaction.reply({ embeds: [errorEmbed(m)], ephemeral: true });
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  await dealAndStart(interaction.client, g.id);
}

// ─── オープン: 参加/抜ける/締切/中止 ───────────────
async function joinOpen(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (g.status !== "open") { await interaction.reply({ content: "もう募集してないよ。", ephemeral: true }); return; }
  const userId = interaction.user.id;
  if (getPlayer(g.id, userId)) { await interaction.reply({ content: "もう参加してるよ。", ephemeral: true }); return; }
  const players = getPlayers(g.id);
  if (players.length >= MAX_OPEN) { await interaction.reply({ content: `定員 ${MAX_OPEN}人 だよ。`, ephemeral: true }); return; }
  ensureUser(userId, g.guild_id);
  if (getBalance(userId, g.guild_id) < g.stake) { await interaction.reply({ content: "残高が足りないよ。", ephemeral: true }); return; }
  const ok = runTransaction<boolean>(() => {
    const cur = getGame(g.id);
    if (!cur || cur.status !== "open") return false;
    const d = adjustBalance(userId, -g.stake, "ポーカー: 参加 ante", "poker", g.guild_id);
    if (!d.ok) return false;
    db.prepare("INSERT INTO poker_players (game_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(g.id, userId);
    return true;
  });
  if (!ok) { await interaction.reply({ content: "参加できなかった。残高か締切を確認して。", ephemeral: true }); return; }
  await interaction.update({ embeds: [renderOpenLobby(g.id)], components: lobbyButtons(g.id) }).catch(() => {});
}

async function leaveOpen(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (g.status !== "open") { await interaction.reply({ content: "もう抜けられないよ。", ephemeral: true }); return; }
  const userId = interaction.user.id;
  const p = getPlayer(g.id, userId);
  if (!p) { await interaction.reply({ content: "まだ参加してないよ。", ephemeral: true }); return; }
  runTransaction(() => {
    adjustBalance(userId, g.stake, "ポーカー: 参加取消・返金", "poker", g.guild_id);
    db.prepare("DELETE FROM poker_players WHERE game_id = ? AND user_id = ?").run(g.id, userId);
  });
  await interaction.update({ embeds: [renderOpenLobby(g.id)], components: lobbyButtons(g.id) }).catch(() => {});
}

async function cancelOpen(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (g.status !== "open") { await interaction.reply({ content: "もう中止できないよ。", ephemeral: true }); return; }
  if (interaction.user.id !== g.host_id) { await interaction.reply({ content: "立て主だけが中止できるよ。", ephemeral: true }); return; }
  // 全員返金
  runTransaction(() => {
    const players = getPlayers(g.id);
    for (const p of players) adjustBalance(p.user_id, g.stake, "ポーカー: 立て主中止・返金", "poker", g.guild_id);
    db.prepare("DELETE FROM poker_players WHERE game_id = ?").run(g.id);
    db.prepare("UPDATE poker_games SET status = 'void' WHERE id = ?").run(g.id);
  });
  await interaction.update({ embeds: [baseEmbed(`🃏 ポーカー #${g.id} — 中止`, PALETTE.NIGHT).setDescription("立て主が中止したよ。参加者には返金済み。")], components: [] }).catch(() => {});
}

async function dealOpen(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (g.status !== "open") { await interaction.reply({ content: "もう締切は受け付けられないよ。", ephemeral: true }); return; }
  if (interaction.user.id !== g.host_id) { await interaction.reply({ content: "立て主だけが締切れるよ。", ephemeral: true }); return; }
  const players = getPlayers(g.id);
  if (players.length < MIN_OPEN) { await interaction.reply({ content: `最低 ${MIN_OPEN}人 必要だよ。`, ephemeral: true }); return; }
  await interaction.deferUpdate().catch(() => {});
  await dealAndStart(interaction.client, g.id);
}

// ─── 配布 ────────────────────────────────────────
async function dealAndStart(client: Client, gameId: number): Promise<void> {
  const g = getGame(gameId);
  if (!g) return;
  const players = getPlayers(gameId);
  const deck = createDeck();
  runTransaction(() => {
    for (const p of players) {
      const hand: Card[] = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
      db.prepare("UPDATE poker_players SET hand = ?, final_hand = ? WHERE game_id = ? AND user_id = ?")
        .run(JSON.stringify(hand), JSON.stringify(hand), gameId, p.user_id);
    }
    db.prepare("UPDATE poker_games SET status = 'dealt', dealt_at = datetime('now') WHERE id = ?").run(gameId);
  });
  await updateMainPanel(client, gameId);
}

function pot(g: GameRow, playerCount: number): number { return g.stake * playerCount; }

async function updateMainPanel(client: Client, gameId: number): Promise<void> {
  const g = getGame(gameId);
  if (!g || !g.channel_id || !g.message_id) return;
  const players = getPlayers(gameId);
  const lines = [
    `参加者 ${players.length}人　|　pot: **${formatEther(pot(g, players.length))}**　|　場代 ${Math.round(RAKE_PCT * 100)}%`,
    "",
    players.map((p) => `${p.discard_done ? "✋" : "…"} <@${p.user_id}>`).join("\n"),
    "",
    "下の **「🃏 手札を見る」** から自分の手札と交換選択。",
    "全員が確定したら自動で開示するよ。",
  ].join("\n");
  const embed = baseEmbed(`🃏 ポーカー #${gameId} — 配布完了`, PALETTE.STARGOLD).setDescription(lines);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pkr:hand:${gameId}`).setLabel("🃏 手札を見る / 交換").setStyle(ButtonStyle.Primary),
  );
  try {
    const ch = await client.channels.fetch(g.channel_id).catch(() => null);
    if (ch && "messages" in ch) {
      const msg = await (ch as any).messages.fetch(g.message_id).catch(() => null);
      if (msg) await msg.edit({ content: "", embeds: [embed], components: [row] }).catch(() => {});
    }
  } catch { /* ignore */ }
}

// ─── 手札表示 / 交換選択 ─────────────────────────
async function showHand(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (g.status !== "dealt") { await interaction.reply({ content: "いまは手札を見られないよ。", ephemeral: true }); return; }
  const p = getPlayer(g.id, interaction.user.id);
  if (!p) { await interaction.reply({ content: "このゲームに参加してないよ。", ephemeral: true }); return; }
  if (p.discard_done) {
    const hand = parseHand(p.final_hand);
    await interaction.reply({
      embeds: [baseEmbed("🃏 きみの手札（確定済み）", PALETTE.JADE).setDescription(`${handStr(hand)}\n\n*もう交換は終わってるよ。他の人を待ってね。*`)],
      ephemeral: true,
    });
    return;
  }
  const hand = parseHand(p.hand);
  const sel = new StringSelectMenuBuilder()
    .setCustomId(`pkr:discard:${g.id}`)
    .setPlaceholder("交換したい札を選ぶ（0〜5枚）")
    .setMinValues(0).setMaxValues(5)
    .addOptions(hand.map((c, i) => ({ label: cardDisplay(c), description: `${i + 1}枚目`, value: String(i) })));
  await interaction.reply({
    embeds: [baseEmbed("🃏 きみの手札", PALETTE.AZURE).setDescription([
      `**${handStr(hand)}**`,
      "",
      "交換したい札を選んで「決定」。何も選ばずに決定すれば全部キープ（ステイ）。",
    ].join("\n"))],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
    ephemeral: true,
  });
}

async function submitDiscard(interaction: StringSelectMenuInteraction, g: GameRow): Promise<void> {
  if (g.status !== "dealt") { await interaction.reply({ content: "いまは交換できないよ。", ephemeral: true }); return; }
  const userId = interaction.user.id;
  const p = getPlayer(g.id, userId);
  if (!p) { await interaction.reply({ content: "このゲームに参加してないよ。", ephemeral: true }); return; }
  if (p.discard_done) { await interaction.reply({ content: "もう交換は終わってるよ。", ephemeral: true }); return; }

  const indices = interaction.values.map(Number).filter((n) => n >= 0 && n < 5);
  // 山札を作り直して既存の全手札を除外
  const allHands = getPlayers(g.id).flatMap((pp) => parseHand(pp.hand));
  const used = new Set(allHands.map((c) => `${c.suit}${c.rank}`));
  const remaining = createDeck().filter((c) => !used.has(`${c.suit}${c.rank}`));
  // 交換
  const oldHand = parseHand(p.hand);
  const newHand: Card[] = oldHand.map((c, i) => indices.includes(i) ? remaining.pop()! : c);

  const ev = evaluate(newHand);
  runTransaction(() => {
    db.prepare(
      "UPDATE poker_players SET discarded = ?, discard_done = 1, final_hand = ?, rank_category = ?, rank_tiebreak = ?, rank_label = ? WHERE game_id = ? AND user_id = ?",
    ).run(JSON.stringify(indices), JSON.stringify(newHand), ev.category, JSON.stringify(ev.tiebreak), ev.label, g.id, userId);
  });

  await interaction.update({
    embeds: [baseEmbed("🃏 交換完了", PALETTE.JADE).setDescription([
      `交換した枚数: **${indices.length}**`,
      `きみの手: **${handStr(newHand)}**`,
      `役: **${ev.label}**`,
      "",
      "*他の人を待ってね。全員終わったら自動で開示するよ。*",
    ].join("\n"))],
    components: [],
  }).catch(() => {});

  // 全員終わってたら settle
  const players = getPlayers(g.id);
  if (players.every((pp) => pp.discard_done === 1)) {
    await settleGame(interaction.client, g.id);
  } else {
    await updateMainPanel(interaction.client, g.id);
  }
}

// ─── 精算 ─────────────────────────────────────────
async function settleGame(client: Client, gameId: number): Promise<void> {
  const g = getGame(gameId);
  if (!g || g.status !== "dealt") return;
  const players = getPlayers(gameId);
  // 各自評価
  const scored = players.map((p) => ({
    user_id: p.user_id,
    hand: parseHand(p.final_hand),
    ev: { category: p.rank_category, tiebreak: JSON.parse(p.rank_tiebreak) as number[], label: p.rank_label },
  }));
  // 最高ランクを見つける
  scored.sort((a, b) => compareEval(b.ev, a.ev));
  const top = scored[0];
  const winners = scored.filter((s) => compareEval(s.ev, top.ev) === 0);

  const totalPot = pot(g, players.length);
  const rake = Math.floor(totalPot * RAKE_PCT);
  const distributable = totalPot - rake;
  const perWinner = Math.floor(distributable / winners.length);
  const leftover = distributable - perWinner * winners.length;

  runTransaction(() => {
    for (const w of winners) {
      adjustBalance(w.user_id, perWinner, "ポーカー: 配当", "poker", g.guild_id);
    }
    if (rake + leftover > 0) {
      db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(rake + leftover, g.guild_id);
    }
    db.prepare("UPDATE poker_games SET status = 'settled', settled_at = datetime('now') WHERE id = ?").run(gameId);
  });

  // 結果 embed
  const allLines = scored.map((s) => `${winners.includes(s) ? "🏆" : "・"} <@${s.user_id}>: ${handStr(s.hand)} — **${s.ev.label}**`);
  const tail = winners.length === 1
    ? `🎉 <@${winners[0].user_id}> の単独勝利！ **${formatEther(perWinner)}** を獲得。`
    : `🤝 ${winners.length}人で同役！ 各 **${formatEther(perWinner)}** 獲得。`;
  const embed = baseEmbed(`🃏 ポーカー #${gameId} — 開示`, PALETTE.STARGOLD).setDescription([
    `pot: **${formatEther(totalPot)}**（場代 ${formatEther(rake)} → ${WORLD.POOL_JACKPOT}）`,
    "",
    ...allLines,
    "",
    tail,
  ].join("\n"));
  try {
    if (g.channel_id && g.message_id) {
      const ch = await client.channels.fetch(g.channel_id).catch(() => null);
      if (ch && "messages" in ch) {
        const msg = await (ch as any).messages.fetch(g.message_id).catch(() => null);
        if (msg) {
          // メンション winner にする
          const winnerMentions = winners.map((w) => `<@${w.user_id}>`).join(" ");
          await msg.edit({ content: winnerMentions, embeds: [embed], components: [], allowedMentions: { users: winners.map((w) => w.user_id) } }).catch(() => {});
        }
      }
    }
  } catch { /* ignore */ }

  // 紐付きVC: ゲーム終了後の振る舞いはモードで分岐
  //   sashi : 決定パネル（両者[続行]で自動再戦）
  //   open  : パネル出さず案内文のみ。再戦は /勝負 ポーカー 額:<額> を再度叩く（相手指定なしでオープン）。
  //           takutate sweep が「最終勝負から 15分」アイドルで VC を片付ける。
  try {
    if (g.mode === "sashi") {
      const { postDecisionPanel } = require("../decisionPanel");
      await postDecisionPanel(client, g.guild_id, "poker", String(gameId), g.host_id, players.map((p) => p.user_id));
    } else {
      const linked = findLinkedVC("poker", String(gameId));
      if (linked) {
        markLinkedVCSettled("poker", String(gameId));
        const ch = await client.channels.fetch(linked.channel_id).catch(() => null);
        if (ch && "send" in ch) {
          const notice = baseEmbed("🪑 次やる？", PALETTE.JADE).setDescription([
            "勝負はお開き。**15分以内**に `/勝負 ポーカー 額:<額>`（相手未指定でオープン）を叩けば、この卓のままもう一戦できるよ。",
            "*（次の勝負が立たないまま 15分 経ったら卓は片付けるね。雑談用には残さないよ。）*",
          ].join("\n"));
          await (ch as any).send({ embeds: [notice] }).catch(() => {});
        }
      }
    }
  } catch (err) { console.warn("[poker] post-settle notice failed:", err); }
}

// ─── 再戦立て（サシのみ・decisionPanel から） ───────
export async function restartPoker(client: Client, oldGameId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getGame(oldGameId);
  if (!old || old.mode !== "sashi") return null;
  const oldPlayers = getPlayers(oldGameId);
  if (oldPlayers.length !== 2) return null;
  const result = runTransaction<{ ok: boolean; newId?: number }>(() => {
    for (const p of oldPlayers) {
      const d = adjustBalance(p.user_id, -old.stake, "ポーカー: 再戦エスクロー", "poker", old.guild_id);
      if (!d.ok) {
        // 既に引いた人を返す（ロールバック）
        for (const p2 of oldPlayers) {
          if (p2.user_id === p.user_id) break;
          adjustBalance(p2.user_id, old.stake, "ポーカー: 再戦失敗・返金", "poker", old.guild_id);
        }
        return { ok: false };
      }
    }
    const res = db.prepare(
      "INSERT INTO poker_games (guild_id, mode, host_id, opponent_id, stake, status, channel_id, dealt_at) VALUES (?, 'sashi', ?, ?, ?, 'dealt', ?, datetime('now'))",
    ).run(old.guild_id, old.host_id, old.opponent_id, old.stake, vcId ?? old.channel_id);
    const newId = Number(res.lastInsertRowid);
    for (const p of oldPlayers) {
      db.prepare("INSERT INTO poker_players (game_id, user_id) VALUES (?, ?)").run(newId, p.user_id);
    }
    return { ok: true, newId };
  });
  if (!result.ok || !result.newId) return null;
  const newId = result.newId;
  // 配布
  const deck = createDeck();
  runTransaction(() => {
    const players = getPlayers(newId);
    for (const p of players) {
      const hand: Card[] = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
      db.prepare("UPDATE poker_players SET hand = ?, final_hand = ? WHERE game_id = ? AND user_id = ?")
        .run(JSON.stringify(hand), JSON.stringify(hand), newId, p.user_id);
    }
  });
  // メッセージ
  const target = vcId ?? old.channel_id;
  if (target) {
    try {
      const ch = await client.channels.fetch(target).catch(() => null);
      if (ch && "send" in ch) {
        const players = getPlayers(newId);
        const embed = baseEmbed(`🃏 ポーカー（サシ）#${newId} — 配布完了`, PALETTE.STARGOLD).setDescription([
          `参加者 ${players.length}人　|　pot: **${formatEther(pot({ ...old, id: newId } as GameRow, players.length))}**`,
          "",
          players.map((p) => `… <@${p.user_id}>`).join("\n"),
          "",
          "下のボタンから自分の手札と交換選択。",
        ].join("\n"));
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`pkr:hand:${newId}`).setLabel("🃏 手札を見る / 交換").setStyle(ButtonStyle.Primary),
        );
        const msg = await (ch as any).send({ embeds: [embed], components: [row] });
        db.prepare("UPDATE poker_games SET message_id = ?, channel_id = ? WHERE id = ?").run(msg.id, target, newId);
      }
    } catch (err) { console.warn("[poker] restart announce failed:", err); }
  }
  return String(newId);
}

// ─── タイムアウト sweep ─────────────────────────────
async function sweepStalePoker(client: Client): Promise<void> {
  const now = Date.now();
  // pending (sashi 申込み放置) 1h で void
  const pending = db.prepare("SELECT * FROM poker_games WHERE status = 'pending'").all() as GameRow[];
  for (const g of pending) {
    const ts = new Date(g.created_at + "Z").getTime();
    if (now - ts >= PENDING_AUTO_DECLINE_MS) {
      try {
        db.prepare("UPDATE poker_games SET status = 'void' WHERE id = ? AND status = 'pending'").run(g.id);
        await editMsg(client, g, "🃏 申込みが5分放置されたから流したよ。");
      } catch { /* ignore */ }
    }
  }
  // open 1h で void（参加者全員返金）
  const open = db.prepare("SELECT * FROM poker_games WHERE status = 'open'").all() as GameRow[];
  for (const g of open) {
    const ts = new Date(g.created_at + "Z").getTime();
    if (now - ts >= PENDING_AUTO_DECLINE_MS) {
      try {
        runTransaction(() => {
          const cur = getGame(g.id);
          if (!cur || cur.status !== "open") return;
          for (const p of getPlayers(g.id)) adjustBalance(p.user_id, g.stake, "ポーカー: 募集放置・返金", "poker", g.guild_id);
          db.prepare("DELETE FROM poker_players WHERE game_id = ?").run(g.id);
          db.prepare("UPDATE poker_games SET status = 'void' WHERE id = ?").run(g.id);
        });
        await editMsg(client, g, "🃏 1時間誰も締めなかったから流したよ。参加者には返金済み。");
      } catch { /* ignore */ }
    }
  }
  // dealt 6h で全員返金 void
  const dealt = db.prepare("SELECT * FROM poker_games WHERE status = 'dealt'").all() as GameRow[];
  for (const g of dealt) {
    const dealtAt = (g as any).dealt_at as string | null;
    const ts = new Date((dealtAt ?? g.created_at) + "Z").getTime();
    if (now - ts >= ACTIVE_AUTO_VOID_MS) {
      try {
        runTransaction(() => {
          const cur = getGame(g.id);
          if (!cur || cur.status !== "dealt") return;
          for (const p of getPlayers(g.id)) adjustBalance(p.user_id, g.stake, "ポーカー: 長時間放置・返金", "poker", g.guild_id);
          db.prepare("UPDATE poker_games SET status = 'void' WHERE id = ?").run(g.id);
        });
        await editMsg(client, g, "🃏 長時間放置されたから全員返金で無効にしたよ。");
      } catch { /* ignore */ }
    }
  }
}

async function editMsg(client: Client, g: GameRow, text: string): Promise<void> {
  if (!g.channel_id || !g.message_id) return;
  try {
    const ch = await client.channels.fetch(g.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(g.message_id).catch(() => null);
    if (!msg) return;
    await msg.edit({ content: "", embeds: [baseEmbed(`🃏 ポーカー #${g.id}`, PALETTE.NIGHT).setDescription(text)], components: [] }).catch(() => {});
  } catch { /* ignore */ }
}

let tickHandle: NodeJS.Timeout | null = null;
export function bootPokerTimeouts(client: Client): void {
  if (tickHandle) clearInterval(tickHandle);
  void sweepStalePoker(client).catch((err) => console.error("[poker] initial sweep failed:", err));
  tickHandle = setInterval(() => {
    void sweepStalePoker(client).catch((err) => console.error("[poker] tick sweep failed:", err));
  }, TICK_INTERVAL_MS);
  console.log("[poker] timeout sweep started (1min interval)");
}

export function refundStalePokerOnStartup(): void {
  const stale = db.prepare("SELECT * FROM poker_games WHERE status IN ('open','dealt')").all() as GameRow[];
  runTransaction(() => {
    for (const g of stale) {
      for (const p of getPlayers(g.id)) adjustBalance(p.user_id, g.stake, "ポーカー: 再起動による返金", "poker", g.guild_id);
      db.prepare("UPDATE poker_games SET status = 'void' WHERE id = ?").run(g.id);
    }
    db.prepare("UPDATE poker_games SET status = 'void' WHERE status = 'pending'").run();
  });
  if (stale.length > 0) console.log(`[bootstrap] refunded ${stale.length} stale poker game(s)`);
}
