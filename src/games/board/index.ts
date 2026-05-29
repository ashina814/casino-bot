/**
 * 賭場の板（公開市場）— 何でも賭けられる多対多マーケット
 * ─────────────────────────────────────────────────────────
 * フロー: 立てる → 賭ける → 締切(手動/自動) → 結果報告 → 承認/異議 → 精算
 *   配分方式: parimutuel（賭け額比例） / winner_take_all（的中者で均等頭割り）
 *   異議が出たら status=disputed → 管理者裁定ボタンで確定/返金
 *
 * 安全設計: タイマーはメモリ依存。再起動時は refundStaleMarketsOnStartup() で
 *   未精算の板を全額返金して void にする（エスクロー整合）。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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
import { baseEmbed, errorEmbed } from "../../ui/embeds";
import { WORLD, formatEther, PALETTE } from "../../world.config";

// ─── 定数 ─────────────────────────────────────────────
const MAX_OPTIONS = 4;
const DISPUTE_WINDOW_MS = 5 * 60 * 1000; // 異議受付 5分
const BIG_BET_THRESHOLD = 10_000;        // 大口強調しきい値
const OPTION_MARKS = ["①", "②", "③", "④"];

type PayoutMode = "parimutuel" | "winner_take_all";

type MarketRow = {
  id: number;
  guild_id: string;
  creator_id: string;
  title: string;
  options: string;
  payout_mode: PayoutMode;
  status: "open" | "closed" | "reported" | "settled" | "disputed" | "void";
  deadline: string | null;
  result_option: number | null;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  fee: number;
  created_at: string;
};

type BetRow = { user_id: string; option_index: number; amount: number };

// id -> Timeout（自動締切・異議window）
const timers = new Map<number, NodeJS.Timeout>();

// ─── DB helper ────────────────────────────────────────
function getMarket(id: number): MarketRow | undefined {
  return db.prepare("SELECT * FROM betting_markets WHERE id = ?").get(id) as MarketRow | undefined;
}
function getBets(id: number): BetRow[] {
  return db.prepare("SELECT user_id, option_index, amount FROM market_bets WHERE market_id = ?").all(id) as BetRow[];
}
function getOptions(m: MarketRow): string[] {
  try { return JSON.parse(m.options) as string[]; } catch { return []; }
}

// ─── Command ──────────────────────────────────────────
export const boardCommand = new SlashCommandBuilder()
  .setName("板")
  .setDescription(`📋 ${WORLD.GAME_BOARD} — 何でも賭けられる公開市場`)
  .addSubcommand((sc) =>
    sc
      .setName("立てる")
      .setDescription("新しい議題を立てる")
      .addStringOption((o) => o.setName("議題").setDescription("何に賭ける？").setRequired(true).setMaxLength(120))
      .addStringOption((o) => o.setName("選択肢").setDescription("カンマ/読点区切りで 2〜4個").setRequired(true).setMaxLength(200))
      .addStringOption((o) =>
        o.setName("方式").setDescription("配分方式").setRequired(false)
          .addChoices(
            { name: "パリミュ（賭け額に比例して山分け）", value: "parimutuel" },
            { name: "総取り（的中者で均等に山分け）", value: "winner_take_all" },
          ),
      )
      .addIntegerOption((o) => o.setName("締切分").setDescription("自動締切までの分数（任意・1〜180）").setRequired(false).setMinValue(1).setMaxValue(180)),
  )
  .addSubcommand((sc) => sc.setName("一覧").setDescription("進行中の議題を表示"));

export async function handleBoardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "立てる") return createMarket(interaction);
  if (sub === "一覧") return listMarkets(interaction);
}

// ─── 立てる ───────────────────────────────────────────
async function createMarket(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true }); return; }

  const title = interaction.options.getString("議題", true).trim();
  const rawOptions = interaction.options.getString("選択肢", true);
  const mode = (interaction.options.getString("方式") as PayoutMode | null) ?? "parimutuel";
  const closeMin = interaction.options.getInteger("締切分");

  const options = rawOptions.split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
  if (options.length < 2 || options.length > MAX_OPTIONS) {
    await interaction.reply({ embeds: [errorEmbed(`選択肢は 2〜${MAX_OPTIONS} 個で指定してね（カンマか読点で区切って）。`)], ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  ensureUser(userId, guildId);
  const cfg = getServerConfig(guildId);
  const fee = cfg.board_fee ?? 500;

  if (getBalance(userId, guildId) < fee) {
    await interaction.reply({ embeds: [errorEmbed(`議題を立てるには ${formatEther(fee)} かかるよ。残高が足りないみたい。`)], ephemeral: true });
    return;
  }

  const deadline = closeMin ? new Date(Date.now() + closeMin * 60_000).toISOString() : null;

  // 手数料を徴収して市場を作成
  const marketId = runTransaction<number>(() => {
    const debit = adjustBalance(userId, -fee, "板: 議題立て手数料", "board", guildId);
    if (!debit.ok) throw new Error("fee debit failed");
    const res = db.prepare(
      `INSERT INTO betting_markets (guild_id, creator_id, title, options, payout_mode, deadline, channel_id, fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(guildId, userId, title, JSON.stringify(options), mode, deadline, interaction.channelId, fee);
    return Number(res.lastInsertRowid);
  });

  await interaction.reply({ content: `議題 #${marketId} を立てたよ。手数料 ${formatEther(fee)} を ${WORLD.POOL_JACKPOT} に納めた。`, ephemeral: true });

  const panel = renderPanel(marketId);
  const channel = interaction.channel;
  if (channel && "send" in channel) {
    const msg = await (channel as TextChannel).send(panel);
    db.prepare("UPDATE betting_markets SET message_id = ? WHERE id = ?").run(msg.id, marketId);
    // 自動スレッド生成（任意・失敗は握り潰す）
    try {
      const thread = await msg.startThread({ name: `📋 ${title}`.slice(0, 90), autoArchiveDuration: 1440 });
      db.prepare("UPDATE betting_markets SET thread_id = ? WHERE id = ?").run(thread.id, marketId);
      await thread.send(`議題「${title}」の板が立った。さあ、どこに賭ける？`);
    } catch { /* スレッド権限なし等は無視 */ }

    // 自動締切タイマー
    if (closeMin) {
      armTimer(marketId, closeMin * 60_000, () => autoClose(interaction.client, marketId));
    }
  }
}

async function listMarkets(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const rows = db.prepare(
    "SELECT id, title, status, payout_mode FROM betting_markets WHERE guild_id = ? AND status IN ('open','closed','reported','disputed') ORDER BY id DESC LIMIT 15",
  ).all(guildId) as Array<{ id: number; title: string; status: string; payout_mode: string }>;

  if (rows.length === 0) {
    await interaction.reply({ embeds: [baseEmbed(`📋 ${WORLD.GAME_BOARD}`, PALETTE.NIGHT).setDescription("いま進行中の議題はないよ。`/板 立てる` で始めてみて。")], ephemeral: true });
    return;
  }
  const statusLabel: Record<string, string> = { open: "受付中", closed: "締切", reported: "結果報告中", disputed: "異議・裁定待ち" };
  const lines = rows.map((r) => `#${r.id} **${r.title}** — ${statusLabel[r.status] ?? r.status}`);
  await interaction.reply({ embeds: [baseEmbed(`📋 ${WORLD.GAME_BOARD} — 進行中`, PALETTE.STARGOLD).setDescription(lines.join("\n"))], ephemeral: true });
}

// ─── パネル描画 ───────────────────────────────────────
function renderPanel(marketId: number): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } {
  const m = getMarket(marketId)!;
  const options = getOptions(m);
  const bets = getBets(marketId);

  const poolByOpt = new Array(options.length).fill(0);
  const countByOpt = new Array(options.length).fill(0);
  let total = 0;
  for (const b of bets) {
    if (b.option_index >= 0 && b.option_index < options.length) {
      poolByOpt[b.option_index] += b.amount;
      countByOpt[b.option_index] += 1;
      total += b.amount;
    }
  }

  const modeLabel = m.payout_mode === "parimutuel" ? "パリミュ（比例配分）" : "総取り（均等頭割り）";
  const statusLabel: Record<string, string> = {
    open: "🟢 受付中", closed: "🔒 締切", reported: "📣 結果報告 — 承認待ち",
    disputed: "⚖️ 異議あり — 裁定待ち", settled: "✅ 精算済み", void: "♻️ 無効・返金済み",
  };

  const optLines = options.map((opt, i) => {
    const mark = OPTION_MARKS[i];
    const pool = poolByOpt[i];
    let extra = "";
    if (m.payout_mode === "parimutuel") {
      const odds = pool > 0 ? (total / pool) : 0;
      extra = pool > 0 ? ` — ${formatEther(pool)}（×${odds.toFixed(2)}）` : " — まだ無し";
    } else {
      extra = countByOpt[i] > 0 ? ` — ${countByOpt[i]}人 / ${formatEther(pool)}` : " — まだ無し";
    }
    const win = m.result_option === i ? " ✅" : "";
    return `${mark} **${opt}**${extra}${win}`;
  });

  const embed = baseEmbed(`📋 #${m.id}　${m.title}`, m.status === "settled" ? PALETTE.JADE : m.status === "void" ? PALETTE.CRIMSON : PALETTE.STARGOLD)
    .setDescription([
      statusLabel[m.status] ?? m.status,
      `方式: ${modeLabel}　|　総額: ${formatEther(total)}`,
      m.deadline && m.status === "open" ? `締切: <t:${Math.floor(new Date(m.deadline).getTime() / 1000)}:R>` : "",
      "",
      ...optLines,
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `立てた人: 結果報告は作成者か管理者　|　1人1口（賭け直しは上書き）` });

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (m.status === "open") {
    const betRow = new ActionRowBuilder<ButtonBuilder>();
    options.forEach((opt, i) => {
      betRow.addComponents(
        new ButtonBuilder().setCustomId(`plate:bet:${m.id}:${i}`).setLabel(`${OPTION_MARKS[i]} ${opt}`.slice(0, 78)).setStyle(ButtonStyle.Primary),
      );
    });
    rows.push(betRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
    const ctlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`plate:close:${m.id}`).setLabel("締切る").setStyle(ButtonStyle.Secondary).setEmoji("🔒"),
    );
    rows.push(ctlRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  } else if (m.status === "closed") {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`plate:report:${m.id}`).setLabel("結果を報告する").setStyle(ButtonStyle.Success).setEmoji("📣"),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  } else if (m.status === "reported") {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`plate:approve:${m.id}`).setLabel("承認").setStyle(ButtonStyle.Success).setEmoji("✅"),
      new ButtonBuilder().setCustomId(`plate:dispute:${m.id}`).setLabel("異議あり").setStyle(ButtonStyle.Danger).setEmoji("⚠️"),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  } else if (m.status === "disputed") {
    const sel = new StringSelectMenuBuilder().setCustomId(`plate:admin_resolve:${m.id}`).setPlaceholder("管理者裁定: 勝ち選択肢を選ぶ");
    options.forEach((opt, i) => sel.addOptions({ label: `${OPTION_MARKS[i]} ${opt}`.slice(0, 90), value: String(i) }));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`plate:admin_void:${m.id}`).setLabel("無効にして全額返金（管理者）").setStyle(ButtonStyle.Danger),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  }

  return { embeds: [embed], components: rows };
}

async function refreshPanel(client: Client, marketId: number): Promise<void> {
  const m = getMarket(marketId);
  if (!m || !m.channel_id || !m.message_id) return;
  try {
    const channel = await client.channels.fetch(m.channel_id);
    if (channel && channel.type === ChannelType.GuildText) {
      const msg = await (channel as TextChannel).messages.fetch(m.message_id);
      await msg.edit(renderPanel(marketId));
    }
  } catch { /* メッセージ削除済み等は無視 */ }
}

async function postToThread(client: Client, m: MarketRow, content: string): Promise<void> {
  if (!m.thread_id) return;
  try {
    const thread = await client.channels.fetch(m.thread_id);
    if (thread && thread.isThread()) await thread.send(content);
  } catch { /* ignore */ }
}

// ─── タイマー ─────────────────────────────────────────
function armTimer(id: number, ms: number, fn: () => void): void {
  clearTimer(id);
  timers.set(id, setTimeout(fn, ms));
}
function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
}

// ─── ボタン/セレクト/モーダル ハンドラ ─────────────────
export async function handleBoardButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr, optStr] = interaction.customId.split(":");
  const marketId = Number(idStr);
  const m = getMarket(marketId);
  if (!m) { await interaction.reply({ content: "その議題はもう無いみたい。", ephemeral: true }); return; }

  switch (action) {
    case "bet": return openBetModal(interaction, m, Number(optStr));
    case "close": return doClose(interaction, m);
    case "report": return openReportSelect(interaction, m);
    case "approve": return doApprove(interaction, m);
    case "dispute": return doDispute(interaction, m);
    case "admin_void": return adminVoid(interaction, m);
  }
}

export async function handleBoardSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const marketId = Number(idStr);
  const m = getMarket(marketId);
  if (!m) { await interaction.reply({ content: "その議題はもう無いみたい。", ephemeral: true }); return; }

  if (action === "reportselect") return applyReport(interaction, m, Number(interaction.values[0]));
  if (action === "admin_resolve") return adminResolve(interaction, m, Number(interaction.values[0]));
}

export async function handleBoardModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, action, idStr, optStr] = interaction.customId.split(":");
  if (action !== "betmodal") return;
  const marketId = Number(idStr);
  const m = getMarket(marketId);
  if (!m) { await interaction.reply({ content: "その議題はもう無いみたい。", ephemeral: true }); return; }
  return submitBet(interaction, m, Number(optStr));
}

// ─── 賭ける ───────────────────────────────────────────
async function openBetModal(interaction: ButtonInteraction, m: MarketRow, opt: number): Promise<void> {
  if (m.status !== "open") { await interaction.reply({ content: "もう受付は締め切られてるよ。", ephemeral: true }); return; }
  const options = getOptions(m);
  const modal = new ModalBuilder().setCustomId(`plate:betmodal:${m.id}:${opt}`).setTitle(`「${options[opt] ?? ""}」に賭ける`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel("賭ける額（エテル）").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("例: 1000"),
    ),
  );
  await interaction.showModal(modal);
}

async function submitBet(interaction: ModalSubmitInteraction, m: MarketRow, opt: number): Promise<void> {
  if (m.status !== "open") { await interaction.reply({ content: "もう受付は締め切られてるよ。", ephemeral: true }); return; }
  const guildId = m.guild_id;
  const userId = interaction.user.id;
  ensureUser(userId, guildId);
  const cfg = getServerConfig(guildId);
  const profile = getProfile(userId, guildId);
  const tier = getTierByKey(profile.tier);

  const v = validateBet(interaction.fields.getTextInputValue("amount"), cfg.min_bet, tier.betCap);
  if (!v.ok) {
    const msg = v.reason === "TOO_SMALL" ? `最低 ${formatEther(cfg.min_bet)} からだよ。`
      : v.reason === "TOO_LARGE" ? `きみの星位だと ${formatEther(tier.betCap)} までだよ。`
      : "整数で額を入れてね。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }
  const amount = v.value;

  const result = runTransaction<{ ok: boolean; reason?: string }>(() => {
    // 最新の状態を再確認（締切レース防止）
    const cur = getMarket(m.id);
    if (!cur || cur.status !== "open") return { ok: false, reason: "CLOSED" };

    // 既存の賭けを返金（1人1口・上書き）
    const prev = db.prepare("SELECT amount FROM market_bets WHERE market_id = ? AND user_id = ?").get(m.id, userId) as { amount: number } | undefined;
    if (prev) {
      const refund = adjustBalance(userId, prev.amount, "板: 賭け直し返金", "board", guildId);
      if (!refund.ok) return { ok: false, reason: "REFUND_FAIL" };
    }
    // 新規額を引く
    const debit = adjustBalance(userId, -amount, "板: 賭け", "board", guildId);
    if (!debit.ok) return { ok: false, reason: "INSUFFICIENT" };
    db.prepare(
      `INSERT INTO market_bets (market_id, user_id, option_index, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT(market_id, user_id) DO UPDATE SET option_index = ?, amount = ?, created_at = datetime('now')`,
    ).run(m.id, userId, opt, amount, opt, amount);
    return { ok: true };
  });

  if (!result.ok) {
    const msg = result.reason === "CLOSED" ? "ちょうど締め切られちゃった。"
      : result.reason === "INSUFFICIENT" ? "残高が足りないみたい。" : "賭けに失敗しちゃった。";
    await interaction.reply({ embeds: [errorEmbed(msg)], ephemeral: true });
    return;
  }

  const options = getOptions(m);
  await interaction.reply({ content: `【${options[opt]}】に ${formatEther(amount)} を投じたよ。`, ephemeral: true });
  await refreshPanel(interaction.client, m.id);

  const feed = `🎲 **${interaction.user.displayName}** が【${options[opt]}】に ${formatEther(amount)} を投じた`;
  await postToThread(interaction.client, m, amount >= BIG_BET_THRESHOLD ? `🔥 大口！ ${feed}` : feed);
}

// ─── 締切 ─────────────────────────────────────────────
function canManage(interaction: ButtonInteraction | StringSelectMenuInteraction, m: MarketRow): boolean {
  if (interaction.user.id === m.creator_id) return true;
  const perms = interaction.memberPermissions;
  return !!perms?.has(PermissionFlagsBits.Administrator);
}

async function doClose(interaction: ButtonInteraction, m: MarketRow): Promise<void> {
  if (!canManage(interaction, m)) { await interaction.reply({ content: "締め切れるのは議題を立てた人か管理者だけだよ。", ephemeral: true }); return; }
  if (m.status !== "open") { await interaction.reply({ content: "もう受付中じゃないよ。", ephemeral: true }); return; }
  db.prepare("UPDATE betting_markets SET status = 'closed' WHERE id = ?").run(m.id);
  clearTimer(m.id);
  await interaction.deferUpdate();
  await refreshPanel(interaction.client, m.id);
}

async function autoClose(client: Client, marketId: number): Promise<void> {
  const m = getMarket(marketId);
  if (!m || m.status !== "open") return;
  db.prepare("UPDATE betting_markets SET status = 'closed' WHERE id = ?").run(marketId);
  clearTimer(marketId);
  await refreshPanel(client, marketId);
  await postToThread(client, m, "⏰ 受付を締め切ったよ。立てた人は結果を報告してね。");
}

// ─── 結果報告 ─────────────────────────────────────────
async function openReportSelect(interaction: ButtonInteraction, m: MarketRow): Promise<void> {
  if (!canManage(interaction, m)) { await interaction.reply({ content: "報告できるのは議題を立てた人か管理者だけだよ。", ephemeral: true }); return; }
  if (m.status !== "closed") { await interaction.reply({ content: "先に締め切ってね。", ephemeral: true }); return; }
  const options = getOptions(m);
  const sel = new StringSelectMenuBuilder().setCustomId(`plate:reportselect:${m.id}`).setPlaceholder("勝った選択肢を選ぶ");
  options.forEach((opt, i) => sel.addOptions({ label: `${OPTION_MARKS[i]} ${opt}`.slice(0, 90), value: String(i) }));
  await interaction.reply({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)], ephemeral: true });
}

async function applyReport(interaction: StringSelectMenuInteraction, m: MarketRow, opt: number): Promise<void> {
  if (!canManage(interaction, m)) { await interaction.reply({ content: "報告できるのは議題を立てた人か管理者だけだよ。", ephemeral: true }); return; }
  if (m.status !== "closed") { await interaction.update({ content: "もう報告は受け付けられないよ。", components: [] }); return; }
  db.prepare("UPDATE betting_markets SET status = 'reported', result_option = ? WHERE id = ?").run(opt, m.id);
  const options = getOptions(m);
  await interaction.update({ content: `結果を【${options[opt]}】で報告したよ。参加者の承認を待つね。`, components: [] });
  await refreshPanel(interaction.client, m.id);
  await postToThread(interaction.client, m, `📣 結果報告: 勝ちは【${options[opt]}】。参加者は承認/異議をどうぞ（${Math.round(DISPUTE_WINDOW_MS / 60000)}分後に自動確定）。`);
  // 異議受付window → 異議が無ければ自動精算
  armTimer(m.id, DISPUTE_WINDOW_MS, () => finalizeIfNoDispute(interaction.client, m.id));
}

async function doApprove(interaction: ButtonInteraction, m: MarketRow): Promise<void> {
  if (m.status !== "reported") { await interaction.reply({ content: "いまは承認の時間じゃないよ。", ephemeral: true }); return; }
  // 賭けた人だけが承認できる
  const isBettor = db.prepare("SELECT 1 FROM market_bets WHERE market_id = ? AND user_id = ?").get(m.id, interaction.user.id);
  if (!isBettor) { await interaction.reply({ content: "賭けた人だけが承認できるよ。", ephemeral: true }); return; }
  db.prepare("INSERT INTO market_approvals (market_id, user_id, vote) VALUES (?, ?, 'approve') ON CONFLICT(market_id, user_id) DO UPDATE SET vote='approve'").run(m.id, interaction.user.id);
  await interaction.reply({ content: "承認したよ。", ephemeral: true });

  // 全員承認なら即精算
  const bettors = db.prepare("SELECT COUNT(*) AS c FROM market_bets WHERE market_id = ?").get(m.id) as { c: number };
  const approvals = db.prepare("SELECT COUNT(*) AS c FROM market_approvals WHERE market_id = ? AND vote='approve'").get(m.id) as { c: number };
  if (approvals.c >= bettors.c) {
    clearTimer(m.id);
    await settleMarket(interaction.client, m.id);
  }
}

async function doDispute(interaction: ButtonInteraction, m: MarketRow): Promise<void> {
  if (m.status !== "reported") { await interaction.reply({ content: "いまは異議の時間じゃないよ。", ephemeral: true }); return; }
  const isBettor = db.prepare("SELECT 1 FROM market_bets WHERE market_id = ? AND user_id = ?").get(m.id, interaction.user.id);
  if (!isBettor) { await interaction.reply({ content: "賭けた人だけが異議を出せるよ。", ephemeral: true }); return; }
  db.prepare("INSERT INTO market_approvals (market_id, user_id, vote) VALUES (?, ?, 'dispute') ON CONFLICT(market_id, user_id) DO UPDATE SET vote='dispute'").run(m.id, interaction.user.id);
  db.prepare("UPDATE betting_markets SET status = 'disputed' WHERE id = ?").run(m.id);
  clearTimer(m.id);
  await interaction.reply({ content: "異議を受け付けたよ。管理者の裁定を待ってね。", ephemeral: true });
  await refreshPanel(interaction.client, m.id);
  await postToThread(interaction.client, m, "⚖️ 異議が出たよ。管理者が裁定します。");
}

async function finalizeIfNoDispute(client: Client, marketId: number): Promise<void> {
  const m = getMarket(marketId);
  if (!m || m.status !== "reported") return; // 既に異議/精算済み
  await settleMarket(client, marketId);
}

// ─── 精算 ─────────────────────────────────────────────
async function settleMarket(client: Client, marketId: number): Promise<void> {
  const m = getMarket(marketId);
  if (!m || (m.status !== "reported" && m.status !== "disputed") || m.result_option == null) return;
  const options = getOptions(m);
  const bets = getBets(marketId);
  const resultOpt = m.result_option;

  const payouts = runTransaction<Array<{ userId: string; amount: number }>>(() => {
    const cur = getMarket(marketId);
    if (!cur || cur.result_option == null) return [];
    const total = bets.reduce((a, b) => a + b.amount, 0);
    const winners = bets.filter((b) => b.option_index === resultOpt);
    const out: Array<{ userId: string; amount: number }> = [];

    if (winners.length === 0) {
      // 的中者なし → 全額返金して void
      for (const b of bets) {
        adjustBalance(b.user_id, b.amount, "板: 的中者なし返金", "board", m.guild_id);
      }
      db.prepare("UPDATE betting_markets SET status = 'void' WHERE id = ?").run(marketId);
      return out;
    }

    if (m.payout_mode === "parimutuel") {
      const winPool = winners.reduce((a, b) => a + b.amount, 0);
      for (const w of winners) {
        const pay = Math.floor(total * (w.amount / winPool));
        adjustBalance(w.user_id, pay, "板: 配当（パリミュ）", "board", m.guild_id);
        out.push({ userId: w.user_id, amount: pay });
      }
    } else {
      // 総取り: 的中者で均等頭割り
      const per = Math.floor(total / winners.length);
      for (const w of winners) {
        adjustBalance(w.user_id, per, "板: 配当（総取り）", "board", m.guild_id);
        out.push({ userId: w.user_id, amount: per });
      }
    }
    db.prepare("UPDATE betting_markets SET status = 'settled' WHERE id = ?").run(marketId);
    return out;
  });

  await refreshPanel(client, marketId);
  const finalM = getMarket(marketId)!;
  if (finalM.status === "void") {
    await postToThread(client, m, "🌀 的中者がいなかったので、全額返金したよ。");
  } else {
    const lines = payouts.map((p) => `<@${p.userId}> +${formatEther(p.amount)}`).join("\n");
    await postToThread(client, m, `🎉 精算完了！ 勝ちは【${options[resultOpt]}】\n${lines || "（配当なし）"}`);
  }
}

// ─── 管理者裁定 ───────────────────────────────────────
async function adminResolve(interaction: StringSelectMenuInteraction, m: MarketRow, opt: number): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) { await interaction.reply({ content: "管理者だけが裁定できるよ。", ephemeral: true }); return; }
  if (m.status !== "disputed") { await interaction.reply({ content: "裁定待ちの議題じゃないよ。", ephemeral: true }); return; }
  db.prepare("UPDATE betting_markets SET result_option = ? WHERE id = ?").run(opt, m.id);
  await interaction.update({ content: "裁定を確定したよ。精算するね。", components: [] }).catch(() => {});
  await settleMarket(interaction.client, m.id);
}

async function adminVoid(interaction: ButtonInteraction, m: MarketRow): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) { await interaction.reply({ content: "管理者だけが無効にできるよ。", ephemeral: true }); return; }
  if (m.status !== "disputed") { await interaction.reply({ content: "裁定待ちの議題じゃないよ。", ephemeral: true }); return; }
  runTransaction(() => {
    for (const b of getBets(m.id)) adjustBalance(b.user_id, b.amount, "板: 裁定により無効・返金", "board", m.guild_id);
    db.prepare("UPDATE betting_markets SET status = 'void' WHERE id = ?").run(m.id);
  });
  await interaction.reply({ content: "無効にして全額返金したよ。", ephemeral: true });
  await refreshPanel(interaction.client, m.id);
  await postToThread(interaction.client, m, "♻️ 管理者の裁定により、この議題は無効。全額返金したよ。");
}

// ─── 起動時返金（未精算の板を全額返金して void） ───────
export function refundStaleMarketsOnStartup(): void {
  const stale = db.prepare(
    "SELECT id FROM betting_markets WHERE status IN ('open','closed','reported','disputed')",
  ).all() as Array<{ id: number }>;
  if (stale.length === 0) return;
  runTransaction(() => {
    for (const { id } of stale) {
      const m = getMarket(id)!;
      for (const b of getBets(id)) {
        adjustBalance(b.user_id, b.amount, "板: 再起動による返金", "board", m.guild_id);
      }
      db.prepare("UPDATE betting_markets SET status = 'void' WHERE id = ?").run(id);
    }
  });
  console.log(`[bootstrap] refunded ${stale.length} stale betting market(s)`);
}
