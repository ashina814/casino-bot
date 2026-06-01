/**
 * /遊ぶ — 全ゲーム統合コマンド
 *
 * サブコマンドで各ゲームを選択。
 * 個別の /slots, /blackjack 等は廃止し、ここに集約。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { handleSlotsCommand } from "./slots/index";
import { handleHighlowCommand } from "./highlow/index";
import { handleBlackjackCommand } from "./blackjack/index";
import { handleCrashCommand } from "./crash/index";
import { handleRouletteCommand } from "./roulette/index";
import { handleChinchiroCommand } from "./chinchiro/index";

// ─── Command Definition ────────────────────────────────

export const asobuCommand = new SlashCommandBuilder()
  .setName("遊ぶ")
  .setDescription("🎰 星約の賭場で遊ぶ")
  .addSubcommand((sub) =>
    sub
      .setName("スロット")
      .setDescription("🎰 スロットを回す")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("丁半")
      .setDescription("🎴 丁半 — 丁（偶）か半（奇）か")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("ブラックジャック")
      .setDescription("🃏 ブラックジャック")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("クラッシュ")
      .setDescription("📈 クラッシュ — どこまで耐えられるか")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("ルーレット")
      .setDescription("🎡 ルーレット")
  )
  .addSubcommand((sub) =>
    sub
      .setName("チンチロ")
      .setDescription("🎲 チンチロ — 3つのサイコロを振る")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  );

// ─── Router ────────────────────────────────────────────

export async function handleAsobuCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "スロット":
      return handleSlotsCommand(interaction);
    case "丁半":
      return handleHighlowCommand(interaction);
    case "ブラックジャック":
      return handleBlackjackCommand(interaction);
    case "クラッシュ":
      return handleCrashCommand(interaction);
    case "ルーレット":
      return handleRouletteCommand(interaction);
    case "チンチロ":
      return handleChinchiroCommand(interaction);
  }
}
