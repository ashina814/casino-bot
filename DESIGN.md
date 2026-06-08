# 🏮 座敷童の賭場 — 設計ドキュメント

Discord 上で動く和風カジノ Bot。
プロジェクト名は技術的には `kabu-casino-bot`、世界観としては「**座敷童の賭場**」。
ただのギャンブルツールではなく、**座敷童というキャラクターと「縁を結んでいく」育成体験**を、賭博メカニクスの上に重ねた構造になっている。

---

## 1. コンセプトと設計思想

### 1.1 ひとことで言うと

> 「賭けて、勝って、負けて、座敷童に少しずつ気に入られていく Discord Bot」

賭博ゲーム単体ではなく、**勝負の結果が座敷童との関係性（好感度・覚醒段階・属性）に影響し、その関係性が経済バランス（ボーナス・加護・福税）にフィードバックされる**——という循環構造を設計の中心に置いている。

```
　遊ぶ  →  好感度UP  →  覚醒段階UP  →  恩恵UP  →  もっと遊びたくなる
　 ↑                                                      │
　 └──────────────────────────────────────────────────────┘
```

### 1.2 設計の3本柱

| 柱 | 内容 |
|---|---|
| **キャラクター駆動** | 全ての勝敗・操作にセリフが付き、座敷童が「結果に反応する」。セリフは `f(結果, 所持金, 格, 連勝/連敗, 好感度, モード, ランダム)` で動的生成。 |
| **インフレ抑制経済** | 累進奉納（福の重み）／残高上限／動的ハウスエッジ／プール分配の4層で、長期プレイ時の小判インフレを構造的に抑制する。 |
| **長期成長ループ** | 妖力レベル（格）／座敷童覚醒（7段階）／五行属性／二つ名 ── 4系統の進行軸を並行させ、短期セッションでも長期目線でも楽しめるよう設計。 |

### 1.3 デザイン原則

- **「自重しない演出」**：スロットのリール、クラッシュの倍率上昇、競馬の実況、株価のスパークラインなど、メッセージ編集による疑似アニメーションを多用してテンポと緊張感を出す。
- **「全て和風で統一」**：色（朱・金・墨・藤・翡翠・紅）、絵文字、用語（小判／妖力／福分け／神馬／龍脈）まで世界観を貫く。
- **「冪等で壊れない」**：bet ロック、レースロック、トランザクション、起動時の自動返金など、Discord の不安定なネットワーク下でも残高が壊れない設計を最優先。
- **「拡張可能なカタログ駆動」**：クエスト・二つ名・銘柄・馬・覚醒段階はすべてデータ定義から駆動。コードを書かずにバランス調整できる。

---

## 2. 技術スタックと全体構成

### 2.1 スタック

- **言語**: TypeScript 5.7（strict）
- **ランタイム**: Node.js 24（`node:sqlite` を使うため 22+ 必須）
- **ライブラリ**:
  - `discord.js` v14 — Bot 本体
  - `better-sqlite3` — 型定義用（実体は組込 `node:sqlite`）
  - `node-cron` — スケジューラ
  - `dotenv` — 環境変数
- **永続化**: SQLite（WAL モード、foreign_keys ON）
- **プロセス管理**: PM2（自動再起動・メモリ監視・JST 固定）
- **デプロイ先**: ConoHa VPS（Ubuntu 24.04, 2GB プラン）

### 2.2 ディレクトリ

```
src/
├─ index.ts             — エントリ。クライアント起動・interaction ルータ
├─ config.ts            — 環境変数読込
├─ deploy-commands.ts   — スラッシュコマンド登録（guild / global 切替）
│
├─ core/                — 横断的なドメインロジック
│  ├─ db.ts             — DB 初期化・スキーマ・マイグレーション・主要 helper
│  ├─ bank.ts           — 残高操作・bet バリデーション・統計記録
│  ├─ economy.ts        — 福の重み・動的ハウスエッジ・プール分配・格判定
│  ├─ dialogue.ts       — 座敷童セリフエンジン
│  ├─ dialogueData.ts   — セリフコーパス
│  ├─ zashikiStage.ts   — 7段階の覚醒システム・五行・レアイベント
│  ├─ zashikiAsset.ts   — 座敷童画像（添付ファイル）
│  ├─ quests.ts         — クエスト定義・進捗算出・受領処理
│  ├─ titlesCatalog.ts  — 二つ名カタログ
│  ├─ specialUsers.ts   — 特別ユーザーへのトリビュート（冪等付与）
│  ├─ scheduler.ts      — cron スケジューラ登録
│  └─ safeReply.ts      — interaction 応答の冗長化ラッパ
│
├─ games/               — 各ゲーム
│  ├─ asobu.ts          — /遊ぶ ルータ（6ゲーム集約）
│  ├─ slots/            — 百鬼夜行巻物
│  ├─ blackjack/        — 花札勝負
│  ├─ chinchiro/        — チンチロ
│  ├─ crash/            — 龍脈昇り
│  ├─ highlow/          — 丁半博打
│  ├─ roulette/         — 運命の水鏡（共有型）
│  ├─ keiba/            — 神馬競走
│  ├─ stocks/           — 龍脈相場
│  ├─ daily.ts          — /福分け
│  ├─ profile.ts        — /通行証
│  ├─ shop.ts           — /商店（旧）
│  ├─ shouten.ts        — /商店（新）
│  ├─ tip.ts            — チップ送付
│  ├─ thanks.ts         — /感謝
│  └─ zashiki.ts        — /座敷童（覚醒/モード/属性）
│
├─ ui/                  — 表示層
│  ├─ embeds.ts         — 統一 Embed パレット
│  ├─ home.ts           — /案内 ホーム画面
│  ├─ ranking.ts        — /番付
│  └─ panels/           — タイトル・履歴・ヘルプ・任務パネル
│
├─ admin/commands.ts    — /管理（監視・設定・mint/burn/refund・通知）
├─ easter-eggs/index.ts — 二つ名判定エンジン
└─ scripts/             — DB 検査・修復スクリプト
```

### 2.3 起動・interaction の流れ

`src/index.ts` の `bootstrap()`：

1. `initializeDatabase()` — テーブル作成と差分マイグレーション
2. `refundStaleBetsOnStartup()` — 前回プロセス死亡時の未精算競馬ベットを全額返金
3. `game_sessions` を全消去 — メモリ上のゲームロックは再起動で消えるので DB 側も整合
4. `cleanStaleSessions()` — 5分以上経った session 行を削除（保険）
5. Discord クライアント起動 → `registerSchedulers()` で cron 登録
6. `InteractionCreate` で commandName / customId プレフィックスベースの巨大ルータ

interaction ハンドラ全体は `try/catch` で囲み、未応答かつ未 defer の場合のみ `ephemeral` でエラー返答。さらに **`unhandledRejection` / `uncaughtException` / `client error` をログのみで握りつぶす**ことで、1リクエスト失敗による Bot 全停止を防いでいる。

---

## 3. データモデル

SQLite に集約。重要テーブルだけ抜粋。

| テーブル | 役割 |
|---|---|
| `users` | 残高・格・レベル・経験値・累計戦績・連勝/連敗 |
| `transaction_logs` | 全ての残高変動の不変ログ（reason / game 付き） |
| `server_config` | guild 単位の経済パラメータ（初期残高・min_bet・上限・JPプール・底辺保護プール・ラッキーゲーム） |
| `affection` | 好感度・覚醒段階・モード・五行属性・日次カウンタ |
| `titles` / `active_titles` | 取得二つ名と装備中のもの |
| `easter_egg_progress` | EE 進捗（lose_100 や thanks など） |
| `quest_claims` | クエスト受領記録（user × quest × period のユニーク） |
| `exchange_logs` | 管理者の mint / burn / refund |
| `rate_memos` | 管理者の為替メモ |
| `system_status` | 競馬の進行フラグ・キャリーオーバー |
| `keiba_horses` / `keiba_bets` | 馬マスタと未精算賭け |
| `game_sessions` | 「現在プレイ中」ロック（user_id PK） |
| `stocks` / `holdings` / `stock_price_history` / `stock_transactions` | 株系 |

### 3.1 トランザクション

`node:sqlite` には `.transaction()` ヘルパが無いため、`runTransaction()` を自前実装。**ネストに対応するため SAVEPOINT を使用**しており、ロールバックの粒度を細かく制御している。

### 3.2 マイグレーション戦略

- カラム追加は `ALTER TABLE ADD COLUMN` を `try/catch` で空振り許容
- CHECK 制約変更（`exchange_logs` に `'refund'` を許可）はテーブル再作成 + データ移行を起動時に1度だけ実行
- 全部 `initializeDatabase()` 内で完結し、別途マイグレーションツールを持ち込まない

---

## 4. 経済設計

### 4.1 福の重み（累進奉納）

所持金が多いほど勝利金から自動で天引きされる仕組み。

| 所持金 | 奉納率 |
|---|---|
| ≤ 10,000 | 0% |
| ≤ 50,000 | 5% |
| ≤ 100,000 | 10% |
| ≤ 300,000 | 20% |
| それ以上 | 30% |

天引き分の半分は JP プール、もう半分は底辺保護プール（`distributeFukuTax`）。覚醒段階6（顕現）に到達すると 50% 軽減される。

### 4.2 動的ハウスエッジ（妖気の潮流）

サーバー全体の小判総量から経済状態を判定し、ハウスエッジを動的に調整する。

```
healthyLine = playerCount × 15,000
total < healthy × 0.5  → デフレ（妖気が薄い）→ HE -2%
total > healthy × 1.5  → インフレ（妖気が満ちておる）→ HE +2%
それ以外                → 通常
```

各ゲームのベース HE（2〜5%）に上記補正を加え、最終 HE は 0〜15% にクランプ。これだけで「全員金持ち状態」を自然に冷却する。

### 4.3 ハウス収益の分配

ハウスが吸収した小判は `distributeHouseEarnings()` で：

- 20% → JP プール
- 30% → 底辺保護プール
- 50% → 消滅（小判のシンク）

「50%消滅」が **長期インフレに対する唯一の最終的ブレーキ**になっている。

### 4.4 残高上限（balance_cap）

`server_config.balance_cap`（既定 300,000）を超えた分は自動で JP / 底辺保護に半々で奉納し、残高自体は cap でクランプ。`adjustBalance()` がこの判定を持つため、上限突破は構造上ありえない。

### 4.5 デイリーボーナス

所持金階層 × `server_config.daily_base` × 覚醒段階倍率（最大 ×1.25）+ 連続ログイン週次ボーナス（最大 +200）。所持金が多いほど基本額が下がる **累進的緩和**になっており、福分けでも金持ち補正がかかる。

### 4.6 格（Tier）と妖力（exp）

| 格 | 必要 Lv | bet 上限 |
|---|---|---|
| 👤 人間 | 1 | 500 |
| 🌗 半妖 | 10 | 2,000 |
| 👹 妖 | 25 | 10,000 |
| 🐉 大妖 | 50 | 50,000 |
| ⛩️ 神 | 100 | 100,000 |

`exp` カーブは `100 × level^1.3`。bet 上限が格に紐づくことで、格そのものが「アンロック型コンテンツ」として機能する。

---

## 5. 座敷童覚醒システム（コア体験）

`src/core/zashikiStage.ts` — このプロジェクトで一番尖っている部分。

### 5.1 7段階の覚醒

| Lv | 名前 | しきい値 | デイリー | 加護率 | JPボーナス | 福税軽減 | 解放モード |
|---|---|---:|---:|---:|---:|---:|---|
| 0 | 🫥 幽か | 0 | ×1.00 | 0% | 0 | 0 | default |
| 1 | 🕯️ 灯し | 10 | ×1.05 | 0% | 0 | 0 | default |
| 2 | 🏮 宿り | 50 | ×1.00 | 0.25% | 0 | 0 | default |
| 3 | 🎀 結び | 100 | ×1.10 | 0.5% | 0 | 0 | default ＋ **五行属性解放** |
| 4 | 🌸 花憑き | 300 | ×1.10 | 1% | 0 | 0 | + tsundere |
| 5 | 🌿 常盤 | 500 | ×1.20 | 1.5% | +0.5% | 25% | + tsundere |
| 6 | ✨ 顕現 | 1000 | ×1.25 | 2% | +1% | 50% | + tsundere + **yami** |

「**幽か → 灯し → 宿り → 結び → 花憑き → 常盤 → 顕現**」と命名された段階遷移自体がストーリーになっており、`getStageUpDialogue()` / `getStageDownDialogue()` で都度ドラマチックな演出を入れる。

### 5.2 好感度の自然減衰

```
decay = floor(affection / 200)   // 1日あたり
```

- 50 未満は減衰なし（初心者保護）
- 顕現（1000）維持には **毎日 +5 以上稼ぐ必要**＝ /福分け（+1）＋ ゲーム数回（+2〜5）で維持できるバランス
- 「**遊ばないと縁が薄れる**」というメタファーをそのまま機構化

### 5.3 セリフモード

`default` / `tsundere` / `yami` の3種。覚醒段階で順次解放され、`/座敷童 mode` で切替。同じ勝敗イベントでも返ってくる言葉が完全に別キャラになる。

### 5.4 五行属性（覚醒3で解放）

- 木 🌿 / 火 🔥 / 土 🪨 / 金 ⚔️ / 水 💧
- **相生** (生む): 木→火→土→金→水→木 → 1.2倍
- **相剋** (剋つ): 木→土→水→火→金→木 → 1.5倍
- 段階6で属性固有の「神柱」に顕現（翠命神／劫焔神／磐祖神／閃鋼神／幽淵神）
- 属性変更は ◉50,000、1回限り

### 5.5 レアイベント

覚醒段階に応じて確率と内容が解放される：

| イベント | 段階 | 条件 | 発動率 | 効果 |
|---|---|---|---|---|
| 💫 座敷童の夢 | 3+ | デイリー時 | 5% | +300/500/777/1000 |
| 🌊 福の奔流 | 4+ | 勝利時 | 2% | 勝利金 ×2 |
| 🌸 花散らしの守り | 4+ | 敗北時 | 3% | 敗北無効化 |
| 💠 魂の共鳴 | 5+ | 勝利時 | 1% | 好感度 +50 |
| 🌀 神隠し | 6 | 全コンテキスト | 0.5% | ◉5,000 + 演出 |

---

## 6. ゲーム群

11のスラッシュコマンドに集約。`/遊ぶ` 配下に6ゲームをサブコマンドで束ねている。

| コマンド | 内容 | 設計の要 |
|---|---|---|
| `/遊ぶ 巻物` | 🎰 百鬼夜行巻物（スロット） | ワイルド月🌙 と スキャッター光✨。JP 当選は **純** 座敷童³のみ。当選時はプールの半分のみ獲得し残りは次回シードに残す（インフレ抑制） |
| `/遊ぶ 札遊び` | 🃏 花札勝負（BJ） | 花札の図柄でフルルール（Hit/Stand/Double/Surrender）。8スーツ |
| `/遊ぶ 暴落` | 📈 龍脈昇り（クラッシュ） | `E[payout] = 1 - houseEdge` を満たす逆 CDF 分布で生成。1% で即クラッシュ |
| `/遊ぶ 丁半` | 🎴 丁半博打（ハイ&ロー） | テンポ重視・連勝チャレンジ |
| `/遊ぶ 輪盤` | 🎡 運命の水鏡（ルーレット） | **共有型**。60秒受付 → 一斉発表。ソーシャル体験の核 |
| `/遊ぶ 賽` | 🎲 チンチロ | ピンゾロ／ゾロ目／シゴロ／ヒフミ／目／メナシ。「もう一度振る」選択でユーザーにリスクを負わせる戦略性。RTP ≈ 95% |
| `/競馬` | 🏇 神馬競走 | パリミューチュエル（単勝・複勝）。土日21時 + 手動。プール 0.8 + キャリーオーバー方式 |
| `/龍脈` | 📈 龍脈相場（株） | 5銘柄。3時間ごとにランダムウォーク + トレンド + 2%レアイベント。**余剰小判のマネーシンク兼長期戦略** |
| `/福分け` | 📅 デイリー | 連続ボーナス・覚醒倍率・減衰・レアイベント・段階UP通知・株インサイダー情報（20%） |
| `/感謝` | 座敷童に感謝を伝える | EE 「座敷童の心友」進捗 |
| `/座敷童` | 覚醒 status / mode / element | キャラ管理 |

### 6.1 共通ロック機構

各ゲームの先頭で `acquireGameLock(userId, "<game>")` を試み、失敗時は「既にゲーム中じゃ」を返す。`game_sessions` テーブル（user_id PK）の `INSERT` で排他制御し、`finally` で必ず `releaseGameLock()`。ロックは 5分タイムアウトで自動掃除される。

### 6.2 競馬の堅牢設計

- `tryAcquireRaceLock()` — `UPDATE ... WHERE is_racing = 0` で原子的にレースロックを取得
- 起動時の `refundStaleBetsOnStartup()` で、プロセスがレース中に死亡した場合の全ベットを自動返金
- パリミューチュエル方式（プール ÷ その馬への賭け = オッズ）でハウス無風（プール 0.8 + キャリーオーバー）

### 6.3 株のマネーシンク設計

- 1単元 = 50円以上の高ボラ価格、3時間ごと値動き
- ランダムウォーク + トレンドバイアス + 2% surge / 2% crash
- 履歴は各銘柄 24件（3日分）保持してスパークライン表示
- **負ければ小判が消える**＝ハウス無関与で経済全体の小判総量を吸う

---

## 7. クエスト・二つ名・実績

### 7.1 クエスト（`core/quests.ts`）

- **拡張可能設計**：`QuestKind = "daily" | "weekly" | "event"` を最初から型に含めて、いつでも週次・イベント追加可能
- **進捗はクエリベース**：`transaction_logs` を期間でフィルタするだけで算出。**追加カウンタテーブル不要**
- `Metric` 種別：`play_count` / `win_count` / `wager_sum` / `win_amount_max` / `distinct_games` / `daily_claim`
- 受領は `quest_claims (user × quest × period)` のユニーク制約で **冪等性を保証**
- 毎日 03:00 JST 頃に日付が変わってリセット（自動）

### 7.2 二つ名（`core/titlesCatalog.ts`）

カテゴリ：

- **easter_egg**（謎解き型）：丑三つ時の常連／粋人／不屈の魂／座敷童の心友／座敷童の秘密を知る者／七福神の寵愛 など
- **shop**（奉納型）：賭場のパトロン（10万）／黄金の成金（50万）／座敷童の飼い主（100万）
- **milestone**（実績型）：大富豪／すってんてん／幸運児 等
- **tribute**（特別）：「二代目」など特定ユーザーに冪等付与

レアリティは `common / rare / legend / myth`。1つを `active_titles` で装備して名前の前に表示する。

### 7.3 イースターエッグ判定（`easter-eggs/index.ts`）

ゲーム結果やコマンド実行後にチェックされる。`easter_egg_progress` で進捗管理し、達成時に `titles` に INSERT（UNIQUE 違反で多重付与を防止）。

---

## 8. UI/UX

### 8.1 統一 Embed パレット（`ui/embeds.ts`）

| Color Key | 16進 | 用途 |
|---|---|---|
| MAIN（朱） | `#C0392B` | メイン・勝利・アクション |
| GOLD（金） | `#F1C40F` | 小判・ジャックポット |
| BASE（墨） | `#2C2C2C` | 通常状態 |
| EVENT（藤） | `#8E44AD` | 特別イベント |
| WIN（翡翠） | `#27AE60` | 利益・勝ち |
| LOSE（紅） | `#E74C3C` | 損失・負け |
| USHIMITSU（暗紫） | `#2C003E` | 丑三つ時演出 |

全 embed は `baseEmbed()` を経由して色とタイムスタンプを自動付与し、視覚的一貫性を担保。

### 8.2 ホーム画面（`/案内`）

全ゲームへのワンタップ入口。`isNewbie`（戦績ゼロ）判定で新規には福分けへ誘導するバナーを表示。`getTodayLuckyGame()` で日替わりのラッキーゲームをローテーション表示。

### 8.3 ホームから派生するパネル

- 📋 任務（`panels/quests.ts`）
- 🏆 二つ名（`panels/titles.ts`）
- 📜 履歴（`panels/history.ts`）
- ❓ ヘルプ（`panels/help.ts`）

すべて `home_*` customId で `home.ts` のルータが束ねる。

### 8.4 セリフエンジン

`dialogue.ts` の `dialogueWin / dialogueLose / dialogueDaily / dialogueFukuWeight / dialogueUshimitsudoki` が中心。`(tier, balance, winStreak, loseStreak, mode, affection)` を入力として、ratio や金額しきい値で **特大勝ち / 大勝ち / 通常勝ち** などのバケットを選び、好感度プールが該当すれば優先して採用する。`isUshimitsudoki()`（午前2〜3時）で深夜限定セリフが混じる。

---

## 9. 管理者ツール

`/管理`（管理者専用 = `PermissionFlagsBits.Administrator`）：

| サブコマンド | 内容 |
|---|---|
| 📊 監視 | 経済監視ダッシュボード（`OWNER_ID` を集計から除外して歪み防止） |
| ⚙️ 設定 | 経済パラメータ・チャンネル設定 |
| 💰 発行 | 小判 mint（理由必須） |
| 🔥 焼却 | 小判 burn |
| ♻️ 返金 | ユーザー返金（`exchange_logs.action = 'refund'`） |
| 🔍 調査 | ユーザー取引履歴 |
| 📢 通知 | 座敷童アナウンス |

全ての mint/burn/refund は `exchange_logs` に admin_id 付きで記録され、後から監査可能。

---

## 10. スケジューラ（`core/scheduler.ts`）

`node-cron` で登録（TZ=Asia/Tokyo を PM2 で強制）：

| cron 式 | 内容 |
|---|---|
| `0 21 * * 6,0` | 競馬：土日 21:00 JST、`config.raceChannelId` で自動開催 |
| `0 */3 * * *` | 龍脈相場：3時間ごとに全銘柄更新、各 guild の `stock_channel_id` にイベント速報 |
| （日内）| クエスト：日付境界での自然リセット（quest_claims の period が変わるだけ） |

---

## 11. 設定・環境変数

`.env`：

```
DISCORD_TOKEN=...     # 必須
CLIENT_ID=...         # 必須
GUILD_ID=             # 任意：開発時のみ即時デプロイ用
RACE_CHANNEL_ID=      # 任意：定期競馬の開催チャンネル
OWNER_ID=             # 任意：監視ダッシュボードから集計除外
```

`config.ts` の `requireEnv()` が起動時バリデーション。`DB_PATH` は `data/database.sqlite` 固定。

`server_config` テーブル（guild ごと）：

- `initial_balance` (3000)
- `daily_base` (300) / `daily_rich` (100)
- `bankruptcy_aid` (500)
- `balance_cap` (300,000)
- `house_edge_offset` (%)
- `min_bet` (50)
- `jackpot_pool` / `relief_pool`
- `*_channel_id`（casino / jackpot / stock）
- `games_enabled`（JSON）

---

## 12. 運用 & デプロイ

詳細は `DEPLOY.md`。要点だけ：

- **VPS**: ConoHa 2GB / Ubuntu 24.04 LTS / 東京リージョン
- **Node 24**（nvm 経由）
- **PM2** で常駐：`autorestart`、`max_memory_restart: 500M`、`exec_mode: fork`、ログを `logs/` に分離
- **TZ=Asia/Tokyo** を PM2 env で強制（cron が必ず JST で動く）
- **DB バックアップ**: `scripts/backup.sh` を毎日 04:30 cron 実行。`sqlite3 .backup` で online backup、7日以上前は自動削除
- **デプロイフロー**: ローカル git push → VPS で `scripts/deploy.sh`（pull → install → build → pm2 restart）

---

## 13. 防御層・壊れない設計

ギャンブル Bot は残高破損が致命的なので、多層防御を入れている：

1. **bet 入力**：`validateBet()` で integer / safe integer / 範囲チェック
2. **adjustBalance**：負残高を作る変更は失敗を返す。`Number.isSafeInteger` でオーバーフロー防御
3. **ロック**：ゲーム単位の `game_sessions` ロック、競馬は `system_status.is_racing` の原子 UPDATE
4. **トランザクション**：金銭関連は全て `runTransaction` でアトミック、SAVEPOINT でネスト対応
5. **起動時補修**：未精算ベットを返金、stale ロックを掃除
6. **interaction 例外吸収**：1リクエスト失敗で Bot 全体を落とさない
7. **process 例外吸収**：`unhandledRejection` / `uncaughtException` をログのみで継続
8. **マイグレーション**：起動時の差分マイグレーションで旧 DB でも壊れない
9. **PM2**：それでも落ちたら 3秒後に自動再起動、メモリ 500M 超でも再起動

---

## 14. 設計の妥協と今後

### 14.1 既知の妥協点

- **node:sqlite を直接 require**：型がないため `db: any`。better-sqlite3 とインターフェースを揃えてるので将来差し替え可能
- **single guild の DB**：`users` テーブルが guild 横断（user_id PK）。マルチ guild で「同じ user が別 server」のとき残高が共有される。`server_config` だけ guild 単位
- **シングルプロセス**：`exec_mode: fork`, `instances: 1`。並列化するなら DB を Postgres に移す前提が必要
- **ロックがメモリ依存**：`game_sessions` は DB だが、競馬の `sessions Map` はプロセスメモリ。再起動でレース session が消えるが、ベットは起動時に返金されるため整合性は保たれる

### 14.2 拡張余地

- 週次・イベント型クエストの追加（型は既に対応済）
- 五行大戦（PvP）：相性倍率の計算は既に実装済
- 銘柄追加：seeds 配列に足すだけ
- 馬追加：`HORSE_SEEDS` に足すだけ
- イースターエッグ追加：`EGGS` 配列とトリガー埋め込みだけ

---

## 15. このドキュメントの位置づけ

- `README` は未整備（本書がそれを兼ねる前提）
- `DEPLOY.md` が運用手順書
- `DESIGN.md`（本書）が**「なぜこう作ったか」**を記録するもの

「賭博ゲーム」と「キャラクター育成」と「経済バランス調整」を**ひとつの循環ループにまとめる**ことが、このプロジェクトの設計上の最大の野心。コードを触るときは、ある変更が「どのループにどう作用するか」を意識すると、世界観を壊さずに改修できる。
