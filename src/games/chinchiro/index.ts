/**
 * 🎲 チンチロ（賭博）
 *
 * 3つのサイコロを振る伝統的な賭博。最大3投。
 * - 終了役（ピンゾロ/ゾロ目/シゴロ/ヒフミ）が出たら即決着
 * - 目（ペア+1）の時はプレイヤーが「止める」or「もう一度振る」を選択
 * - メナシは自動再振り（カウントは消費）、3投全部メナシならプッシュ
 *
 * 設計方針（インフレ抑制）:
 * - 単発オッズ固定、プログレッシブ無し
 * - 「もう一度振る」選択でリスクをユーザーに負わせる（戦略性）
 * - RTP ≈ 95%（ハウスエッジ 5%）
 */
import {
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
  EmbedBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { adjustBalance, getBalance, recordWin, recordLoss, recordWager, ensureUser, getProfile } from "../../core/bank";
import { consumeWinBonus, consumeLossProtection, consumeReroll } from "../../core/items";
import { getServerConfig, acquireGameLock, releaseGameLock } from "../../core/db";
import {
  getEffectiveHouseEdge,
  getFukuWeight,
  distributeHouseEarnings,
  distributeFukuTax,
  addExp,
  checkSubstituteBlessing,
  getTierByKey,
} from "../../core/economy";
import { dialogueWin, dialogueLose, type DialogueContext } from "../../core/dialogue";
import { gameResultEmbed, baseEmbed, COLORS } from "../../ui/embeds";

const DIE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"]; // 1..6

const MAX_ROLLS = 3;
const ROLL_BUTTON_TIMEOUT_MS = 30_000;

type Dice = [number, number, number];

export type Hand =
  | { type: "pinzoro" }            // 1-1-1
  | { type: "zorome"; value: number } // 2-2-2 .. 6-6-6
  | { type: "shigoro" }            // 4-5-6
  | { type: "hifumi" }             // 1-2-3
  | { type: "me"; score: number }  // ペア + 単
  | { type: "menashi" };

function rollDice(): Dice {
  return [
    1 + Math.floor(Math.random() * 6),
    1 + Math.floor(Math.random() * 6),
    1 + Math.floor(Math.random() * 6),
  ];
}

export function evaluate(dice: Dice): Hand {
  const sorted = [...dice].sort((a, b) => a - b);
  const [a, b, c] = sorted;
  if (a === b && b === c) {
    if (a === 1) return { type: "pinzoro" };
    return { type: "zorome", value: a };
  }
  if (a === 4 && b === 5 && c === 6) return { type: "shigoro" };
  if (a === 1 && b === 2 && c === 3) return { type: "hifumi" };
  if (a === b) return { type: "me", score: c };
  if (b === c) return { type: "me", score: a };
  // a == c は理論上ペアだが上記でカバー済み
  return { type: "menashi" };
}

/** 役の強さを数値化（大きいほど強い）。 */
export function handRank(hand: Hand): number {
  switch (hand.type) {
    case "pinzoro": return 1000;
    case "zorome":  return 800 + hand.value;  // 802〜806
    case "shigoro": return 700;
    case "me":      return 100 + hand.score;  // 101〜106
    case "menashi": return 0;
    case "hifumi":  return -100;              // ヒフミは最弱（自爆）
  }
}

/** 役の基本倍率（比較ベース・どちらが勝った時の純配当倍率の絶対値）。 */
function handBaseMul(hand: Hand): number {
  switch (hand.type) {
    case "pinzoro": return 5;
    case "zorome":  return 3;
    case "shigoro": return 2;
    case "me":      return 1;
    case "menashi": return 1;
    case "hifumi":  return 2;  // ヒフミは負ける側が2倍払う
  }
}

export type CompareResult = {
  /** "player_win" | "dealer_win" | "push" */
  result: "player_win" | "dealer_win" | "push";
  /** プレイヤー視点の純配当倍率（プラス=利益、マイナス=損失、0=プッシュ）。houseEdge 適用前。 */
  mul: number;
};

/**
 * プレイヤーとアステルの手を比較して配当倍率を返す。
 *
 * 特殊ルール:
 * - プレイヤー ヒフミ → 必ず -2倍
 * - アステル ヒフミ かつ プレイヤー非ヒフミ → +2倍（アステルの自爆）
 * - 両方ヒフミ → プッシュ
 * - 同点（同じ目スコア、両方メナシ） → **アステル勝ち** （ハウスエッジ根幹）
 *
 * 通常比較:
 * - プレイヤー強 → +勝者役 mul
 * - アステル強 → -アステル役 mul
 */
export function compareHands(player: Hand, dealer: Hand): CompareResult {
  // ヒフミ ルール
  if (player.type === "hifumi" && dealer.type === "hifumi") {
    return { result: "push", mul: 0 };
  }
  if (player.type === "hifumi") {
    return { result: "dealer_win", mul: -2 };
  }
  if (dealer.type === "hifumi") {
    return { result: "player_win", mul: 2 };
  }

  const pr = handRank(player);
  const dr = handRank(dealer);

  if (pr > dr) {
    // プレイヤー勝ち：プレイヤーの役 mul
    return { result: "player_win", mul: handBaseMul(player) };
  }
  if (pr < dr) {
    // プレイヤー負け：アステルの役 mul（マイナス）
    return { result: "dealer_win", mul: -handBaseMul(dealer) };
  }
  // 同点：ハウスが取る（プレイヤーの負け、賭金分のみ）
  return { result: "dealer_win", mul: -1 };
}

export function describeHand(hand: Hand): string {
  switch (hand.type) {
    case "pinzoro": return "🌟 **ピンゾロ**！1-1-1";
    case "zorome":  return `🎯 **ゾロ目**！${hand.value}-${hand.value}-${hand.value}`;
    case "shigoro": return "🔥 **シゴロ**！4-5-6";
    case "hifumi":  return "💀 **ヒフミ**…1-2-3（倍付け没収）";
    case "me":      return `🎲 **目** スコア **${hand.score}**`;
    case "menashi": return "🌀 **メナシ**（揃いも特別役も無し）";
  }
}

function isTerminalHand(hand: Hand): boolean {
  // メナシ・目 以外はすべて終了役
  return hand.type !== "me" && hand.type !== "menashi";
}

export function diceDisplay(d: Dice): string {
  return `┃ ${DIE_FACES[d[0]-1]} ┃ ${DIE_FACES[d[1]-1]} ┃ ${DIE_FACES[d[2]-1]} ┃`;
}

/**
 * アニメ無しの自動振り（胴戦略）。対人戦などで両者を同一戦略で振らせるための共有関数。
 * 戦略: 終了役 or 目スコア≥5 で止め、目1〜4 と メナシ は再振り（最大3投）。
 */
export function autoRollHand(): { hand: Hand; dice: Dice } {
  let dice: Dice = [1, 1, 1];
  let hand: Hand = { type: "menashi" };
  for (let rollNo = 1; rollNo <= MAX_ROLLS; rollNo += 1) {
    dice = rollDice();
    hand = evaluate(dice);
    const meStop = hand.type === "me" && hand.score >= 5;
    if (isTerminalHand(hand) || meStop) break;
    // 目1〜4 / メナシ は残り投数があれば振り直し
  }
  return { hand, dice };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public Entry ─────────────────────────────────────────

export async function handleChinchiroCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  if (!acquireGameLock(userId, "chinchiro")) {
    await interaction.reply({ content: "もう遊んでる最中だよ。終わるまで待ってね。", ephemeral: true });
    return;
  }

  try {
    await playChinchiro(interaction, guildId, userId);
  } finally {
    releaseGameLock(userId);
  }
}

export async function playChinchiro(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  guildId: string,
  userId: string,
  overrideBet?: number,
): Promise<void> {
  const cfg = getServerConfig(guildId);
  const profile = ensureUser(userId, guildId);
  const tier = getTierByKey(profile.tier);

  const bet = overrideBet ?? (interaction as ChatInputCommandInteraction).options?.getInteger?.("bet") ?? cfg.min_bet;

  if (bet < cfg.min_bet) {
    const msg = { content: `最低ベットは ◈${cfg.min_bet} からだよ。`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
    else await interaction.reply(msg);
    return;
  }

  if (bet > tier.betCap) {
    const msg = { content: `きみの星位(${tier.emoji}${tier.name})だと ◈${tier.betCap.toLocaleString()} までしか賭けられないよ。`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
    else await interaction.reply(msg);
    return;
  }

  // 賭金が払えれば OK（ヒフミ時の追加徴収は残高不足ならスキップする設計）
  const deductResult = adjustBalance(userId, -bet, "chinchiro_bet", "chinchiro");
  if (!deductResult.ok) {
    const msg = { content: "エテルが足りないみたい。", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
    else await interaction.reply(msg);
    return;
  }
  recordWager(userId, bet);
  try { require("../../core/db").addGamePlayAffection(userId); } catch {}

  // 初回 embed
  const startEmbed = baseEmbed("🎲 チンチロ", COLORS.GOLD).setDescription(
    [
      "*「さあ…茶碗に振ってみい。」*",
      "",
      "┃ ❓ ┃ ❓ ❓ ❓ ┃",
      "",
      `ベット: ◈${bet.toLocaleString()} / 残投数: ${MAX_ROLLS}`,
    ].join("\n")
  );

  let reply: any;
  if (interaction.deferred || interaction.replied) {
    reply = await interaction.followUp({ embeds: [startEmbed], fetchReply: true });
  } else {
    reply = await interaction.reply({ embeds: [startEmbed], fetchReply: true });
  }

  await runRollLoop(reply, guildId, userId, bet, profile.tier);
}

/**
 * 振りループ：最大MAX_ROLLS回。
 * - 振ってシェイクアニメ
 * - 評価
 * - 終了役 or 最終投 → 決着
 * - メナシ → 自動再振り（カウント消費）
 * - 目 → プレイヤーに選択ボタン
 */
async function runRollLoop(
  reply: any,
  guildId: string,
  userId: string,
  bet: number,
  tierKey: string,
): Promise<void> {
  let rollNo = 0;
  let finalDice: Dice = [1, 1, 1];
  let finalHand: Hand = { type: "menashi" };

  // 二度振りの権（装備中なら消費して投数+1）
  const rerollUsed = consumeReroll(userId);
  const playerMaxRolls = MAX_ROLLS + (rerollUsed ? 1 : 0);

  while (rollNo < playerMaxRolls) {
    rollNo += 1;

    // ── シェイクアニメ ──
    for (let f = 0; f < 4; f += 1) {
      const shake: Dice = [
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
      ];
      const e = baseEmbed("🎲 チンチロ", COLORS.GOLD).setDescription(
        [
          `*「振るよ……」*`,
          "",
          diceDisplay(shake),
          "",
          `ベット: ◈${bet.toLocaleString()} / 第${rollNo}投 (残り${playerMaxRolls - rollNo + 1})${rerollUsed ? " ✨二度振り" : ""}`,
        ].join("\n")
      );
      await reply.edit({ embeds: [e], components: [] });
      await sleep(220);
    }

    // ── 確定 ──
    const dice = rollDice();
    const hand = evaluate(dice);
    finalDice = dice;
    finalHand = hand;

    const handLabel = describeHand(hand);
    const remainingRolls = playerMaxRolls - rollNo;

    // ── メナシは自動再振り（ただし最終投なら決着） ──
    if (hand.type === "menashi" && rollNo < playerMaxRolls) {
      const e = baseEmbed("🎲 チンチロ", COLORS.GOLD).setDescription(
        [
          handLabel,
          "",
          diceDisplay(dice),
          "",
          `第${rollNo}投 → 自動で再振り… (残り${remainingRolls})`,
        ].join("\n")
      );
      await reply.edit({ embeds: [e], components: [] });
      await sleep(1500);
      continue;
    }

    // ── 終了役 → プレイヤー手確定（アステルフェーズへ） ──
    if (isTerminalHand(hand)) {
      await settleVsDealer(reply, guildId, userId, bet, tierKey, hand, dice);
      return;
    }

    // ── 目 ──
    if (hand.type === "me") {
      // 最終投なら確定
      if (rollNo >= playerMaxRolls) {
        await settleVsDealer(reply, guildId, userId, bet, tierKey, hand, dice);
        return;
      }

      // 選択ボタン提示
      const proceed = await askRerollChoice(reply, dice, hand, bet, rollNo, remainingRolls, userId);
      if (proceed === "stop") {
        await settleVsDealer(reply, guildId, userId, bet, tierKey, hand, dice);
        return;
      }
      // proceed === "reroll" → ループ続行
    }
  }

  // ── 3投全部メナシ → プレイヤー手は「メナシ」確定（アステルフェーズへ） ──
  await settleVsDealer(reply, guildId, userId, bet, tierKey, finalHand, finalDice);
}

/**
 * 目が出た時の「止める / もう一度振る」選択を待つ。
 * collector で30秒、タイムアウト時は "stop"（保守的なデフォルト）。
 */
async function askRerollChoice(
  reply: any,
  dice: Dice,
  hand: Extract<Hand, { type: "me" }>,
  bet: number,
  rollNo: number,
  remaining: number,
  userId: string,
): Promise<"stop" | "reroll"> {
  const e = baseEmbed("🎲 チンチロ", COLORS.GOLD).setDescription(
    [
      describeHand(hand),
      "",
      diceDisplay(dice),
      "",
      `**止めるか、もう一度振るか…**（残り ${remaining}回）`,
      "",
      "・**止める** → 今の目で決着",
      "・**もう一度振る** → 上書き。ヒフミやメナシ続きのリスクあり",
    ].join("\n")
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`chinchiro_stop_${bet}`)
      .setLabel(`✋ 止める (${hand.score})`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`chinchiro_reroll_${bet}`)
      .setLabel(`🎲 もう一度振る (残り${remaining})`)
      .setStyle(ButtonStyle.Danger),
  );
  await reply.edit({ embeds: [e], components: [row] });

  return new Promise((resolve) => {
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: ROLL_BUTTON_TIMEOUT_MS,
      filter: (i: ButtonInteraction) => i.user.id === userId,
    });
    collector.on("collect", async (btn: ButtonInteraction) => {
      if (btn.customId.startsWith("chinchiro_stop_")) {
        await btn.deferUpdate();
        collector.stop("stop");
        resolve("stop");
      } else if (btn.customId.startsWith("chinchiro_reroll_")) {
        await btn.deferUpdate();
        collector.stop("reroll");
        resolve("reroll");
      }
    });
    collector.on("end", (_: any, reason: string) => {
      if (reason !== "stop" && reason !== "reroll") {
        resolve("stop"); // タイムアウト時は保守的に止める
      }
    });
  });
}

/**
 * アステルの振りフェーズ。プレイヤーが手を確定した後に呼ばれる。
 * 戦略（決定論的）:
 * - メナシ → 自動再振り（最大3投）
 * - 終了役（ピンゾロ／ゾロ目／シゴロ／ヒフミ） → 即止め
 * - 目 score 5,6 → 止め
 * - 目 score 1〜4 → 振り直す（残り回数があれば）
 * - 3投目で強制確定
 */
async function dealerRollPhase(
  reply: any,
  bet: number,
  playerHand: Hand,
  playerDice: Dice,
): Promise<{ dealerHand: Hand; dealerDice: Dice }> {
  // 導入演出
  const introEmbed = baseEmbed("🎲 チンチロ — アステルの番", COLORS.GOLD).setDescription(
    [
      "*「さて、わたしの番だね。」*",
      "",
      `あなた: ${diceDisplay(playerDice)}`,
      `　└ ${describeHand(playerHand)}`,
      "",
      "アステル: ┃ ❓ ┃ ❓ ❓ ❓ ┃",
    ].join("\n")
  );
  try { await reply.edit({ embeds: [introEmbed], components: [] }); } catch { /* */ }
  await sleep(1200);

  let rollNo = 0;
  let dealerDice: Dice = [1, 1, 1];
  let dealerHand: Hand = { type: "menashi" };

  while (rollNo < MAX_ROLLS) {
    rollNo += 1;

    // シェイクアニメ
    for (let f = 0; f < 4; f += 1) {
      const shake: Dice = [
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
      ];
      const e = baseEmbed("🎲 チンチロ — アステルの番", COLORS.GOLD).setDescription(
        [
          `*「わたしが振ってる……」*`,
          "",
          `あなた: ${diceDisplay(playerDice)}`,
          `　└ ${describeHand(playerHand)}`,
          "",
          `アステル: ${diceDisplay(shake)}`,
          `第${rollNo}投 (残り${MAX_ROLLS - rollNo + 1})`,
        ].join("\n")
      );
      try { await reply.edit({ embeds: [e], components: [] }); } catch { /* */ }
      await sleep(220);
    }

    // 確定
    dealerDice = rollDice();
    dealerHand = evaluate(dealerDice);
    const handLabel = describeHand(dealerHand);
    const remaining = MAX_ROLLS - rollNo;

    // 戦略判断
    const isTerminal = isTerminalHand(dealerHand);
    const meStop = dealerHand.type === "me" && dealerHand.score >= 5;
    const willStop = isTerminal || meStop || rollNo >= MAX_ROLLS;

    let comment = "";
    if (isTerminal) {
      comment = "*「これで止めるとするか。」*";
    } else if (meStop) {
      comment = `*「${(dealerHand as { score: number }).score}なら十分じゃ、止める。」*`;
    } else if (dealerHand.type === "menashi" && remaining > 0) {
      comment = "*「メナシか…もう一度振ろう。」*";
    } else if (dealerHand.type === "me" && remaining > 0) {
      comment = `*「${(dealerHand as { score: number }).score}か…もう一度狙ってみよう。」*`;
    } else {
      comment = "*「これしかないか…」*";
    }

    const e = baseEmbed("🎲 チンチロ — アステルの番", COLORS.GOLD).setDescription(
      [
        comment,
        "",
        `あなた: ${diceDisplay(playerDice)}`,
        `　└ ${describeHand(playerHand)}`,
        "",
        `アステル: ${diceDisplay(dealerDice)}`,
        `　└ ${handLabel}`,
      ].join("\n")
    );
    try { await reply.edit({ embeds: [e], components: [] }); } catch { /* */ }
    await sleep(willStop ? 1500 : 1100);

    if (willStop) break;
  }

  return { dealerHand, dealerDice };
}

/**
 * アステルとプレイヤーの手を比較して配当を適用、結果を表示。
 * 注意: 賭金は既に控除済み。配当の `mul` はプレイヤー視点の純利益倍率（compareHands より）。
 * - mul > 0: bet*(1+mul*(1-edge)) を加算（賭金返却+利益）
 * - mul = 0: bet をそのまま返す（プッシュ）
 * - mul < 0: |mul| - 1 倍を追加徴収（mul = -1 は通常負け、追加無し）
 */
async function settleVsDealer(
  reply: any,
  guildId: string,
  userId: string,
  bet: number,
  tierKey: string,
  playerHand: Hand,
  playerDice: Dice,
): Promise<void> {
  // ── アステルの振り ──
  const { dealerHand, dealerDice } = await dealerRollPhase(reply, bet, playerHand, playerDice);

  // ── 比較 ──
  const cmp = compareHands(playerHand, dealerHand);
  const houseEdge = getEffectiveHouseEdge(guildId, 0.05);
  const mul = cmp.mul;

  const profile = getProfile(userId, guildId);
  const ctx: DialogueContext & { userId: string } = {
    userId,
    tier: tierKey as any,
    balance: getBalance(userId, guildId),
    winStreak: profile.current_win_streak,
    loseStreak: profile.current_lose_streak,
  };

  let resultType: "win" | "lose" | "jackpot" = "lose";
  let dialogue = "";
  let payoutText = "";
  let fukuTax = 0;
  let extraSkipped = false;

  let itemNote = "";
  if (mul > 0) {
    // 純利益: bet * mul * (1 - houseEdge)。賭金 bet も同時に返却
    let profit = Math.floor(bet * mul * (1 - houseEdge));
    const wb = consumeWinBonus(userId);
    if (wb.mult !== 1) { profit = Math.floor(profit * wb.mult); itemNote = wb.note ?? ""; }
    const total = bet + profit;
    const newBal = getBalance(userId, guildId) + total;
    const fukuRate = getFukuWeight(newBal);
    fukuTax = Math.floor(profit * fukuRate);
    const actualTotal = total - fukuTax;

    adjustBalance(userId, actualTotal, "chinchiro_win", "chinchiro", guildId);
    recordWin(userId, profit - fukuTax);
    if (fukuTax > 0) distributeFukuTax(guildId, fukuTax);
    addExp(userId, 15);

    resultType = (playerHand.type === "pinzoro" || playerHand.type === "zorome") ? "jackpot" : "win";
    dialogue = dialogueWin(ctx, profit - fukuTax, bet);
    payoutText = `💰 配当: ◈${actualTotal.toLocaleString()}（賭金返却+利益 ◈${(profit - fukuTax).toLocaleString()}）`;
  } else if (mul === 0) {
    // プッシュ：賭金を返金
    adjustBalance(userId, bet, "chinchiro_push", "chinchiro", guildId);
    dialogue = "*「両方ヒフミか。引き分けだね、賭け金は返すよ。」*";
    payoutText = `🌀 プッシュ：◈${bet.toLocaleString()} を返金`;
    resultType = "win";
  } else if (mul === -1) {
    // 通常負け：既に賭金控除済み、追加徴収なし
    if (checkSubstituteBlessing(userId)) {
      adjustBalance(userId, bet, "blessing_refund", "chinchiro", guildId);
      dialogue = "「あぶない。……今のは、わたしが庇っといたよ。（身代わりの加護で賭け金が戻った！）」";
      resultType = "win";
      payoutText = "🛡️ 身代わりの加護で返金";
    } else {
      const prot = consumeLossProtection(userId);
      if (prot.refundRate > 0) {
        const refund = Math.floor(bet * prot.refundRate);
        adjustBalance(userId, refund, "item_refund", "chinchiro", guildId);
        itemNote = prot.note ?? "";
        if (prot.refundRate < 1) { recordLoss(userId); distributeHouseEarnings(guildId, bet - refund); addExp(userId, 5); }
        dialogue = dialogueLose(ctx, bet);
        payoutText = prot.refundRate >= 1 ? `🛡 敗北無効：◈${refund.toLocaleString()} 返金` : `🛡 保険：◈${refund.toLocaleString()} 返金`;
      } else {
        recordLoss(userId);
        distributeHouseEarnings(guildId, bet);
        addExp(userId, 5);
        dialogue = dialogueLose(ctx, bet);
        payoutText = `💸 -◈${bet.toLocaleString()}`;
      }
    }
  } else {
    // mul ≤ -2: 大きい負け。賭金 bet は既に控除済み、追加で (|mul|-1) * bet を徴収
    const extraNeeded = (Math.abs(mul) - 1) * bet;
    const extra = adjustBalance(userId, -extraNeeded, "chinchiro_loss_extra", "chinchiro", guildId);
    if (extra.ok) {
      recordLoss(userId);
      distributeHouseEarnings(guildId, bet + extraNeeded);
      addExp(userId, 5);
      const totalLoss = bet + extraNeeded;
      dialogue = `*「${describeHand(dealerHand).replace(/\*\*/g, "")} 相手では分が悪かったの。」*`;
      payoutText = `💀 -◈${totalLoss.toLocaleString()}（${Math.abs(mul)}倍負け）`;
    } else {
      // 残高不足：通常負けにフォールバック
      recordLoss(userId);
      distributeHouseEarnings(guildId, bet);
      addExp(userId, 5);
      dialogue = "*「大きく負けたけど……残高が足りないか。通常負けで勘弁してあげる。」*";
      payoutText = `💸 -◈${bet.toLocaleString()}（残高不足のため追加徴収はスキップ）`;
      extraSkipped = true;
    }
  }

  if (itemNote) dialogue += `\n（${itemNote}）`;

  const newWinStreak = mul > 0 ? profile.current_win_streak + 1 : 0;
  const streakBadge = newWinStreak >= 2 ? `🔥 ${newWinStreak}連勝中！\n` : "";
  const fukuLine = fukuTax > 0 ? `\n*（奉納: ◈${fukuTax.toLocaleString()}）*` : "";

  // 比較ライン
  const resultLabel = cmp.result === "player_win"
    ? "✨ **あなたの勝ち！**"
    : cmp.result === "dealer_win"
      ? "✦ **アステルの勝ち…**"
      : "🌀 **引き分け**";
  const comparison = [
    `┌─ あなた ─────────┐`,
    `│ ${diceDisplay(playerDice)}`,
    `│ ${describeHand(playerHand)}`,
    `└──────────────────┘`,
    `┌─ アステル ─────────┐`,
    `│ ${diceDisplay(dealerDice)}`,
    `│ ${describeHand(dealerHand)}`,
    `└──────────────────┘`,
    "",
    resultLabel,
  ].join("\n");

  const embed = gameResultEmbed({
    title: `🎲 チンチロ — 対 アステル`,
    description: [
      streakBadge + dialogue,
      "",
      comparison,
      "",
      payoutText + fukuLine,
      extraSkipped ? "" : "",
    ].filter((s) => s !== "").join("\n"),
    result: resultType,
    userId,
    guildId,
  });

  await reply.edit({ embeds: [embed], components: [buildResultButtons(guildId, userId, bet)] });

  // クイックベット collector
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });
  collector.on("collect", async (btn: ButtonInteraction) => {
    if (btn.customId === "chinchiro_paytable") {
      await btn.reply({ embeds: [buildPaytableEmbed()], ephemeral: true });
      return;
    }
    collector.stop();
    if (btn.customId.startsWith("chinchiro_retry_")) {
      const retryBet = parseInt(btn.customId.split("_")[2]);
      await btn.deferUpdate();
      if (acquireGameLock(userId, "chinchiro")) {
        try {
          await playChinchiro(btn, guildId, userId, retryBet);
        } finally {
          releaseGameLock(userId);
        }
      }
    }
  });
  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      try { await reply.edit({ components: [] }); } catch { /* */ }
    }
  });
}

function buildResultButtons(guildId: string, userId: string, bet: number): ActionRowBuilder<ButtonBuilder> {
  const cfg = getServerConfig(guildId);
  const profile = getProfile(userId, guildId);
  const tier = getTierByKey(profile.tier);
  const minB = cfg.min_bet;
  const balance = profile.balance;
  const maxB = Math.min(tier.betCap, balance);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`chinchiro_retry_${minB}_min`)
      .setLabel(`最低 ◈${minB.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(balance < minB),
    new ButtonBuilder()
      .setCustomId(`chinchiro_retry_${bet}_same`)
      .setLabel(`🎲 もう一回 ◈${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(balance < bet),
    new ButtonBuilder()
      .setCustomId(`chinchiro_retry_${maxB}_max`)
      .setLabel(`最大 ◈${maxB.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(maxB < minB),
    new ButtonBuilder()
      .setCustomId("chinchiro_paytable")
      .setLabel("📖 配当表")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildPaytableEmbed(): EmbedBuilder {
  return baseEmbed("📖 チンチロ — 対 アステル タイマン", COLORS.GOLD).setDescription(
    [
      "**あなた vs アステル** のタイマン勝負。両者が3つのサイコロを最大3投し、役の強さを比べる。",
      "",
      "**🥇 役の強さ（強い順）**",
      "　🌟 ピンゾロ (1-1-1) > 🎯 ゾロ目 (6→2) > 🔥 シゴロ (4-5-6) > 🎲 目スコア6→1 > 🌀 メナシ > 💀 ヒフミ",
      "",
      "**💰 配当（プレイヤー視点）**",
      "　あなたが勝つ → **勝者の役 mul × 95%**（ハウスエッジ 5%）",
      "　あなたが負ける → **負け役 mul（アステルの役）の全額**",
      "　同点（同じ目スコアなど）→ **アステル勝ち**（ハウスが取る）",
      "",
      "**役 mul**",
      "　🌟 ピンゾロ: 5倍",
      "　🎯 ゾロ目: 3倍",
      "　🔥 シゴロ: 2倍",
      "　🎲 目 / 🌀 メナシ: 1倍",
      "",
      "**💀 ヒフミ 特殊ルール**",
      "　あなた ヒフミ → 必ず **-2倍**（アステルの役に関係なく自爆）",
      "　アステル ヒフミ かつ あなた非ヒフミ → **+2倍**（アステルの自爆）",
      "　両方ヒフミ → プッシュ（返金）",
      "",
      "**🎲 振りの戦略**",
      "　目が出たら「止める」or「もう一度振る」を選べる（残り回数次第）。",
      "　振り直しでヒフミやメナシのリスクあり。",
      "　メナシは自動で再振り（最大3投）。",
      "",
      "**✦ アステルの戦略**",
      "　終了役 / 目スコア5,6 で止め、目1〜4 で再振り、メナシで自動再振り。",
    ].join("\n")
  );
}
