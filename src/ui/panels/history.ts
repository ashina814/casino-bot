/**
 * 取引履歴パネル（ページネーション）
 *
 * `transaction_logs` から直近 N 件を 10件/ページで表示。
 * 前/次ボタンでページ送り。
 */
import {
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { db } from "../../core/db";
import { baseEmbed, COLORS } from "../embeds";
import { safeReply, safeEditReply } from "../../core/safeReply";

const PAGE_SIZE = 10;
const MAX_PAGES = 5; // 直近 50 件まで

type LogRow = {
  amount: number;
  reason: string;
  game: string | null;
  created_at: string;
};

function fetchPage(userId: string, page: number): { rows: LogRow[]; total: number } {
  const offset = page * PAGE_SIZE;
  const rows = db.prepare(`
    SELECT amount, reason, game, created_at FROM transaction_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(userId, PAGE_SIZE, offset) as LogRow[];
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM transaction_logs WHERE user_id = ?").get(userId) as { c: number };
  return { rows, total: Math.min(totalRow.c, PAGE_SIZE * MAX_PAGES) };
}

function formatRow(r: LogRow): string {
  const sign = r.amount >= 0 ? "+" : "";
  const amountStr = `${sign}◈${r.amount.toLocaleString()}`;
  const timestamp = r.created_at.slice(5, 16).replace("T", " "); // MM-DD HH:MM
  const game = r.game ? ` [${r.game}]` : "";
  return `\`${timestamp}\` ${amountStr}　${r.reason}${game}`;
}

function buildButtons(userId: string, page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`history_page_${userId}_${Math.max(0, page - 1)}`)
      .setLabel("◀ 前")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("history_noop")
      .setLabel(`${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`history_page_${userId}_${Math.min(totalPages - 1, page + 1)}`)
      .setLabel("次 ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

export async function showHistoryPanel(interaction: ButtonInteraction, page = 0): Promise<void> {
  const userId = interaction.user.id;
  const { rows, total } = fetchPage(userId, page);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const embed = baseEmbed("📋 取引履歴", COLORS.GOLD)
    .setDescription(
      rows.length === 0
        ? "*まだ取引の履歴はないみたい。*"
        : rows.map(formatRow).join("\n"),
    )
    .setFooter({ text: `直近 ${Math.min(total, PAGE_SIZE * MAX_PAGES)} 件まで表示` });

  const buttons = buildButtons(userId, page, totalPages);

  if (interaction.replied || interaction.deferred) {
    await safeEditReply(interaction, { embeds: [embed], components: [buttons] });
  } else {
    await safeReply(interaction, { embeds: [embed], components: [buttons], ephemeral: true });
  }
}

/**
 * ページ送りボタンの押下を処理する。customId は `history_page_<userId>_<page>` の形式。
 * 他人の履歴ボタンを押されてもブロック。
 */
export async function handleHistoryButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === "history_noop") return;
  const m = interaction.customId.match(/^history_page_(\d+)_(\d+)$/);
  if (!m) return;
  const targetUser = m[1];
  if (targetUser !== interaction.user.id) {
    await safeReply(interaction, { content: "ほかの人の履歴は覗けないよ。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  await showHistoryPanel(interaction, Number(m[2]));
}
