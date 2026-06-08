/**
 * ハイロー対人（1v1・同時宣言型・3本勝負）
 * ─────────────────────────────────────────────────────────
 * 基準カード公開 → 両者が同時に Hi/Lo を秘密選択 → 次カード公開で判定。
 * 次カードが基準より strictly 大きい=Hi 正解 / 小さい=Lo 正解 / 同じ=両者ハズレ。
 *
 * 3本勝負（先に 2勝で確定）。各ラウンド両者同時アクション。
 * スコア同点で 3R 終了 → サドンデス 1R 追加（同点続いたらさらに追加）。
 *
 * 賭け金 stake は両者から徴収。勝者総取り 2×stake − 場代3% → JP。
 * 片方フォールド扱い（タイムアウト）は indian と同様。
 */
import {
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
import { memberName } from "../../core/names";

const RAKE_PCT = 0.03;
const PENDING_AUTO_DECLINE_MS = 5 * 60_000;
const ACTIVE_AUTO_VOID_MS = 6 * 60 * 60_000;
const TICK_INTERVAL_MS = 60_000;
const BEST_OF = 3;

type Call = "hi" | "lo";
type DuelRow = {
  id: number;
  guild_id: string;
  challenger_id: string;
  opponent_id: string;
  stake: number;
  status: "pending" | "active" | "settled" | "declined" | "void";
  best_of: number;
  round_no: number;
  base_card: number | null;
  challenger_call: Call | null;
  opponent_call: Call | null;
  challenger_score: number;
  opponent_score: number;
  history: string | null; // JSON
  winner_id: string | null;
  rake: number;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
};

type RoundLog = { base: number; next: number; cCall: Call | null; oCall: Call | null; cHit: boolean; oHit: boolean };

function getDuel(id: number): DuelRow | undefined {
  return db.prepare("SELECT * FROM highlow_duels WHERE id = ?").get(id) as DuelRow | undefined;
}

const RANK_NAMES = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function rankName(n: number): string { return RANK_NAMES[n] ?? "?"; }
function rand13(): number { return 1 + Math.floor(Math.random() * 13); }
function isParticipant(d: DuelRow, userId: string): boolean { return userId === d.challenger_id || userId === d.opponent_id; }
function parseHistory(d: DuelRow): RoundLog[] { try { return d.history ? JSON.parse(d.history) as RoundLog[] : []; } catch { return []; } }

// ─── 申込み（shoubu から呼ばれる） ─────────────────
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
    "INSERT INTO highlow_duels (guild_id, challenger_id, opponent_id, stake, best_of, channel_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(guildId, challengerId, opponent.id, stake, BEST_OF, interaction.channelId).lastInsertRowid);

  const embed = baseEmbed(`📈 ハイロー #${duelId}`, PALETTE.VERMILION).setDescription([
    `**${memberName(interaction)}** が <@${opponent.id}> にハイロー勝負を申し込んだ。`,
    `賭け金: **${formatEther(stake)}**（両者同額・勝者総取り）`,
    `*場代 ${Math.round(RAKE_PCT * 100)}% は ${WORLD.POOL_JACKPOT} へ。*`,
    "",
    `📈 ルール: ${BEST_OF}本勝負。基準カードを見て、次のカードが Hi(↑) か Lo(↓) かを両者同時に予想。`,
    "同じ数字が出たら両者ハズレ。先に 2勝した方が勝ち。",
    "",
    `<@${opponent.id}> — 受けるなら「受ける」を押してね。`,
  ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`hld:accept:${duelId}`).setLabel("受ける").setStyle(ButtonStyle.Success).setEmoji("📈"),
    new ButtonBuilder().setCustomId(`hld:decline:${duelId}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
  );
  const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`hld:linkvc:${duelId}`).setLabel("この勝負用の卓を立てる").setStyle(ButtonStyle.Secondary).setEmoji("📈"),
  );
  await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row, linkRow] });
  const msg = await interaction.fetchReply();
  db.prepare("UPDATE highlow_duels SET message_id = ? WHERE id = ?").run(msg.id, duelId);
}

// ─── ボタンルータ ───────────────────────────────────
export async function handleHighlowDuelButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const d = getDuel(Number(idStr));
  if (!d) { await interaction.reply({ content: "その勝負はもう無いみたい。", ephemeral: true }); return; }
  switch (action) {
    case "accept": return accept(interaction, d);
    case "decline": return decline(interaction, d);
    case "hi": return call(interaction, d, "hi");
    case "lo": return call(interaction, d, "lo");
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
  const existing = findLinkedVC("highlow_duel", String(d.id));
  if (existing) {
    await interaction.reply({
      embeds: [baseEmbed("📈 もう立ってるよ", PALETTE.JADE).setDescription(`卓は <#${existing.channel_id}> にあるよ。`)],
      ephemeral: true,
    });
    return;
  }
  await createLinkedTable(interaction, {
    linkType: "highlow_duel", linkId: String(d.id),
    userLimit: 2, allowedUserIds: [d.challenger_id, d.opponent_id],
    vcName: `📈 ハイローの卓 #${d.id}`,
  });
}

async function decline(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが操作できるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE highlow_duels SET status = 'declined' WHERE id = ?").run(d.id);
  await interaction.update({ content: "", embeds: [baseEmbed(`📈 ハイロー #${d.id} — 辞退`, PALETTE.NIGHT).setDescription("この勝負は見送られたよ。")], components: [] });
}

async function accept(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが受けられるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  const result = runTransaction<{ ok: boolean; reason?: string }>(() => {
    const cur = getDuel(d.id);
    if (!cur || cur.status !== "pending") return { ok: false, reason: "GONE" };
    const dc = adjustBalance(d.challenger_id, -d.stake, "ハイロー: エスクロー", "highlow_duel", d.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(d.opponent_id, -d.stake, "ハイロー: エスクロー", "highlow_duel", d.guild_id);
    if (!dop.ok) {
      adjustBalance(d.challenger_id, d.stake, "ハイロー: 受諾失敗の返金", "highlow_duel", d.guild_id);
      return { ok: false, reason: "OPPONENT_FUNDS" };
    }
    // 1R 目開始
    const base = rand13();
    db.prepare(
      "UPDATE highlow_duels SET status='active', round_no=1, base_card=?, challenger_call=NULL, opponent_call=NULL, history='[]' WHERE id=?",
    ).run(base, d.id);
    return { ok: true };
  });
  if (!result.ok) {
    const msg = result.reason === "OPPONENT_FUNDS" ? "きみの残高が足りないみたい。"
      : result.reason === "CHALLENGER_FUNDS" ? "申込者の残高が足りなくなってたよ。" : "もう受付が終わってたよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }
  await interaction.update(renderPanel(d.id, false));
}

async function call(interaction: ButtonInteraction, d: DuelRow, choice: Call): Promise<void> {
  if (d.status !== "active") { await interaction.reply({ content: "いまは行動できないよ。", ephemeral: true }); return; }
  if (!isParticipant(d, interaction.user.id)) { await interaction.reply({ content: "当事者だけが行動できるよ。", ephemeral: true }); return; }
  const userId = interaction.user.id;
  const isChallenger = userId === d.challenger_id;
  const alreadyActed = isChallenger ? d.challenger_call !== null : d.opponent_call !== null;
  if (alreadyActed) { await interaction.reply({ content: "もう宣言済みだよ。相手を待って。", ephemeral: true }); return; }

  // 宣言を原子的に記録
  const result = runTransaction<{ bothDone: boolean }>(() => {
    const cur = getDuel(d.id);
    if (!cur || cur.status !== "active") return { bothDone: false };
    if (isChallenger) {
      if (cur.challenger_call !== null) return { bothDone: false };
      db.prepare("UPDATE highlow_duels SET challenger_call = ? WHERE id = ?").run(choice, d.id);
    } else {
      if (cur.opponent_call !== null) return { bothDone: false };
      db.prepare("UPDATE highlow_duels SET opponent_call = ? WHERE id = ?").run(choice, d.id);
    }
    const fresh = getDuel(d.id)!;
    return { bothDone: fresh.challenger_call !== null && fresh.opponent_call !== null };
  });

  if (result.bothDone) {
    await interaction.update({ components: [] }).catch(() => {});
    await resolveRound(interaction.client, d.id);
  } else {
    // 自分だけ反映 → ephemeral で確認、パネルは「○○が宣言済み」と曖昧表示
    await interaction.reply({ content: `${choice === "hi" ? "↑ Hi" : "↓ Lo"} で宣言したよ。相手を待ってる。`, ephemeral: true });
    await refreshPanel(interaction.client, d.id);
  }
}

// ─── ラウンド解決 ────────────────────────────────────
async function resolveRound(client: Client, duelId: number): Promise<void> {
  const d = getDuel(duelId);
  if (!d || d.status !== "active" || d.base_card == null || !d.challenger_call || !d.opponent_call) return;

  const next = rand13();
  const isHigher = next > d.base_card;
  const isLower = next < d.base_card;
  const cHit = (d.challenger_call === "hi" && isHigher) || (d.challenger_call === "lo" && isLower);
  const oHit = (d.opponent_call === "hi" && isHigher) || (d.opponent_call === "lo" && isLower);

  let finished = false;
  let winnerId: string | null = null;
  let rake = 0;
  let payout = 0;
  let cTotal = 0, oTotal = 0;
  let lastNext = next;
  let history: RoundLog[] = [];

  runTransaction(() => {
    const cur = getDuel(duelId);
    if (!cur || cur.status !== "active") return;
    history = parseHistory(cur);
    history.push({ base: cur.base_card!, next, cCall: cur.challenger_call, oCall: cur.opponent_call, cHit, oHit });
    const newCScore = cur.challenger_score + (cHit ? 1 : 0);
    const newOScore = cur.opponent_score + (oHit ? 1 : 0);
    cTotal = newCScore; oTotal = newOScore;

    const majority = Math.floor(cur.best_of / 2) + 1;
    const completedRounds = cur.round_no;
    const remaining = cur.best_of - completedRounds;
    // 勝者確定条件: 既に過半数 or 残ラウンドで追い付けない / または best_of 終了で同点でなければ確定
    const cClinched = newCScore >= majority;
    const oClinched = newOScore >= majority;
    const cUncatchable = newCScore - newOScore > remaining;
    const oUncatchable = newOScore - newCScore > remaining;

    if (cClinched || cUncatchable) { winnerId = d.challenger_id; finished = true; }
    else if (oClinched || oUncatchable) { winnerId = d.opponent_id; finished = true; }
    else if (completedRounds >= cur.best_of) {
      // 本数終了で同点 → サドンデス 1R 追加（決着まで）
      if (newCScore !== newOScore) {
        winnerId = newCScore > newOScore ? d.challenger_id : d.opponent_id;
        finished = true;
      }
      // 同点なら finished = false、追加ラウンド
    }

    if (finished && winnerId) {
      rake = Math.floor(d.stake * RAKE_PCT);
      payout = d.stake * 2 - rake;
      adjustBalance(winnerId, payout, "ハイロー: 勝者総取り", "highlow_duel", d.guild_id);
      if (rake > 0) db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(rake, d.guild_id);
      db.prepare(
        "UPDATE highlow_duels SET status='settled', challenger_score=?, opponent_score=?, history=?, winner_id=?, rake=? WHERE id=?",
      ).run(newCScore, newOScore, JSON.stringify(history), winnerId, rake, duelId);
    } else {
      // 次ラウンドへ
      const newBase = rand13();
      lastNext = newBase;
      db.prepare(
        "UPDATE highlow_duels SET round_no=round_no+1, base_card=?, challenger_call=NULL, opponent_call=NULL, challenger_score=?, opponent_score=?, history=? WHERE id=?",
      ).run(newBase, newCScore, newOScore, JSON.stringify(history), duelId);
    }
  });

  // メッセージ更新
  const fresh = getDuel(duelId)!;
  if (finished) {
    const render = renderPanel(duelId, true);
    const tail = [
      `🎯 結果: <@${d.challenger_id}> **${cTotal}** — **${oTotal}** <@${d.opponent_id}>`,
      "",
      winnerId ? `🎉 <@${winnerId}> の勝ち！ ${formatEther(payout)} を総取り。` : "",
      winnerId && rake > 0 ? `*場代 ${formatEther(rake)} を ${WORLD.POOL_JACKPOT} に納めた。*` : "",
    ].filter(Boolean).join("\n");
    render.embeds[0].setDescription(((render.embeds[0].data as any).description ?? "") + "\n\n" + tail);
    const mentions = winnerId ? [winnerId] : [d.challenger_id, d.opponent_id];
    try {
      if (fresh.channel_id && fresh.message_id) {
        const ch = await client.channels.fetch(fresh.channel_id).catch(() => null);
        if (ch && "messages" in ch) {
          const msg = await (ch as any).messages.fetch(fresh.message_id).catch(() => null);
          if (msg) {
            await msg.edit({
              content: mentions.map((u) => `<@${u}>`).join(" "),
              embeds: render.embeds,
              components: [],
              allowedMentions: { users: mentions },
            }).catch(() => {});
          }
        }
      }
    } catch { /* ignore */ }

    // 紐付きVCがあれば 続行/やめる パネル
    try {
      const { postDecisionPanel } = require("../decisionPanel");
      await postDecisionPanel(client, d.guild_id, "highlow_duel", String(d.id), d.challenger_id, [d.challenger_id, d.opponent_id]);
    } catch (err) { console.warn("[highlow_duel] decisionPanel post failed:", err); }
  } else {
    // 次ラウンドのパネルを描画（前ラウンドの結果を上に出す）
    void refreshPanelWithLastRound(client, duelId, history[history.length - 1]);
    void lastNext; // unused warn 回避
  }
}

// ─── 描画 ───────────────────────────────────────────
function renderPanel(duelId: number, reveal: boolean): { embeds: ReturnType<typeof baseEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const d = getDuel(duelId)!;
  const cWaiting = d.challenger_call === null ? "…宣言待ち" : "✅ 宣言済み";
  const oWaiting = d.opponent_call === null ? "…宣言待ち" : "✅ 宣言済み";
  const history = parseHistory(d);
  const lines = [
    `**<@${d.challenger_id}> ${d.challenger_score}** — **${d.opponent_score} <@${d.opponent_id}>**`,
    `第 **${d.round_no}** / ${d.best_of} ラウンド（先に ${Math.floor(d.best_of / 2) + 1} 勝で確定）`,
    "",
    d.base_card != null ? `🎴 基準カード: **${rankName(d.base_card)}**` : "",
    reveal ? "" : `<@${d.challenger_id}>: ${cWaiting}\n<@${d.opponent_id}>: ${oWaiting}`,
    "",
    `賭け金: ${formatEther(d.stake)} ずつ（総取り ${formatEther(d.stake * 2)} − 場代 ${Math.round(RAKE_PCT * 100)}%）`,
  ].filter(Boolean).join("\n");

  const embed = baseEmbed(`📈 ハイロー #${d.id}`, reveal ? PALETTE.STARGOLD : PALETTE.VERMILION).setDescription(lines);
  if (history.length > 0) {
    const histLines = history.map((h, i) => {
      const cMark = h.cHit ? "○" : "×";
      const oMark = h.oHit ? "○" : "×";
      const cArrow = h.cCall === "hi" ? "↑" : h.cCall === "lo" ? "↓" : "—";
      const oArrow = h.oCall === "hi" ? "↑" : h.oCall === "lo" ? "↓" : "—";
      return `R${i + 1}: ${rankName(h.base)} → ${rankName(h.next)} ｜ <@${d.challenger_id}> ${cArrow}${cMark}  <@${d.opponent_id}> ${oArrow}${oMark}`;
    }).join("\n");
    embed.addFields({ name: "📜 これまでの結果", value: histLines });
  }
  if (reveal) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`hld:hi:${d.id}`).setLabel("↑ Hi（高い）").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hld:lo:${d.id}`).setLabel("↓ Lo（低い）").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

async function refreshPanel(client: Client, duelId: number): Promise<void> {
  const d = getDuel(duelId);
  if (!d) return;
  if (!d.channel_id || !d.message_id) return;
  try {
    const ch = await client.channels.fetch(d.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(d.message_id).catch(() => null);
    if (!msg) return;
    const r = renderPanel(duelId, false);
    await msg.edit({ embeds: r.embeds, components: r.components }).catch(() => {});
  } catch { /* ignore */ }
}

async function refreshPanelWithLastRound(client: Client, duelId: number, lastRound: RoundLog): Promise<void> {
  const d = getDuel(duelId);
  if (!d || !d.channel_id || !d.message_id) return;
  try {
    const ch = await client.channels.fetch(d.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(d.message_id).catch(() => null);
    if (!msg) return;
    const r = renderPanel(duelId, false);
    // 直前ラウンドの結果を強調
    const cArrow = lastRound.cCall === "hi" ? "↑" : "↓";
    const oArrow = lastRound.oCall === "hi" ? "↑" : "↓";
    const flash = `🃏 直前: **${rankName(lastRound.base)} → ${rankName(lastRound.next)}** ｜ <@${d.challenger_id}> ${cArrow}${lastRound.cHit ? "○" : "×"}  <@${d.opponent_id}> ${oArrow}${lastRound.oHit ? "○" : "×"}`;
    r.embeds[0].setDescription(flash + "\n\n" + ((r.embeds[0].data as any).description ?? ""));
    await msg.edit({ embeds: r.embeds, components: r.components }).catch(() => {});
  } catch { /* ignore */ }
}

// ─── 再戦立て ───────────────────────────────────────
export async function restartHighlowDuel(client: Client, oldDuelId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getDuel(oldDuelId);
  if (!old) return null;
  const inserted = runTransaction<{ ok: boolean; newId?: number }>(() => {
    const dc = adjustBalance(old.challenger_id, -old.stake, "ハイロー: 再戦エスクロー", "highlow_duel", old.guild_id);
    if (!dc.ok) return { ok: false };
    const dop = adjustBalance(old.opponent_id, -old.stake, "ハイロー: 再戦エスクロー", "highlow_duel", old.guild_id);
    if (!dop.ok) { adjustBalance(old.challenger_id, old.stake, "ハイロー: 再戦失敗・返金", "highlow_duel", old.guild_id); return { ok: false }; }
    const base = rand13();
    const res = db.prepare(
      `INSERT INTO highlow_duels (guild_id, challenger_id, opponent_id, stake, status, best_of, round_no, base_card, history, channel_id)
       VALUES (?, ?, ?, ?, 'active', ?, 1, ?, '[]', ?)`,
    ).run(old.guild_id, old.challenger_id, old.opponent_id, old.stake, old.best_of, base, vcId ?? old.channel_id);
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
        db.prepare("UPDATE highlow_duels SET message_id = ?, channel_id = ? WHERE id = ?").run(msg.id, target, inserted.newId);
      }
    } catch (err) { console.warn("[highlow_duel] restart announce failed:", err); }
  }
  return String(inserted.newId);
}

// ─── タイムアウト sweep ─────────────────────────────
async function sweepStaleHighlowDuel(client: Client): Promise<void> {
  const now = Date.now();
  const pending = db.prepare("SELECT * FROM highlow_duels WHERE status = 'pending'").all() as DuelRow[];
  for (const d of pending) {
    const ts = new Date(d.created_at + "Z").getTime();
    if (now - ts >= PENDING_AUTO_DECLINE_MS) {
      try {
        db.prepare("UPDATE highlow_duels SET status = 'void' WHERE id = ? AND status = 'pending'").run(d.id);
        await clearPanel(client, d, "📈 申込みが5分放置されたから流したよ。");
      } catch (err) { console.warn(`[highlow_duel sweep] pending decline failed for #${d.id}:`, err); }
    }
  }
  const active = db.prepare("SELECT * FROM highlow_duels WHERE status = 'active'").all() as DuelRow[];
  for (const d of active) {
    const ts = new Date(d.created_at + "Z").getTime();
    if (now - ts >= ACTIVE_AUTO_VOID_MS) {
      try {
        runTransaction(() => {
          const cur = getDuel(d.id);
          if (!cur || cur.status !== "active") return;
          adjustBalance(d.challenger_id, d.stake, "ハイロー: 長時間放置で自動返金", "highlow_duel", d.guild_id);
          adjustBalance(d.opponent_id, d.stake, "ハイロー: 長時間放置で自動返金", "highlow_duel", d.guild_id);
          db.prepare("UPDATE highlow_duels SET status = 'void' WHERE id = ?").run(d.id);
        });
        await clearPanel(client, d, "📈 長時間放置されたから両者に返金して無効にしたよ。");
      } catch (err) { console.warn(`[highlow_duel sweep] active void failed for #${d.id}:`, err); }
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
    await m.edit({ content: "", embeds: [baseEmbed(`📈 ハイロー #${d.id}`, PALETTE.NIGHT).setDescription(msg)], components: [] }).catch(() => {});
  } catch { /* ignore */ }
}

let tickHandle: NodeJS.Timeout | null = null;
export function bootHighlowDuelTimeouts(client: Client): void {
  if (tickHandle) clearInterval(tickHandle);
  void sweepStaleHighlowDuel(client).catch((err) => console.error("[highlow_duel] initial sweep failed:", err));
  tickHandle = setInterval(() => {
    void sweepStaleHighlowDuel(client).catch((err) => console.error("[highlow_duel] tick sweep failed:", err));
  }, TICK_INTERVAL_MS);
  console.log("[highlow_duel] timeout sweep started (1min interval)");
}

export function refundStaleHighlowDuelOnStartup(): void {
  const stale = db.prepare("SELECT * FROM highlow_duels WHERE status = 'active'").all() as DuelRow[];
  runTransaction(() => {
    for (const d of stale) {
      adjustBalance(d.challenger_id, d.stake, "ハイロー: 再起動による返金", "highlow_duel", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "ハイロー: 再起動による返金", "highlow_duel", d.guild_id);
      db.prepare("UPDATE highlow_duels SET status = 'void' WHERE id = ?").run(d.id);
    }
    db.prepare("UPDATE highlow_duels SET status = 'void' WHERE status = 'pending'").run();
  });
  if (stale.length > 0) console.log(`[bootstrap] refunded ${stale.length} stale highlow_duel(s)`);
}
