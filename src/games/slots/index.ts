/**
 * 🎰 スロット（スロット）
 *
 * メッセージ編集3回で「左→中→右」とリールが止まる擬似アニメーション。
 * 最後のリールは溜めを入れて緊張感を演出。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import { adjustBalance, getBalance, recordWin, recordLoss, recordWager, ensureUser, getProfile } from "../../core/bank";
import { awardChain } from "../../core/chain";
import { getServerConfig, acquireGameLock, releaseGameLock, db } from "../../core/db";
import {
  getEffectiveHouseEdge,
  getFukuWeight,
  distributeHouseEarnings,
  distributeFukuTax,
  addExp,
  checkSubstituteBlessing,
  getTierByKey,
} from "../../core/economy";
import { dialogueWin, dialogueLose, dialogueFukuWeight, type DialogueContext } from "../../core/dialogue";
import { gameResultEmbed, baseEmbed, COLORS } from "../../ui/embeds";
import { consumeWinBonus, consumeLossProtection } from "../../core/items";
import { broadcastBigWin } from "../../core/bigwin";
import { effectiveBetCap } from "../../core/vip";
import { WORLD } from "../../world.config";

// ─── Symbols & Payouts ─────────────────────────────────
//
// 設計方針（インフレ抑制）:
// - ワイルド🌙 は 3揃いの代用にのみ機能（2揃いには効かない）
// - スキャッター✨ は 3つ位置不問で出るとフリースピン1回（自重しない）
// - JP は **純** アステル³ のみ。ワイルド代用でのアステル³ は通常 triple 扱い
// - JP プールは賭金の1%が積立、当選時に **半分を獲得・半分は次回シードに残留**

const SYMBOLS = [
  { emoji: "🌠", name: "流星",     weight: 28, kind: "normal" },
  { emoji: "☄️", name: "彗星",     weight: 23, kind: "normal" },
  { emoji: "🪐", name: "惑星",     weight: 17, kind: "normal" },
  { emoji: "☀️", name: "陽",   weight: 13, kind: "normal" },
  { emoji: "🌟", name: "輝星",     weight: 8,  kind: "normal" },
  { emoji: "✴️", name: "アステル", weight: 3,  kind: "normal" },
  { emoji: "🌙", name: "月",     weight: 5,  kind: "wild" },
  { emoji: "✨", name: "星屑",     weight: 3,  kind: "scatter" },
] as const;

type Symbol = (typeof SYMBOLS)[number];
type SymbolName = Symbol["name"];

// 通常絵柄の 3つ揃い配当
const TRIPLE_PAYOUTS: Partial<Record<SymbolName, number>> = {
  流星: 3,
  彗星: 5,
  惑星: 10,
  陽: 15,
  輝星: 30,
  アステル: 100, // 純3つ揃いのみJP扱い
  月: 25,      // ワイルド3つ揃い自体は中位配当
};

// 2つ揃い配当（ワイルド代用なし、純2つのみ）
const DOUBLE_PAYOUTS: Partial<Record<SymbolName, number>> = {
  流星: 1,
  彗星: 1.5,
  惑星: 2,
  陽: 3,
  輝星: 5,
  アステル: 10,
};

// JP プールへの貢献率と当選時の分配率
const JP_CONTRIBUTION = 0.01;   // 賭金の1%を積立
const JP_WIN_SHARE     = 0.5;   // 当選時に取れるのはプール半分（残り半分はシード）
const JP_POOL_FLOOR    = 10_000; // 最低保証値（これ以下にはならない）

// スキャッター当選条件
const SCATTER_TRIGGER_COUNT = 3; // 3つ揃ったらフリースピン1回

// ─── Weighted Random ───────────────────────────────────

function spinReel(): Symbol {
  const totalWeight = SYMBOLS.reduce((acc, s) => acc + s.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const s of SYMBOLS) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return SYMBOLS[0];
}

function isWild(s: Symbol): boolean { return s.kind === "wild"; }
function isScatter(s: Symbol): boolean { return s.kind === "scatter"; }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Game Logic ────────────────────────────────────────

export async function handleSlotsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  // Lock check
  if (!acquireGameLock(userId, "slots")) {
    await interaction.reply({ content: "もう遊んでる最中だよ。終わるまで待ってね。", ephemeral: true });
    return;
  }

  try {
    await playSlots(interaction, guildId, userId);
  } finally {
    releaseGameLock(userId);
  }
}

export async function playSlots(
  interaction: ChatInputCommandInteraction | ButtonInteraction | import("discord.js").ModalSubmitInteraction,
  guildId: string,
  userId: string,
  overrideBet?: number,
  isFreeSpin = false,
): Promise<void> {
  const cfg = getServerConfig(guildId);
  const profile = ensureUser(userId, guildId);
  const tier = getTierByKey(profile.tier);
  const betCap = effectiveBetCap(tier.betCap, userId, guildId);

  const bet = overrideBet ?? (interaction as ChatInputCommandInteraction).options?.getInteger?.("bet") ?? cfg.min_bet;

  if (bet < cfg.min_bet) {
    const msg = { content: `最低ベットは ◈${cfg.min_bet} からだよ。`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
    }
    return;
  }

  if (bet > betCap) {
    const msg = { content: `きみの賭け上限は ◈${betCap.toLocaleString()}（${tier.emoji}${tier.name}${betCap > tier.betCap ? "・💎VIP×2" : ""}）までだよ。`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
    }
    return;
  }

  // Deduct bet (フリースピン時は控除しない)
  if (!isFreeSpin) {
    const deductResult = adjustBalance(userId, -bet, "slots_bet", "slots");
    if (!deductResult.ok) {
      const msg = { content: "エテルが足りないみたい。", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
      return;
    }
    recordWager(userId, bet);
    contributeToJackpot(guildId, bet);
    try { require("../../core/db").addGamePlayAffection(userId); } catch {}
  }

  // Spin
  const reels = [spinReel(), spinReel(), spinReel()];

  // ── Phase 1: Spinning animation ──
  const jpDisplay = getJackpotPool(guildId);
  const labelPrefix = isFreeSpin ? "✨ フリースピン中" : "✦ スロット";
  const spinSlot = (s: string) => `┃ ${s} ┃`;
  // 高速サイクル用のダミー絵柄列
  const cycle = ["🌠","☄️","🪐","☀️","🌟","✴️","🌙","✨"];
  const cycleAt = (n: number) => cycle[n % cycle.length];

  const buildSpinEmbed = (label: string, slots: [string, string, string]) =>
    baseEmbed(labelPrefix, COLORS.GOLD).setDescription(
      [
        `*「${label}」*`,
        "",
        `┃ ${slots[0]} ┃ ${slots[1]} ┃ ${slots[2]} ┃`,
        "",
        isFreeSpin ? "ベット: **無料** (フリースピン)" : `ベット: ◈${bet.toLocaleString()}`,
        `🏆 JP プール: **◈${jpDisplay.toLocaleString()}**`,
      ].join("\n")
    );

  let reply: any;
  if (interaction.deferred || interaction.replied) {
    reply = await interaction.followUp({ embeds: [buildSpinEmbed("さぁ…巻物を開くぞ…", ["❓","❓","❓"])], fetchReply: true });
  } else {
    reply = await interaction.reply({ embeds: [buildSpinEmbed("さぁ…巻物を開くぞ…", ["❓","❓","❓"])], fetchReply: true });
  }

  // リール1: サイクル → 確定
  for (let t = 0; t < 3; t += 1) {
    await sleep(160);
    await reply.edit({ embeds: [buildSpinEmbed("ぐるぐる…", [cycleAt(t * 3), cycleAt(t * 3 + 1), cycleAt(t * 3 + 2)])] });
  }
  await sleep(160);
  await reply.edit({ embeds: [buildSpinEmbed("ふむ…", [reels[0].emoji, cycleAt(99), cycleAt(98)])] });

  // リール2: サイクル → 確定
  for (let t = 0; t < 3; t += 1) {
    await sleep(160);
    await reply.edit({ embeds: [buildSpinEmbed("おぉ…", [reels[0].emoji, cycleAt(t * 5), cycleAt(t * 5 + 1)])] });
  }
  await sleep(160);

  // ── ダブル煽り：1+2リールで同じ絵柄(純normal)が止まったらニアミス煽り ──
  const isNearMiss = !isScatter(reels[0]) && !isScatter(reels[1])
    && reels[0].kind === "normal" && reels[1].kind === "normal"
    && reels[0].name === reels[1].name;
  const teaseLabel = isNearMiss
    ? `あと一つで… **${reels[0].name}** が揃うぞ…！`
    : "むむ…";
  await reply.edit({ embeds: [buildSpinEmbed(teaseLabel, [reels[0].emoji, reels[1].emoji, "❓"])] });
  await sleep(isNearMiss ? 1900 : 1100);

  // ── Calculate result ──
  const result = calculatePayout(reels, bet, guildId);
  const { payoutType, freeSpinTriggered } = result;
  let payout = result.payout;
  // 純3アステル揃いの時のみ JP プール獲得（ワイルド代用は対象外）
  let jpWin = 0;
  if (payoutType === "jackpot") {
    jpWin = seizeJackpot(guildId);
    payout += jpWin;
  }

  // 使い切り景品: 勝利ボーナス（福のお守り 等）
  let itemNote = "";
  if (payout > 0) {
    const wb = consumeWinBonus(userId);
    if (wb.mult !== 1) { payout = Math.floor(payout * wb.mult); itemNote = wb.note ?? ""; }
  }

  // Apply fuku weight (progressive tax)
  let actualPayout = payout;
  let fukuTax = 0;
  const newBalance = getBalance(userId, guildId) + payout;

  if (payout > 0) {
    const fukuRate = getFukuWeight(newBalance);
    fukuTax = Math.floor(payout * fukuRate);
    actualPayout = payout - fukuTax;
  }

  // Apply payout
  const ctx: DialogueContext & { userId: string } = {
    userId,
    tier: profile.tier as any,
    balance: getBalance(userId, guildId),
    winStreak: profile.current_win_streak,
    loseStreak: profile.current_lose_streak,
  };

  let resultType: "win" | "lose" | "jackpot";
  let dialogue: string;

  let chainLine = "";
  if (actualPayout > 0) {
    adjustBalance(userId, actualPayout, "slots_win", "slots", guildId);
    const chain = awardChain(userId, actualPayout, "slots", guildId);
    chainLine = chain.line;
    recordWin(userId, actualPayout);

    if (fukuTax > 0) {
      distributeFukuTax(guildId, fukuTax);
    }

    resultType = payoutType === "jackpot" ? "jackpot" : "win";
    dialogue = dialogueWin(ctx, actualPayout, bet);
    addExp(userId, 15);
  } else {
    // フリースピンの時は損失計上しない
    if (isFreeSpin) {
      resultType = "lose";
      dialogue = "「フリースピン、外れたか…！」";
    } else if (checkSubstituteBlessing(userId)) {
      adjustBalance(userId, bet, "blessing_refund", "slots", guildId);
      dialogue = "「あぶない。……今のは、わたしが庇っといたよ。（身代わりの加護で賭け金が戻った！）」";
      resultType = "win";
    } else {
      const prot = consumeLossProtection(userId);
      if (prot.refundRate > 0) {
        const refund = Math.floor(bet * prot.refundRate);
        adjustBalance(userId, refund, "item_refund", "slots", guildId);
        if (prot.refundRate >= 1) {
          resultType = "win";
          dialogue = `${dialogueLose(ctx, bet)}\n*（${prot.note}）*`;
        } else {
          recordLoss(userId);
          distributeHouseEarnings(guildId, bet - refund);
          resultType = "lose";
          dialogue = `${dialogueLose(ctx, bet)}\n*（${prot.note}）*`;
          addExp(userId, 5);
        }
      } else {
        recordLoss(userId);
        distributeHouseEarnings(guildId, bet);
        resultType = "lose";
        dialogue = dialogueLose(ctx, bet);
        addExp(userId, 5);
      }
    }
  }
  if (itemNote) dialogue += `\n*（${itemNote}）*`;

  // Fuku weight message
  const fukuMsg = payout > 0 ? dialogueFukuWeight(newBalance) : null;
  const extraInfo = fukuMsg ? `\n*${fukuMsg}（奉納: ◈${fukuTax.toLocaleString()}）*` : "";

  // ── Phase 2: Result ──
  const reelDisplay = `┃ ${reels[0].emoji} ┃ ${reels[1].emoji} ┃ ${reels[2].emoji} ┃`;

  // 配当タイプの表示ラベル
  const payoutLabel = (() => {
    switch (payoutType) {
      case "jackpot": return `🎉 **JACKPOT！** 純3アステル 揃い`;
      case "triple": return `3つ揃い (${result.matchedName})`;
      case "wild_triple": return `🌙 ワイルド3つ揃い (${result.matchedName})`;
      case "double": return `2つ揃い (${result.matchedName})`;
      default: return "";
    }
  })();

  const prefix = resultType === "jackpot" ? "🔥🔥🔥 " : "";
  const suffix = resultType === "jackpot" ? " 🔥🔥🔥" : "";

  // 連勝バッジ
  const newWinStreak = actualPayout > 0 ? profile.current_win_streak + 1 : 0;
  const streakBadge = newWinStreak >= 2 ? `🔥 ${newWinStreak}連勝中！\n` : "";

  // JP獲得詳細
  const jpLine = jpWin > 0 ? `\n💎 JPプール獲得: **◈${jpWin.toLocaleString()}** (残りプール: ◈${getJackpotPool(guildId).toLocaleString()})` : "";
  // フリースピン獲得通知
  const freeSpinNotice = freeSpinTriggered ? `\n\n✨✨ **3つの星屑！フリースピン1回獲得！** ✨✨` : "";

  const descLines = [
    streakBadge + dialogue,
    "",
    reelDisplay,
    "",
    payout > 0 ? `💰 配当: ◈${actualPayout.toLocaleString()} (${payoutLabel})${jpLine}` : "💨 ハズレ",
    chainLine,
    extraInfo,
    freeSpinNotice,
    isFreeSpin ? "" : `\n🏆 JP プール: ◈${getJackpotPool(guildId).toLocaleString()}`,
  ].filter((s) => s !== "").join("\n");

  const resultEmbed = gameResultEmbed({
    title: `${prefix}✦ スロット${suffix}`,
    description: descLines,
    result: resultType === "jackpot" ? "jackpot" : payout > 0 ? "win" : "lose",
    userId,
    guildId,
  });

  // ── Quick-bet buttons (最低 / 前回 / 最大) + ペイアウト表 ──
  const minB = cfg.min_bet;
  const maxB = Math.min(betCap, getBalance(userId, guildId));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`slots_retry_${minB}_min`)
      .setLabel(`最低 ◈${minB.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(getBalance(userId, guildId) < minB),
    new ButtonBuilder()
      .setCustomId(`slots_retry_${bet}_same`)
      .setLabel(`🎰 もう一回 ◈${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(getBalance(userId, guildId) < bet),
    new ButtonBuilder()
      .setCustomId(`slots_retry_${maxB}_max`)
      .setLabel(`最大 ◈${maxB.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(maxB < minB),
    new ButtonBuilder()
      .setCustomId("slots_paytable")
      .setLabel("📖 配当表")
      .setStyle(ButtonStyle.Secondary),
  );

  await reply.edit({ embeds: [resultEmbed], components: [row] });

  // 大勝ち速報（JP当選 or 高倍率）
  if (actualPayout > 0) {
    broadcastBigWin(interaction.client, guildId, {
      userId, game: WORLD.GAME_SLOTS, bet, payout: actualPayout, isJackpot: resultType === "jackpot",
    });
  }

  // ── フリースピンが発動していれば、結果表示後に自動で再スピン ──
  if (freeSpinTriggered && !isFreeSpin) {
    await sleep(2500);
    await playSlots(interaction, guildId, userId, bet, true);
    return; // 元の collector は閉じる
  }

  // ── Button collector ──
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    if (btn.customId === "slots_paytable") {
      await btn.reply({ embeds: [buildPaytableEmbed()], ephemeral: true });
      return;
    }
    collector.stop();

    if (btn.customId.startsWith("slots_retry_")) {
      const retryBet = parseInt(btn.customId.split("_")[2]);
      await btn.deferUpdate();
      if (acquireGameLock(userId, "slots")) {
        try {
          await playSlots(btn, guildId, userId, retryBet);
        } finally {
          releaseGameLock(userId);
        }
      }
    }
  });

  collector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      try {
        await reply.edit({ components: [] });
      } catch { /* message may be deleted */ }
    }
  });
}

// ─── Paytable Embed ────────────────────────────────────

function buildPaytableEmbed(): import("discord.js").EmbedBuilder {
  const tripleLines = (Object.entries(TRIPLE_PAYOUTS) as Array<[SymbolName, number]>)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      const label = name === "アステル" ? `${sym.emoji} ${name} (純3つでJP)` : `${sym.emoji} ${name}`;
      return `　${label}: **${mul}倍**`;
    }).join("\n");

  const doubleLines = (Object.entries(DOUBLE_PAYOUTS) as Array<[SymbolName, number]>)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      return `　${sym.emoji} ${name}: **${mul}倍**`;
    }).join("\n");

  return baseEmbed("📖 スロット — 配当表", COLORS.GOLD).setDescription(
    [
      "**🎯 3つ揃い** (左から3つ同じ絵柄)",
      tripleLines,
      "",
      "**🎯 2つ揃い** (左から2つ同じ絵柄、ワイルド代用不可)",
      doubleLines,
      "",
      "**🌙 月（ワイルド）**",
      "　他の絵柄を補って3つ揃いを成立させる（アステルの純3はJP扱いだがワイルド代用は通常配当）",
      "",
      "**✨ 星屑（スキャッター）**",
      `　位置不問で${SCATTER_TRIGGER_COUNT}つ出現 → **賭金不要でもう1回スピン**`,
      "",
      "**🏆 ジャックポット**",
      `　純3つの ${SYMBOLS.find(s => s.name === "アステル")!.emoji} アステル で発動`,
      `　 → 通常配当 + JPプールの **${JP_WIN_SHARE * 100}%** を獲得`,
      `　 (プールは賭金の ${JP_CONTRIBUTION * 100}% を毎回積立)`,
    ].join("\n")
  );
}

// ─── Payout Calculation ────────────────────────────────

export type SpinResult = {
  payout: number;
  payoutType: "triple" | "double" | "wild_triple" | "none" | "jackpot";
  /** ワイルド代用で揃った絵柄名（演出用） */
  matchedName?: SymbolName;
  /** 純3アステル揃いで JP プールから取れる金額（payout に含まない、別建て） */
  jpBonus: number;
  /** 3つのうち2つ揃った時の "あと一つで揃う" 演出フラグ */
  nearMiss: boolean;
  /** スキャッター3つ揃い → フリースピン発動 */
  freeSpinTriggered: boolean;
};

function calculatePayout(
  reels: Symbol[],
  bet: number,
  guildId: string,
): SpinResult {
  const houseEdge = getEffectiveHouseEdge(guildId, 0.04);

  // ── スキャッター判定（位置不問で3つ） ──
  const scatterCount = reels.filter(isScatter).length;
  const freeSpinTriggered = scatterCount >= SCATTER_TRIGGER_COUNT;

  // 演出用: 2つ揃ったところで止まる時のニアミス検出（純絵柄のみ）
  const reelsForNearMiss = reels.slice(0, 2);
  const nearMiss = !reelsForNearMiss.some(isScatter) && reelsForNearMiss[0].name === reelsForNearMiss[1].name;

  // ── 純3つ揃い（ワイルド未使用） ──
  if (reels[0].name === reels[1].name && reels[1].name === reels[2].name && !reels.some(isScatter)) {
    const name = reels[0].name;
    const multiplier = TRIPLE_PAYOUTS[name] ?? 0;
    if (multiplier > 0) {
      const raw = Math.floor(bet * multiplier * (1 - houseEdge));
      if (name === "アステル") {
        // JP（純3アステルのみ）
        return {
          payout: raw,
          payoutType: "jackpot",
          matchedName: name,
          jpBonus: 0, // JP プール獲得分は呼び出し側で確定
          nearMiss: false,
          freeSpinTriggered,
        };
      }
      return { payout: raw, payoutType: name === "月" ? "wild_triple" : "triple", matchedName: name, jpBonus: 0, nearMiss: false, freeSpinTriggered };
    }
  }

  // ── ワイルド代用3つ揃い（スキャッターは含まない） ──
  // スキャッターが居る場合は揃い扱いしない（混在防止）
  if (!reels.some(isScatter)) {
    const wildCount = reels.filter(isWild).length;
    const normals = reels.filter((s) => s.kind === "normal");
    if (wildCount > 0 && wildCount < 3 && normals.length > 0) {
      // 全 normal が同じ絵柄か？
      const allSame = normals.every((s) => s.name === normals[0].name);
      if (allSame) {
        const name = normals[0].name;
        const multiplier = TRIPLE_PAYOUTS[name] ?? 0;
        if (multiplier > 0) {
          const raw = Math.floor(bet * multiplier * (1 - houseEdge));
          // ワイルド代用アステル³ は JP 扱いせず、通常 triple 配当（インフレ抑制）
          return { payout: raw, payoutType: "wild_triple", matchedName: name, jpBonus: 0, nearMiss: false, freeSpinTriggered };
        }
      }
    }
  }

  // ── 純2つ揃い（ワイルド代用なし） ──
  if (!reels.some(isScatter)) {
    for (const sym of SYMBOLS) {
      if (sym.kind !== "normal") continue;
      const count = reels.filter((r) => r.name === sym.name).length;
      if (count === 2) {
        const multiplier = DOUBLE_PAYOUTS[sym.name] ?? 0;
        if (multiplier > 0) {
          const raw = Math.floor(bet * multiplier * (1 - houseEdge));
          return { payout: raw, payoutType: "double", matchedName: sym.name, jpBonus: 0, nearMiss: false, freeSpinTriggered };
        }
      }
    }
  }

  return { payout: 0, payoutType: "none", jpBonus: 0, nearMiss, freeSpinTriggered };
}

// ─── Jackpot Pool ─────────────────────────────────────

function getJackpotPool(guildId: string): number {
  const row = db.prepare("SELECT jackpot_pool FROM server_config WHERE guild_id = ?").get(guildId) as { jackpot_pool: number } | undefined;
  return Math.max(row?.jackpot_pool ?? 0, JP_POOL_FLOOR);
}

function contributeToJackpot(guildId: string, bet: number): void {
  const amount = Math.floor(bet * JP_CONTRIBUTION);
  if (amount <= 0) return;
  db.prepare("UPDATE server_config SET jackpot_pool = jackpot_pool + ? WHERE guild_id = ?").run(amount, guildId);
}

function seizeJackpot(guildId: string): number {
  const pool = getJackpotPool(guildId);
  const share = Math.floor(pool * JP_WIN_SHARE);
  const remaining = pool - share;
  db.prepare("UPDATE server_config SET jackpot_pool = ? WHERE guild_id = ?").run(Math.max(remaining, JP_POOL_FLOOR), guildId);
  return share;
}
