/**
 * 賽勝負（さいしょうぶ）— 1v1 チンチロ対戦（BOT自動判定 PvP）
 * ─────────────────────────────────────────────────────────
 * 申込 → 相手が「受ける」→ 両者エスクロー → BOTが両者の賽を振って自動判定
 *   → 勝者総取り（2×額 − 場代3%）。同役は振り直し、決まらなければ全額返金。
 *   役の強さはソロチンチロと同一（ピンゾロ>ゾロ目>シゴロ>目>メナシ>ヒフミ）。
 *   両者とも同じ自動戦略で振る（運だめし型）。倍率は付けず勝敗判定のみに使う。
 *
 * 安全設計: 再起動時 refundStaleDuelsOnStartup() で active を全額返金 void、
 *   pending（未徴収）は void のみ。
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
import { autoRollHand, handRank, describeHand, diceDisplay, type Hand } from "../chinchiro/index";

const RAKE_PCT = 0.03;     // 場代 3%（勝者が得る相手分から）→ 星溜まり(JP)
const MAX_TIE_ROUNDS = 5;  // 同役での振り直し上限
const PENDING_AUTO_DECLINE_MS = 60 * 60_000; // 申込み放置 1時間で自動辞退
const SAI_TICK_INTERVAL_MS = 60_000;         // 1分ごとに点検

type DuelRow = {
  id: number;
  guild_id: string;
  challenger_id: string;
  opponent_id: string;
  stake: number;
  status: "pending" | "active" | "settled" | "declined" | "void";
  winner_id: string | null;
  rake: number;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
};

function getDuel(id: number): DuelRow | undefined {
  return db.prepare("SELECT * FROM dice_duels WHERE id = ?").get(id) as DuelRow | undefined;
}

// ─── Command ──────────────────────────────────────────
export const saiCommand = new SlashCommandBuilder()
  .setName("チンチロ対戦")
  .setDescription("🎲 1対1のチンチロ対戦 — BOTが両者のサイコロを振って即決着")
  .addSubcommand((sc) =>
    sc
      .setName("申込み")
      .setDescription("相手にチンチロ対戦を申し込む")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額・勝者総取り）").setRequired(true).setMinValue(1)),
  );

export async function handleSaiCommand(interaction: ChatInputCommandInteraction): Promise<void> {
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
  { const cap = effectiveBetCap(tier.betCap, challengerId, guildId); if (stake > cap) { await interaction.reply({ embeds: [errorEmbed(`上限 ${formatEther(cap)}${cap > tier.betCap ? "（💎VIP×2）" : ""} までだよ。`)], ephemeral: true }); return; } }
  if (getBalance(challengerId, guildId) < stake) { await interaction.reply({ embeds: [errorEmbed("自分の残高が足りないみたい。")], ephemeral: true }); return; }

  const duelId = Number(db.prepare(
    "INSERT INTO dice_duels (guild_id, challenger_id, opponent_id, stake, channel_id) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, challengerId, opponent.id, stake, interaction.channelId).lastInsertRowid);

  const embed = baseEmbed(`🎲 チンチロ対戦 #${duelId}`, PALETTE.STARGOLD).setDescription([
    `**${interaction.user.displayName}** が <@${opponent.id}> にチンチロ対戦を申し込んだ。`,
    `賭け金: **${formatEther(stake)}**（両者同額・勝者総取り）`,
    `*場代 ${Math.round(RAKE_PCT * 100)}% は ${WORLD.POOL_JACKPOT} へ。*`,
    "",
    `<@${opponent.id}> — 受けるなら「受ける」を押してね。`,
  ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sai:accept:${duelId}`).setLabel("受ける").setStyle(ButtonStyle.Success).setEmoji("🎲"),
    new ButtonBuilder().setCustomId(`sai:decline:${duelId}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row] });
  const msg = await interaction.fetchReply();
  db.prepare("UPDATE dice_duels SET message_id = ? WHERE id = ?").run(msg.id, duelId);
}

// ─── ボタン ───────────────────────────────────────────
export async function handleSaiButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const d = getDuel(Number(idStr));
  if (!d) { await interaction.reply({ content: "その勝負はもう無いみたい。", ephemeral: true }); return; }
  if (action === "accept") return accept(interaction, d);
  if (action === "decline") return decline(interaction, d);
}

async function decline(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが操作できるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }
  db.prepare("UPDATE dice_duels SET status = 'declined' WHERE id = ?").run(d.id);
  await interaction.update({ content: "", embeds: [baseEmbed(`🎲 チンチロ対戦 #${d.id} — 辞退`, PALETTE.NIGHT).setDescription("この勝負は見送られたよ。")], components: [] });
}

async function accept(interaction: ButtonInteraction, d: DuelRow): Promise<void> {
  if (interaction.user.id !== d.opponent_id) { await interaction.reply({ content: "申し込まれた本人だけが受けられるよ。", ephemeral: true }); return; }
  if (d.status !== "pending") { await interaction.reply({ content: "もう受付は終わってるよ。", ephemeral: true }); return; }

  // 両者エスクロー
  const escrow = runTransaction<{ ok: boolean; reason?: string }>(() => {
    const cur = getDuel(d.id);
    if (!cur || cur.status !== "pending") return { ok: false, reason: "GONE" };
    const dc = adjustBalance(d.challenger_id, -d.stake, "賽勝負: エスクロー", "saishoubu", d.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(d.opponent_id, -d.stake, "賽勝負: エスクロー", "saishoubu", d.guild_id);
    if (!dop.ok) return { ok: false, reason: "OPPONENT_FUNDS" };
    db.prepare("UPDATE dice_duels SET status = 'active' WHERE id = ?").run(d.id);
    return { ok: true };
  });
  if (!escrow.ok) {
    const msg = escrow.reason === "OPPONENT_FUNDS" ? "きみの残高が足りないみたい。"
      : escrow.reason === "CHALLENGER_FUNDS" ? "申込者の残高が足りなくなってたよ。" : "もう受付が終わってたよ。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  // ── 両者を同一戦略で振る。同役なら振り直し ──
  let cHand: Hand = { type: "menashi" }, cDice: [number, number, number] = [1, 1, 1];
  let oHand: Hand = { type: "menashi" }, oDice: [number, number, number] = [1, 1, 1];
  let round = 0;
  let winnerId: string | null = null;
  while (round < MAX_TIE_ROUNDS) {
    round += 1;
    const c = autoRollHand(); cHand = c.hand; cDice = c.dice;
    const o = autoRollHand(); oHand = o.hand; oDice = o.dice;
    const cr = handRank(cHand), or = handRank(oHand);
    if (cr > or) { winnerId = d.challenger_id; break; }
    if (or > cr) { winnerId = d.opponent_id; break; }
    // 同役 → 振り直し
  }

  await settle(interaction.client, d.id, winnerId, { cHand, cDice, oHand, oDice, round });
  await interaction.editReply({ components: [] }).catch(() => {});
}

// ─── 精算 ─────────────────────────────────────────────
async function settle(
  client: Client,
  duelId: number,
  winnerId: string | null,
  reveal: { cHand: Hand; cDice: [number, number, number]; oHand: Hand; oDice: [number, number, number]; round: number },
): Promise<void> {
  const d = getDuel(duelId);
  if (!d || d.status !== "active") return;

  let rake = 0;
  let payout = 0;
  runTransaction(() => {
    const cur = getDuel(duelId);
    if (!cur || cur.status !== "active") return;
    if (!winnerId) {
      // 決着つかず → 全額返金
      adjustBalance(d.challenger_id, d.stake, "賽勝負: 引分返金", "saishoubu", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "賽勝負: 引分返金", "saishoubu", d.guild_id);
      db.prepare("UPDATE dice_duels SET status = 'void' WHERE id = ?").run(duelId);
      return;
    }
    // 勝者総取り（2×stake）− 場代（負け側 stake の 3%）
    rake = Math.floor(d.stake * RAKE_PCT);
    payout = d.stake * 2 - rake;
    adjustBalance(winnerId, payout, "賽勝負: 勝者総取り", "saishoubu", d.guild_id);
    if (rake > 0) db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(rake, d.guild_id);
    db.prepare("UPDATE dice_duels SET status = 'settled', winner_id = ?, rake = ? WHERE id = ?").run(winnerId, rake, duelId);
  });

  const { cHand, cDice, oHand, oDice, round } = reveal;
  const lines = [
    `┌─ <@${d.challenger_id}> ─┐`,
    `│ ${diceDisplay(cDice)}　${describeHand(cHand)}`,
    `┌─ <@${d.opponent_id}> ─┐`,
    `│ ${diceDisplay(oDice)}　${describeHand(oHand)}`,
    round > 1 ? `\n*（同役が続いて ${round} 回振り直した）*` : "",
    "",
    winnerId
      ? `🎉 <@${winnerId}> の勝ち！ ${formatEther(payout)} を総取り。`
      : `🤝 決着つかず。賭け金 ${formatEther(d.stake)} を両者に返したよ。`,
    winnerId && rake > 0 ? `*場代 ${formatEther(rake)} を ${WORLD.POOL_JACKPOT} に納めた。*` : "",
  ].filter(Boolean).join("\n");

  const embed = baseEmbed(`🎲 チンチロ対戦 #${d.id} — 決着`, winnerId ? PALETTE.JADE : PALETTE.NIGHT).setDescription(lines);
  await announce(client, d, { embeds: [embed] });

  // 紐付きVCがあれば 続行/やめる パネルを投下
  try {
    const { postDecisionPanel } = require("../decisionPanel");
    await postDecisionPanel(client, d.guild_id, "saishoubu", String(d.id), d.challenger_id, [d.challenger_id, d.opponent_id]);
  } catch (err) {
    console.warn("[saishoubu] decisionPanel post failed:", err);
  }
}

// ─── 再戦立て（decisionPanel から呼ばれる） ───────────
/**
 * 続行成立時に同条件で新しいチンチロ対戦を回す。
 * 両者は decisionPanel で合意済みなので accept ボタン省略、
 * いきなりエスクロー → 自動振り → 精算まで一気に通す。
 */
export async function restartDuel(client: Client, oldDuelId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getDuel(oldDuelId);
  if (!old) return null;

  const inserted = runTransaction<{ ok: boolean; newId?: number; reason?: string }>(() => {
    const dc = adjustBalance(old.challenger_id, -old.stake, "賽勝負: 再戦エスクロー", "saishoubu", old.guild_id);
    if (!dc.ok) return { ok: false, reason: "CHALLENGER_FUNDS" };
    const dop = adjustBalance(old.opponent_id, -old.stake, "賽勝負: 再戦エスクロー", "saishoubu", old.guild_id);
    if (!dop.ok) {
      adjustBalance(old.challenger_id, old.stake, "賽勝負: 再戦失敗・返金", "saishoubu", old.guild_id);
      return { ok: false, reason: "OPPONENT_FUNDS" };
    }
    const res = db.prepare(
      "INSERT INTO dice_duels (guild_id, challenger_id, opponent_id, stake, channel_id, status) VALUES (?, ?, ?, ?, ?, 'active')",
    ).run(old.guild_id, old.challenger_id, old.opponent_id, old.stake, vcId ?? old.channel_id);
    return { ok: true, newId: Number(res.lastInsertRowid) };
  });
  if (!inserted.ok || !inserted.newId) return null;
  const newId = inserted.newId;

  // 自動振り（accept と同じロジック）
  let cHand: Hand = { type: "menashi" }, cDice: [number, number, number] = [1, 1, 1];
  let oHand: Hand = { type: "menashi" }, oDice: [number, number, number] = [1, 1, 1];
  let round = 0;
  let winnerId: string | null = null;
  while (round < MAX_TIE_ROUNDS) {
    round += 1;
    const c = autoRollHand(); cHand = c.hand; cDice = c.dice;
    const o = autoRollHand(); oHand = o.hand; oDice = o.dice;
    const cr = handRank(cHand), or = handRank(oHand);
    if (cr > or) { winnerId = old.challenger_id; break; }
    if (or > cr) { winnerId = old.opponent_id; break; }
  }

  // 新規 duel の channel_id を VC に差し替えてから精算
  db.prepare("UPDATE dice_duels SET channel_id = ? WHERE id = ?").run(vcId ?? old.channel_id, newId);
  await settle(client, newId, winnerId, { cHand, cDice, oHand, oDice, round });

  return String(newId);
}

async function announce(client: Client, d: DuelRow, payload: any): Promise<void> {
  if (!d.channel_id) return;
  try {
    const ch = await client.channels.fetch(d.channel_id);
    if (ch && ch.isTextBased()) await (ch as any).send(payload);
  } catch { /* ignore */ }
}

// ─── pending 自動辞退 ──────────────────────────────
async function clearDuelPanel(client: Client, d: DuelRow, replaceContent: string): Promise<void> {
  if (!d.channel_id || !d.message_id) return;
  try {
    const ch = await client.channels.fetch(d.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(d.message_id).catch(() => null);
    if (!msg) return;
    await msg.edit({
      content: "",
      embeds: [baseEmbed(`🎲 チンチロ対戦 #${d.id}`, PALETTE.NIGHT).setDescription(replaceContent)],
      components: [],
    }).catch(() => {});
  } catch { /* ignore */ }
}

async function sweepStalePendingDuels(client: Client): Promise<void> {
  const now = Date.now();
  const pending = db.prepare("SELECT * FROM dice_duels WHERE status = 'pending'").all() as DuelRow[];
  for (const d of pending) {
    const createdTs = new Date(d.created_at + "Z").getTime();
    if (now - createdTs >= PENDING_AUTO_DECLINE_MS) {
      try {
        db.prepare("UPDATE dice_duels SET status = 'void' WHERE id = ? AND status = 'pending'").run(d.id);
        await clearDuelPanel(client, d, "🎲 申込みが1時間放置されたから流したよ。また気が向いたら声かけて。");
      } catch (err) {
        console.warn(`[saishoubu sweep] pending auto-decline failed for #${d.id}:`, err);
      }
    }
  }
}

let saiTickHandle: NodeJS.Timeout | null = null;
/** 起動時に呼ぶ。1分ごとに pending を点検して放置申込みを自動辞退化する。 */
export function bootSaiTimeouts(client: Client): void {
  if (saiTickHandle) clearInterval(saiTickHandle);
  void sweepStalePendingDuels(client).catch((err) => console.error("[saishoubu] initial sweep failed:", err));
  saiTickHandle = setInterval(() => {
    void sweepStalePendingDuels(client).catch((err) => console.error("[saishoubu] tick sweep failed:", err));
  }, SAI_TICK_INTERVAL_MS);
  console.log("[saishoubu] pending sweep started (1min interval)");
}

// ─── 起動時返金 ───────────────────────────────────────
export function refundStaleDuelsOnStartup(): void {
  const stale = db.prepare("SELECT * FROM dice_duels WHERE status = 'active'").all() as DuelRow[];
  runTransaction(() => {
    for (const d of stale) {
      adjustBalance(d.challenger_id, d.stake, "賽勝負: 再起動による返金", "saishoubu", d.guild_id);
      adjustBalance(d.opponent_id, d.stake, "賽勝負: 再起動による返金", "saishoubu", d.guild_id);
      db.prepare("UPDATE dice_duels SET status = 'void' WHERE id = ?").run(d.id);
    }
    db.prepare("UPDATE dice_duels SET status = 'void' WHERE status = 'pending'").run();
  });
  if (stale.length > 0) console.log(`[bootstrap] refunded ${stale.length} stale dice duel(s)`);
}
