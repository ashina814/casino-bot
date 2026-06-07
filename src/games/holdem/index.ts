/**
 * /勝負 奥ポーカー — VIP専用テキサスホールデム
 * キャッシュゲーム・サイドポット対応・2〜8人卓
 */
import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  Client,
} from "discord.js";
import { adjustBalance, ensureUser } from "../../core/bank";
import { getServerConfig, db } from "../../core/db";
import { isVip } from "../../core/vip";
import { baseEmbed, errorEmbed, successEmbed, COLORS } from "../../ui/embeds";

// ─── Types ─────────────────────────────────────────────

type Phase = "lobby" | "preflop" | "flop" | "turn" | "river" | "showdown" | "ended";

type Player = {
  userId: string;
  displayName: string;
  stack: number;          // chips at the table
  hand: number[];         // 2 hole cards (-1 if not dealt)
  betThisRound: number;   // chips committed this betting round
  totalIn: number;        // chips committed this hand (for sidepot)
  hasFolded: boolean;
  isAllIn: boolean;
  hasActed: boolean;      // acted at least once this round (for round end detection)
};

type Table = {
  channelId: string;
  guildId: string;
  hostId: string;
  messageId: string | null;   // main lobby/board message
  sb: number;
  bb: number;
  minBuyIn: number;
  maxPlayers: number;
  players: Player[];
  dealerIdx: number;          // index in players (rotates each hand)
  phase: Phase;
  community: number[];        // 0-5 community cards
  pot: number;                // chips committed in previous rounds (not current betting round)
  currentBet: number;         // highest bet in current round
  minRaise: number;           // minimum raise increment
  actionIdx: number;          // whose turn (index in players)
  deck: number[];
  handNumber: number;
  lastAggressorIdx: number;   // index of last aggressor (raiser); action ends when it returns
  actionTimer: NodeJS.Timeout | null;
  cancelled: boolean;
};

// ─── State Store ───────────────────────────────────────

const tables = new Map<string, Table>(); // keyed by channelId

// ─── Card Utils ────────────────────────────────────────
// 0-51: rank = c % 13 (0=2 ... 12=A), suit = floor(c / 13) (0=♠ 1=♥ 2=♦ 3=♣)

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

function cardLabel(c: number): string {
  if (c < 0 || c > 51) return "??";
  return `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`;
}
function hand2str(cards: number[]): string {
  return cards.map(cardLabel).join(" ");
}

function freshDeck(): number[] {
  const d: number[] = [];
  for (let i = 0; i < 52; i++) d.push(i);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ─── Hand Evaluation (7 → best 5) ──────────────────────
// Returns a tuple [category, ...tiebreaker ranks] for lexicographic comparison.
// Category: 8=StraightFlush, 7=Quads, 6=FullHouse, 5=Flush, 4=Straight, 3=Trips, 2=TwoPair, 1=Pair, 0=High

function eval5(cards: number[]): number[] {
  const ranks = cards.map((c) => c % 13).sort((a, b) => b - a); // desc
  const suits = cards.map((c) => Math.floor(c / 13));
  const isFlush = suits.every((s) => s === suits[0]);

  // Straight check (A-low handled via [12,3,2,1,0])
  const uniqRanks = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = -1;
  if (uniqRanks.length === 5) {
    if (uniqRanks[0] - uniqRanks[4] === 4) {
      isStraight = true;
      straightHigh = uniqRanks[0];
    } else if (uniqRanks[0] === 12 && uniqRanks[1] === 3 && uniqRanks[2] === 2 && uniqRanks[3] === 1 && uniqRanks[4] === 0) {
      isStraight = true;
      straightHigh = 3; // 5-high straight (wheel)
    }
  }

  // Count ranks
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Sort entries: by count desc, then rank desc
  const grouped = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  if (isStraight && isFlush) return [8, straightHigh];
  if (grouped[0][1] === 4) return [7, grouped[0][0], grouped[1][0]];
  if (grouped[0][1] === 3 && grouped[1][1] === 2) return [6, grouped[0][0], grouped[1][0]];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (grouped[0][1] === 3) return [3, grouped[0][0], grouped[1][0], grouped[2][0]];
  if (grouped[0][1] === 2 && grouped[1][1] === 2) return [2, grouped[0][0], grouped[1][0], grouped[2][0]];
  if (grouped[0][1] === 2) return [1, grouped[0][0], grouped[1][0], grouped[2][0], grouped[3][0]];
  return [0, ...ranks];
}

function evalBest(seven: number[]): number[] {
  // Enumerate C(7,5)=21 combos
  let best: number[] | null = null;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 4; j++) {
      // exclude indices i, j from the 7 to get 5
      const five: number[] = [];
      for (let k = 0; k < 7; k++) if (k !== i && k !== j) five.push(seven[k]);
      const v = eval5(five);
      if (!best || cmpEval(v, best) > 0) best = v;
    }
  }
  // Above only covers 6 combos (i<3, j<4). Need full enumeration.
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 7; j++) {
      const five: number[] = [];
      for (let k = 0; k < 7; k++) if (k !== i && k !== j) five.push(seven[k]);
      const v = eval5(five);
      if (!best || cmpEval(v, best) > 0) best = v;
    }
  }
  return best!;
}

function cmpEval(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const HAND_NAMES = ["ハイカード", "ワンペア", "ツーペア", "スリーカード", "ストレート", "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ"];
function handName(ev: number[]): string {
  return HAND_NAMES[ev[0]] ?? "?";
}

// ─── Sidepot Calculation ───────────────────────────────

type Pot = { amount: number; eligibleIds: string[] };

function buildPots(players: Player[]): Pot[] {
  // Levels = distinct totalIn values from non-folded players (those eligible to win),
  // plus contributions from folded players (which go into the lowest pot they fed).
  // Algorithm: for each level (sorted ascending of contender totalIns), pot_at_level = sum over all players of min(player.totalIn, level) - prev_level total
  const contenders = players.filter((p) => !p.hasFolded);
  const levels = [...new Set(contenders.map((p) => p.totalIn))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const lvl of levels) {
    if (lvl <= prev) continue;
    let amount = 0;
    for (const p of players) {
      amount += Math.max(0, Math.min(p.totalIn, lvl) - prev);
    }
    const eligibleIds = contenders.filter((p) => p.totalIn >= lvl).map((p) => p.userId);
    if (amount > 0 && eligibleIds.length > 0) pots.push({ amount, eligibleIds });
    prev = lvl;
  }
  return pots;
}

// ─── VIP / Validation ──────────────────────────────────

function checkVip(userId: string, guildId: string): boolean {
  // 1) DB の vip エントリ（/vip 月会員）
  if (isVip(userId, guildId)) return true;
  // 2) ロール側で付いてる場合は弾かない判定にしてもいいが、DB が真とする
  return false;
}

// ─── Command Entry ─────────────────────────────────────

export async function challenge(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ embeds: [errorEmbed("サーバー内でのみ使えるよ。")], ephemeral: true });
    return;
  }
  if (!checkVip(interaction.user.id, guildId)) {
    await interaction.reply({
      embeds: [errorEmbed("奥座敷の卓だよ。`/vip` で月会員になれば座れる。")],
      ephemeral: true,
    });
    return;
  }
  const channelId = interaction.channelId;
  if (tables.has(channelId)) {
    await interaction.reply({ embeds: [errorEmbed("このチャンネルでは既に卓が立ってるよ。")], ephemeral: true });
    return;
  }

  const sb = interaction.options.getInteger("sb") ?? 100;
  const bb = interaction.options.getInteger("bb") ?? sb * 2;
  const minBuyIn = interaction.options.getInteger("最低バイイン") ?? 10000;
  const maxPlayers = interaction.options.getInteger("最大人数") ?? 8;

  if (bb <= sb) {
    await interaction.reply({ embeds: [errorEmbed("BBはSBより大きくしてね。")], ephemeral: true });
    return;
  }
  if (minBuyIn < bb * 20) {
    await interaction.reply({ embeds: [errorEmbed(`最低バイインは BB×20 以上（◈${bb * 20}以上）にしてね。`)], ephemeral: true });
    return;
  }

  ensureUser(interaction.user.id, guildId);

  const table: Table = {
    channelId,
    guildId,
    hostId: interaction.user.id,
    messageId: null,
    sb, bb, minBuyIn, maxPlayers,
    players: [],
    dealerIdx: 0,
    phase: "lobby",
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: bb,
    actionIdx: 0,
    deck: [],
    handNumber: 0,
    lastAggressorIdx: -1,
    actionTimer: null,
    cancelled: false,
  };
  tables.set(channelId, table);

  await interaction.reply({ embeds: [lobbyEmbed(table)], components: lobbyRows(table) });
  const msg = await interaction.fetchReply();
  table.messageId = msg.id;
}

// ─── UI Builders ───────────────────────────────────────

function lobbyEmbed(t: Table): EmbedBuilder {
  const seats = t.players.length === 0
    ? "*まだ誰も座ってないよ。*"
    : t.players.map((p, i) => `${i === t.dealerIdx ? "🔘" : "・"} <@${p.userId}> — ◈${p.stack.toLocaleString()}`).join("\n");
  return baseEmbed("✦ 奥座敷ポーカー — ロビー", COLORS.GOLD)
    .setDescription([
      `**ホスト**: <@${t.hostId}>`,
      `**ブラインド**: SB ◈${t.sb} / BB ◈${t.bb}`,
      `**最低バイイン**: ◈${t.minBuyIn.toLocaleString()}　**定員**: ${t.maxPlayers}人`,
      "",
      "**着席中**:",
      seats,
      "",
      "*「座る」を押してバイインを入力。揃ったらホストが「ハンド開始」。*",
    ].join("\n"));
}

function lobbyRows(t: Table): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("hold:join").setLabel("🪑 座る").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hold:leave").setLabel("🚪 離席").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("hold:start").setLabel("▶ ハンド開始").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("hold:cancel").setLabel("✖ 解散").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function boardEmbed(t: Table): EmbedBuilder {
  const community = t.community.length === 0 ? "*（まだ）*" : t.community.map(cardLabel).join(" ");
  const lines = t.players.map((p, i) => {
    const tag = p.hasFolded ? "💤" : (p.isAllIn ? "🔥" : (i === t.actionIdx ? "👉" : "・"));
    const dealer = i === t.dealerIdx ? " 🔘" : "";
    const stack = `◈${p.stack.toLocaleString()}`;
    const bet = p.betThisRound > 0 ? ` (bet ◈${p.betThisRound.toLocaleString()})` : "";
    const fold = p.hasFolded ? " *fold*" : "";
    return `${tag} <@${p.userId}>${dealer} — ${stack}${bet}${fold}`;
  }).join("\n");

  const totalPot = t.pot + t.players.reduce((s, p) => s + p.betThisRound, 0);
  const phaseLabel: Record<Phase, string> = {
    lobby: "ロビー", preflop: "プリフロップ", flop: "フロップ", turn: "ターン", river: "リバー",
    showdown: "ショウダウン", ended: "終了",
  };
  return baseEmbed(`🃏 奥座敷ポーカー — Hand #${t.handNumber}`, COLORS.GOLD)
    .setDescription([
      `**フェーズ**: ${phaseLabel[t.phase]}`,
      `**コミュニティ**: ${community}`,
      `**ポット**: ◈${totalPot.toLocaleString()}　**現在のベット**: ◈${t.currentBet.toLocaleString()}`,
      "",
      lines,
    ].join("\n"));
}

function actionRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("hold:hand").setLabel("🃏 手札").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("hold:check").setLabel("チェック").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("hold:call").setLabel("コール").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("hold:fold").setLabel("フォールド").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("hold:bet").setLabel("ベット").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hold:raise").setLabel("レイズ").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hold:allin").setLabel("オールイン").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function endRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("hold:next").setLabel("▶ 次のハンド").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("hold:standup").setLabel("🚪 離席").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("hold:end").setLabel("✖ お開き").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ─── Persistence (UI) ──────────────────────────────────

async function refresh(client: Client, t: Table, extra?: string): Promise<void> {
  if (!t.messageId) return;
  try {
    const ch = await client.channels.fetch(t.channelId).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(t.messageId).catch(() => null);
    if (!msg) return;
    if (t.phase === "lobby") {
      await msg.edit({ embeds: [lobbyEmbed(t)], components: lobbyRows(t) }).catch(() => {});
      return;
    }
    if (t.phase === "showdown" || t.phase === "ended") {
      await msg.edit({ embeds: [boardEmbed(t)], components: endRows(), content: extra ?? "" }).catch(() => {});
      return;
    }
    const active = t.players[t.actionIdx];
    const content = active ? `<@${active.userId}> の番` : "";
    await msg.edit({ embeds: [boardEmbed(t)], components: actionRows(), content, allowedMentions: { users: active ? [active.userId] : [] } }).catch(() => {});
  } catch (err) {
    console.warn("[holdem] refresh failed:", err);
  }
}

// ─── Button Router ─────────────────────────────────────

export async function handleHoldemButton(interaction: ButtonInteraction): Promise<void> {
  const t = tables.get(interaction.channelId!);
  if (!t) {
    await interaction.reply({ embeds: [errorEmbed("この卓はもう存在しないみたい。")], ephemeral: true });
    return;
  }
  const action = interaction.customId.split(":")[1];

  switch (action) {
    case "join": return showJoinModal(interaction, t);
    case "leave": return handleLeave(interaction, t);
    case "start": return handleStart(interaction, t);
    case "cancel": return handleCancel(interaction, t);
    case "hand": return showHand(interaction, t);
    case "check": return handleCheck(interaction, t);
    case "call": return handleCall(interaction, t);
    case "fold": return handleFold(interaction, t);
    case "bet": return showBetModal(interaction, t, false);
    case "raise": return showBetModal(interaction, t, true);
    case "allin": return handleAllIn(interaction, t);
    case "next": return handleNext(interaction, t);
    case "standup": return handleStandUp(interaction, t);
    case "end": return handleEnd(interaction, t);
  }
}

export async function handleHoldemModal(interaction: ModalSubmitInteraction): Promise<void> {
  const t = tables.get(interaction.channelId!);
  if (!t) {
    await interaction.reply({ embeds: [errorEmbed("この卓はもう存在しないみたい。")], ephemeral: true });
    return;
  }
  const which = interaction.customId.split(":")[1];
  if (which === "join_modal") return submitJoin(interaction, t);
  if (which === "bet_modal") return submitBet(interaction, t, false);
  if (which === "raise_modal") return submitBet(interaction, t, true);
}

// ─── Join / Leave / Start ──────────────────────────────

async function showJoinModal(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("ハンド中は途中参加できないよ。次のハンドが始まる前にどうぞ。")], ephemeral: true });
    return;
  }
  if (!checkVip(interaction.user.id, t.guildId)) {
    await interaction.reply({ embeds: [errorEmbed("奥座敷の卓だよ。`/vip` で月会員になれば座れる。")], ephemeral: true });
    return;
  }
  if (t.players.some((p) => p.userId === interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("もう座ってるよ。")], ephemeral: true });
    return;
  }
  if (t.players.length >= t.maxPlayers) {
    await interaction.reply({ embeds: [errorEmbed("満席だよ。")], ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId("hold:join_modal")
    .setTitle("バイイン額を入力")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel(`バイイン額（最低 ◈${t.minBuyIn.toLocaleString()}）`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(String(t.minBuyIn)),
      ),
    );
  await interaction.showModal(modal);
}

async function submitJoin(interaction: ModalSubmitInteraction, t: Table): Promise<void> {
  if (t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("ロビーじゃないみたい。")], ephemeral: true });
    return;
  }
  const amt = parseInt(interaction.fields.getTextInputValue("amount"), 10);
  if (!Number.isFinite(amt) || amt < t.minBuyIn) {
    await interaction.reply({ embeds: [errorEmbed(`最低 ◈${t.minBuyIn.toLocaleString()} 以上で入れてね。`)], ephemeral: true });
    return;
  }
  const profile = ensureUser(interaction.user.id, t.guildId);
  if (profile.balance < amt) {
    await interaction.reply({ embeds: [errorEmbed(`残高不足。現在 ◈${profile.balance.toLocaleString()}。`)], ephemeral: true });
    return;
  }
  const r = adjustBalance(interaction.user.id, -amt, "奥ポーカー: バイイン", "holdem", t.guildId);
  if (!r.ok) {
    await interaction.reply({ embeds: [errorEmbed("バイインの預け入れに失敗しました。")], ephemeral: true });
    return;
  }
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  t.players.push({
    userId: interaction.user.id,
    displayName: member?.displayName ?? interaction.user.username,
    stack: amt,
    hand: [-1, -1],
    betThisRound: 0,
    totalIn: 0,
    hasFolded: false,
    isAllIn: false,
    hasActed: false,
  });
  await interaction.reply({ embeds: [successEmbed(`◈${amt.toLocaleString()} で着席。`)], ephemeral: true });
  await refresh(interaction.client, t);
}

async function handleLeave(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("ハンド中は離席できないよ。ハンド終了後に。")], ephemeral: true });
    return;
  }
  const idx = t.players.findIndex((p) => p.userId === interaction.user.id);
  if (idx < 0) {
    await interaction.reply({ embeds: [errorEmbed("そもそも座ってないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[idx];
  adjustBalance(p.userId, p.stack, "奥ポーカー: 離席返金", "holdem", t.guildId);
  t.players.splice(idx, 1);
  if (t.dealerIdx >= t.players.length) t.dealerIdx = 0;
  await interaction.reply({ embeds: [successEmbed(`◈${p.stack.toLocaleString()} 持って退席。`)], ephemeral: true });
  await refresh(interaction.client, t);
}

async function handleCancel(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (interaction.user.id !== t.hostId) {
    await interaction.reply({ embeds: [errorEmbed("ホストだけが解散できるよ。")], ephemeral: true });
    return;
  }
  if (t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("ハンド中は解散できないよ。ハンド終了後に「お開き」で。")], ephemeral: true });
    return;
  }
  for (const p of t.players) {
    adjustBalance(p.userId, p.stack, "奥ポーカー: 解散返金", "holdem", t.guildId);
  }
  tables.delete(t.channelId);
  await interaction.update({ embeds: [baseEmbed("✦ 奥座敷ポーカー — 解散", COLORS.LOSE).setDescription("ホストにより卓は解散されたよ。バイインは全員に返金済み。")], components: [] });
}

async function handleStart(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (interaction.user.id !== t.hostId) {
    await interaction.reply({ embeds: [errorEmbed("ホストだけがハンドを開始できるよ。")], ephemeral: true });
    return;
  }
  if (t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("もう始まってるよ。")], ephemeral: true });
    return;
  }
  if (t.players.length < 2) {
    await interaction.reply({ embeds: [errorEmbed("2人以上必要だよ。")], ephemeral: true });
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  startHand(interaction.client, t);
}

// ─── Hand Flow ─────────────────────────────────────────

function startHand(client: Client, t: Table): void {
  t.handNumber += 1;
  t.deck = freshDeck();
  t.community = [];
  t.pot = 0;
  t.currentBet = 0;
  t.minRaise = t.bb;
  t.phase = "preflop";
  t.lastAggressorIdx = -1;
  for (const p of t.players) {
    p.hand = [t.deck.pop()!, t.deck.pop()!];
    p.betThisRound = 0;
    p.totalIn = 0;
    p.hasFolded = false;
    p.isAllIn = false;
    p.hasActed = false;
  }

  // Post blinds. SB = dealerIdx + 1 (heads-up: dealer = SB), BB = dealerIdx + 2
  const n = t.players.length;
  const sbIdx = n === 2 ? t.dealerIdx : (t.dealerIdx + 1) % n;
  const bbIdx = n === 2 ? (t.dealerIdx + 1) % n : (t.dealerIdx + 2) % n;
  postBlind(t.players[sbIdx], t.sb);
  postBlind(t.players[bbIdx], t.bb);
  t.currentBet = t.bb;
  t.lastAggressorIdx = bbIdx; // until raise, action ends when BB acts (preflop) or when full circle (postflop)

  // First to act preflop = UTG (BB + 1). Heads-up: SB acts first.
  t.actionIdx = n === 2 ? sbIdx : (bbIdx + 1) % n;

  void refresh(client, t);
  armActionTimer(client, t);
}

function postBlind(p: Player, amount: number): void {
  const pay = Math.min(p.stack, amount);
  p.stack -= pay;
  p.betThisRound += pay;
  p.totalIn += pay;
  if (p.stack === 0) p.isAllIn = true;
}

function armActionTimer(client: Client, t: Table): void {
  if (t.actionTimer) clearTimeout(t.actionTimer);
  t.actionTimer = setTimeout(() => {
    void autoFold(client, t);
  }, 60_000);
}

async function autoFold(client: Client, t: Table): Promise<void> {
  const p = t.players[t.actionIdx];
  if (!p || p.hasFolded || p.isAllIn) return;
  p.hasFolded = true;
  p.hasActed = true;
  await advanceAction(client, t, `<@${p.userId}> 時間切れで自動フォールド`);
}

async function advanceAction(client: Client, t: Table, note?: string): Promise<void> {
  if (t.actionTimer) { clearTimeout(t.actionTimer); t.actionTimer = null; }

  // Check end-of-hand: only 1 non-folded → award pot
  const live = t.players.filter((p) => !p.hasFolded);
  if (live.length === 1) {
    await endHandByFold(client, t, live[0]);
    return;
  }

  // Check round end: all live players have acted AND all bets matched (or are all-in)
  if (roundComplete(t)) {
    await nextStreet(client, t, note);
    return;
  }

  // Next actor
  const n = t.players.length;
  let i = t.actionIdx;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    const p = t.players[i];
    if (!p.hasFolded && !p.isAllIn) {
      t.actionIdx = i;
      break;
    }
  }

  await refresh(client, t);
  armActionTimer(client, t);
}

function roundComplete(t: Table): boolean {
  const active = t.players.filter((p) => !p.hasFolded && !p.isAllIn);
  if (active.length === 0) return true; // everyone remaining is all-in
  // All active players have matched currentBet AND all have acted at least once
  return active.every((p) => p.hasActed && p.betThisRound === t.currentBet);
}

async function nextStreet(client: Client, t: Table, _note?: string): Promise<void> {
  // Sweep bets into pot
  for (const p of t.players) {
    t.pot += p.betThisRound;
    p.betThisRound = 0;
    p.hasActed = false;
  }
  t.currentBet = 0;
  t.minRaise = t.bb;
  t.lastAggressorIdx = -1;

  if (t.phase === "preflop") {
    t.community.push(t.deck.pop()!, t.deck.pop()!, t.deck.pop()!);
    t.phase = "flop";
  } else if (t.phase === "flop") {
    t.community.push(t.deck.pop()!);
    t.phase = "turn";
  } else if (t.phase === "turn") {
    t.community.push(t.deck.pop()!);
    t.phase = "river";
  } else if (t.phase === "river") {
    await showdown(client, t);
    return;
  }

  // If everyone remaining is all-in (no one can act), skip remaining streets straight to showdown
  const canAct = t.players.filter((p) => !p.hasFolded && !p.isAllIn);
  if (canAct.length <= 1) {
    // Run out remaining community then showdown
    if (t.phase === "flop") { t.community.push(t.deck.pop()!); t.phase = "turn"; }
    if (t.phase === "turn") { t.community.push(t.deck.pop()!); t.phase = "river"; }
    await showdown(client, t);
    return;
  }

  // First to act postflop = first live player after dealer
  const n = t.players.length;
  let i = t.dealerIdx;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    const p = t.players[i];
    if (!p.hasFolded && !p.isAllIn) {
      t.actionIdx = i;
      break;
    }
  }
  await refresh(client, t);
  armActionTimer(client, t);
}

async function endHandByFold(client: Client, t: Table, winner: Player): Promise<void> {
  if (t.actionTimer) { clearTimeout(t.actionTimer); t.actionTimer = null; }
  // Sweep bets
  for (const p of t.players) { t.pot += p.betThisRound; p.betThisRound = 0; }
  winner.stack += t.pot;
  const won = t.pot;
  t.pot = 0;
  t.phase = "ended";
  const note = `🎴 <@${winner.userId}> が全員フォールドで ◈${won.toLocaleString()} 獲得`;
  await refresh(client, t, note);
  // Refresh dealer + remove busted players (auto-leave with 0 stack)
  cleanupBusted(t);
  t.dealerIdx = (t.dealerIdx + 1) % Math.max(1, t.players.length);
}

async function showdown(client: Client, t: Table): Promise<void> {
  if (t.actionTimer) { clearTimeout(t.actionTimer); t.actionTimer = null; }
  // Sweep bets
  for (const p of t.players) { t.pot += p.betThisRound; p.betThisRound = 0; }
  t.phase = "showdown";

  // Evaluate hands for non-folded players
  const live = t.players.filter((p) => !p.hasFolded);
  const evals = new Map<string, number[]>();
  for (const p of live) {
    evals.set(p.userId, evalBest([...p.hand, ...t.community]));
  }

  // Build sidepots
  const pots = buildPots(t.players);
  const awards = new Map<string, number>();

  const lines: string[] = [];
  for (let i = 0; i < pots.length; i++) {
    const pot = pots[i];
    const contenders = pot.eligibleIds.filter((id) => !t.players.find((p) => p.userId === id)?.hasFolded);
    if (contenders.length === 0) continue;
    // Best eval among contenders
    let bestEv: number[] | null = null;
    let winners: string[] = [];
    for (const id of contenders) {
      const ev = evals.get(id)!;
      const c = bestEv ? cmpEval(ev, bestEv) : 1;
      if (c > 0) { bestEv = ev; winners = [id]; }
      else if (c === 0) { winners.push(id); }
    }
    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;
    for (const id of winners) {
      awards.set(id, (awards.get(id) ?? 0) + share);
    }
    if (winners.length > 0 && remainder > 0) {
      awards.set(winners[0], (awards.get(winners[0]) ?? 0) + remainder);
    }
    const label = pots.length === 1 ? "ポット" : `${i === 0 ? "メイン" : `サイド${i}`}ポット`;
    lines.push(`**${label}** ◈${pot.amount.toLocaleString()} → ${winners.map((id) => `<@${id}>`).join(" / ")} (${handName(evals.get(winners[0])!)})`);
  }

  // Apply awards to stacks
  for (const [id, amt] of awards) {
    const p = t.players.find((pp) => pp.userId === id);
    if (p) p.stack += amt;
  }

  // Show all live hands
  const handLines = live.map((p) => `<@${p.userId}>: ${hand2str(p.hand)} — *${handName(evals.get(p.userId)!)}*`);
  const note = [
    "🃏 **ショウダウン**",
    `コミュニティ: ${hand2str(t.community)}`,
    "",
    ...handLines,
    "",
    ...lines,
  ].join("\n");

  t.pot = 0;
  t.phase = "ended";
  await refresh(client, t, note);
  cleanupBusted(t);
  t.dealerIdx = (t.dealerIdx + 1) % Math.max(1, t.players.length);
}

function cleanupBusted(t: Table): void {
  const busted = t.players.filter((p) => p.stack === 0);
  if (busted.length === 0) return;
  t.players = t.players.filter((p) => p.stack > 0);
  if (t.dealerIdx >= t.players.length) t.dealerIdx = 0;
}

// ─── Actions ───────────────────────────────────────────

function isMyTurn(t: Table, userId: string): boolean {
  if (!["preflop", "flop", "turn", "river"].includes(t.phase)) return false;
  const p = t.players[t.actionIdx];
  return !!p && p.userId === userId && !p.hasFolded && !p.isAllIn;
}

async function showHand(interaction: ButtonInteraction, t: Table): Promise<void> {
  const p = t.players.find((pp) => pp.userId === interaction.user.id);
  if (!p) {
    await interaction.reply({ embeds: [errorEmbed("この卓に座ってないよ。")], ephemeral: true });
    return;
  }
  if (p.hand[0] < 0) {
    await interaction.reply({ embeds: [errorEmbed("まだ配られてないよ。")], ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [baseEmbed("🃏 あなたの手札", COLORS.GOLD).setDescription(`**${hand2str(p.hand)}**\n\nコミュニティ: ${t.community.length === 0 ? "（まだ）" : hand2str(t.community)}\nスタック: ◈${p.stack.toLocaleString()}`)],
    ephemeral: true,
  });
}

async function handleCheck(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (!isMyTurn(t, interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("あなたの番じゃないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[t.actionIdx];
  if (p.betThisRound < t.currentBet) {
    await interaction.reply({ embeds: [errorEmbed("ベットに合わせる必要があるよ（コール/レイズ/フォールド）。")], ephemeral: true });
    return;
  }
  p.hasActed = true;
  await interaction.deferUpdate().catch(() => {});
  await advanceAction(interaction.client, t);
}

async function handleCall(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (!isMyTurn(t, interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("あなたの番じゃないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[t.actionIdx];
  const need = t.currentBet - p.betThisRound;
  if (need <= 0) {
    await interaction.reply({ embeds: [errorEmbed("コールするベットが無いよ。チェックして。")], ephemeral: true });
    return;
  }
  const pay = Math.min(p.stack, need);
  p.stack -= pay;
  p.betThisRound += pay;
  p.totalIn += pay;
  if (p.stack === 0) p.isAllIn = true;
  p.hasActed = true;
  await interaction.deferUpdate().catch(() => {});
  await advanceAction(interaction.client, t);
}

async function handleFold(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (!isMyTurn(t, interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("あなたの番じゃないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[t.actionIdx];
  p.hasFolded = true;
  p.hasActed = true;
  await interaction.deferUpdate().catch(() => {});
  await advanceAction(interaction.client, t);
}

async function showBetModal(interaction: ButtonInteraction, t: Table, isRaise: boolean): Promise<void> {
  if (!isMyTurn(t, interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("あなたの番じゃないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[t.actionIdx];
  if (isRaise && t.currentBet === 0) {
    await interaction.reply({ embeds: [errorEmbed("まだベットが無いから「ベット」を使ってね。")], ephemeral: true });
    return;
  }
  if (!isRaise && t.currentBet > p.betThisRound) {
    await interaction.reply({ embeds: [errorEmbed("既にベットが入ってるから「レイズ」を使ってね。")], ephemeral: true });
    return;
  }
  const minTotal = isRaise ? t.currentBet + t.minRaise : Math.max(t.bb, t.minRaise);
  const modal = new ModalBuilder()
    .setCustomId(isRaise ? "hold:raise_modal" : "hold:bet_modal")
    .setTitle(isRaise ? `レイズ（最低 ◈${minTotal}）` : `ベット（最低 ◈${minTotal}）`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel(isRaise ? "レイズ後の合計ベット額" : "ベット額").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(String(minTotal)),
      ),
    );
  await interaction.showModal(modal);
}

async function submitBet(interaction: ModalSubmitInteraction, t: Table, isRaise: boolean): Promise<void> {
  if (!isMyTurn(t, interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("あなたの番じゃないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[t.actionIdx];
  const target = parseInt(interaction.fields.getTextInputValue("amount"), 10);
  if (!Number.isFinite(target) || target <= 0) {
    await interaction.reply({ embeds: [errorEmbed("数字で入れてね。")], ephemeral: true });
    return;
  }
  const minTotal = isRaise ? t.currentBet + t.minRaise : Math.max(t.bb, t.minRaise);
  const maxTotal = p.betThisRound + p.stack;

  let total = target;
  // allow all-in shortfall: if player can't reach minTotal, they can only go all-in
  if (total > maxTotal) total = maxTotal;
  if (total < minTotal && total < maxTotal) {
    await interaction.reply({ embeds: [errorEmbed(`最低 ◈${minTotal.toLocaleString()} 以上で入れてね（オールインなら ◈${maxTotal.toLocaleString()}）。`)], ephemeral: true });
    return;
  }

  const pay = total - p.betThisRound;
  p.stack -= pay;
  p.betThisRound = total;
  p.totalIn += pay;
  if (p.stack === 0) p.isAllIn = true;

  const raiseAmount = total - t.currentBet;
  if (raiseAmount > 0) {
    t.minRaise = Math.max(t.minRaise, raiseAmount);
    t.currentBet = total;
    t.lastAggressorIdx = t.actionIdx;
    // Reset hasActed for everyone else (they need to respond)
    for (let i = 0; i < t.players.length; i++) {
      if (i !== t.actionIdx) t.players[i].hasActed = false;
    }
  }
  p.hasActed = true;
  await interaction.deferUpdate().catch(() => {});
  await advanceAction(interaction.client, t);
}

async function handleAllIn(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (!isMyTurn(t, interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("あなたの番じゃないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[t.actionIdx];
  if (p.stack === 0) {
    await interaction.reply({ embeds: [errorEmbed("もう全部入ってるよ。")], ephemeral: true });
    return;
  }
  const total = p.betThisRound + p.stack;
  const pay = p.stack;
  p.betThisRound = total;
  p.totalIn += pay;
  p.stack = 0;
  p.isAllIn = true;
  p.hasActed = true;
  const raiseAmount = total - t.currentBet;
  if (raiseAmount > 0) {
    if (raiseAmount >= t.minRaise) {
      // full raise → reopen action for others
      for (let i = 0; i < t.players.length; i++) {
        if (i !== t.actionIdx) t.players[i].hasActed = false;
      }
      t.minRaise = raiseAmount;
      t.lastAggressorIdx = t.actionIdx;
    }
    t.currentBet = total;
  }
  await interaction.deferUpdate().catch(() => {});
  await advanceAction(interaction.client, t);
}

// ─── End-of-hand actions ───────────────────────────────

async function handleNext(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (interaction.user.id !== t.hostId) {
    await interaction.reply({ embeds: [errorEmbed("ホストだけが次のハンドを開始できるよ。")], ephemeral: true });
    return;
  }
  if (t.phase !== "ended") {
    await interaction.reply({ embeds: [errorEmbed("まだハンド中だよ。")], ephemeral: true });
    return;
  }
  if (t.players.length < 2) {
    await interaction.reply({ embeds: [errorEmbed("2人以上いないと続けられないよ。")], ephemeral: true });
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  startHand(interaction.client, t);
}

async function handleStandUp(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (t.phase !== "ended" && t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("ハンドが終わってから離席してね。")], ephemeral: true });
    return;
  }
  const idx = t.players.findIndex((p) => p.userId === interaction.user.id);
  if (idx < 0) {
    await interaction.reply({ embeds: [errorEmbed("そもそも座ってないよ。")], ephemeral: true });
    return;
  }
  const p = t.players[idx];
  adjustBalance(p.userId, p.stack, "奥ポーカー: 離席返金", "holdem", t.guildId);
  t.players.splice(idx, 1);
  if (t.dealerIdx >= t.players.length) t.dealerIdx = 0;
  await interaction.reply({ embeds: [successEmbed(`◈${p.stack.toLocaleString()} 持って退席。`)], ephemeral: true });
  if (t.players.length === 0) {
    tables.delete(t.channelId);
  } else {
    await refresh(interaction.client, t);
  }
}

async function handleEnd(interaction: ButtonInteraction, t: Table): Promise<void> {
  if (interaction.user.id !== t.hostId) {
    await interaction.reply({ embeds: [errorEmbed("ホストだけがお開きにできるよ。")], ephemeral: true });
    return;
  }
  if (t.phase !== "ended" && t.phase !== "lobby") {
    await interaction.reply({ embeds: [errorEmbed("ハンドが終わってから。")], ephemeral: true });
    return;
  }
  for (const p of t.players) {
    if (p.stack > 0) {
      adjustBalance(p.userId, p.stack, "奥ポーカー: お開き返金", "holdem", t.guildId);
    }
  }
  tables.delete(t.channelId);
  await interaction.update({ embeds: [baseEmbed("✦ 奥座敷ポーカー — お開き", COLORS.GOLD).setDescription("卓を畳んだよ。残ったチップは全員のエテルに戻したから安心して。")], components: [] }).catch(() => {});
}

// ─── Startup Cleanup ───────────────────────────────────
// 起動時は in-memory なので卓は消えてる。プロセス中断で残ったバイインを救済する仕組みは別途必要だが
// 現状は holdem の取引履歴を見て、ログ上「バイイン」した分の差分があれば返金する簡易ロジックでも可。
// MVPでは省略（再起動前のテーブルは消える → 単純に balance への戻しが無いリスク）。
// ここでは tx_logs から救済する関数のスタブだけ提供。
export function refundStaleHoldemOnStartup(): void {
  // 取引ログから「奥ポーカー: バイイン」と「奥ポーカー: 離席返金/解散返金/お開き返金」を集計し、
  // 差し引き未返金のユーザーへ自動返金。
  type Row = { user_id: string; net: number };
  const rows = db.prepare(`
    SELECT user_id,
      SUM(CASE WHEN reason LIKE '奥ポーカー%' THEN amount ELSE 0 END) AS net
    FROM transaction_logs
    WHERE game = 'holdem'
    GROUP BY user_id
    HAVING net < 0
  `).all() as Row[];
  for (const r of rows) {
    const refund = -r.net;
    if (refund <= 0) continue;
    adjustBalance(r.user_id, refund, "奥ポーカー: 中断救済", "holdem");
    console.log(`[holdem] startup refund: ${r.user_id} ◈${refund.toLocaleString()}`);
  }
}
