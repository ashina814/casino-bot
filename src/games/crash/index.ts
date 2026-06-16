/**
 * 📈 クラッシュ（クラッシュ）
 *
 * 倍率が上がり続け、いつ「崩壊」するか分からない。
 * 降りるタイミングを見極めるチキンレース。
 * メッセージ編集でリアルタイム更新。
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
import { consumeWinBonus, consumeLossProtection } from "../../core/items";
import { getServerConfig, acquireGameLock, releaseGameLock } from "../../core/db";
import {
  getEffectiveHouseEdge,
  getFukuWeight,
  distributeHouseEarnings,
  distributeFukuTax,
  addExp,
  getTierByKey,
} from "../../core/economy";
import { dialogueWin, dialogueLose, type DialogueContext } from "../../core/dialogue";
import { gameResultEmbed, baseEmbed, COLORS } from "../../ui/embeds";
import { broadcastBigWin } from "../../core/bigwin";
import { effectiveBetCap } from "../../core/vip";
import { WORLD } from "../../world.config";

// ─── Crash Point Generation ────────────────────────────

/**
 * クラッシュポイントを生成。ハウスエッジを組み込んだ分布。
 * E[payout] ≈ (1 - INSTANT_CRASH_RATE) × (1 - houseEdge) を満たす設計。
 *
 * 旧設定（即崩壊1% / houseEdge=0.04）は数学RTP 95%だが、MIN_CASHOUT=1.5xの
 * 仕様と組み合わさり「1.5xで確実に降りる戦略」の勝率が約63%になり、
 * プレイヤー体感が「勝ちやすすぎる」状態だった。即崩壊率を 1%→3% に引き上げて
 * 心理的恐怖と勝率を同時に少しだけ下げる。
 */
const INSTANT_CRASH_RATE = 0.03;

function generateCrashPoint(houseEdge: number): number {
  const e = 1 - houseEdge;
  const r = Math.random();
  if (r < INSTANT_CRASH_RATE) return 1.0;
  // Inverse CDF: crash = e / (1 - uniform)（Pareto-like distribution）
  const crash = e / (1 - r);
  return Math.max(1.0, Math.round(crash * 100) / 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildProgressBar(multiplier: number): string {
  const steps = 15;
  // Log scale: reaches end around 31.6x
  const progress = Math.min(1, Math.log10(multiplier) / 1.5);
  const filled = Math.floor(progress * steps);
  return "█".repeat(filled) + "🐉" + "・".repeat(steps - filled);
}

// ─── Command ───────────────────────────────────────────

export async function handleCrashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  if (!acquireGameLock(userId, "crash")) {
    await interaction.reply({ content: "もう遊んでる最中だよ。", ephemeral: true });
    return;
  }

  let lockReleased = false;
  try {
    const cfg = getServerConfig(guildId);
    const bet = interaction.options.getInteger("bet") ?? cfg.min_bet;
    await playCrash(interaction, guildId, userId, bet);
    // playCrash 内の正常終了で lock は解放済み（line 300）。それ以外は finally で保険解放
  } catch (err) {
    console.error("[crash] handleCrashCommand failed:", err);
    releaseGameLock(userId);
    lockReleased = true;
  } finally {
    // バリデーション失敗等の早期 return では playCrash が解放してないので保険
    if (!lockReleased) releaseGameLock(userId);
  }
}

// ─── Game Loop ─────────────────────────────────────────

export async function playCrash(
  interaction: ChatInputCommandInteraction | ButtonInteraction | import("discord.js").ModalSubmitInteraction,
  guildId: string,
  userId: string,
  bet: number,
): Promise<void> {
  // 全エントリ（slash / home modal / 等）でここを通るため、tier 上限と賭金控除はここで行う
  const cfg = getServerConfig(guildId);
  const profile = ensureUser(userId, guildId);
  const tier = getTierByKey(profile.tier);

  const reply = async (content: string) => {
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content, ephemeral: true });
    else await interaction.reply({ content, ephemeral: true });
  };

  if (bet < cfg.min_bet) {
    await reply(`最低ベットは ◈${cfg.min_bet} からだよ。`);
    return;
  }
  const betCap = effectiveBetCap(tier.betCap, userId, guildId);
  if (bet > betCap) {
    await reply(`きみの賭け上限は ◈${betCap.toLocaleString()}（${tier.emoji}${tier.name}${betCap > tier.betCap ? "・💎VIP×2" : ""}）までだね。`);
    return;
  }

  const deduct = adjustBalance(userId, -bet, "crash_bet", "crash");
  if (!deduct.ok) {
    await reply("エテルが足りないみたい。");
    return;
  }
  recordWager(userId, bet);
  try { require("../../core/db").addGamePlayAffection(userId); } catch {}

  // クラッシュは MIN_CASHOUT=1.5x で勝率が高めに出る性質があるので、
  // 他ゲーム（4%基準）より少し厚めの 6% を既定にする。
  const houseEdge = getEffectiveHouseEdge(guildId, 0.06);
  const crashPoint = generateCrashPoint(houseEdge);

  // 最低降車ライン: ここに届くまで降りられない（即降り無リスク払戻しの抑制）
  // 数学的 RTP は変わらず 96% だが、各ラウンドで真の敗北リスクを引き受けさせる設計
  const MIN_CASHOUT = 1.5;

  const START_TIME = Date.now();
  const GROWTH_RATE = 0.00015; // M = exp(0.00015 * ms)
  const t_crash = Math.log(crashPoint) / GROWTH_RATE;
  const CRASH_TIME = START_TIME + t_crash;
  const MIN_CASHOUT_TIME = START_TIME + Math.log(MIN_CASHOUT) / GROWTH_RATE; // 1.5x 到達時刻

  let currentMultiplier = 1.0;
  let cashedOut = false;
  let cashOutMultiplier = 0;

  // Initial embed
  const makeEmbed = (multi: number) => {
    const currentValue = Math.floor(bet * multi);
    const canCashOut = multi >= MIN_CASHOUT;
    return baseEmbed("📈 クラッシュ", COLORS.GOLD).setDescription(
      [
        `*「星が昇っていく……いつ墜ちる？」*`,
        "",
        `📈 現在: **${multi.toFixed(2)}x**` + (canCashOut ? " 🟢" : ` 🔒 (最低降車 **${MIN_CASHOUT.toFixed(2)}x** まで待て)`),
        buildProgressBar(multi),
        "",
        `ベット: ◈${bet.toLocaleString()} → 現在価値: ◈${currentValue.toLocaleString()}`,
        `*(※内部はリアルタイムで上昇中。押した瞬間の倍率が適用されるぞ)*`
      ].join("\n"),
    );
  };

  const cashOutRow = (multi: number) => {
    const val = Math.floor(bet * multi);
    const ready = multi >= MIN_CASHOUT;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("crash_cashout")
        .setLabel(ready ? `💰 降りる (◈${val.toLocaleString()})` : `🔒 ${MIN_CASHOUT.toFixed(2)}x まで降りれぬ`)
        .setStyle(ready ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!ready),
    );
  };

  let replyMsg: import("discord.js").Message;
  if ("message" in interaction && interaction.message) {
    if (interaction.replied || interaction.deferred) {
      replyMsg = await interaction.editReply({ embeds: [makeEmbed(currentMultiplier)], components: [cashOutRow(currentMultiplier)] });
    } else {
      replyMsg = await interaction.reply({ embeds: [makeEmbed(currentMultiplier)], components: [cashOutRow(currentMultiplier)], fetchReply: true });
    }
  } else {
    if (interaction.replied || interaction.deferred) {
      replyMsg = await interaction.editReply({ embeds: [makeEmbed(currentMultiplier)], components: [cashOutRow(currentMultiplier)] });
    } else {
      replyMsg = await interaction.reply({ embeds: [makeEmbed(currentMultiplier)], components: [cashOutRow(currentMultiplier)], fetchReply: true });
    }
  }

  // Collector for cash-out button
  const collector = replyMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i: ButtonInteraction) => i.user.id === userId && i.customId === "crash_cashout",
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    if (cashedOut) return;
    const clickTime = Date.now();

    // 1. 最低降車ライン到達前のクリックは弾く（UI で disabled だが念のためサーバー側検証）
    if (clickTime < MIN_CASHOUT_TIME) {
      await btn.reply({ content: `🔒 まだ ${MIN_CASHOUT.toFixed(2)}x に届いてないよ。`, ephemeral: true });
      return;
    }
    // 2. 既にクラッシュ済みかチェック
    if (clickTime >= CRASH_TIME) {
      await btn.reply({ content: "💥 遅かった…！通信の裏ですでに崩壊しておったぞ！", ephemeral: true });
      return;
    }

    cashedOut = true;
    const rawMul = Math.exp(GROWTH_RATE * (clickTime - START_TIME));
    // 防御: クラッシュ点を超える倍率は理論上不可だが、process suspend 等で
    // clickTime が暴騰した場合に Infinity が出る可能性をクランプする
    const cappedMul = Math.min(rawMul, crashPoint);
    cashOutMultiplier = Math.max(1.0, Math.floor(cappedMul * 100) / 100);
    if (!Number.isFinite(cashOutMultiplier)) cashOutMultiplier = 1.0;
    collector.stop("cashout");
    await btn.deferUpdate();
  });

  // ── Multiplier loop ──
  const UPDATE_INTERVAL = 1500; // ms
  let lastEditTime = START_TIME;
  let unlockRendered = false; // MIN_CASHOUT 到達時の特別描画フラグ

  while (true) {
    await sleep(200);
    if (cashedOut) break;

    const now = Date.now();
    if (now >= CRASH_TIME) {
      currentMultiplier = crashPoint;
      break;
    }

    // 最低降車ライン到達の瞬間は即座に再描画（ボタン解禁の瞬間を逃さない）
    const forceUnlockRender = !unlockRendered && now >= MIN_CASHOUT_TIME;
    if (forceUnlockRender || now - lastEditTime >= UPDATE_INTERVAL) {
      lastEditTime = now;
      currentMultiplier = Math.floor(Math.exp(GROWTH_RATE * (now - START_TIME)) * 100) / 100;
      if (forceUnlockRender) unlockRendered = true;

      try {
        await replyMsg.edit({
          embeds: [makeEmbed(currentMultiplier)],
          components: [cashOutRow(currentMultiplier)],
        });
      } catch { break; }
    }
  }

  collector.stop();

  // ── Result ──（cfg/profile/tier は関数冒頭で取得済み）
  const ctx: DialogueContext & { userId: string } = {
    userId,
    tier: profile.tier as any,
    balance: getBalance(userId, guildId),
    winStreak: profile.current_win_streak,
    loseStreak: profile.current_lose_streak,
  };

  const minB = cfg.min_bet;
  const buildRetryRow = () => {
    const balance = getBalance(userId, guildId);
    const maxB = Math.min(betCap, balance);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`crash_retry_${minB}_min`).setLabel(`最低 ◈${minB.toLocaleString()}`).setStyle(ButtonStyle.Secondary).setDisabled(balance < minB),
      new ButtonBuilder().setCustomId(`crash_retry_${bet}_same`).setLabel(`🎰 もう一回 ◈${bet.toLocaleString()}`).setStyle(ButtonStyle.Primary).setDisabled(balance < bet),
      new ButtonBuilder().setCustomId(`crash_retry_${maxB}_max`).setLabel(`最大 ◈${maxB.toLocaleString()}`).setStyle(ButtonStyle.Secondary).setDisabled(maxB < minB),
      new ButtonBuilder().setCustomId("crash_paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("crash_quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
    );
  };

  if (cashedOut) {
    // Player won
    let rawPayout = Math.floor(bet * cashOutMultiplier);
    let itemNote = "";
    const wb = consumeWinBonus(userId);
    if (wb.mult !== 1) { rawPayout = Math.floor(rawPayout * wb.mult); itemNote = wb.note ?? ""; }
    const net = rawPayout - bet;
    const newBal = getBalance(userId, guildId) + rawPayout;
    const fukuRate = getFukuWeight(newBal);
    const fukuTax = Math.floor(net * fukuRate);
    const actualPayout = rawPayout - fukuTax;

    adjustBalance(userId, actualPayout, "crash_win", "crash", guildId);
    const chain = awardChain(userId, net - fukuTax, "crash", guildId);
    recordWin(userId, net - fukuTax);
    if (fukuTax > 0) distributeFukuTax(guildId, fukuTax);
    addExp(userId, 15);

    let dialogue = dialogueWin(ctx, net, bet);
    if (itemNote) dialogue += `\n（${itemNote}）`;
    const embed = gameResultEmbed({
      title: "📈 クラッシュ — 離脱成功！",
      description: [
        `*${dialogue}*`,
        "",
        `📈 離脱: **${cashOutMultiplier.toFixed(2)}x** / 崩壊: ${crashPoint.toFixed(2)}x`,
        `💰 +◈${(net - fukuTax).toLocaleString()}`,
        chain.line,
      ].filter(Boolean).join("\n"),
      result: "win",
      userId,
      guildId,
    });

    await replyMsg.edit({ embeds: [embed], components: [buildRetryRow()] });

    broadcastBigWin(replyMsg.client, guildId, {
      userId, game: WORLD.GAME_CRASH, bet, payout: actualPayout,
    });
  } else {
    // Crashed
    let lossNote = "";
    const prot = consumeLossProtection(userId);
    if (prot.refundRate > 0) {
      const refund = Math.floor(bet * prot.refundRate);
      adjustBalance(userId, refund, "item_refund", "crash", guildId);
      lossNote = prot.note ?? "";
      if (prot.refundRate < 1) { recordLoss(userId); distributeHouseEarnings(guildId, bet - refund); }
    } else {
      recordLoss(userId);
      distributeHouseEarnings(guildId, bet);
    }
    addExp(userId, 5);

    let dialogue = dialogueLose(ctx, bet);
    if (lossNote) dialogue += `\n（${lossNote}）`;
    const embed = gameResultEmbed({
      title: "💥 クラッシュ — 燃え尽き！",
      description: [
        `*${dialogue}*`,
        "",
        `📉 崩壊: **${crashPoint.toFixed(2)}x**`,
        `💸 -◈${bet.toLocaleString()}`,
      ].join("\n"),
      result: "lose",
      userId,
      guildId,
    });

    await replyMsg.edit({ embeds: [embed], components: [buildRetryRow()] });
  }

  releaseGameLock(userId);

  // Retry collector
  const retryCollector = replyMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 20_000,
    filter: (i: ButtonInteraction) => i.user.id === userId,
  });

  retryCollector.on("collect", async (btn: ButtonInteraction) => {
    if (btn.customId === "crash_paytable") {
      await btn.reply({ embeds: [crashPaytableEmbed()], ephemeral: true });
      return;
    }
    retryCollector.stop();
    if (btn.customId === "crash_quit") {
      await btn.deferUpdate();
      await replyMsg.edit({ components: [] });
      return;
    }
    if (btn.customId.startsWith("crash_retry_")) {
      const retryBet = parseInt(btn.customId.split("_")[2]);
      if (!Number.isFinite(retryBet) || retryBet <= 0) return;
      await btn.deferUpdate();
      await replyMsg.edit({ components: [] });
      // playCrash は自前で tier 上限・賭金控除を行う。ロックも再取得
      if (acquireGameLock(userId, "crash")) {
        try {
          await playCrash(btn, guildId, userId, retryBet);
        } catch (err) {
          console.error("[crash] retry failed:", err);
          releaseGameLock(userId);
        }
      } else {
        await btn.followUp({ content: "もう遊んでる最中だよ。", ephemeral: true });
      }
    }
  });

  retryCollector.on("end", async (_: any, reason: string) => {
    if (reason === "time") {
      try { await replyMsg.edit({ components: [] }); } catch { /* */ }
    }
  });
}

// ─── Paytable ──────────────────────────────────────────

function crashPaytableEmbed(): import("discord.js").EmbedBuilder {
  return baseEmbed("📖 クラッシュ — ルール", COLORS.GOLD).setDescription(
    [
      "*「星は天井知らずに昇るけど、いつ燃え尽きるかは分からない。墜ちる前に降りれば、倍率で買い取るよ。」*",
      "",
      "**遊び方**",
      "・賭けると倍率が **1.00x** から指数的に上昇",
      "・任意のタイミングで「💰 降りる」を押すと、その時点の倍率で買い取り",
      "・ただし、見えない **崩壊ポイント** が抽選で決まっており、そこに到達したら賭金没収",
      "",
      "**最低降車ライン: 1.50x**",
      "・1.50x に届くまで降車不可（即降り無リスク払戻しの防止）",
      "・1.50x 未到達でクラッシュ → 通常通り賭金没収",
      "",
      "**配当**",
      "・降車成功 → 賭金 × 倍率（小数点以下切捨て）",
      "・配当 = 賭金 + 利益。福の重み（高残高時の自動奉納）適用",
      "・ハウスエッジ 4%（長期的に見て店が微益）",
      "",
      "**コツ**",
      "・倍率分布: 平均的に2.0x前後で崩壊することが多い",
      "・大きい倍率を狙うほど崩壊リスクが高くなる",
    ].join("\n")
  );
}
