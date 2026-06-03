/**
 * /勝負 — 対人ゲームの統合入口
 * ─────────────────────────────────────────────────────────
 * 丁半（多人数）・チンチロ対戦（1v1）・サシ（1v1エスクロー）を1コマンドに集約。
 * 各サブコマンドは既存ゲームの内部関数（openBon / saiChallenge / sashiChallenge）へ委譲。
 * ※ 板（公開市場）は別種なので /板 のまま独立。
 */
import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { openBon } from "../chohan";
import { challenge as saiChallenge } from "../saishoubu";
import { challenge as sashiChallenge } from "../sashi";

export const shoubuCommand = new SlashCommandBuilder()
  .setName("勝負")
  .setDescription("⚔️ 人と賭ける（丁半・チンチロ対戦・サシ）")
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
  );

export async function handleShoubuCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "丁半": return openBon(interaction);
    case "チンチロ": return saiChallenge(interaction);
    case "サシ": return sashiChallenge(interaction);
  }
}
