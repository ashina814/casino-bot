/**
 * 勝負終了後の 続行/やめる パネル（段階1）
 * ─────────────────────────────────────────────────────────
 * 紐付きVC（takutate.createLinkedTable で立てた卓）の中で勝負が決着したら、
 * その VC のテキストチャットに「もう一勝負する？」パネルを投下する。
 *
 *   - 1v1（サシ / チンチロ対戦） : 両者が[続行]を押したら **自動で再戦** を立てる
 *   - 多人数（板 / 丁半）         : 立て主が[続行]を押したら 「同条件で立て直してね」プロンプトを出す。
 *                                     卓寿命だけ延長して、実際の立て直しは各ゲームのコマンド再叩きに任せる（段階1）。
 *   - [やめる]                    : 紐付きVCを即削除（雑談継続不可）
 *   - 無選択 5分                  : 30秒前に警告 → 期限到達でVC削除
 *
 * 再起動耐性: decision_panels テーブルに永続化。bootDecisionPanels() が起動時に
 *   過ぎてるパネルを片付け、tick interval を開始する。
 */
import {
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ChannelType,
  type VoiceChannel,
  type TextBasedChannel,
} from "discord.js";
import { db } from "../core/db";
import { baseEmbed } from "../ui/embeds";
import { PALETTE } from "../world.config";
import { findLinkedVC, updateLinkedVCLinkId, deleteLinkedVC, markLinkedVCSettled } from "./takutate/index";

// ─── 設定（後で調整しやすいように定数化） ─────────────
const DECISION_TIMEOUT_MS = 5 * 60_000;   // 続行判断の制限時間
const WARNING_BEFORE_MS = 30_000;          // 残りこの時間で警告
const TICK_INTERVAL_MS = 10_000;           // 期限/警告の点検周期

// ─── 型 ──────────────────────────────────────────────
type LinkType = "sashi" | "board" | "chohan" | "saishoubu";

type PanelRow = {
  id: number;
  message_id: string;
  channel_id: string;
  guild_id: string;
  vc_id: string | null;
  link_type: string;
  link_id: string;
  host_id: string;
  participant_ids: string;
  deadline_at: string;
  status: "open" | "continued" | "stopped" | "expired";
  votes_continue: string;
  votes_stop: string;
  warned: number;
  created_at: string;
};

function parseList(json: string): string[] {
  try { return JSON.parse(json) as string[]; } catch { return []; }
}

function isOneOnOne(linkType: string): boolean {
  return linkType === "sashi" || linkType === "saishoubu";
}

// ─── DB helpers ──────────────────────────────────────
function insertPanel(p: Omit<PanelRow, "id" | "created_at">): number {
  const res = db.prepare(
    `INSERT INTO decision_panels (message_id, channel_id, guild_id, vc_id, link_type, link_id, host_id, participant_ids, deadline_at, status, votes_continue, votes_stop, warned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.message_id, p.channel_id, p.guild_id, p.vc_id, p.link_type, p.link_id, p.host_id, p.participant_ids, p.deadline_at, p.status, p.votes_continue, p.votes_stop, p.warned);
  return Number(res.lastInsertRowid);
}

function getPanel(id: number): PanelRow | undefined {
  return db.prepare("SELECT * FROM decision_panels WHERE id = ?").get(id) as PanelRow | undefined;
}

function listOpenPanels(): PanelRow[] {
  return db.prepare("SELECT * FROM decision_panels WHERE status = 'open' ORDER BY id").all() as PanelRow[];
}

function setPanelStatus(id: number, status: PanelRow["status"]): void {
  db.prepare("UPDATE decision_panels SET status = ? WHERE id = ?").run(status, id);
}

function setWarned(id: number): void {
  db.prepare("UPDATE decision_panels SET warned = 1 WHERE id = ?").run(id);
}

function setVotes(id: number, kind: "continue" | "stop", users: string[]): void {
  const col = kind === "continue" ? "votes_continue" : "votes_stop";
  db.prepare(`UPDATE decision_panels SET ${col} = ? WHERE id = ?`).run(JSON.stringify(users), id);
}

function setLinkId(panelId: number, newLinkId: string): void {
  db.prepare("UPDATE decision_panels SET link_id = ?, status = 'continued' WHERE id = ?").run(newLinkId, panelId);
}

// ─── パネル描画 ─────────────────────────────────────
function renderPanelEmbed(p: PanelRow): { embeds: ReturnType<typeof baseEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const cont = parseList(p.votes_continue);
  const stop = parseList(p.votes_stop);
  const isPair = isOneOnOne(p.link_type);
  const deadlineUnix = Math.floor(new Date(p.deadline_at).getTime() / 1000);

  const lines: string[] = [
    "もう一勝負する？",
    "",
    `⏱ <t:${deadlineUnix}:R> までに決めて。`,
  ];
  if (isPair) {
    const partIds = parseList(p.participant_ids);
    const yes = partIds.filter((u) => cont.includes(u)).map((u) => `<@${u}>`).join("・") || "—";
    const no = partIds.filter((u) => stop.includes(u)).map((u) => `<@${u}>`).join("・") || "—";
    lines.push("", `▶ 続行希望: ${yes}`, `⏹ やめる: ${no}`, "*両方が「続行」で再戦が成立するよ。*");
  } else {
    const yesCount = cont.length;
    const noCount = stop.length;
    lines.push("", `▶ 続行賛成: ${yesCount}人　|　⏹ やめたい: ${noCount}人`, `*立て主（<@${p.host_id}>）が[続行]で成立。*`);
  }

  const embed = baseEmbed("🎴 続けるか、やめるか", PALETTE.STARGOLD).setDescription(lines.join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`decision:continue:${p.id}`).setLabel("続行").setStyle(ButtonStyle.Success).setEmoji("▶️"),
    new ButtonBuilder().setCustomId(`decision:stop:${p.id}`).setLabel("やめる").setStyle(ButtonStyle.Secondary).setEmoji("⏹️"),
  );
  return { embeds: [embed], components: [row] };
}

async function editPanel(client: Client, p: PanelRow, extraLine?: string): Promise<void> {
  try {
    const ch = await client.channels.fetch(p.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(p.message_id).catch(() => null);
    if (!msg) return;
    const rendered = renderPanelEmbed(p);
    if (extraLine) {
      const e = rendered.embeds[0];
      e.setDescription(((e.data as any).description ?? "") + "\n\n" + extraLine);
    }
    await msg.edit({ embeds: rendered.embeds, components: p.status === "open" ? rendered.components : [] });
  } catch { /* メッセージ消えてたら諦める */ }
}

// ─── パネル投下（各ゲームの settle から呼ぶ） ─────────
/**
 * 紐付きVCがあれば「続けるか、やめるか」パネルを投下する。
 * VC が無い（手動 /卓 経由で立てなかった勝負）はパネルを出さない。
 */
export async function postDecisionPanel(
  client: Client,
  guildId: string,
  linkType: LinkType,
  linkId: string,
  hostId: string,
  participantIds: string[],
): Promise<void> {
  const linked = findLinkedVC(linkType, linkId);
  if (!linked) return; // 紐付きVCなし

  // この勝負が settle したことを記録 → デポジット返却条件をクリア
  markLinkedVCSettled(linkType, linkId);

  const vc = await client.channels.fetch(linked.channel_id).catch(() => null);
  if (!vc || vc.type !== ChannelType.GuildVoice) return;
  const vcChannel = vc as VoiceChannel & TextBasedChannel;

  const deadline_at = new Date(Date.now() + DECISION_TIMEOUT_MS).toISOString();

  // 先に空レコード作って ID を貰い、メッセージを投下してから message_id を入れる
  const tempId = insertPanel({
    message_id: "PENDING",
    channel_id: linked.channel_id,
    guild_id: guildId,
    vc_id: linked.channel_id,
    link_type: linkType,
    link_id: linkId,
    host_id: hostId,
    participant_ids: JSON.stringify(participantIds),
    deadline_at,
    status: "open",
    votes_continue: "[]",
    votes_stop: "[]",
    warned: 0,
  });

  const fakePanel: PanelRow = {
    id: tempId, message_id: "PENDING", channel_id: linked.channel_id, guild_id: guildId,
    vc_id: linked.channel_id, link_type: linkType, link_id: linkId, host_id: hostId,
    participant_ids: JSON.stringify(participantIds), deadline_at, status: "open",
    votes_continue: "[]", votes_stop: "[]", warned: 0, created_at: new Date().toISOString(),
  };
  const rendered = renderPanelEmbed(fakePanel);

  try {
    const msg = await vcChannel.send({ embeds: rendered.embeds, components: rendered.components });
    db.prepare("UPDATE decision_panels SET message_id = ? WHERE id = ?").run(msg.id, tempId);
  } catch (err) {
    console.warn(`[decision] failed to post panel:`, err);
    setPanelStatus(tempId, "expired"); // 無効化
  }
}

// ─── ボタンハンドラ（src/index.ts から呼ぶ） ───────
export async function handleDecisionButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  const panelId = Number(idStr);
  const p = getPanel(panelId);
  if (!p) { await interaction.reply({ content: "このパネルはもう無効だよ。", ephemeral: true }); return; }
  if (p.status !== "open") { await interaction.reply({ content: "もう決まっちゃったみたい。", ephemeral: true }); return; }
  if (new Date(p.deadline_at).getTime() < Date.now()) {
    await expirePanel(interaction.client, p);
    await interaction.reply({ content: "時間切れだったみたい。", ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  const participants = parseList(p.participant_ids);
  const isPair = isOneOnOne(p.link_type);

  // 参加者だけが押せる（多人数の[賛成]も含む）
  if (!participants.includes(userId) && userId !== p.host_id) {
    await interaction.reply({ content: "この勝負に参加してた人だけが押せるよ。", ephemeral: true });
    return;
  }

  if (action === "continue") return onContinue(interaction, p, userId, isPair);
  if (action === "stop") return onStop(interaction, p, userId, isPair);
}

async function onContinue(interaction: ButtonInteraction, p: PanelRow, userId: string, isPair: boolean): Promise<void> {
  const cont = new Set(parseList(p.votes_continue));
  const stop = new Set(parseList(p.votes_stop));
  cont.add(userId); stop.delete(userId);
  setVotes(p.id, "continue", Array.from(cont));
  setVotes(p.id, "stop", Array.from(stop));

  const refreshed = getPanel(p.id)!;

  if (isPair) {
    const participants = parseList(p.participant_ids);
    const bothAgreed = participants.every((u) => cont.has(u));
    if (bothAgreed) {
      await interaction.deferUpdate().catch(() => {});
      await tryRestart(interaction.client, refreshed);
      return;
    }
  } else {
    if (userId === p.host_id) {
      await interaction.deferUpdate().catch(() => {});
      await tryRestart(interaction.client, refreshed);
      return;
    }
  }

  await interaction.update(renderPanelEmbed(refreshed)).catch(async () => {
    await interaction.reply({ content: "票を反映したよ。", ephemeral: true }).catch(() => {});
  });
}

async function onStop(interaction: ButtonInteraction, p: PanelRow, userId: string, isPair: boolean): Promise<void> {
  // 1v1: どちらかが [やめる] → 即解散
  // 多人数: 立て主が [やめる] → 即解散。参加者の [やめる] は意思表示のみ
  if (isPair || userId === p.host_id) {
    setPanelStatus(p.id, "stopped");
    await interaction.update({
      embeds: [baseEmbed("⏹️ お開き", PALETTE.NIGHT).setDescription("また今度ね。卓はそっと片付けるよ。")],
      components: [],
    }).catch(() => {});
    if (p.vc_id) await deleteLinkedVC(interaction.client, p.vc_id, "decisionPanel: やめる");
    return;
  }
  const cont = new Set(parseList(p.votes_continue));
  const stop = new Set(parseList(p.votes_stop));
  stop.add(userId); cont.delete(userId);
  setVotes(p.id, "continue", Array.from(cont));
  setVotes(p.id, "stop", Array.from(stop));
  const refreshed = getPanel(p.id)!;
  await interaction.update(renderPanelEmbed(refreshed)).catch(async () => {
    await interaction.reply({ content: "票を反映したよ。", ephemeral: true }).catch(() => {});
  });
}

// ─── 再戦立て（dispatcher） ─────────────────────────
async function tryRestart(client: Client, p: PanelRow): Promise<void> {
  try {
    let newLinkId: string | null = null;

    if (p.link_type === "sashi") {
      const { restartSashi } = require("./sashi/index");
      newLinkId = await restartSashi(client, Number(p.link_id), p.vc_id, p.guild_id);
    } else if (p.link_type === "saishoubu") {
      const { restartDuel } = require("./saishoubu/index");
      newLinkId = await restartDuel(client, Number(p.link_id), p.vc_id, p.guild_id);
    } else if (p.link_type === "board") {
      const { restartBoard } = require("./board/index");
      newLinkId = await restartBoard(client, Number(p.link_id), p.vc_id, p.guild_id);
    } else if (p.link_type === "chohan") {
      const { restartChohan } = require("./chohan/index");
      newLinkId = await restartChohan(client, Number(p.link_id), p.vc_id, p.guild_id);
    }

    if (newLinkId) {
      setLinkId(p.id, newLinkId);
      if (p.vc_id) updateLinkedVCLinkId(p.vc_id, newLinkId);
      // パネルは「続行成立」表示に上書き
      await editLatestAsContinued(client, p);
    } else {
      // 再戦失敗 → やめる扱い
      setPanelStatus(p.id, "stopped");
      if (p.vc_id) {
        await postPlainMessage(client, p.vc_id, "⚠️ 再戦の立て直しに失敗しちゃった（残高不足など）。卓はこのあと片付けるよ。");
        await deleteLinkedVC(client, p.vc_id, "decisionPanel: 再戦失敗");
      }
    }
  } catch (err) {
    console.error("[decision] restart failed:", err);
    setPanelStatus(p.id, "stopped");
    if (p.vc_id) await deleteLinkedVC(client, p.vc_id, "decisionPanel: 再戦エラー");
  }
}

async function editLatestAsContinued(client: Client, p: PanelRow): Promise<void> {
  try {
    const ch = await client.channels.fetch(p.channel_id).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await (ch as any).messages.fetch(p.message_id).catch(() => null);
    if (!msg) return;
    const e = baseEmbed("🎴 もう一勝負！", PALETTE.JADE).setDescription("再戦を立て直したよ。同じ卓で続けて。");
    await msg.edit({ embeds: [e], components: [] });
  } catch { /* ignore */ }
}

async function postPlainMessage(client: Client, channelId: string, text: string): Promise<void> {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch && "send" in ch) await (ch as any).send(text);
  } catch { /* ignore */ }
}

// ─── 期限処理 ────────────────────────────────────────
async function expirePanel(client: Client, p: PanelRow): Promise<void> {
  setPanelStatus(p.id, "expired");
  try {
    const ch = await client.channels.fetch(p.channel_id).catch(() => null);
    if (ch && "messages" in ch) {
      const msg = await (ch as any).messages.fetch(p.message_id).catch(() => null);
      if (msg) {
        await msg.edit({
          embeds: [baseEmbed("⏰ 時間切れ", PALETTE.NIGHT).setDescription("お開きにしよう。卓は片付けるね。")],
          components: [],
        }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
  if (p.vc_id) await deleteLinkedVC(client, p.vc_id, "decisionPanel: 期限切れ");
}

async function warnPanel(client: Client, p: PanelRow): Promise<void> {
  setWarned(p.id);
  await postPlainMessage(client, p.channel_id, "*30秒後に卓を閉じるよ。続けるならボタン押して。*");
}

// ─── tick: 警告/期限の点検 ───────────────────────────
let tickHandle: NodeJS.Timeout | null = null;

function tick(client: Client): void {
  const open = listOpenPanels();
  const now = Date.now();
  for (const p of open) {
    const remain = new Date(p.deadline_at).getTime() - now;
    if (remain <= 0) {
      // 期限切れ → 解散
      void expirePanel(client, p);
    } else if (!p.warned && remain <= WARNING_BEFORE_MS) {
      void warnPanel(client, p);
    }
  }
}

// ─── 起動時フック（src/index.ts から呼ぶ） ────────────
export function bootDecisionPanels(client: Client): void {
  // 起動時に過ぎてるパネルを片付ける
  const open = listOpenPanels();
  for (const p of open) {
    if (new Date(p.deadline_at).getTime() < Date.now()) {
      void expirePanel(client, p);
    }
  }
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => tick(client), TICK_INTERVAL_MS);
  console.log(`[decision] tick started (${open.length} open panel(s) at boot)`);
}
