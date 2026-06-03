/**
 * ヘルプパネル — カテゴリ別ガイド
 *
 * 概要 + 5カテゴリのセレクトメニュー：
 * - 🎮 ゲーム — 各ゲームの一行紹介と起動方法（詳細は各ゲームの📖配当表ボタン）
 * - 💼 経済 — 段位・星の力・cap・福の重み等の仕組み
 * - ✦ アステル — 覚醒・モード
 * - ✨ 隠し・レア — 二つ名・レアイベント・隠しコマンド
 * - 🔤 用語集 — 主要な単語の辞書
 */
import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from "discord.js";
import { baseEmbed, COLORS } from "../embeds";
import { safeReply, safeEditReply } from "../../core/safeReply";

// ─── Section Embeds ────────────────────────────────────

function overviewEmbed(): EmbedBuilder {
  return baseEmbed("📖 賭場の歩き方", COLORS.GOLD)
    .setDescription(
      [
        "*「初めてだね。何が知りたい？」*",
        "",
        "下のメニューから知りたいカテゴリを選んでね。",
      ].join("\n"),
    )
    .addFields(
      {
        name: "✦ まずはここから（最低限）",
        value: [
          "`/案内` — ホーム。全機能の入口",
          "📅 **福分け**（`/案内` のボタン）— 毎日のボーナス（連続で増える）",
          "`/通行証` — 自分の所持金・戦績",
        ].join("\n"),
      },
      {
        name: "📋 今日の任務",
        value: [
          "`/案内` → 「📋 任務」 で**毎日3つの任務**が出る。",
          "達成して受領するとエテル+星の力ボーナス。**当日中限り**。",
        ].join("\n"),
      },
      {
        name: "🗂 カテゴリ",
        value: [
          "🎮 **ゲーム** — 何で遊べるか",
          "💼 **経済** — 段位・上限・福の重み等の仕組み",
          "✦ **アステル** — 星約段階・モード",
          "✨ **隠し・レア** — 二つ名・レアイベント",
          "🔤 **用語集** — 「cap」「JP」「奉納」って何？",
        ].join("\n"),
      },
    )
    .setFooter({ text: "詳しいルールは各ゲーム結果の「📖 配当表」ボタンでも見れる" });
}

function gamesEmbed(): EmbedBuilder {
  return baseEmbed("🎮 ヘルプ — ゲーム一覧", COLORS.GOLD)
    .setDescription("各ゲームを始めると「📖 配当表」ボタンで詳細ルールが見れる。")
    .addFields(
      {
        name: "🏠 単独プレイ（`/遊ぶ` 経由）",
        value: [
          "🎰 `/遊ぶ スロット` — スロット（ワイルド/スキャッター/JP有り）",
          "🎴 `/遊ぶ 丁半` — 丁半（丁=偶 / 半=奇、対 胴のソロ）",
          "🃏 `/遊ぶ ブラックジャック` — ブラックジャック",
          "📈 `/遊ぶ クラッシュ` — クラッシュ（最低降車1.5x、降りるタイミング）",
          "🎲 `/遊ぶ チンチロ` — チンチロ（対アステル タイマン、役比べ）",
        ].join("\n"),
      },
      {
        name: "👥 みんなで",
        value: [
          "🎡 `/遊ぶ ルーレット` — ルーレット（赤黒奇偶緑、複数人参加可）",
          "🏇 `/競馬 start` — 競馬（単勝・複勝のパリミューチュエル）",
          "🎴 `/丁半 立てる` — 丁半（胴が振り、丁/半に分かれて張る多人数戦）",
          "🎲 `/チンチロ対戦 申込み` — チンチロ 1対1（賭けて勝者総取り）",
        ].join("\n"),
      },
      {
        name: "📈 投資系",
        value: [
          "`/株` — 株（5銘柄、3時間ごと値動き、スパークラインで履歴可視化）",
        ].join("\n"),
      },
    );
}

function economyEmbed(): EmbedBuilder {
  return baseEmbed("💼 ヘルプ — 経済の仕組み", COLORS.GOLD)
    .addFields(
      {
        name: "💴 残高と上限（cap）",
        value: [
          "所持金には上限 (cap) がある。**勝って cap を超えた分は自動で「奉納」**されて、JPプール/救済プールに半々で流れる。",
          "→ 「賭ければ賭けるほど富が永遠に増える」を防ぐ仕組み。",
        ].join("\n"),
      },
      {
        name: "🥇 星位と賭け上限",
        value: [
          "プレイすると **星の力 (EXP)** が貯まり、レベルが上がる。レベルで星位（漂着者→星拾い→星約者→星詠み→北極星）が昇格し、**1回の賭け上限**が解放される。",
          "現在の星位・賭け上限は `/通行証` で確認。",
        ].join("\n"),
      },
      {
        name: "⚖️ 福の重み（累進奉納）",
        value: [
          "所持金が多くなるほど、**勝利金の一部が自動で奉納**される（5%〜30%）。アステルとの星約が深まると軽減される。",
          "→ 「富めば富むほど勝ち分が減る」累進課税のような仕組み。",
        ].join("\n"),
      },
      {
        name: "🎯 ハウスエッジ・ラッキーゲーム",
        value: [
          "各ゲームには **ハウスエッジ (4-5%)** が組み込まれ、長期的にはハウスが微益。",
          "ただし **日替わりラッキーゲーム** は配当 1.2 倍（`/案内` で今日のラッキー確認）。",
        ].join("\n"),
      },
      {
        name: "🏆 JPプール（スロット）",
        value: [
          "スロットの賭金の **1%が累積**。アステル3つ揃いで **プールの半分を獲得**。残り半分は次回シードに残留。",
          "現在のプール額はスロット画面で常時表示。",
        ].join("\n"),
      },
    );
}

function zashikiEmbed(): EmbedBuilder {
  return baseEmbed("✦ ヘルプ — アステルとの星約", COLORS.GOLD)
    .addFields(
      {
        name: "💖 好感度と覚醒段階（6段階）",
        value: [
          "プレイ・福分け・心付けで **好感度** が貯まる。閾値超えで **覚醒段階**が上がり、新たな恩恵が解放：",
          "・Lv2: 身代わりの加護 解禁",
          "・Lv3: レアイベント解放",
          "・Lv4: 拗ねモード、星祝（勝利金が膨らむ）",
          "・Lv5: 福の重み軽減、JP+",
          "・Lv6: 蝕モード、星隠れ",
          "現状は `/アステル status` で確認。",
        ].join("\n"),
      },
      {
        name: "🎭 セリフモード",
        value: [
          "覚醒段階で **セリフモード**（常 / 拗ね / 蝕、＋前世）が解放される。",
          "`/アステル mode` で切替。今のところ **セリフ味の変化のみ**（ゲーム効果はない）。",
        ].join("\n"),
      },
      {
        name: "🛡️ 身代わりの加護",
        value: [
          "Lv2以降、**敗北時に稀に賭金が返ってくる**。覚醒段階が高いほど発動率↑。",
        ].join("\n"),
      },
    );
}

function hiddenEmbed(): EmbedBuilder {
  return baseEmbed("✨ ヘルプ — 隠し・レアの世界", COLORS.GOLD)
    .addFields(
      {
        name: "📜 二つ名（称号）",
        value: [
          "特定の条件を満たすと自動で授かる称号。`/案内` → 「📜 二つ名」で取得済みと未取得（ヒント付き）を確認。",
          "ヒント例: 「深夜の刻に来た者」「百敗してなお…」など。",
          "商店で買える奉納系の称号もある。",
        ].join("\n"),
      },
      {
        name: "✨ レアイベント（覚醒で起こる）",
        value: [
          "星約が深まると、稀にアステルの光が揺らいで起こる：",
          "・**流星** — 福分けで稀に、ボーナスエテル",
          "・**星祝** — 勝利時に稀に、配当が膨らむ",
          "・**庇護の光** — 敗北時に稀に、賭金返還",
          "・**星隠れ** — 高位の星約で起こる極稀な現象",
          "*（発動率は伏せておくね。星約を深めて、自分で出会って）*",
        ].join("\n"),
      },
      {
        name: "🔍 隠しコマンド・遊び",
        value: [
          "`/アステル お礼` — アステルにお礼を言う。何度かで…？",
          "**特定の数字で賭ける**と縁起の良いことがあるとか…",
          "**深夜の特定時刻**にプレイすると珍しいことが…",
        ].join("\n"),
      },
    );
}

function glossaryEmbed(): EmbedBuilder {
  return baseEmbed("🔤 ヘルプ — 用語集", COLORS.GOLD)
    .addFields(
      {
        name: "💴 通貨・残高",
        value: [
          "**エテル (◈)**: ゲーム内通貨",
          "**cap (所持金上限)**: 残高の天井。超過分は自動奉納",
          "**奉納**: cap超過や福の重みで自動的にプールへ流れる",
        ].join("\n"),
      },
      {
        name: "🎯 進行・星位",
        value: [
          "**星の力 (EXP)**: プレイで貯まる経験値",
          "**星位 (tier)**: 漂着者→星拾い→星約者→星詠み→北極星。賭け上限が変わる",
          "**星約段階**: アステルとの絆の深さ。好感度で上がる",
          "**好感度**: アステルとの星約。プレイ・福分け・心付けで貯まる、日次で少し減衰",
        ].join("\n"),
      },
      {
        name: "💰 経済",
        value: [
          "**ハウスエッジ**: ゲームの理論的な店側取り分（4-5%）",
          "**RTP**: 還元率（理論的に賭けの何%が返ってくるか）",
          "**福の重み**: 所持金に応じた累進的な勝利金奉納（5-30%）",
          "**JPプール**: スロット専用の累積式ジャックポット",
          "**救済プール**: 別建ての福分けプール。底辺保護用",
          "**繰越**: 競馬で的中ゼロの時、賞金プールが次回に持ち越し",
        ].join("\n"),
      },
      {
        name: "🎲 ゲーム用語",
        value: [
          "**パリミューチュエル**: 全員の賭金が1つのプールに集まり、当選者で分ける方式（競馬）",
          "**ワイルド 🌙**: スロットで他の絵柄の代用になる絵柄",
          "**スキャッター ✨**: スロットで位置不問の特典絵柄",
          "**ぞろ目 / ピンゾロ**: チンチロのサイコロ3つ同じ目（1-1-1がピンゾロ）",
          "**目 / メナシ / ヒフミ**: チンチロの役。ヒフミは負け役",
        ].join("\n"),
      },
    );
}

// ─── Public Entry ──────────────────────────────────────

function buildSelectMenu(currentSection: string | null = null): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("help_section_select")
    .setPlaceholder("カテゴリを選んで詳細を読む")
    .addOptions(
      { label: "概要に戻る", value: "overview", emoji: "📖", default: currentSection === "overview" || currentSection === null },
      { label: "ゲーム一覧", value: "games", emoji: "🎮", default: currentSection === "games" },
      { label: "経済の仕組み", value: "economy", emoji: "💼", default: currentSection === "economy" },
      { label: "アステルとの星約", value: "zashiki", emoji: "💫", default: currentSection === "zashiki" },
      { label: "隠し・レア", value: "hidden", emoji: "✨", default: currentSection === "hidden" },
      { label: "用語集", value: "glossary", emoji: "🔤", default: currentSection === "glossary" },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function getSectionEmbed(key: string): EmbedBuilder {
  switch (key) {
    case "games":    return gamesEmbed();
    case "economy":  return economyEmbed();
    case "zashiki":  return zashikiEmbed();
    case "hidden":   return hiddenEmbed();
    case "glossary": return glossaryEmbed();
    default:         return overviewEmbed();
  }
}

export async function showHelpPanel(interaction: ButtonInteraction): Promise<void> {
  await safeReply(interaction, {
    embeds: [overviewEmbed()],
    components: [buildSelectMenu("overview")],
    ephemeral: true,
  });
}

export async function handleHelpSectionSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.customId !== "help_section_select") return;
  const key = interaction.values[0];
  await interaction.update({
    embeds: [getSectionEmbed(key)],
    components: [buildSelectMenu(key)],
  });
}
