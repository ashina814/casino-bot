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
      .setName("巻物")
      .setDescription("🎰 星辰の巻（スロット）を回す")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("丁半")
      .setDescription("🎴 丁半博打 — 丁か半か")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("札遊び")
      .setDescription("🃏 星札勝負（ブラックジャック）")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("暴落")
      .setDescription("📈 星昇り — どこまで耐えられるか")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("輪盤")
      .setDescription("🎡 運命の星盤（ルーレット）")
  )
  .addSubcommand((sub) =>
    sub
      .setName("賽")
      .setDescription("🎲 チンチロ — 3つのサイコロを振る")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("賭けるエテルの額").setRequired(false).setMinValue(50).setMaxValue(1000000000)
      )
  );

// ─── Router ────────────────────────────────────────────

export async function handleAsobuCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "巻物":
      return handleSlotsCommand(interaction);
    case "丁半":
      return handleHighlowCommand(interaction);
    case "札遊び":
      return handleBlackjackCommand(interaction);
    case "暴落":
      return handleCrashCommand(interaction);
    case "輪盤":
      return handleRouletteCommand(interaction);
    case "賽":
      return handleChinchiroCommand(interaction);
  }
}
