/**
 * /勝負 — 対人ゲームの統合入口
 * ─────────────────────────────────────────────────────────
 * 丁半（多人数）・チンチロ対戦（1v1）・サシ（1v1エスクロー）・板（公開市場）を1コマンドに集約。
 * 各サブコマンドは既存ゲームの内部関数へ委譲（実装本体は移動しない）。
 *   板だけは「立てる / 一覧」と2階層あるので subcommandGroup として組む。
 */
import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { openBon } from "../chohan";
import { challenge as saiChallenge } from "../saishoubu";
import { challenge as sashiChallenge } from "../sashi";
import { handleBoardCommand } from "../board";
import { challenge as bjdChallenge } from "../bjduel";
import { challenge as indianChallenge } from "../indian";
import { challenge as pokerChallenge } from "../poker";

export const shoubuCommand = new SlashCommandBuilder()
  .setName("勝負")
  .setDescription("⚔️ 人と賭ける（丁半・チンチロ対戦・サシ・板）")
  .addSubcommand((sc) =>
    sc
      .setName("丁半")
      .setDescription("🀄 多人数の丁半。胴が振り、丁/半に分かれて張る")
      .addIntegerOption((o) => o.setName("締切分").setDescription("自動で振るまでの分数（任意・1〜60）").setRequired(false).setMinValue(1).setMaxValue(60))
      .addStringOption((o) =>
        o.setName("面").setDescription("自分の最初の賭け（任意）").setRequired(false)
          .addChoices({ name: "丁（偶）", value: "cho" }, { name: "半（奇）", value: "han" }),
      )
      .addIntegerOption((o) => o.setName("賭け").setDescription("最初の賭け額（面を選んだ時）").setRequired(false).setMinValue(1)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("チンチロ")
      .setDescription("🎲 1対1のチンチロ対戦（BOTが両者の賽を振って即決着）")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額・勝者総取り）").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("サシ")
      .setDescription("⚔️ 1対1の私的決闘（エスクロー・申告制）")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額）").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("内容").setDescription("勝負の内容（GF/麻雀など）").setRequired(false).setMaxLength(80)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("BJ")
      .setDescription("🃏 ブラックジャック対人戦 — 2人で21に近づける（手は全公開）")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額・勝者総取り）").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("インディアン")
      .setDescription("🪶 インディアンポーカー — 相手の手は見えて自分の手は見えない心理戦")
      .addUserOption((o) => o.setName("相手").setDescription("対戦相手").setRequired(true))
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（両者同額・勝者総取り）").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("ポーカー")
      .setDescription("🃏 5枚交換ポーカー — 相手指定でサシ・未指定でオープン募集")
      .addIntegerOption((o) => o.setName("額").setDescription("賭け金（参加者全員同額）").setRequired(true).setMinValue(1))
      .addUserOption((o) => o.setName("相手").setDescription("相手指定でサシ（未指定なら誰でも参加できるオープン）").setRequired(false)),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("板")
      .setDescription("📋 何でも賭けられる公開市場")
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
      .addSubcommand((sc) => sc.setName("一覧").setDescription("進行中の議題を表示")),
  );

export async function handleShoubuCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  if (group === "板") return handleBoardCommand(interaction);
  switch (interaction.options.getSubcommand()) {
    case "丁半": return openBon(interaction);
    case "チンチロ": return saiChallenge(interaction);
    case "サシ": return sashiChallenge(interaction);
    case "BJ": return bjdChallenge(interaction);
    case "インディアン": return indianChallenge(interaction);
    case "ポーカー": return pokerChallenge(interaction);
  }
}
