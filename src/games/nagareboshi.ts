/**
 * /流れ星 — 星占い（純粋なフレーバー＋エテル回収）
 * ─────────────────────────────────────────────────────────
 * 1日5回まで（初回無料、2〜5回目は cfg.daily_base / 3 切り捨て）。
 * 報酬は出さず、占い料は完全消滅（誰にも入らない＝burn 相当）。
 * 流れ星（5%）のみ アステル好感度 +1 のおまけ。
 *
 * 設計意図:
 *  - エテルの 100% 回収 = インフレ抑制
 *  - 触る回数を増やすフレーバー機能（賭けじゃない遊び）
 *  - 台詞バリエーション豊富で何度引いても飽きさせない
 */
import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { db, getServerConfig, runTransaction } from "../core/db";
import { adjustBalance, ensureUser, getBalance } from "../core/bank";
import { baseEmbed, errorEmbed, COLORS } from "../ui/embeds";
import { PALETTE } from "../world.config";
import { addressOwner } from "../core/ownerAddress";

const MAX_PER_DAY = 5;

type Outcome = {
  key: string;
  weight: number;
  label: string;
  color: number;
  special?: "affection+1";
};

// 占い結果（報酬ナシ・全てフレーバー）。重み合計 100。
const OUTCOMES: Outcome[] = [
  { key: "daikichi",    weight: 5,  label: "大吉",   color: COLORS.GOLD },
  { key: "chukichi",    weight: 15, label: "中吉",   color: COLORS.WIN },
  { key: "shokichi",    weight: 30, label: "小吉",   color: PALETTE.AZURE },
  { key: "kyou",        weight: 30, label: "凶",     color: COLORS.LOSE },
  { key: "daikyou",     weight: 15, label: "大凶",   color: PALETTE.ECLIPSE },
  { key: "nagareboshi", weight: 5,  label: "流れ星", color: PALETTE.STARGOLD, special: "affection+1" },
];

// 結果ごとの台詞バリエーション（5種ずつ）
// アステル素モード: 一人称「わたし」/呼称「きみ」/気だるげ余裕の現代口語
// 詩的に寄せすぎず、運勢の内容がパッと分かる文を優先
const LINES: Record<string, string[]> = {
  daikichi: [
    "うわ、大吉。今日は何やってもうまくいくよ、たぶん。",
    "絶好調。いまなら大胆にいっていい日。",
    "こんなにいい目、滅多に出ないよ。せっかくなら使お。",
    "星の並び、めっちゃ良い。攻めていいよ。",
    "強気で行っていい一日。流れがきみに来てる。",
  ],
  chukichi: [
    "悪くない日。慎重にいけば、ちゃんと伸びるよ。",
    "順調。普段通りに過ごせば、ちょっと良いことあるかも。",
    "追い風きてる。無理さえしなければ大丈夫。",
    "そこそこ。守りつつ攻める日って感じ。",
    "穏やかに良い日。攻めすぎなければOK。",
  ],
  shokichi: [
    "ちょっとだけ運がいい日。深追いはしないこと。",
    "悪くはない。けど、欲張ると一気にひっくり返るやつ。",
    "小さい良いこと、ひとつくらいあるかも。",
    "そっと一歩。それでちょうどいい日。",
    "派手じゃないけど、十分。って感じの日。",
  ],
  kyou: [
    "うーん、今日はちょっと運が悪いかも。無理しないで。",
    "あんまり良くない。今日は控えめにね。",
    "ちょっと雲行きが怪しい。賭けるなら小さく。",
    "今日は様子見の日。動かないのも選択肢。",
    "焦らないで。今日は一旦立ち止まろ。",
  ],
  daikyou: [
    "…今日はやめときな。本当に運が悪い日。",
    "悪いけど、大凶。賭場から離れた方がいい。",
    "うわ、これは厳しい。今日は何もしないのがいちばん。",
    "今日のきみ、わたしから見ても危ない。引いて、引いて。",
    "蝕の符。動けば動くほど絡まるから、休んで。",
  ],
  nagareboshi: [
    "あっ、流れ星！願いごと、間に合った？",
    "お、本物の流れ星。珍しいの引いたね、ラッキー。",
    "ほら、見て。…願ってもいいんだよ。",
    "わたしも久しぶりに見た。きみ、運いいね。",
    "おっ、流れた。今のは内緒のおまけ、ね。",
  ],
};

export const nagareCommand = new SlashCommandBuilder()
  .setName("流れ星")
  .setDescription("✨ アステルに星占いをしてもらう（1日5回・初回無料）");

function pickOutcome(): Outcome {
  const total = OUTCOMES.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of OUTCOMES) {
    if ((r -= o.weight) <= 0) return o;
  }
  return OUTCOMES[OUTCOMES.length - 1];
}

function pickLine(key: string): string {
  const arr = LINES[key] ?? ["…"];
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function handleNagareCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "サーバー内でのみ使えるよ。", ephemeral: true });
    return;
  }
  const userId = interaction.user.id;
  ensureUser(userId, guildId);

  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT nagareboshi_date, nagareboshi_count FROM users WHERE user_id = ?",
  ).get(userId) as { nagareboshi_date: string | null; nagareboshi_count: number } | undefined;
  const todayCount = row?.nagareboshi_date === today ? row.nagareboshi_count : 0;

  if (todayCount >= MAX_PER_DAY) {
    await interaction.reply({
      embeds: [errorEmbed(`今日はもう ${MAX_PER_DAY} 回見ちゃった。また明日にしよっか。`)],
      ephemeral: true,
    });
    return;
  }

  // 占い料 = デイリー基本 ÷ 3（/管理 設定 → 経済 から引っ張る）
  const cfg = getServerConfig(guildId);
  const unit = Math.max(1, Math.floor(cfg.daily_base / 3));
  const cost = todayCount === 0 ? 0 : unit;

  if (cost > 0 && getBalance(userId, guildId) < cost) {
    await interaction.reply({
      embeds: [errorEmbed(`占ってもらうには ◈${cost} 要るよ。残高が足りないみたい。`)],
      ephemeral: true,
    });
    return;
  }

  const pick = pickOutcome();
  const line = addressOwner(pickLine(pick.key), userId);

  runTransaction(() => {
    if (cost > 0) {
      // 占い料は完全消滅（誰にも入らない＝burn）。adjustBalance に -cost で記録だけ残す。
      adjustBalance(userId, -cost, `流れ星: 占い料（${pick.label}）`, "nagareboshi", guildId);
    }
    db.prepare("UPDATE users SET nagareboshi_date = ?, nagareboshi_count = ? WHERE user_id = ?")
      .run(today, todayCount + 1, userId);
  });

  // 流れ星限定: アステル好感度 +1
  let bonusNote = "";
  if (pick.special === "affection+1") {
    try {
      const { addAffection } = require("../core/db");
      addAffection(userId, 1);
      bonusNote = "*（アステルとの星約が、ほんの少し近づいた。）*";
    } catch { /* ignore — non-critical */ }
  }

  const lines = [
    `*「${line}」*`,
    bonusNote,
    "",
    cost > 0 ? `💸 占い料: ◈${cost}` : "💸 今回は無料（初回）",
    `📜 今日の占い: ${todayCount + 1} / ${MAX_PER_DAY}`,
  ].filter(Boolean);

  const embed = baseEmbed(`✨ ${pick.label}`, pick.color).setDescription(lines.join("\n"));
  await interaction.reply({ embeds: [embed] });
}
