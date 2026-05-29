/**
 * 囃子（はやし）— 他のプレイヤーを煽る/応援する公開コマンド
 * ─────────────────────────────────────────────────────────
 * Iter.2: 無料＋クールダウン。将来ショップの「囃子権」所持チェックを
 *   hasCheerRight() に差し込むだけでゲートできるようフックを用意。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { errorEmbed } from "../ui/embeds";

const COOLDOWN_MS = 60_000; // 60秒
const lastUsed = new Map<string, number>();

const TAUNTS = [
  "ほら、逃げないで全部張りなよ。……ふふ、見ててあげる。",
  "その手、ほんとに大丈夫？ わたしは止めないけど。",
  "弱気だなあ。星はね、思い切った人に微笑むんだよ？",
  "今ここで降りるの？ もったいない。",
  "ふーん、その程度？ きみならもっといけるでしょ。",
];
const CHEERS = [
  "いいよ、その意気。きみの星、ちゃんと光ってる。",
  "落ち着いていこ。流れはきみに来てるよ。",
  "大丈夫、わたしがついてる。思い切って。",
  "ここまでよく粘った。次の一手、信じてる。",
  "うん、いい目だ。今夜はきみの夜かもね。",
];

function pick<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

/** 将来: ショップの囃子権所持チェックを差し込むフック（今は常に true） */
function hasCheerRight(_userId: string): boolean {
  return true;
}

export const cheerCommand = new SlashCommandBuilder()
  .setName("囃子")
  .setDescription("🎭 賭場の誰かを煽る・応援する")
  .addUserOption((o) => o.setName("相手").setDescription("囃す相手").setRequired(true))
  .addStringOption((o) =>
    o.setName("種類").setDescription("煽る or 応援").setRequired(false)
      .addChoices({ name: "煽る", value: "taunt" }, { name: "応援", value: "cheer" }),
  );

export async function handleCheerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const target = interaction.options.getUser("相手", true);
  const kind = interaction.options.getString("種類") ?? "taunt";

  if (target.id === userId) {
    await interaction.reply({ embeds: [errorEmbed("自分を囃してどうするのさ。")], ephemeral: true });
    return;
  }
  if (target.bot) {
    await interaction.reply({ embeds: [errorEmbed("ボットは囃せないよ。")], ephemeral: true });
    return;
  }

  if (!hasCheerRight(userId)) {
    await interaction.reply({ embeds: [errorEmbed("囃子権が必要だよ。（商店で手に入る予定）")], ephemeral: true });
    return;
  }

  const now = Date.now();
  const last = lastUsed.get(userId) ?? 0;
  const remain = COOLDOWN_MS - (now - last);
  if (remain > 0) {
    await interaction.reply({ embeds: [errorEmbed(`続けては囃せないよ。あと ${Math.ceil(remain / 1000)} 秒待ってね。`)], ephemeral: true });
    return;
  }
  lastUsed.set(userId, now);

  const line = kind === "cheer" ? pick(CHEERS) : pick(TAUNTS);
  const verb = kind === "cheer" ? "応援" : "煽り";
  await interaction.reply({
    content: `🎭 **${interaction.user.displayName}** が <@${target.id}> に${verb}！\n*「${line}」*`,
  });
}
