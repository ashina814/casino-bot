/**
 * BJ 対人戦（ヘッズアップ21競争）— BOT ディーラー無し、2人で21に近づける
 * ─────────────────────────────────────────────────────────
 * 申込み → 相手「受ける」→ 両者エスクロー → 各々2枚配る
 * → 申込者からターン制で hit/stand → 受け手が hit/stand
 * → 判定（両者バスト=引分 / 片方バスト=もう一方勝ち / 両者21以下=高い方）
 * → 同点プッシュ（賭金返却） / 勝者総取り(2×stake − 場代3% → JP)
 *
 * 互いの手は **全公開** — 心理戦は「相手の手を見て自分の決断」が肝
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
import { createDeck, handValue, handDisplay, type Card } from "../blackjack/index";

const RAKE_PCT = 0.03;                       // 場代 3% → JP
const PENDING_AUTO_DECLINE_MS = 60 * 60_000; // 1h で自動辞退
const ACTIVE_AUTO_VOID_MS = 6 * 60 * 60_000; // 6h でアクティブも void＋両者返金
const BJD_TICK_INTERVAL_MS = 60_000;

type DuelRow = {
  id: number;
  guild_id: string;
  challenger_id: string;
  opponent_id: string;
  stake: number;
  status: "pending" | "active" | "settled" | "declined" | "void";
  challenger_hand: string;
  opponent_hand: string;
  challenger_done: number;
  opponent_done: number;
  turn: "challenger" | "opponent";
  winner_id: string | null;
  rake: number;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
};

function getDuel(id: number): DuelRow | undefined {
  return db.prepare("SELECT * FROM bj_duels WHERE id = ?").get(id) as DuelRow | undefined;
}
function parseHand(s: string): Card[] {
  try { return JSON.parse(s) as Card[]; } catch { return []; }
}
function isParticipant(d: DuelRow, userId: string): boolean {
  return userId === d.challenger_id || userId === d.opponent_id;
}

// ─── Command ─────────────────────────────────────────
export const bjDuelCommand = new SlashCommandBuilder()
  .setName("BJ対戦")
  .setDescription("🃏 ブラックジャック対人戦 — 2人で21に近づけて勝負")
  .addSubcommand((sc) =>
    sc
      .setName("申込み")
      .setDescription("相手にブラックジャック対戦を申し込む")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額・勝者総取り）").setRequired(true).setMinValue(1)),
  );

export async function handleBjDuelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
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
    "INSERT INTO bj_duels (guild_id, challenger_id, opponent_id, stake, channel_id) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, challengerId, opponent.id, stake, interaction.channelId).lastInsertRowid);

  const embed = baseEmbed(`🃏 BJ対戦 #${duelId}`, PALETTE.VERMILION).setDescription([
    `**${interaction.user.displayName}** が <@${opponent.id}> にブラックジャック対戦を申し込んだ。`,
    `賭け金: **${formatEther(stake)}**（両者同額・勝者総取り）`,
    `*場代 ${Math.round(RAKE_PCT * 100)}% は ${WORLD.POOL_JACKPOT} へ。*`,
    "",
    "互いの手は **公開** だよ。相手の手を見て駆け引きしよう。",
    "",
    `<@${opponent.id}> — 受けるなら「受ける」を押してね。`,
  ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`bjd:accept:${duelId}`).setLabel("受ける").setStyle(ButtonStyle.Success).setEmoji("🃏"),
    new ButtonBuilder().setCustomId(`bjd:decline:${duelId}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row] });
  const msg = await interaction.fetchReply();
  db.prepare("UPDATE bj_duels SET message_id = ? WHERE id = ?").run(msg.id, duelId);
}

// ─── ボタン ─────────────────────────────────────────
export async function handleBjDuelButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const d = getDuel(Number(idStr));
  if (!d) { await interaction.reply({ content: "その勝負はもう無いみたい。", ephemeral: true }); return; }
  switch (action) {
    case "accept": return accept(interaction, d);
    case "decline": return decline(interaction, d);
    case "hit": return hit(interaction, d);
    case "stand": return stand(interaction, d);
  }
}

async function decline(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが操作できるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE bj_duels SET status = 'declined' WHERE id = ?").run(d.id);
  await interaction.update({ content: "", embeds: [baseEmbed(`🃏 BJ対戦 #${d.id} — 辞退`, PALETTE.NIGHT).setDescription("この勝負は見送られたよ。")], components: [] });
}

async function accept(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが受けられるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }

  // 両者エスクロー & 配る
  const result = runTransaction<{ ok: boolean; reason?: string; cHand?: Card[]; oHand?: Card[] }>(() => {
    const cur = getDuel(d.id);
    if (!cur || cur.status !== "pending") return { ok: false, reason: "GONE" };
    const dc = adjustBalance(d.challenger_id, -d.stake, "BJ対戦: エスクロー", "bjduel", d.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(d.opponent_id, -d.stake, "BJ対戦: エスクロー", "bjduel", d.guild_id);
    if (!dop.ok) return { ok: false, reason: "OPPONENT_FUNDS" };
    const deck = createDeck();
    const cHand: Card[] = [deck.pop()!, deck.pop()!];
    const oHand: Card[] = [deck.pop()!, deck.pop()!];
    db.prepare(
      "UPDATE bj_duels SET status = 'active', challenger_hand = ?, opponent_hand = ?, turn = 'challenger' WHERE id = ?",
    ).run(JSON.stringify(cHand), JSON.stringify(oHand), d.id);
    return { ok: true, cHand, oHand };
  });
  if (!result.ok) {
    const msg = result.reason === "OPPONENT_FUNDS" ? "きみの残高が足りないみたい。"
      : result.reason === "CHALLENGER_FUNDS" ? "申込者の残高が足りなくなってたよ。" : "もう受付が終わってたよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  await interaction.update(renderGame(d.id, false));

  // 自然 BJ チェック: どちらかが21なら即決着（両者BJなら引分）
  const cVal = handValue(result.cHand!);
  const oVal = handValue(result.oHand!);
  if (cVal === 21 || oVal === 21) {
    if (cVal === 21 && oVal === 21) await settleDuel(interaction.client, d.id, null, "両者がいきなり21（ナチュラルBJ）！プッシュ。");
    else if (cVal === 21) await settleDuel(interaction.client, d.id, d.challenger_id, `<@${d.challenger_id}> がナチュラル21！`);
    else await settleDuel(interaction.client, d.id, d.opponent_id, `<@${d.opponent_id}> がナチュラル21！`);
  }
}

// ─── ターン操作 ────────────────────────────────────
async function hit(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (d.status !== "active") { await interaction.reply({ content: "いまは行動できないよ。", ephemeral: true }); return; }
  const expected = d.turn === "challenger" ? d.challenger_id : d.opponent_id;
  if (interaction.user.id !== expected) { await interaction.reply({ content: "きみの番じゃないよ。", ephemeral: true }); return; }

  const hand = parseHand(d.turn === "challenger" ? d.challenger_hand : d.opponent_hand);
  // 山札を場で作り直す（他のカードは公開済みなので除外）
  const used = [...parseHand(d.challenger_hand), ...parseHand(d.opponent_hand)].map((c) => c.display);
  const deck = createDeck().filter((c) => !used.includes(c.display));
  const drawn = deck[Math.floor(Math.random() * deck.length)];
  hand.push(drawn);
  const value = handValue(hand);

  const handCol = d.turn === "challenger" ? "challenger_hand" : "opponent_hand";
  const doneCol = d.turn === "challenger" ? "challenger_done" : "opponent_done";
  db.prepare(`UPDATE bj_duels SET ${handCol} = ? WHERE id = ?`).run(JSON.stringify(hand), d.id);

  if (value > 21) {
    // バスト → 自分のターン終了、相手のターン
    db.prepare(`UPDATE bj_duels SET ${doneCol} = 1 WHERE id = ?`).run(d.id);
    await advanceTurnOrSettle(interaction, d.id);
  } else if (value === 21) {
    // 21 = 強制 stand
    db.prepare(`UPDATE bj_duels SET ${doneCol} = 1 WHERE id = ?`).run(d.id);
    await advanceTurnOrSettle(interaction, d.id);
  } else {
    await interaction.update(renderGame(d.id, false));
  }
}

async function stand(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (d.status !== "active") { await interaction.reply({ content: "いまは行動できないよ。", ephemeral: true }); return; }
  const expected = d.turn === "challenger" ? d.challenger_id : d.opponent_id;
  if (interaction.user.id !== expected) { await interaction.reply({ content: "きみの番じゃないよ。", ephemeral: true }); return; }

  const doneCol = d.turn === "challenger" ? "challenger_done" : "opponent_done";
  db.prepare(`UPDATE bj_duels SET ${doneCol} = 1 WHERE id = ?`).run(d.id);
  await advanceTurnOrSettle(interaction, d.id);
}

async function advanceTurnOrSettle(interaction: ButtonInteraction, duelId: number): Promise<void> {
  const d = getDuel(duelId);
  if (!d) return;
  // 両者完了 → 精算
  if (d.challenger_done === 1 && d.opponent_done === 1) {
    const cVal = handValue(parseHand(d.challenger_hand));
    const oVal = handValue(parseHand(d.opponent_hand));
    const cBust = cVal > 21, oBust = oVal > 21;
    let winnerId: string | null = null;
    let note = "";
    if (cBust && oBust) { winnerId = null; note = "両者バスト。引き分けで両者返金。"; }
    else if (cBust) { winnerId = d.opponent_id; note = `<@${d.challenger_id}> がバスト（${cVal}）。`; }
    else if (oBust) { winnerId = d.challenger_id; note = `<@${d.opponent_id}> がバスト（${oVal}）。`; }
    else if (cVal === oVal) { winnerId = null; note = `両者 ${cVal} で引き分け、プッシュ。`; }
    else if (cVal > oVal) { winnerId = d.challenger_id; note = `${cVal} vs ${oVal}。`; }
    else { winnerId = d.opponent_id; note = `${cVal} vs ${oVal}。`; }
    await interaction.update({ components: [] }).catch(() => {});
    await settleDuel(interaction.client, duelId, winnerId, note);
    return;
  }
  // ターン交代
  const nextTurn = d.turn === "challenger" ? "opponent" : "challenger";
  db.prepare("UPDATE bj_duels SET turn = ? WHERE id = ?").run(nextTurn, duelId);
  await interaction.update(renderGame(duelId, false));
}

// ─── 描画 ──────────────────────────────────────────
function renderGame(duelId: number, finalReveal: boolean): { embeds: ReturnType<typeof baseEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const d = getDuel(duelId)!;
  const cHand = parseHand(d.challenger_hand);
  const oHand = parseHand(d.opponent_hand);
  const cVal = handValue(cHand);
  const oVal = handValue(oHand);
  const cMark = d.challenger_done === 1 ? "✋ 確定" : (d.turn === "challenger" ? "▶ ターン" : "…待機");
  const oMark = d.opponent_done === 1 ? "✋ 確定" : (d.turn === "opponent" ? "▶ ターン" : "…待機");

  const embed = baseEmbed(`🃏 BJ対戦 #${d.id}`, finalReveal ? PALETTE.STARGOLD : PALETTE.VERMILION).setDescription([
    `┌─ <@${d.challenger_id}> （${cMark}） ─┐`,
    `│ ${handDisplay(cHand)} = **${cVal}**`,
    `┌─ <@${d.opponent_id}> （${oMark}） ─┐`,
    `│ ${handDisplay(oHand)} = **${oVal}**`,
    "",
    finalReveal ? "" : `▶ いま **<@${d.turn === "challenger" ? d.challenger_id : d.opponent_id}>** の番。引くか止めるか選んで。`,
    `*賭け金: ${formatEther(d.stake)} ずつ（総取り ${formatEther(d.stake * 2)} − 場代 ${Math.round(RAKE_PCT * 100)}%）*`,
  ].filter(Boolean).join("\n"));

  if (finalReveal) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`bjd:hit:${d.id}`).setLabel("✦ 引く").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`bjd:stand:${d.id}`).setLabel("✋ 止める").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

// ─── 精算 ──────────────────────────────────────────
async function settleDuel(client: Client, duelId: number, winnerId: string | null, note: string): Promise<void> {
  const d = getDuel(duelId);
  if (!d || d.status !== "active") return;
  let rake = 0;
  let payout = 0;
  runTransaction(() => {
    const cur = getDuel(duelId);
    if (!cur || cur.status !== "active") return;
    if (!winnerId) {
      // 引き分け / 両者バスト → 全額返金
      adjustBalance(d.challenger_id, d.stake, "BJ対戦: 引分返金", "bjduel", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "BJ対戦: 引分返金", "bjduel", d.guild_id);
      db.prepare("UPDATE bj_duels SET status = 'settled', challenger_done = 1, opponent_done = 1 WHERE id = ?").run(duelId);
      return;
    }
    rake = Math.floor(d.stake * RAKE_PCT);
    payout = d.stake * 2 - rake;
    adjustBalance(winnerId, payout, "BJ対戦: 勝者総取り", "bjduel", d.guild_id);
    if (rake > 0) db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(rake, d.guild_id);
    db.prepare("UPDATE bj_duels SET status = 'settled', winner_id = ?, rake = ?, challenger_done = 1, opponent_done = 1 WHERE id = ?")
      .run(winnerId, rake, duelId);
  });

  const render = renderGame(duelId, true);
  const resultLines = [
    note,
    "",
    winnerId
      ? `🎉 <@${winnerId}> の勝ち！ ${formatEther(payout)} を総取り。`
      : `🤝 賭け金 ${formatEther(d.stake)} を両者に返したよ。`,
    winnerId && rake > 0 ? `*場代 ${formatEther(rake)} を ${WORLD.POOL_JACKPOT} に納めた。*` : "",
  ].filter(Boolean).join("\n");
  render.embeds[0].setDescription(((render.embeds[0].data as any).description ?? "") + "\n\n" + resultLines);

  try {
    if (d.channel_id && d.message_id) {
      const ch = await client.channels.fetch(d.channel_id).catch(() => null);
      if (ch && "messages" in ch) {
        const msg = await (ch as any).messages.fetch(d.message_id).catch(() => null);
        if (msg) await msg.edit({ content: "", embeds: render.embeds, components: [] }).catch(() => {});
      }
    }
  } catch { /* ignore */ }

  // 紐付きVCがあれば 続行/やめる パネルを投下
  try {
    const { postDecisionPanel } = require("../decisionPanel");
    await postDecisionPanel(client, d.guild_id, "bjduel", String(d.id), d.challenger_id, [d.challenger_id, d.opponent_id]);
  } catch (err) { console.warn("[bjduel] decisionPanel post failed:", err); }
}

// ─── 再戦立て（decisionPanel から呼ばれる） ──────────
export async function restartBjDuel(client: Client, oldDuelId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getDuel(oldDuelId);
  if (!old) return null;
  const inserted = runTransaction<{ ok: boolean; newId?: number }>(() => {
    const dc = adjustBalance(old.challenger_id, -old.stake, "BJ対戦: 再戦エスクロー", "bjduel", old.guild_id);
    if (!dc.ok) return { ok: false };
    const dop = adjustBalance(old.opponent_id, -old.stake, "BJ対戦: 再戦エスクロー", "bjduel", old.guild_id);
    if (!dop.ok) {
      adjustBalance(old.challenger_id, old.stake, "BJ対戦: 再戦失敗・返金", "bjduel", old.guild_id);
      return { ok: false };
    }
    const deck = createDeck();
    const cHand: Card[] = [deck.pop()!, deck.pop()!];
    const oHand: Card[] = [deck.pop()!, deck.pop()!];
    const res = db.prepare(
      `INSERT INTO bj_duels (guild_id, challenger_id, opponent_id, stake, status, challenger_hand, opponent_hand, turn, channel_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 'challenger', ?)`,
    ).run(old.guild_id, old.challenger_id, old.opponent_id, old.stake, JSON.stringify(cHand), JSON.stringify(oHand), vcId ?? old.channel_id);
    return { ok: true, newId: Number(res.lastInsertRowid) };
  });
  if (!inserted.ok || !inserted.newId) return null;

  // VC（または元 channel）に新ハンドのパネル投下
  const target = vcId ?? old.channel_id;
  if (target) {
    try {
      const ch = await client.channels.fetch(target).catch(() => null);
      if (ch && "send" in ch) {
        const render = renderGame(inserted.newId, false);
        const msg = await (ch as any).send({ embeds: render.embeds, components: render.components });
        db.prepare("UPDATE bj_duels SET message_id = ?, channel_id = ? WHERE id = ?").run(msg.id, target, inserted.newId);
      }
    } catch (err) { console.warn("[bjduel] restart announce failed:", err); }
  }
  return String(inserted.newId);
}

// ─── タイムアウト sweep ─────────────────────────────
async function sweepStaleBjDuels(client: Client): Promise<void> {
  const now = Date.now();
  // pending 1h で自動辞退（未徴収）
  const pending = db.prepare("SELECT * FROM bj_duels WHERE status = 'pending'").all() as DuelRow[];
  for (const d of pending) {
    const createdTs = new Date(d.created_at + "Z").getTime();
    if (now - createdTs >= PENDING_AUTO_DECLINE_MS) {
      try {
        db.prepare("UPDATE bj_duels SET status = 'void' WHERE id = ? AND status = 'pending'").run(d.id);
        await clearPanel(client, d, "🃏 申込みが1時間放置されたから流したよ。");
      } catch (err) { console.warn(`[bjduel sweep] pending decline failed for #${d.id}:`, err); }
    }
  }
  // active 6h で両者返金 void
  const active = db.prepare("SELECT * FROM bj_duels WHERE status = 'active'").all() as DuelRow[];
  for (const d of active) {
    const createdTs = new Date(d.created_at + "Z").getTime();
    if (now - createdTs >= ACTIVE_AUTO_VOID_MS) {
      try {
        runTransaction(() => {
          const cur = getDuel(d.id);
          if (!cur || cur.status !== "active") return;
          adjustBalance(d.challenger_id, d.stake, "BJ対戦: 長時間放置で自動返金", "bjduel", d.guild_id);
          adjustBalance(d.opponent_id, d.stake, "BJ対戦: 長時間放置で自動返金", "bjduel", d.guild_id);
          db.prepare("UPDATE bj_duels SET status = 'void' WHERE id = ?").run(d.id);
        });
        await clearPanel(client, d, "🃏 長時間放置されたから両者に返金して無効にしたよ。");
      } catch (err) { console.warn(`[bjduel sweep] active void failed for #${d.id}:`, err); }
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
    await m.edit({ content: "", embeds: [baseEmbed(`🃏 BJ対戦 #${d.id}`, PALETTE.NIGHT).setDescription(msg)], components: [] }).catch(() => {});
  } catch { /* ignore */ }
}

let bjdTickHandle: NodeJS.Timeout | null = null;
export function bootBjDuelTimeouts(client: Client): void {
  if (bjdTickHandle) clearInterval(bjdTickHandle);
  void sweepStaleBjDuels(client).catch((err) => console.error("[bjduel] initial sweep failed:", err));
  bjdTickHandle = setInterval(() => {
    void sweepStaleBjDuels(client).catch((err) => console.error("[bjduel] tick sweep failed:", err));
  }, BJD_TICK_INTERVAL_MS);
  console.log("[bjduel] timeout sweep started (1min interval)");
}

// ─── 起動時返金（active を void）─────────────────────
export function refundStaleBjDuelsOnStartup(): void {
  const stale = db.prepare("SELECT * FROM bj_duels WHERE status = 'active'").all() as DuelRow[];
  runTransaction(() => {
    for (const d of stale) {
      adjustBalance(d.challenger_id, d.stake, "BJ対戦: 再起動による返金", "bjduel", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "BJ対戦: 再起動による返金", "bjduel", d.guild_id);
      db.prepare("UPDATE bj_duels SET status = 'void' WHERE id = ?").run(d.id);
    }
    db.prepare("UPDATE bj_duels SET status = 'void' WHERE status = 'pending'").run();
  });
  if (stale.length > 0) console.log(`[bootstrap] refunded ${stale.length} stale BJ duel(s)`);
}
