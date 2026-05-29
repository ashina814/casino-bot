/**
 * 📈 龍脈相場（株式投資）
 *
 * 龍脈の力を「銘柄」として売買する投資ゲーム。
 * 1時間ごとに値動き。ランダムウォーク + イベント。
 * 余剰エテルのマネーシンク & 長期戦略コンテンツ。
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
} from "discord.js";
import { db, getServerConfig, runTransaction } from "../../core/db";
import { adjustBalance, getBalance, ensureUser, validateBet, getProfile } from "../../core/bank";
import { getTierByKey } from "../../core/economy";
import { baseEmbed, COLORS, infoEmbed, errorEmbed, successEmbed } from "../../ui/embeds";

// ─── Types ─────────────────────────────────────────────

type Stock = {
  id: string;
  name: string;
  emoji: string;
  price: number;
  prev_price: number;
  trend: number; // -1 to 1, affects bias
  last_update: string;
};

type Holding = {
  user_id: string;
  stock_id: string;
  shares: number;
  avg_cost: number;
};

// ─── DB Init ───────────────────────────────────────────

export function initStockTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 1000,
      prev_price INTEGER NOT NULL DEFAULT 1000,
      trend REAL NOT NULL DEFAULT 0,
      last_update TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS holdings (
      user_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      shares INTEGER NOT NULL DEFAULT 0 CHECK(shares >= 0),
      avg_cost INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, stock_id)
    );

    CREATE TABLE IF NOT EXISTS stock_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id TEXT NOT NULL,
      price INTEGER NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_stock_time
      ON stock_price_history(stock_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS stock_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('buy', 'sell')),
      shares INTEGER NOT NULL,
      price INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      profit_loss INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stock_tx_user_time
      ON stock_transactions(user_id, created_at DESC);
  `);

  // Seed stocks if empty
  const count = db.prepare("SELECT COUNT(*) as c FROM stocks").get() as { c: number };
  if (count.c === 0) {
    const seeds: Omit<Stock, "prev_price" | "last_update">[] = [
      { id: "guren", name: "紅蓮の脈", emoji: "🔥", price: 1000, trend: 0.1 },
      { id: "souhyo", name: "蒼氷の脈", emoji: "❄️", price: 800, trend: -0.05 },
      { id: "ougon", name: "黄金の脈", emoji: "✨", price: 1500, trend: 0.15 },
      { id: "shinryoku", name: "深緑の脈", emoji: "🌿", price: 600, trend: 0 },
      { id: "meiun", name: "冥雲の脈", emoji: "🌑", price: 1200, trend: -0.1 },
    ];

    const insert = db.prepare(
      "INSERT INTO stocks (id, name, emoji, price, prev_price, trend) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const s of seeds) {
      insert.run(s.id, s.name, s.emoji, s.price, s.price, s.trend);
    }
  }
}

// ─── Price Update ──────────────────────────────────────

/**
 * 全銘柄の価格を更新する。1時間ごとにcronで呼ぶ。
 * ランダムウォーク + トレンドバイアス + 稀にイベント。
 */
export function updateAllPrices(): { events: string[] } {
  const stocks = db.prepare("SELECT * FROM stocks").all() as Stock[];
  const events: string[] = [];

  const update = db.prepare(
    "UPDATE stocks SET prev_price = price, price = ?, trend = ?, last_update = datetime('now') WHERE id = ?"
  );

  runTransaction(() => {
    for (const stock of stocks) {
      let newPrice = stock.price;
      let newTrend = stock.trend;

      // Random walk with trend bias
      const volatility = 0.08; // 8% max change
      const change = (Math.random() - 0.5 + stock.trend * 0.3) * volatility;
      newPrice = Math.round(stock.price * (1 + change));

      // Trend mean-reversion
      newTrend *= 0.95; // slowly decay toward 0
      newTrend += (Math.random() - 0.5) * 0.05; // small random shift
      newTrend = Math.max(-0.5, Math.min(0.5, newTrend));

      // Rare events (2% chance each)
      const eventRoll = Math.random();
      if (eventRoll < 0.02) {
        // Surge: +30-60%
        const surge = 1.3 + Math.random() * 0.3;
        newPrice = Math.round(stock.price * surge);
        newTrend = 0.3;
        events.push(`🐉 **龍脈噴出！** ${stock.emoji}${stock.name} が急騰！ (+${Math.round((surge - 1) * 100)}%)`);
      } else if (eventRoll < 0.04) {
        // Crash: -30-50%
        const crash = 0.5 + Math.random() * 0.2;
        newPrice = Math.round(stock.price * crash);
        newTrend = -0.3;
        events.push(`💀 **龍脈枯渇！** ${stock.emoji}${stock.name} が急落！ (-${Math.round((1 - crash) * 100)}%)`);
      }

      // Floor
      newPrice = Math.max(50, newPrice);

      update.run(newPrice, newTrend, stock.id);

      // 履歴記録（スパークライン用、3時間×24=3日分保持）
      db.prepare(
        "INSERT INTO stock_price_history (stock_id, price) VALUES (?, ?)"
      ).run(stock.id, newPrice);
    }

    // 古い履歴削除（各銘柄 最新24件のみ保持 = 3日分）
    db.prepare(`
      DELETE FROM stock_price_history
      WHERE id NOT IN (
        SELECT id FROM stock_price_history h2
        WHERE h2.stock_id = stock_price_history.stock_id
        ORDER BY recorded_at DESC LIMIT 24
      )
    `).run();
  });

  return { events };
}

// ─── Sparkline & Trend Meter ───────────────────────────

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

function sparkline(prices: number[]): string {
  if (prices.length === 0) return "(履歴なし)";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  if (range === 0) return SPARK_CHARS[3].repeat(prices.length);
  return prices.map((p) => {
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor(((p - min) / range) * (SPARK_CHARS.length - 1)));
    return SPARK_CHARS[idx];
  }).join("");
}

function getPriceHistory(stockId: string, limit = 24): number[] {
  const rows = db.prepare(
    "SELECT price FROM stock_price_history WHERE stock_id = ? ORDER BY recorded_at DESC LIMIT ?"
  ).all(stockId, limit) as Array<{ price: number }>;
  // 古い→新しい順に並び替え
  return rows.map((r) => r.price).reverse();
}

/**
 * trend (-0.5..+0.5) を 5段階の視覚メーターに変換
 */
function trendMeter(trend: number): string {
  if (trend >= 0.25) return "🔥🔥🔥🔥🔥 強気";
  if (trend >= 0.1)  return "🔥🔥🔥▫️▫️ やや強気";
  if (trend > -0.1)  return "▫️▫️🟡▫️▫️ 凪";
  if (trend > -0.25) return "▫️▫️🌪️🌪️🌪️ やや弱気";
  return "🌪️🌪️🌪️🌪️🌪️ 弱気";
}

// ─── Helper ────────────────────────────────────────────

function getAllStocks(): Stock[] {
  return db.prepare("SELECT * FROM stocks ORDER BY price DESC").all() as Stock[];
}

function getStock(id: string): Stock | undefined {
  return db.prepare("SELECT * FROM stocks WHERE id = ?").get(id) as Stock | undefined;
}

function getHoldings(userId: string): Holding[] {
  return db.prepare("SELECT * FROM holdings WHERE user_id = ? AND shares > 0").all(userId) as Holding[];
}

function getHolding(userId: string, stockId: string): Holding | undefined {
  return db.prepare("SELECT * FROM holdings WHERE user_id = ? AND stock_id = ?").get(userId, stockId) as Holding | undefined;
}

function changeEmoji(current: number, prev: number): string {
  if (current > prev) return "📈";
  if (current < prev) return "📉";
  return "➡️";
}

// ─── Command ───────────────────────────────────────────

export const stocksCommand = new SlashCommandBuilder()
  .setName("龍脈")
  .setDescription("📈 龍脈相場 — 龍脈の力に投資する");

export async function handleStocksCommand(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  initStockTables();
  ensureUser(userId, guildId);

  await renderDashboard(interaction, userId, guildId);
}

// ─── Dashboard ─────────────────────────────────────────

export async function renderDashboard(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  userId: string,
  guildId: string
): Promise<void> {
  const stocks = getAllStocks();
  const holdings = getHoldings(userId);

  // Market string — 価格 + スパークライン + 気運メーター
  const marketLines = stocks.map((s) => {
    const pct = s.prev_price > 0 ? (((s.price - s.prev_price) / s.prev_price) * 100).toFixed(1) : "0.0";
    const sign = s.price >= s.prev_price ? "+" : "";
    const spark = sparkline(getPriceHistory(s.id, 24));
    const meter = trendMeter(s.trend);
    return (
      `${s.emoji} **${s.name}** — ◈${s.price.toLocaleString()} ${changeEmoji(s.price, s.prev_price)} ${sign}${pct}%\n` +
      `　\`${spark}\`  気運: ${meter}`
    );
  });

  // Portfolio string
  let pfLines = ["まだ何も持っておらぬ。"];
  let totalValue = 0;
  let totalCost = 0;

  if (holdings.length > 0) {
    pfLines = holdings.map(h => {
      const stock = stocks.find(s => s.id === h.stock_id);
      if (!stock) return "";
      const value = h.shares * stock.price;
      const cost = h.shares * h.avg_cost;
      const profit = value - cost;
      const pct = cost > 0 ? ((profit / cost) * 100).toFixed(1) : "0.0";
      
      totalValue += value;
      totalCost += cost;

      const emoji = profit >= 0 ? "📈" : "📉";
      return `${stock.emoji} **${stock.name}** × ${h.shares}株\n` +
             `　　評価: ◈${value.toLocaleString()} (${emoji} ${profit >= 0 ? "+" : ""}${pct}%)`;
    }).filter(l => l.length > 0);
  }

  const totalProfit = totalValue - totalCost;
  const totalPct = totalCost > 0 ? ((totalProfit / totalCost) * 100).toFixed(1) : "0.0";

  const embed = baseEmbed("📈 龍脈相場（投資）", COLORS.GOLD)
    .setDescription(
      [
        `*「龍脈の力は日々変わる。見極めるのじゃ。」*`,
        "",
        `**【 銘柄一覧 】**`,
        ...marketLines,
        "",
        `**【 あなたの保有状況 】**`,
        ...pfLines,
        ...(holdings.length > 0 ? [
          `━━━━━━━━━━━━━━`,
          `💰 総評価額: ◈${totalValue.toLocaleString()}`,
          `${totalProfit >= 0 ? "📈" : "📉"} 総損益: ${totalProfit >= 0 ? "+" : ""}◈${totalProfit.toLocaleString()} (${totalProfit >= 0 ? "+" : ""}${totalPct}%)`,
        ] : []),
      ].join("\n"),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("stocks_buy_menu").setLabel("💰 購入する").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("stocks_sell_menu").setLabel("💵 売却する").setStyle(ButtonStyle.Danger).setDisabled(holdings.length === 0),
    new ButtonBuilder().setCustomId("stocks_refresh").setLabel("🔄 更新").setStyle(ButtonStyle.Secondary),
  );

  if (interaction.isChatInputCommand() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ embeds: [embed], components: [row] });
    } else {
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  } else if (interaction.isButton()) {
    try {
      await interaction.update({ embeds: [embed], components: [row] });
    } catch {
      await interaction.editReply({ embeds: [embed], components: [row] });
    }
  }
}

// ─── Interaction Handlers ──────────────────────────────

export async function handleStocksButton(interaction: ButtonInteraction): Promise<void> {
  const action = interaction.customId.replace("stocks_", "");
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  if (action === "refresh") {
    await renderDashboard(interaction, userId, guildId);
    return;
  }

  if (action === "buy_menu") {
    const stocks = getAllStocks();
    const select = new StringSelectMenuBuilder()
      .setCustomId("stocks_buy_select")
      .setPlaceholder("購入する銘柄を選ぶのじゃ")
      .addOptions(stocks.map(s => ({
        label: `${s.name} (◈${s.price.toLocaleString()})`,
        value: s.id,
        emoji: s.emoji,
      })));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ components: [row], embeds: interaction.message.embeds });
    return;
  }

  if (action === "sell_menu") {
    const holdings = getHoldings(userId);
    const stocks = getAllStocks();
    const select = new StringSelectMenuBuilder()
      .setCustomId("stocks_sell_select")
      .setPlaceholder("売却する銘柄を選ぶのじゃ")
      .addOptions(holdings.map(h => {
        const s = stocks.find(x => x.id === h.stock_id);
        return {
          label: `${s?.name} (保有: ${h.shares}株)`,
          value: h.stock_id,
          emoji: s?.emoji,
        };
      }));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ components: [row], embeds: interaction.message.embeds });
    return;
  }
}

export async function handleStocksSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const action = interaction.customId.replace("stocks_", "");
  const stockId = interaction.values[0];
  const stock = getStock(stockId);
  if (!stock) {
    await interaction.reply({ content: "銘柄が見つからぬ。", ephemeral: true });
    return;
  }

  if (action === "buy_select") {
    const profile = getProfile(interaction.user.id, interaction.guildId!);
    const tier = getTierByKey(profile.tier);
    const modal = new ModalBuilder()
      .setCustomId(`stocks_buy_modal_${stockId}`)
      .setTitle(`${stock.name} を購入`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`投資額 (1株◈${stock.price} / 上限◈${tier.betCap.toLocaleString()})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
  } else if (action === "sell_select") {
    const holding = getHolding(interaction.user.id, stockId);
    const shares = holding ? holding.shares : 0;
    const modal = new ModalBuilder()
      .setCustomId(`stocks_sell_modal_${stockId}`)
      .setTitle(`${stock.name} を売却`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("shares")
            .setLabel(`売却株数 (空欄で全売却) [保有: ${shares}株]`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        )
      );
    await interaction.showModal(modal);
  }
}

export async function handleStocksModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  
  if (interaction.customId.startsWith("stocks_buy_modal_")) {
    const stockId = interaction.customId.replace("stocks_buy_modal_", "");
    const amountStr = interaction.fields.getTextInputValue("amount");

    // tier に応じた1回投資の上限を適用（他ゲームの賭け上限と整合）
    const profile = getProfile(userId, guildId);
    const tier = getTierByKey(profile.tier);
    const txMax = tier.betCap;

    const validated = validateBet(amountStr.trim(), 100, txMax);
    if (!validated.ok) {
      const reason = validated.reason;
      const msg =
        reason === "TOO_LARGE"
          ? `1回の投資額は **◈${txMax.toLocaleString()}** までじゃ（${tier.emoji}${tier.name} の上限）。`
          : reason === "TOO_SMALL"
            ? "投資額は **100以上** で指定するのじゃ。"
            : "投資額は整数で指定するのじゃ。";
      await interaction.reply({ content: msg, ephemeral: true });
      return;
    }
    const amount = validated.value;

    const stock = getStock(stockId);
    if (!stock) return;

    const shares = Math.floor(amount / stock.price);
    if (shares < 1) {
      await interaction.reply({ content: `◈${amount} では1株も買えぬ（1株 = ◈${stock.price.toLocaleString()}）`, ephemeral: true });
      return;
    }

    const totalCost = shares * stock.price;
    const result = adjustBalance(userId, -totalCost, "stock_buy", "stocks", guildId);
    if (!result.ok) {
      await interaction.reply({ content: "エテルが足りぬぞ…。", ephemeral: true });
      return;
    }

    const existing = getHolding(userId, stockId);
    if (existing) {
      const newShares = existing.shares + shares;
      const newAvg = Math.floor((existing.avg_cost * existing.shares + totalCost) / newShares);
      db.prepare("UPDATE holdings SET shares = ?, avg_cost = ? WHERE user_id = ? AND stock_id = ?")
        .run(newShares, newAvg, userId, stockId);
    } else {
      db.prepare("INSERT INTO holdings (user_id, stock_id, shares, avg_cost) VALUES (?, ?, ?, ?)")
        .run(userId, stockId, shares, stock.price);
    }

    // 取引履歴に記録
    try {
      db.prepare(
        "INSERT INTO stock_transactions (user_id, stock_id, action, shares, price, amount) VALUES (?, ?, 'buy', ?, ?, ?)"
      ).run(userId, stockId, shares, stock.price, totalCost);
    } catch { /* ignore */ }

    const unused = amount - totalCost;
    const unusedLine = unused > 0 ? `\n（入力 ◈${amount.toLocaleString()} のうち ◈${unused.toLocaleString()} は端数のため未使用 — 残高に保持）` : "";

    await interaction.reply({
      embeds: [successEmbed(
        `${stock.emoji} **${stock.name}** を **${shares}株** 購入！\n` +
        `投資額: ◈${totalCost.toLocaleString()} (1株 ◈${stock.price.toLocaleString()})${unusedLine}`
      )],
      ephemeral: true
    });

  } else if (interaction.customId.startsWith("stocks_sell_modal_")) {
    const stockId = interaction.customId.replace("stocks_sell_modal_", "");
    const sharesStr = interaction.fields.getTextInputValue("shares").trim();

    const stock = getStock(stockId);
    const holding = getHolding(userId, stockId);

    if (!stock || !holding || holding.shares <= 0) {
      await interaction.reply({ content: "保有しておらぬぞ。", ephemeral: true });
      return;
    }

    // 空欄なら全株売却、数値指定があればバリデーション
    let shares: number;
    if (sharesStr === "") {
      shares = holding.shares;
    } else {
      const v = validateBet(sharesStr, 1, holding.shares);
      if (!v.ok) {
        await interaction.reply({ content: `1〜${holding.shares}株の範囲で整数指定するのじゃ。`, ephemeral: true });
        return;
      }
      shares = v.value;
    }
    if (shares > holding.shares) {
      await interaction.reply({ content: `${holding.shares}株しか持っておらぬ。`, ephemeral: true });
      return;
    }

    const revenue = shares * stock.price;
    const costBasis = shares * holding.avg_cost;
    const profit = revenue - costBasis;

    adjustBalance(userId, revenue, "stock_sell", "stocks", guildId);

    const remaining = holding.shares - shares;
    if (remaining <= 0) {
      db.prepare("DELETE FROM holdings WHERE user_id = ? AND stock_id = ?").run(userId, stockId);
    } else {
      db.prepare("UPDATE holdings SET shares = ? WHERE user_id = ? AND stock_id = ?")
        .run(remaining, userId, stockId);
    }

    // 取引履歴 + 実現損益を記録
    try {
      db.prepare(
        "INSERT INTO stock_transactions (user_id, stock_id, action, shares, price, amount, profit_loss) VALUES (?, ?, 'sell', ?, ?, ?, ?)"
      ).run(userId, stockId, shares, stock.price, revenue, profit);
    } catch { /* ignore */ }

    const profitStr = profit >= 0 ? `+◈${profit.toLocaleString()}` : `-◈${Math.abs(profit).toLocaleString()}`;
    const emoji = profit >= 0 ? "📈" : "📉";

    await interaction.reply({
      embeds: [successEmbed(
        `${stock.emoji} **${stock.name}** を **${shares}株** 売却！\n` +
        `売却額: ◈${revenue.toLocaleString()} / 損益: ${emoji} ${profitStr}`
      )],
      ephemeral: true
    });
  }
}
