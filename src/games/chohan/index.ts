/**
 * 盆（ぼん）— 多人数 丁半（BOT自動判定 PvP）
 * ─────────────────────────────────────────────────────────
 * 本来の丁半: 胴（BOT）が二賽を振り、客が「丁(偶)」「半(奇)」に分かれて張る。
 *   合計が偶数=丁 / 奇数=半。勝った側が負け側の賭け金を賭け額比で山分け（自分の賭け金は返る）。
 *   負け側からレーキ(場代)を引いて星溜まり(JP)へ。
 *
 * フロー: /盆 立てる → [丁に張る][半に張る] で即エスクロー → 締切(自動/手締め)
 *   → BOTが振る → 自動精算。片側のみ＝勝負不成立は全額返金で void。
 *
 * 安全設計: タイマーはメモリ依存。再起動時は refundStaleChohanOnStartup() で
 *   未精算分を全額返金して void にする（板/サシと同じ整合方針）。
 */
import {
  SlashCommandBuilder,
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
  PermissionFlagsBits,
  ChannelType,
  Client,
  type TextChannel,
} from "discord.js";
import { db, getServerConfig, runTransaction } from "../../core/db";
import { adjustBalance, ensureUser, getBalance, getProfile, validateBet } from "../../core/bank";
import { getTierByKey } from "../../core/economy";
import { effectiveBetCap } from "../../core/vip";
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { WORLD, formatEther, PALETTE } from "../../world.config";
import { createLinkedTable, findLinkedVC } from "../takutate/index";

// ─── 定数 ─────────────────────────────────────────────
const RAKE_PCT = 0.03;                   // 場代 3% → 星溜まり(JP)
const BIG_BET_THRESHOLD = 10_000;        // 大口強調
const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
type Side = "cho" | "han";
const SIDE_LABEL: Record<Side, string> = { cho: "丁", han: "半" };

type GameRow = {
  id: number;
  guild_id: string;
  host_id: string;
  status: "open" | "settled" | "void";
  deadline: string | null;
  die1: number | null;
  die2: number | null;
  result: Side | null;
  rake: number;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
};
type BetRow = { user_id: string; side: Side; amount: number };

// id -> 自動締切タイマー
const timers = new Map<number, NodeJS.Timeout>();

function getGame(id: number): GameRow | undefined {
  return db.prepare("SELECT * FROM chohan_games WHERE id = ?").get(id) as GameRow | undefined;
}
function getBets(id: number): BetRow[] {
  return db.prepare("SELECT user_id, side, amount FROM chohan_bets WHERE game_id = ?").all(id) as BetRow[];
}
function poolBySide(bets: BetRow[]): { cho: number; han: number } {
  let cho = 0, han = 0;
  for (const b of bets) { if (b.side === "cho") cho += b.amount; else han += b.amount; }
  return { cho, han };
}

function armTimer(id: number, ms: number, fn: () => void): void {
  clearTimer(id);
  timers.set(id, setTimeout(fn, ms));
}
function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
}

// ─── Command ──────────────────────────────────────────
export const chohanCommand = new SlashCommandBuilder()
  .setName("丁半")
  .setDescription("🎴 丁半 — 胴が振り、丁(偶)か半(奇)に分かれて張る多人数勝負")
  .addSubcommand((sc) =>
    sc
      .setName("立てる")
      .setDescription("丁半の卓を立てる（参加者を募る）")
      .addIntegerOption((o) => o.setName("締切分").setDescription("自動で振るまでの分数（任意・1〜60）").setRequired(false).setMinValue(1).setMaxValue(60))
      .addStringOption((o) =>
        o.setName("面").setDescription("自分の最初の賭け（任意）").setRequired(false)
          .addChoices({ name: "丁（偶）", value: "cho" }, { name: "半（奇）", value: "han" }),
      )
      .addIntegerOption((o) => o.setName("賭け").setDescription("最初の賭け額（面を選んだ時）").setRequired(false).setMinValue(1)),
  );

export async function handleChohanCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommand() === "立てる") return openBon(interaction);
}

export async function openBon(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }

  const userId = interaction.user.id;
  const closeMin = interaction.options.getInteger("締切分");
  const firstSide = interaction.options.getString("面") as Side | null;
  const firstBet = interaction.options.getInteger("賭け");

  ensureUser(userId, guildId);
  const cfg = getServerConfig(guildId);
  const tier = getTierByKey(getProfile(userId, guildId).tier);

  // 初期賭けのバリデーション（面と賭けは両方そろって有効）
  let initial: { side: Side; amount: number } | null = null;
  if (firstSide && firstBet != null) {
    if (firstBet < cfg.min_bet) { await interaction.reply({ embeds: [errorEmbed(`最低 ${formatEther(cfg.min_bet)} からだよ。`)], ephemeral: true }); return; }
    if (firstBet > effectiveBetCap(tier.betCap, userId, guildId)) { await interaction.reply({ embeds: [errorEmbed(`上限 ${formatEther(effectiveBetCap(tier.betCap, userId, guildId))} までだよ。`)], ephemeral: true }); return; }
    if (getBalance(userId, guildId) < firstBet) { await interaction.reply({ embeds: [errorEmbed("残高が足りないみたい。")], ephemeral: true }); return; }
    initial = { side: firstSide, amount: firstBet };
  }

  const deadline = closeMin ? new Date(Date.now() + closeMin * 60_000).toISOString() : null;

  const gameId = runTransaction<number>(() => {
    const res = db.prepare(
      "INSERT INTO chohan_games (guild_id, host_id, deadline, channel_id) VALUES (?, ?, ?, ?)",
    ).run(guildId, userId, deadline, interaction.channelId);
    const id = Number(res.lastInsertRowid);
    if (initial) {
      const debit = adjustBalance(userId, -initial.amount, "盆: 賭け", "chohan", guildId);
      if (!debit.ok) throw new Error("initial bet debit failed");
      db.prepare("INSERT INTO chohan_bets (game_id, user_id, side, amount) VALUES (?, ?, ?, ?)").run(id, userId, initial.side, initial.amount);
    }
    return id;
  });

  await interaction.reply({ content: `丁半 #${gameId} を始めたよ。${initial ? `【${SIDE_LABEL[initial.side]}】に ${formatEther(initial.amount)} を張った。` : ""}`, ephemeral: true });

  const panel = renderPanel(gameId);
  const channel = interaction.channel;
  if (channel && "send" in channel) {
    const msg = await (channel as TextChannel).send(panel);
    db.prepare("UPDATE chohan_games SET message_id = ? WHERE id = ?").run(msg.id, gameId);
    if (closeMin) armTimer(gameId, closeMin * 60_000, () => roll(interaction.client, gameId));
  }
}

// ─── パネル描画 ───────────────────────────────────────
function renderPanel(gameId: number): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const g = getGame(gameId)!;
  const bets = getBets(gameId);
  const { cho, han } = poolBySide(bets);
  const choCount = bets.filter((b) => b.side === "cho").length;
  const hanCount = bets.filter((b) => b.side === "han").length;
  const total = cho + han;

  const statusLabel: Record<string, string> = { open: "🟢 受付中", settled: "✅ 決着", void: "♻️ 無効・返金済み" };
  const color = g.status === "settled" ? PALETTE.JADE : g.status === "void" ? PALETTE.CRIMSON : PALETTE.STARGOLD;

  const lines = [
    statusLabel[g.status] ?? g.status,
    g.deadline && g.status === "open" ? `締切: <t:${Math.floor(new Date(g.deadline).getTime() / 1000)}:R>` : "",
    "",
    `🔴 **丁（偶）** — ${cho > 0 ? `${formatEther(cho)}（${choCount}人）` : "まだ無し"}`,
    `🔵 **半（奇）** — ${han > 0 ? `${formatEther(han)}（${hanCount}人）` : "まだ無し"}`,
    `総額: ${formatEther(total)}　|　場代: ${Math.round(RAKE_PCT * 100)}% → ${WORLD.POOL_JACKPOT}`,
  ];

  if (g.status === "settled" && g.die1 && g.die2 && g.result) {
    const sum = g.die1 + g.die2;
    lines.push("", `🎲 ${DICE_FACES[g.die1]} ${DICE_FACES[g.die2]} ＝ ${sum} → **${SIDE_LABEL[g.result]}（${g.result === "cho" ? "偶" : "奇"}）の勝ち**`);
  }

  const embed = baseEmbed(`🎴 丁半 #${g.id}`, color)
    .setDescription(lines.filter(Boolean).join("\n"))
    .setFooter({ text: "1人1面（賭け直しは同じ面に加算）　|　締切は主催か管理者が手締めも可" });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (g.status === "open") {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bon:bet:${g.id}:cho`).setLabel("丁（偶）に張る").setStyle(ButtonStyle.Danger).setEmoji("🔴"),
      new ButtonBuilder().setCustomId(`bon:bet:${g.id}:han`).setLabel("半（奇）に張る").setStyle(ButtonStyle.Primary).setEmoji("🔵"),
    ));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bon:close:${g.id}`).setLabel("締めて振る").setStyle(ButtonStyle.Secondary).setEmoji("🎲"),
      new ButtonBuilder().setCustomId(`bon:linkvc:${g.id}`).setLabel("この勝負用の卓を立てる").setStyle(ButtonStyle.Secondary).setEmoji("🎴"),
    ));
  }
  return { embeds: [embed], components: rows };
}

async function refreshPanel(client: Client, gameId: number): Promise<void> {
  const g = getGame(gameId);
  if (!g || !g.channel_id || !g.message_id) return;
  try {
    const channel = await client.channels.fetch(g.channel_id);
    if (channel && channel.type === ChannelType.GuildText) {
      const msg = await (channel as TextChannel).messages.fetch(g.message_id);
      await msg.edit(renderPanel(gameId));
    }
  } catch { /* メッセージ削除済み等は無視 */ }
}

async function announce(client: Client, g: GameRow, content: string): Promise<void> {
  if (!g.channel_id) return;
  try {
    const channel = await client.channels.fetch(g.channel_id);
    if (channel && channel.type === ChannelType.GuildText) await (channel as TextChannel).send(content);
  } catch { /* ignore */ }
}

// ─── ハンドラ ─────────────────────────────────────────
export async function handleChohanButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr, sideArg] = interaction.customId.split(":");
  const gameId = Number(idStr);
  const g = getGame(gameId);
  if (!g) { await interaction.reply({ content: "その丁半はもう無いみたい。", ephemeral: true }); return; }
  if (action === "bet") return openBetModal(interaction, g, sideArg as Side);
  if (action === "close") return doClose(interaction, g);
  if (action === "linkvc") return linkVc(interaction, g);
}

async function linkVc(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (g.status !== "open") {
    await interaction.reply({ content: "受付中の盆だけ立てられるよ。", ephemeral: true }); return;
  }
  const existing = findLinkedVC("chohan", String(g.id));
  if (existing) {
    await interaction.reply({
      embeds: [baseEmbed("🎴 もう立ってるよ", PALETTE.JADE).setDescription(`卓は <#${existing.channel_id}> にあるよ。`)],
      ephemeral: true,
    });
    return;
  }
  // 丁半は公開（誰でも参加可能）→ パネルch継承
  await createLinkedTable(interaction, {
    linkType: "chohan", linkId: String(g.id),
    userLimit: 0, allowedUserIds: null,
    vcName: `🎴 丁半の卓 #${g.id}`,
  });
}

export async function handleChohanModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, action, idStr, sideArg] = interaction.customId.split(":");
  if (action !== "betmodal") return;
  const gameId = Number(idStr);
  const g = getGame(gameId);
  if (!g) { await interaction.reply({ content: "その丁半はもう無いみたい。", ephemeral: true }); return; }
  return submitBet(interaction, g, sideArg as Side);
}

// ─── 張る ─────────────────────────────────────────────
async function openBetModal(interaction: ButtonInteraction, g: GameRow, side: Side): Promise<void> {
  if (g.status !== "open") { await interaction.reply({ content: "もう受付は締め切られてるよ。", ephemeral: true }); return; }
  // 既に反対の面に張っていたら拒否（1人1面）
  const prev = db.prepare("SELECT side FROM chohan_bets WHERE game_id = ? AND user_id = ?").get(g.id, interaction.user.id) as { side: Side } | undefined;
  if (prev && prev.side !== side) {
    await interaction.reply({ content: `きみはもう【${SIDE_LABEL[prev.side]}】に張ってるよ。同じ面にしか足せないんだ。`, ephemeral: true });
    return;
  }
  const modal = new ModalBuilder().setCustomId(`bon:betmodal:${g.id}:${side}`).setTitle(`【${SIDE_LABEL[side]}】に張る`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel("賭ける額（エテル）").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("例: 1000"),
    ),
  );
  await interaction.showModal(modal);
}

async function submitBet(interaction: ModalSubmitInteraction, g: GameRow, side: Side): Promise<void> {
  if (g.status !== "open") { await interaction.reply({ content: "もう受付は締め切られてるよ。", ephemeral: true }); return; }
  const guildId = g.guild_id;
  const userId = interaction.user.id;
  ensureUser(userId, guildId);
  const cfg = getServerConfig(guildId);
  const tier = getTierByKey(getProfile(userId, guildId).tier);
  const betCap = effectiveBetCap(tier.betCap, userId, guildId);

  const v = validateBet(interaction.fields.getTextInputValue("amount"), cfg.min_bet, betCap);
  if (!v.ok) {
    const msg = v.reason === "TOO_SMALL" ? `最低 ${formatEther(cfg.min_bet)} からだよ。`
      : v.reason === "TOO_LARGE" ? `上限 ${formatEther(betCap)}${betCap > tier.betCap ? "（💎VIP×2）" : ""} までだよ（賭け直しは加算なので合計に注意）。`
      : "整数で額を入れてね。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }
  const amount = v.value;

  const result = runTransaction<{ ok: boolean; reason?: string; total?: number }>(() => {
    const cur = getGame(g.id);
    if (!cur || cur.status !== "open") return { ok: false, reason: "CLOSED" };
    const prev = db.prepare("SELECT side, amount FROM chohan_bets WHERE game_id = ? AND user_id = ?").get(g.id, userId) as { side: Side; amount: number } | undefined;
    if (prev && prev.side !== side) return { ok: false, reason: "WRONG_SIDE" };
    // 賭け直しは同じ面に加算。合計が上限を超えないか確認
    const newTotal = (prev?.amount ?? 0) + amount;
    if (newTotal > betCap) return { ok: false, reason: "OVER_CAP", total: newTotal };
    const debit = adjustBalance(userId, -amount, "盆: 賭け", "chohan", guildId);
    if (!debit.ok) return { ok: false, reason: "INSUFFICIENT" };
    db.prepare(
      `INSERT INTO chohan_bets (game_id, user_id, side, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT(game_id, user_id) DO UPDATE SET amount = amount + ?, created_at = datetime('now')`,
    ).run(g.id, userId, side, amount, amount);
    return { ok: true, total: newTotal };
  });

  if (!result.ok) {
    const msg = result.reason === "CLOSED" ? "ちょうど締め切られちゃった。"
      : result.reason === "WRONG_SIDE" ? "反対の面には張れないよ。"
      : result.reason === "OVER_CAP" ? `合計が上限 ${formatEther(betCap)} を超えちゃう。`
      : result.reason === "INSUFFICIENT" ? "残高が足りないみたい。" : "賭けに失敗しちゃった。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  await interaction.reply({ content: `【${SIDE_LABEL[side]}】に ${formatEther(amount)} を張ったよ（きみの合計: ${formatEther(result.total!)}）。`, ephemeral: true });
  await refreshPanel(interaction.client, g.id);

  const feed = `🎴 **${interaction.user.displayName}** が【${SIDE_LABEL[side]}】に ${formatEther(amount)}`;
  await announce(interaction.client, g, amount >= BIG_BET_THRESHOLD ? `🔥 大口！ ${feed}` : feed);
}

// ─── 締めて振る ───────────────────────────────────────
function canManage(interaction: ButtonInteraction, g: GameRow): boolean {
  if (interaction.user.id === g.host_id) return true;
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function doClose(interaction: ButtonInteraction, g: GameRow): Promise<void> {
  if (!canManage(interaction, g)) { await interaction.reply({ content: "締められるのは丁半を始めた人か管理者だけだよ。", ephemeral: true }); return; }
  if (g.status !== "open") { await interaction.reply({ content: "もう受付中じゃないよ。", ephemeral: true }); return; }
  await interaction.deferUpdate();
  await roll(interaction.client, g.id);
}

// ─── 振って精算 ───────────────────────────────────────
async function roll(client: Client, gameId: number): Promise<void> {
  clearTimer(gameId);
  const g = getGame(gameId);
  if (!g || g.status !== "open") return;

  const bets = getBets(gameId);
  const { cho, han } = poolBySide(bets);

  // 片側のみ＝勝負不成立 → 全額返金で void
  if (cho === 0 || han === 0) {
    runTransaction(() => {
      const cur = getGame(gameId);
      if (!cur || cur.status !== "open") return;
      for (const b of bets) adjustBalance(b.user_id, b.amount, "盆: 勝負不成立・返金", "chohan", g.guild_id);
      db.prepare("UPDATE chohan_games SET status = 'void' WHERE id = ?").run(gameId);
    });
    await refreshPanel(client, gameId);
    await announce(client, g, "🌀 片方の面にしか張りが無かったから、勝負不成立。全額返したよ。");
    return;
  }

  const die1 = 1 + Math.floor(Math.random() * 6);
  const die2 = 1 + Math.floor(Math.random() * 6);
  const sum = die1 + die2;
  const result: Side = sum % 2 === 0 ? "cho" : "han";

  const payouts = runTransaction<{ list: Array<{ userId: string; amount: number }>; rake: number }>(() => {
    const cur = getGame(gameId);
    if (!cur || cur.status !== "open") return { list: [], rake: 0 };

    const winners = bets.filter((b) => b.side === result);
    const winnerTotal = winners.reduce((a, b) => a + b.amount, 0);
    const loserPot = (result === "cho" ? han : cho);
    const rake = Math.floor(loserPot * RAKE_PCT);
    const distributable = loserPot - rake;

    const list: Array<{ userId: string; amount: number }> = [];
    let distributed = 0;
    for (const w of winners) {
      const winShare = Math.floor(distributable * (w.amount / winnerTotal));
      const pay = w.amount + winShare; // 元本返却 + 取り分
      distributed += winShare;
      adjustBalance(w.user_id, pay, "盆: 配当（勝ち）", "chohan", g.guild_id);
      list.push({ userId: w.user_id, amount: pay });
    }
    // レーキ + 配分端数 を星溜まり(JP)へ
    const toJP = rake + (distributable - distributed);
    if (toJP > 0) db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(toJP, g.guild_id);

    db.prepare("UPDATE chohan_games SET status = 'settled', die1 = ?, die2 = ?, result = ?, rake = ? WHERE id = ?")
      .run(die1, die2, result, rake, gameId);
    return { list, rake };
  });

  await refreshPanel(client, gameId);
  const winLines = payouts.list.map((p) => `<@${p.userId}> +${formatEther(p.amount)}`).join("\n");
  await announce(client, g, [
    `🎲 ${DICE_FACES[die1]} ${DICE_FACES[die2]} ＝ ${sum} → **${SIDE_LABEL[result]}（${result === "cho" ? "偶" : "奇"}）の勝ち！**`,
    winLines || "（勝者なし）",
    payouts.rake > 0 ? `*場代 ${formatEther(payouts.rake)} を ${WORLD.POOL_JACKPOT} に納めた。*` : "",
  ].filter(Boolean).join("\n"));

  // 紐付きVCがあれば 続行/やめる パネルを投下（参加者=賭けた全員）
  try {
    const bettorIds = Array.from(new Set(bets.map((b) => b.user_id)));
    const { postDecisionPanel } = require("../decisionPanel");
    await postDecisionPanel(client, g.guild_id, "chohan", String(g.id), g.host_id, bettorIds);
  } catch (err) {
    console.warn("[chohan] decisionPanel post failed:", err);
  }
}

// ─── 再戦立て（decisionPanel から呼ばれる） ───────────
/**
 * 続行成立時に、同じ立て主で新しい盆を立てる。手数料なし、初期賭けなし。
 * @returns 新 game ID（文字列）。失敗したら null。
 */
export async function restartChohan(client: Client, oldGameId: number, vcId: string | null, _guildId: string): Promise<string | null> {
  const old = getGame(oldGameId);
  if (!old) return null;

  const newId = runTransaction<number>(() => {
    const res = db.prepare(
      "INSERT INTO chohan_games (guild_id, host_id, deadline, channel_id) VALUES (?, ?, ?, ?)",
    ).run(old.guild_id, old.host_id, null, vcId ?? old.channel_id);
    return Number(res.lastInsertRowid);
  });

  const target = vcId ?? old.channel_id;
  if (target) {
    try {
      const ch = await client.channels.fetch(target).catch(() => null);
      if (ch && "send" in ch) {
        const panel = renderPanel(newId);
        const msg = await (ch as any).send(panel);
        db.prepare("UPDATE chohan_games SET message_id = ?, channel_id = ? WHERE id = ?").run(msg.id, target, newId);
      }
    } catch (err) {
      console.warn("[chohan] restart announce failed:", err);
    }
  }
  return String(newId);
}

// ─── 起動時返金 ───────────────────────────────────────
export function refundStaleChohanOnStartup(): void {
  const stale = db.prepare("SELECT id FROM chohan_games WHERE status = 'open'").all() as Array<{ id: number }>;
  if (stale.length === 0) return;
  runTransaction(() => {
    for (const { id } of stale) {
      const g = getGame(id)!;
      for (const b of getBets(id)) adjustBalance(b.user_id, b.amount, "盆: 再起動による返金", "chohan", g.guild_id);
      db.prepare("UPDATE chohan_games SET status = 'void' WHERE id = ?").run(id);
    }
  });
  console.log(`[bootstrap] refunded ${stale.length} stale chohan game(s)`);
}
