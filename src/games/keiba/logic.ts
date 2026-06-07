import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  InteractionReplyOptions,
  Message,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  ButtonInteraction
} from "discord.js";
import { db, getRandomRaceHorses, getSystemStatus, KeibaHorse, releaseRaceLock, tryAcquireRaceLock, updateSystemStatus, runTransaction, addGamePlayAffection, acquireGameLock, releaseGameLock } from "../../core/db";
import { adjustBalance } from "../../core/bank";

type BetType = "win" | "place";

type ActiveRaceSession = {
  raceId: string;
  horses: KeibaHorse[];
  message: Message;
  acceptingBets: boolean;
  guildId: string;
  hostId: string | null;          // 手動 /競馬 start の発信者。cron なら null
  closeTimeout: NodeJS.Timeout | null; // 主催者が手動で進めた時にキャンセルする
};

const TRACK_LENGTH = 20;
const BASE_TURN_WAIT_MS = 4000;
const FINAL_STRAIGHT_WAIT_MS = 6000;
const sessions = new Map<string, ActiveRaceSession>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ephemeral(content: string): InteractionReplyOptions {
  return { content, ephemeral: true };
}

// ─── プール集計 / オッズ計算 ───────────────────────────

type PoolStats = {
  totalWin: number;
  totalPlace: number;
  winByHorse: Map<number, number>;
  placeByHorse: Map<number, number>;
  carryWin: number;
  carryPlace: number;
};

function computePoolStats(session: ActiveRaceSession): PoolStats {
  const rows = db.prepare(
    "SELECT horse_id, bet_type, amount FROM keiba_bets"
  ).all() as Array<{ horse_id: number; bet_type: BetType; amount: number }>;

  const winByHorse = new Map<number, number>();
  const placeByHorse = new Map<number, number>();
  let totalWin = 0;
  let totalPlace = 0;
  for (const r of rows) {
    if (r.bet_type === "win") {
      winByHorse.set(r.horse_id, (winByHorse.get(r.horse_id) ?? 0) + r.amount);
      totalWin += r.amount;
    } else {
      placeByHorse.set(r.horse_id, (placeByHorse.get(r.horse_id) ?? 0) + r.amount);
      totalPlace += r.amount;
    }
  }

  const status = getSystemStatus();
  return {
    totalWin,
    totalPlace,
    winByHorse,
    placeByHorse,
    carryWin: status.keiba_carryover_win,
    carryPlace: status.keiba_carryover_place,
  };
}

/**
 * 概算オッズ = 賞金プール / その馬への賭け額
 * 賞金プール = total * 0.8 + carryover
 * 賭け0の馬は "-" を返す
 */
function approxOdds(prizePool: number, horseStake: number): string {
  if (horseStake <= 0) return "—";
  const o = prizePool / horseStake;
  return `${o.toFixed(1)}倍`;
}

function renderPanel(session: ActiveRaceSession, disabled = false): {
  embed: EmbedBuilder;
  rows: [ActionRowBuilder<StringSelectMenuBuilder>, ActionRowBuilder<StringSelectMenuBuilder>, ActionRowBuilder<ButtonBuilder>];
} {
  const stats = computePoolStats(session);
  const winPrize = Math.floor(stats.totalWin * 0.8 + stats.carryWin);
  const placePrize = Math.floor(stats.totalPlace * 0.8 + stats.carryPlace);

  // 各馬の単勝賭け額で「人気」を順位付け
  const popularity = [...session.horses]
    .map((h) => ({ id: h.id, stake: stats.winByHorse.get(h.id) ?? 0 }))
    .sort((a, b) => b.stake - a.stake);
  const popRank = new Map<number, number>();
  popularity.forEach((p, i) => { if (p.stake > 0) popRank.set(p.id, i + 1); });

  const options = session.horses.map((horse) => {
    const rank = popRank.get(horse.id);
    const odds = approxOdds(winPrize, stats.winByHorse.get(horse.id) ?? 0);
    return {
      label: horse.name,
      value: String(horse.id),
      description: `${horse.style} | 単勝 ${odds}${rank ? ` (人気${rank})` : ""}`,
    };
  });

  const winMenu = new StringSelectMenuBuilder()
    .setCustomId(`keiba:select:win:${session.raceId}`)
    .setPlaceholder("単勝の馬を選択")
    .setDisabled(disabled)
    .addOptions(options);

  const placeMenu = new StringSelectMenuBuilder()
    .setCustomId(`keiba:select:place:${session.raceId}`)
    .setPlaceholder("複勝の馬を選択")
    .setDisabled(disabled)
    .addOptions(options.map((o, i) => {
      const horse = session.horses[i];
      const placeOdds = approxOdds(placePrize, stats.placeByHorse.get(horse.id) ?? 0);
      return { ...o, description: `${horse.style} | 複勝 ${placeOdds}` };
    }));

  const statusButton = new ButtonBuilder()
    .setCustomId(`keiba:status:${session.raceId}`)
    .setLabel("📋 賭け状況")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);

  const cancelWinButton = new ButtonBuilder()
    .setCustomId(`keiba:cancel_one:win:${session.raceId}`)
    .setLabel("単勝のみ取消")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const cancelPlaceButton = new ButtonBuilder()
    .setCustomId(`keiba:cancel_one:place:${session.raceId}`)
    .setLabel("複勝のみ取消")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`keiba:cancel:${session.raceId}`)
    .setLabel("🔄 全取り消し")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);

  // 主催者のみ: 3分待たずに即スタート（手動レースのみ・cron では非表示）
  const goButton = session.hostId
    ? new ButtonBuilder()
        .setCustomId(`keiba:go:${session.raceId}`)
        .setLabel("🏁 締切→スタート（主催者）")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    : null;

  // 馬一覧（人気・現在オッズ付き）
  const horseList = session.horses.map((h, i) => {
    const winStake = stats.winByHorse.get(h.id) ?? 0;
    const placeStake = stats.placeByHorse.get(h.id) ?? 0;
    const rank = popRank.get(h.id);
    const mark = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "　";
    const winOdds = approxOdds(winPrize, winStake);
    const placeOdds = approxOdds(placePrize, placeStake);
    return `${mark} ${i + 1}. **${h.name}** (${h.style})\n　└ 単勝 ${winOdds} / 複勝 ${placeOdds}`;
  }).join("\n");

  const poolLine = [
    `🎯 単勝プール: ◈${stats.totalWin.toLocaleString()}${stats.carryWin > 0 ? ` (+繰越◈${stats.carryWin.toLocaleString()})` : ""}`,
    `🎯 複勝プール: ◈${stats.totalPlace.toLocaleString()}${stats.carryPlace > 0 ? ` (+繰越◈${stats.carryPlace.toLocaleString()})` : ""}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🏇 競馬レース受付")
    .setColor(0xC0392B)
    .setDescription(
      [
        "受付は **3分間** です。賭けが入るたびにオッズは変動します。",
        "単勝・複勝はそれぞれ別で賭けられます (100〜10,000エテル)。",
      ].join("\n")
    )
    .addFields(
      { name: "💰 プール", value: poolLine, inline: false },
      { name: "🐎 出走馬 / 概算オッズ", value: horseList, inline: false },
    )
    .setFooter({ text: "オッズは現時点のプールから計算。賭け状況確認は📋ボタンから（あなたのみ表示）" });

  const buttonRow = goButton
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(statusButton, cancelWinButton, cancelPlaceButton, cancelButton, goButton)
    : new ActionRowBuilder<ButtonBuilder>().addComponents(statusButton, cancelWinButton, cancelPlaceButton, cancelButton);

  return {
    embed,
    rows: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(winMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(placeMenu),
      buttonRow,
    ],
  };
}

/**
 * 受付パネルを最新プール状況で再描画する。
 * bet/cancel/cancel_one の後に呼ばれる。エラーは握り潰す（panel は補助情報）。
 */
async function refreshPanel(session: ActiveRaceSession): Promise<void> {
  if (!session.acceptingBets) return;
  try {
    const panel = renderPanel(session, false);
    await session.message.edit({ embeds: [panel.embed], components: panel.rows });
  } catch (err) {
    console.warn("[keiba] refreshPanel failed:", (err as Error)?.message ?? err);
  }
}

function requireSession(raceId: string): ActiveRaceSession | null {
  return sessions.get(raceId) ?? null;
}

export async function startRace(
  client: Client,
  payload: { channelId: string; initiatedBy: string; isScheduled: boolean; hostUserId?: string | null }
): Promise<void> {
  let lockAcquired = tryAcquireRaceLock();
  if (!lockAcquired) {
    // ゾンビロック対策: 実体セッションが無いのにフラグだけ残ってるなら強制リセットして再取得
    if (sessions.size === 0) {
      console.warn("[keiba] zombie race lock detected — force-release and retry");
      releaseRaceLock();
      lockAcquired = tryAcquireRaceLock();
    }
    if (!lockAcquired) throw new Error("Another race is already in progress.");
  }
  const raceId = `${Date.now()}`;

  try {
    const channel = await client.channels.fetch(payload.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error("Race channel is invalid or inaccessible.");
    }

    const horses = getRandomRaceHorses(5, 8);
    const tempSession: ActiveRaceSession = {
      raceId,
      horses,
      message: {} as Message,
      acceptingBets: true,
      guildId: channel.guildId,
      hostId: payload.hostUserId ?? null,
      closeTimeout: null,
    };
    const panel = renderPanel(tempSession, false);
    const message = await channel.send({
      content: payload.isScheduled
        ? "📢 定期競馬イベント開始！3分以内に賭けてください。"
        : `🏁 ${payload.initiatedBy} が競馬レースを開始しました！`,
      embeds: [panel.embed],
      components: panel.rows
    });
    tempSession.message = message;
    sessions.set(raceId, tempSession);

    tempSession.closeTimeout = setTimeout(() => {
      const session = sessions.get(raceId);
      if (!session) {
        return;
      }
      void closeBettingAndRunRace(session).catch(async (error) => {
        console.error("[keiba] closeBettingAndRunRace failed:", error);
        try {
          await rollbackRaceBets("レース異常終了返金", session.guildId);
          await session.message.edit({
            content: "⚠️ レース処理でエラーが発生したため、賭け金を全額返金しました。",
            components: []
          });
        } catch (nestedError) {
          console.error("[keiba] timeout fallback failed:", nestedError);
        } finally {
          sessions.delete(session.raceId);
          releaseRaceLock();
        }
      });
    }, 3 * 60 * 1000);
  } catch (error) {
    releaseRaceLock();
    throw error;
  }
}

export async function handleKeibaSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [prefix, action, betType, raceId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "select" || !raceId || (betType !== "win" && betType !== "place")) {
    return;
  }

  const userId = interaction.user.id;
  if (!acquireGameLock(userId, "keiba")) {
    await interaction.reply({ content: "もう遊んでる最中だよ。", ephemeral: true });
    return;
  }

  // ロックは showModal 直後（または途中エラー時）に必ず解放する。
  // モーダル送信側は runTransaction で原子的に処理されるためロック保持不要。
  try {
    try { addGamePlayAffection(userId); } catch {}

    const session = requireSession(raceId);
    if (!session || !session.acceptingBets) {
      await interaction.reply(ephemeral("このレースの受付は終了しています。"));
      return;
    }

    const horseId = interaction.values[0];
    const horse = session.horses.find((h) => String(h.id) === horseId);
    if (!horse) {
      await interaction.reply(ephemeral("選択された馬が見つかりませんでした。"));
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`keiba:modal:${betType}:${horseId}:${raceId}`)
      .setTitle(`${betType === "win" ? "単勝" : "複勝"} 賭け金入力`);

    const amountInput = new TextInputBuilder()
      .setCustomId("amount")
      .setLabel("賭け金 (100〜10,000)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder("例: 1500");

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
    await interaction.showModal(modal);
  } finally {
    releaseGameLock(userId);
  }
}

export async function handleKeibaModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const [prefix, action, betType, horseIdStr, raceId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "modal" || !raceId || !horseIdStr || (betType !== "win" && betType !== "place")) {
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const session = requireSession(raceId);
  if (!session || !session.acceptingBets) {
    await interaction.editReply("このレースの受付は終了しています。");
    return;
  }

  const horseId = Number(horseIdStr);
  const horse = session.horses.find((h) => h.id === horseId);
  if (!horse) {
    await interaction.editReply("指定された馬は出走していません。");
    return;
  }

  const raw = interaction.fields.getTextInputValue("amount").trim();
  if (!/^\d+$/.test(raw)) {
    await interaction.editReply("金額は整数で入力してください。");
    return;
  }
  const amount = Math.floor(Number(raw));
  if (amount < 100 || amount > 10000) {
    await interaction.editReply("賭け金は 100〜10,000エテルの範囲で指定してください。");
    return;
  }

  const userId = interaction.user.id;

  try {
    runTransaction(() => {
      const existing = db
        .prepare(
          "SELECT amount FROM keiba_bets WHERE user_id = ? AND bet_type = ?"
        )
        .get(userId, betType) as { amount: number } | undefined;

      if (existing) {
        const refundResult = adjustBalance(userId, Math.floor(existing.amount), "競馬賭け直し返金", "keiba", interaction.guildId ?? undefined);
        if (!refundResult.ok) {
          throw new Error("Failed to refund previous bet.");
        }
        db.prepare("DELETE FROM keiba_bets WHERE user_id = ? AND bet_type = ?").run(userId, betType);
      }

      const payment = adjustBalance(userId, -Math.floor(amount), `競馬${betType === "win" ? "単勝" : "複勝"}賭け`, "keiba", interaction.guildId ?? undefined);
      if (!payment.ok) {
        if (payment.reason === "INSUFFICIENT_FUNDS") {
          throw new Error("INSUFFICIENT_FUNDS");
        }
        throw new Error("Failed to charge bet.");
      }

      db.prepare(
        "INSERT INTO keiba_bets (user_id, horse_id, bet_type, amount) VALUES (?, ?, ?, ?)"
      ).run(userId, horseId, betType, Math.floor(amount));
    });
    await interaction.editReply(
      `${betType === "win" ? "単勝" : "複勝"}で **${horse.name}** に **${amount.toLocaleString()}エテル** 賭けました。`
    );
    // 受付パネルを最新オッズで再描画
    void refreshPanel(session);
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_FUNDS") {
      await interaction.editReply("残高不足のため賭けられませんでした。");
      return;
    }
    console.error("[keiba] modal submit failed:", error);
    await interaction.editReply("ごめん、なんか調子が狂ったみたい。少し待ってから、もう一度試してね。");
  }
}

// ─── Bet Status & Per-Type Cancel ──────────────────────

export async function handleKeibaStatus(interaction: ButtonInteraction): Promise<void> {
  const [prefix, action, raceId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "status" || !raceId) return;

  const session = requireSession(raceId);
  if (!session) {
    await interaction.reply(ephemeral("このレースは既に終了しています。"));
    return;
  }

  const userId = interaction.user.id;
  const rows = db.prepare(
    "SELECT horse_id, bet_type, amount FROM keiba_bets WHERE user_id = ?"
  ).all(userId) as Array<{ horse_id: number; bet_type: BetType; amount: number }>;

  if (rows.length === 0) {
    await interaction.reply(ephemeral("まだ賭けていません。馬を選択して賭けてください。"));
    return;
  }

  const lines = rows.map((r) => {
    const horse = session.horses.find((h) => h.id === r.horse_id);
    const horseName = horse?.name ?? `#${r.horse_id}`;
    const label = r.bet_type === "win" ? "単勝" : "複勝";
    return `**${label}** ${horseName} に ◈${r.amount.toLocaleString()}`;
  });

  await interaction.reply(ephemeral(`📋 あなたの賭け状況\n${lines.join("\n")}`));
}

export async function handleKeibaCancelOne(interaction: ButtonInteraction): Promise<void> {
  const [prefix, action, typeStr, raceId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "cancel_one" || !raceId) return;
  if (typeStr !== "win" && typeStr !== "place") return;
  const betType = typeStr as BetType;

  await interaction.deferReply({ ephemeral: true });

  const session = requireSession(raceId);
  if (!session || !session.acceptingBets) {
    await interaction.editReply("このレースの受付は終了しています。");
    return;
  }

  const userId = interaction.user.id;
  try {
    const refunded = runTransaction(() => {
      const row = db
        .prepare("SELECT amount FROM keiba_bets WHERE user_id = ? AND bet_type = ?")
        .get(userId, betType) as { amount: number } | undefined;
      if (!row) return 0;
      db.prepare("DELETE FROM keiba_bets WHERE user_id = ? AND bet_type = ?").run(userId, betType);
      const result = adjustBalance(userId, Math.floor(row.amount), `競馬${betType === "win" ? "単勝" : "複勝"}取り消し返金`, "keiba", interaction.guildId ?? undefined);
      if (!result.ok) throw new Error("Failed to refund.");
      return row.amount;
    });
    if (refunded === 0) {
      await interaction.editReply(`${betType === "win" ? "単勝" : "複勝"}は賭けていません。`);
      return;
    }
    await interaction.editReply(`${betType === "win" ? "単勝" : "複勝"}の賭けを取り消し、${refunded.toLocaleString()}エテル返金しました。`);
    void refreshPanel(session);
  } catch (error) {
    console.error("[keiba] cancel_one failed:", error);
    await interaction.editReply("取り消しに失敗しちゃった。ごめんね。");
  }
}

/** 主催者の「🏁 締切→スタート」ボタン。3分待たずに即レース開始。 */
export async function handleKeibaGo(interaction: ButtonInteraction): Promise<void> {
  const [prefix, action, raceId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "go" || !raceId) return;

  const session = requireSession(raceId);
  if (!session) { await interaction.reply({ content: "そのレースはもう無いみたい。", ephemeral: true }); return; }
  if (!session.acceptingBets) { await interaction.reply({ content: "もう受付終わってるよ。", ephemeral: true }); return; }
  if (!session.hostId || interaction.user.id !== session.hostId) {
    await interaction.reply({ content: "主催者だけがスタートできるよ。", ephemeral: true }); return;
  }

  // 3分タイマーをキャンセル
  if (session.closeTimeout) { clearTimeout(session.closeTimeout); session.closeTimeout = null; }

  await interaction.deferUpdate().catch(() => {});
  try {
    await closeBettingAndRunRace(session);
  } catch (error) {
    console.error("[keiba] manual go failed:", error);
    try {
      await rollbackRaceBets("レース処理エラー返金", session.guildId);
      await session.message.edit({ content: "⚠️ レース処理でエラーが発生したため、賭け金を全額返金しました。", components: [] });
    } catch { /* ignore */ }
    sessions.delete(session.raceId);
    releaseRaceLock();
  }
}

export async function handleKeibaCancel(interaction: ButtonInteraction): Promise<void> {
  const [prefix, action, raceId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "cancel" || !raceId) {
    return;
  }
  
  await interaction.deferReply({ ephemeral: true });
  
  const session = requireSession(raceId);
  if (!session || !session.acceptingBets) {
    await interaction.editReply("このレースの受付は終了しています。");
    return;
  }

  const userId = interaction.user.id;
  try {
    const refunded = runTransaction(() => {
      const bets = db
        .prepare("SELECT amount FROM keiba_bets WHERE user_id = ?")
        .all(userId) as Array<{ amount: number }>;

      let refund = 0;
      for (const bet of bets) {
        refund += Math.floor(bet.amount);
      }
      db.prepare("DELETE FROM keiba_bets WHERE user_id = ?").run(userId);
      if (refund > 0) {
        const result = adjustBalance(userId, refund, "競馬賭け取り消し返金", "keiba", interaction.guildId ?? undefined);
        if (!result.ok) {
          throw new Error("Failed to refund cancellation.");
        }
      }
      return refund;
    });
    if (refunded === 0) {
      await interaction.editReply("取り消し対象の賭けはありませんでした。");
      return;
    }
    await interaction.editReply(`賭けを取り消し、${refunded.toLocaleString()}エテル返金しました。`);
    void refreshPanel(session);
  } catch (error) {
    console.error("[keiba] cancel failed:", error);
    await interaction.editReply("取り消しに失敗しちゃった。ごめんね。");
  }
}

async function closeBettingAndRunRace(session: ActiveRaceSession): Promise<void> {
  session.acceptingBets = false;
  const panel = renderPanel(session, true);
  await session.message.edit({
    content: "⏰ 受付終了。レース開始までしばらくお待ちください...",
    embeds: [panel.embed],
    components: panel.rows
  });
  await runRace(session);
}

const STYLE_EMOJI: Record<string, string> = {
  nige: "🏃",
  senko: "⚡",
  sashi: "🎯",
  oikomi: "🔥",
};

function buildLane(pos: number, totalLanes = TRACK_LENGTH): string {
  const filled = Math.min(Math.floor(pos), totalLanes);
  const remain = Math.max(0, totalLanes - filled);
  return `${"━".repeat(filled)}🐎${"┄".repeat(remain)}`;
}

async function runRace(session: ActiveRaceSession): Promise<void> {
  const positions = new Map<number, number>(session.horses.map((h) => [h.id, 0]));
  const conditions = new Map<number, number>(
    session.horses.map((h) => [h.id, 0.8 + Math.random() * 0.4])
  );
  let finalStraightAnnounced = false;
  let prevLeaderId: number | null = null;

  // スタート煽り
  try {
    await session.message.edit({
      content: "🚦 **三、二、一…スタート！**",
      embeds: [
        new EmbedBuilder()
          .setTitle("🏇 レース開始")
          .setColor(0xC0392B)
          .setDescription(session.horses.map((h, i) => `${i + 1}. ${STYLE_EMOJI[h.style] ?? "🐎"} **${h.name}** (${h.style})\n　${buildLane(0)}`).join("\n")),
      ],
      components: [],
    });
    await sleep(2000);
  } catch { /* ignore */ }

  try {
    for (let turn = 1; turn <= 15; turn += 1) {
      for (const horse of session.horses) {
        const current = positions.get(horse.id) ?? 0;
        const progress = current / TRACK_LENGTH;
        const styleBonus =
          horse.style === "nige"
            ? 0.4 * (1 - progress)
            : horse.style === "senko"
              ? 0.25
              : horse.style === "sashi"
                ? 0.35 * progress
                : 0.45 * progress;
        const randomFactor = 0.75 + Math.random() * 0.5;
        const move = horse.base_speed * (conditions.get(horse.id) ?? 1) * randomFactor + styleBonus;
        positions.set(horse.id, Math.min(TRACK_LENGTH, current + move));
      }

      const ranking = [...session.horses].sort(
        (a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0)
      );
      const leaderPos = positions.get(ranking[0].id) ?? 0;
      const remain = TRACK_LENGTH - leaderPos;

      const board = ranking
        .map((horse, idx) => {
          const pos = positions.get(horse.id) ?? 0;
          const emoji = STYLE_EMOJI[horse.style] ?? "🐎";
          return `${idx + 1}. ${emoji} **${horse.name}**\n　${buildLane(pos)}`;
        })
        .join("\n");

      // 実況：先頭交代 / 最終直線 / 競り合い検出
      const commentary: string[] = [];
      if (prevLeaderId !== null && prevLeaderId !== ranking[0].id) {
        const newLeader = ranking[0].name;
        const oldLeader = session.horses.find((h) => h.id === prevLeaderId)?.name ?? "前の馬";
        commentary.push(`📢 **先頭交代！${newLeader} が ${oldLeader} を抜いた！**`);
      }
      if (!finalStraightAnnounced && remain < 5) {
        finalStraightAnnounced = true;
        commentary.push("🔥 **さあ最終直線！勝つのはどっちだ…！？**");
      }
      if (finalStraightAnnounced) {
        const secondPos = positions.get(ranking[1]?.id ?? -1) ?? 0;
        const lead = leaderPos - secondPos;
        if (lead < 0.5 && remain < 4) {
          commentary.push(`⚔️ 並んだ！${ranking[0].name} と ${ranking[1].name} の叩き合い！`);
        } else if (lead < 1.5 && remain < 3) {
          commentary.push(`🏃 ${ranking[1].name} が猛追！差は僅かじゃ…！`);
        }
      }
      prevLeaderId = ranking[0].id;

      const header = `**Turn ${turn}** ・ 先頭 ${ranking[0].name}（残り ${remain.toFixed(1)}）`;
      await session.message.edit({
        content: [header, ...commentary].join("\n"),
        embeds: [
          new EmbedBuilder().setTitle("🏇 レース進行").setColor(0xC0392B).setDescription(board)
        ],
        components: []
      });

      if (leaderPos >= TRACK_LENGTH) {
        await sleep(1500);
        await settleRace(session, ranking, positions);
        return;
      }

      await sleep(finalStraightAnnounced && remain < 5 ? FINAL_STRAIGHT_WAIT_MS : BASE_TURN_WAIT_MS);
    }

    const ranking = [...session.horses].sort(
      (a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0)
    );
    await settleRace(session, ranking, positions);
  } catch (error) {
    console.error("[keiba] race run failed:", error);
    await rollbackRaceBets("レース異常終了返金", session.guildId);
    await session.message.edit({
      content: "⚠️ レース中にシステムエラーが発生したため、賭け金を全額返金しました。",
      components: []
    });
  } finally {
    sessions.delete(session.raceId);
    releaseRaceLock();
  }
}

async function settleRace(session: ActiveRaceSession, ranking: KeibaHorse[], positions: Map<number, number>): Promise<void> {
  const top = ranking.slice(0, 3);
  const placeCount = session.horses.length === 8 ? 3 : 2;
  const placeWinners = ranking.slice(0, placeCount);

  const allBets = db
    .prepare("SELECT user_id, horse_id, bet_type, amount FROM keiba_bets")
    .all() as Array<{ user_id: string; horse_id: number; bet_type: BetType; amount: number }>;

  const status = getSystemStatus();
  const carryBefore = {
    win: status.keiba_carryover_win,
    place: status.keiba_carryover_place,
  };
  const nextCarry = { ...carryBefore };

  // 集計（精算前のスナップショット）
  const totalWin = allBets.filter((b) => b.bet_type === "win").reduce((s, b) => s + b.amount, 0);
  const totalPlace = allBets.filter((b) => b.bet_type === "place").reduce((s, b) => s + b.amount, 0);
  const winStakeOnTop = allBets.filter((b) => b.bet_type === "win" && b.horse_id === top[0].id).reduce((s, b) => s + b.amount, 0);
  const placeStakeOnTop = allBets.filter((b) => b.bet_type === "place" && placeWinners.some((w) => w.id === b.horse_id)).reduce((s, b) => s + b.amount, 0);
  const winPrizePool = Math.floor(totalWin * 0.8 + carryBefore.win);
  const placePrizePool = Math.floor(totalPlace * 0.8 + carryBefore.place);
  const winPayoutRate = winStakeOnTop > 0 ? (winPrizePool / winStakeOnTop) : 0;
  const placePayoutRate = placeStakeOnTop > 0 ? (placePrizePool / placeStakeOnTop) : 0;

  const payoutsByUser = new Map<string, number>();
  runTransaction(() => {
    settlePool("win", new Set([top[0].id]), allBets, nextCarry, session.guildId, payoutsByUser);
    settlePool("place", new Set(placeWinners.map((h) => h.id)), allBets, nextCarry, session.guildId, payoutsByUser);
    updateSystemStatus({
      keiba_carryover_win: nextCarry.win,
      keiba_carryover_place: nextCarry.place
    });
    db.prepare("DELETE FROM keiba_bets").run();
  });

  const resultText = [
    `🥇 1着: **${top[0].name}** (${STYLE_EMOJI[top[0].style] ?? ""} ${top[0].style})`,
    `🥈 2着: ${top[1]?.name ?? "-"}`,
    `🥉 3着: ${top[2]?.name ?? "-"}`,
    "",
    `複勝対象: ${placeWinners.map((h) => h.name).join(", ")}`
  ].join("\n");

  const board = ranking
    .map((horse, idx) => `${idx + 1}. ${horse.name} (${Math.floor(positions.get(horse.id) ?? 0)}マス)`)
    .join("\n");

  // 払戻内訳
  const breakdown: string[] = [];
  breakdown.push(`💰 **単勝プール**: ◈${totalWin.toLocaleString()} (+繰越◈${carryBefore.win.toLocaleString()})`);
  if (winStakeOnTop > 0) {
    breakdown.push(`　└ 配当率: **${winPayoutRate.toFixed(2)}倍** (1着 ${top[0].name} に ◈${winStakeOnTop.toLocaleString()})`);
  } else {
    breakdown.push(`　└ 的中ゼロ: 50%返還 / 50%繰越 (◈${nextCarry.win.toLocaleString()})`);
  }
  breakdown.push(`💰 **複勝プール**: ◈${totalPlace.toLocaleString()} (+繰越◈${carryBefore.place.toLocaleString()})`);
  if (placeStakeOnTop > 0) {
    breakdown.push(`　└ 配当率: **${placePayoutRate.toFixed(2)}倍** (複勝対象に ◈${placeStakeOnTop.toLocaleString()})`);
  } else {
    breakdown.push(`　└ 的中ゼロ: 50%返還 / 50%繰越 (◈${nextCarry.place.toLocaleString()})`);
  }
  const houseCut = Math.floor((totalWin + totalPlace) * 0.2);
  breakdown.push(`🏛️ ハウス取り分 (20%): ◈${houseCut.toLocaleString()}`);

  // 当たり金額（個人別、降順）
  if (payoutsByUser.size > 0) {
    const sorted = [...payoutsByUser.entries()].sort((a, b) => b[1] - a[1]);
    const PAYOUT_CAP = 10;
    const winLines = sorted.slice(0, PAYOUT_CAP).map(([uid, amt]) => `　🎯 <@${uid}> → **+◈${amt.toLocaleString()}**`);
    if (sorted.length > PAYOUT_CAP) winLines.push(`　…他 ${sorted.length - PAYOUT_CAP}人`);
    breakdown.push("");
    breakdown.push("**💴 当たり金額**");
    breakdown.push(...winLines);
  }

  // レース後の「もう一度開催」ボタン
  const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`keiba:restart:${session.message.channelId}`)
      .setLabel("🏇 もう一度開催")
      .setStyle(ButtonStyle.Primary),
  );

  // 賭けた人を全員メンション（重複排除・最大25人で打ち切り）
  const bettorIds = Array.from(new Set(allBets.map((b) => b.user_id)));
  const mentionCap = 25;
  const mentionsLine = bettorIds.length > 0
    ? `\n${bettorIds.slice(0, mentionCap).map((id) => `<@${id}>`).join(" ")}${bettorIds.length > mentionCap ? ` …他${bettorIds.length - mentionCap}人` : ""}`
    : "";

  await session.message.edit({
    content: `🏁 **レース終了！結果発表**${mentionsLine}`,
    embeds: [
      new EmbedBuilder().setTitle("🏆 結果").setColor(0xF1C40F).setDescription(resultText),
      new EmbedBuilder().setTitle("📊 払戻内訳").setColor(0xC0392B).setDescription(breakdown.join("\n")),
      new EmbedBuilder().setTitle("📋 最終着順").setColor(0x95A5A6).setDescription(board)
    ],
    components: [retryRow],
    allowedMentions: { users: bettorIds.slice(0, mentionCap) },
  });
}

/**
 * 「もう一度開催」ボタンのハンドラ。誰でも押せて、同じチャンネルで新レースを開始する。
 */
export async function handleKeibaRestart(interaction: ButtonInteraction): Promise<void> {
  const [prefix, action, channelId] = interaction.customId.split(":");
  if (prefix !== "keiba" || action !== "restart" || !channelId) return;

  // 既に走行中ならスキップ
  if (!tryAcquireRaceLock()) {
    await interaction.reply({ content: "もう別のレースが開催中だよ。終わるまで待ってね。", ephemeral: true });
    return;
  }
  releaseRaceLock(); // 一旦解放、startRace で再取得させる

  // 押下メッセージを「再開催中」に上書き
  try {
    await interaction.update({
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("keiba:restart_used").setLabel("🏇 開催中…").setStyle(ButtonStyle.Secondary).setDisabled(true),
        ),
      ],
    });
  } catch { /* */ }

  try {
    await startRace(interaction.client, {
      channelId,
      initiatedBy: `<@${interaction.user.id}>`,
      isScheduled: false,
      hostUserId: interaction.user.id,
    });
  } catch (error) {
    console.error("[keiba] restart failed:", error);
    try { await interaction.followUp({ content: "再開催が叶わなんだ。少し待ってからもう一度試してくれ。", ephemeral: true }); } catch { /* */ }
  }
}

function settlePool(
  betType: BetType,
  winnerHorseIds: Set<number>,
  allBets: Array<{ user_id: string; horse_id: number; bet_type: BetType; amount: number }>,
  nextCarry: { win: number; place: number },
  guildId: string,
  payouts: Map<string, number>,
): void {
  const poolBets = allBets.filter((b) => b.bet_type === betType);
  if (poolBets.length === 0) {
    return;
  }

  const total = Math.floor(poolBets.reduce((sum, b) => sum + Math.floor(b.amount), 0));
  const retained = Math.floor(total * 0.8);
  const carryKey = betType === "win" ? "win" : "place";
  const prizePool = Math.floor(retained + nextCarry[carryKey]);
  const winners = poolBets.filter((b) => winnerHorseIds.has(b.horse_id));

  if (winners.length > 0) {
    const totalWinnerStake = Math.floor(winners.reduce((sum, b) => sum + Math.floor(b.amount), 0));
    let distributed = 0;
    for (let i = 0; i < winners.length; i += 1) {
      const b = winners[i];
      const payout =
        i === winners.length - 1
          ? Math.floor(prizePool - distributed)
          : Math.floor((prizePool * Math.floor(b.amount)) / totalWinnerStake);
      distributed += payout;
      const paid = adjustBalance(b.user_id, payout, `競馬${betType}配当`, "keiba", guildId);
      if (!paid.ok) {
        throw new Error("Payout failed.");
      }
      payouts.set(b.user_id, (payouts.get(b.user_id) ?? 0) + payout);
    }
    nextCarry[carryKey] = 0;
    return;
  }

  // 的中ゼロ: 50%返還 + 50%キャリーオーバー
  const refundPool = Math.floor(prizePool * 0.5);
  let refunded = 0;
  for (let i = 0; i < poolBets.length; i += 1) {
    const b = poolBets[i];
    const refund =
      i === poolBets.length - 1
        ? Math.floor(refundPool - refunded)
        : Math.floor((refundPool * Math.floor(b.amount)) / total);
    refunded += refund;
    const result = adjustBalance(b.user_id, refund, `競馬${betType}的中なし返還`, "keiba", guildId);
    if (!result.ok) {
      throw new Error("Refund failed.");
    }
  }
  nextCarry[carryKey] = Math.floor(prizePool - refunded);
}

async function rollbackRaceBets(reason: string, guildId?: string): Promise<void> {
  const bets = db.prepare("SELECT user_id, amount FROM keiba_bets").all() as Array<{ user_id: string; amount: number }>;
  runTransaction(() => {
    for (const bet of bets) {
      const refund = adjustBalance(bet.user_id, Math.floor(bet.amount), reason, "keiba", guildId);
      if (!refund.ok) {
        throw new Error("Rollback refund failed.");
      }
    }
    db.prepare("DELETE FROM keiba_bets").run();
  });
}
