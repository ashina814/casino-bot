# 🚀 ConoHa VPS デプロイ手順書

座敷童の賭場 Bot を ConoHa VPS（推奨 2GB プラン）に移行する完全手順。

## -1. ローカル準備（VPS 移行前に1回だけ）

このプロジェクトはまだ git リポジトリになっていない。先に GitHub に push する：

```bash
# プロジェクトルートで（PowerShell or Git Bash）
cd "C:\Users\kotes\OneDrive - RYUKOKU UNIVERSITY\新しいフォルダー\カジノボット\kabu-casino-bot"

# git 初期化
git init
git branch -M main
git add .
# .gitignore で .env, node_modules, dist, data/database.sqlite 等は除外される

# 初回コミット前に、何が commit 対象か確認（.env や DB が含まれてないこと！）
git status

# .env や data/database.sqlite が見えていたら除外漏れ。.gitignore を確認
git commit -m "initial commit: kabu-casino-bot ready for VPS deploy"
```

GitHub で新規リポジトリを作成（**Private 推奨**）→ そこに push：
```bash
git remote add origin git@github.com:YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

これで VPS から `git clone` できる状態になる。

## 0. ConoHa 契約時のおすすめ設定

| 項目 | 推奨値 |
|---|---|
| プラン | **2GB**（複数 Bot 同居想定） |
| イメージ | **Ubuntu 24.04 LTS**（または 22.04 LTS） |
| リージョン | 東京（低レイテンシ） |
| 認証 | **SSH 公開鍵**（パスワードログイン無効化推奨） |

VPS 作成完了したら、IP アドレスと SSH キーを控えておく。

---

## 1. VPS に初回接続

```bash
ssh root@VPS_IP_ADDRESS
```

ログインしたら、まずは **作業用ユーザー** を作る（root で直接運用しない）：

```bash
# adduser コマンドで新規ユーザー作成
adduser kabu
# パスワード設定（記録しておく）

# sudo 権限を付与
usermod -aG sudo kabu

# 公開鍵を kabu ユーザーにコピー
mkdir -p /home/kabu/.ssh
cp /root/.ssh/authorized_keys /home/kabu/.ssh/
chown -R kabu:kabu /home/kabu/.ssh
chmod 700 /home/kabu/.ssh
chmod 600 /home/kabu/.ssh/authorized_keys

# 以降は kabu ユーザーで作業
exit
ssh kabu@VPS_IP_ADDRESS
```

## 2. 基本パッケージインストール

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential sqlite3
```

`build-essential` は **better-sqlite3 のネイティブビルド** に必要。

## 3. タイムゾーンを JST に

```bash
sudo timedatectl set-timezone Asia/Tokyo
date  # JST で表示されることを確認
```

これで cron（競馬土日21時、株3時間ごと、クエスト04:00）が JST で動く。

## 4. Node.js 24 インストール（nvm 経由）

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# bash 再読み込み
source ~/.bashrc

# Node 24 をインストール
nvm install 24
nvm alias default 24
node --version  # v24.x.x が出ればOK
```

## 5. PM2 インストール（プロセス常駐）

```bash
npm install -g pm2
pm2 --version  # バージョン出ればOK
```

## 6. GitHub からクローン

### SSH キー設定（推奨）

```bash
# VPS 上で SSH キー生成
ssh-keygen -t ed25519 -C "kabu-vps"
# Enter 連打でOK（パスフレーズなし）

# 公開鍵をコピー
cat ~/.ssh/id_ed25519.pub
```

→ 出力された公開鍵を **GitHub: Settings → SSH and GPG keys → New SSH key** に登録。

```bash
# 接続確認
ssh -T git@github.com
# → Hi USER! You've successfully authenticated...

# クローン
cd ~
git clone git@github.com:YOUR_NAME/YOUR_REPO.git kabu-casino-bot
cd kabu-casino-bot
```

## 7. `.env` を VPS 上で作成

```bash
cp .env.example .env
nano .env
```

中身に Discord トークンなどを記入：
```env
DISCORD_TOKEN=実トークン
CLIENT_ID=実アプリケーションID
GUILD_ID=        # 空欄 = global デプロイ
RACE_CHANNEL_ID= # 任意：定期競馬の起動チャンネル
OWNER_ID=        # 任意：監視ダッシュボードから除外する自分のID
```

```bash
# 権限を絞る
chmod 600 .env
```

## 8. 依存・ビルド

```bash
npm install
npm run build
```

better-sqlite3 のネイティブビルドが走るので少し時間かかる。

## 9. スラッシュコマンドをデプロイ

```bash
npm run deploy
# → ✅ 11 slash commands deployed globally (反映に最大1時間)
```

**global デプロイの初回は1時間ほど反映に時間がかかる**。すぐ確認したい場合は `.env` の `GUILD_ID` に特定サーバーID入れて再デプロイすれば即時。

## 10. PM2 で起動・自動再起動設定

```bash
# スクリプト実行権限
chmod +x scripts/deploy.sh scripts/backup.sh

# 初回起動
pm2 start ecosystem.config.js

# 状態確認
pm2 list
pm2 logs kabu-casino --lines 30   # 起動ログ確認

# システム起動時に自動起動するよう設定
pm2 startup
# → 表示された sudo コマンドをコピペ実行

# 現在の状態を保存
pm2 save
```

これで VPS 再起動時もボットが自動で立ち上がる。

## 11. DB バックアップを cron 登録

```bash
crontab -e
```

末尾に追加：
```cron
# 毎日 4:30 JST に DB をバックアップ（7日分保持、自動で古いの削除）
30 4 * * * /home/kabu/kabu-casino-bot/scripts/backup.sh >> /home/kabu/kabu-casino-bot/logs/backup.log 2>&1
```

## 12. 動作確認

Discord で：
- `/案内` を実行 → パネル表示
- `/福分け` → デイリー獲得 + GIF 表示
- `/遊ぶ 巻物` → スロット動く

問題なければ完成 🎉

---

## 日常運用

### コード更新時のデプロイ

ローカルで開発 → push → VPS で pull のフロー：

```bash
# ローカル
git add . && git commit -m "..." && git push

# VPS（SSH接続して）
~/kabu-casino-bot/scripts/deploy.sh
```

`deploy.sh` が pull → build → pm2 restart まで全部やってくれる。

### ログ確認

```bash
pm2 logs kabu-casino           # リアルタイムログ
pm2 logs kabu-casino --lines 100  # 直近100行
pm2 monit                      # CPU・メモリのリアルタイム監視
```

### 再起動

```bash
pm2 restart kabu-casino
```

### 停止

```bash
pm2 stop kabu-casino
```

### バックアップ手動実行

```bash
~/kabu-casino-bot/scripts/backup.sh
```

### バックアップから復旧

```bash
pm2 stop kabu-casino
cp ~/kabu-casino-bot/data/backup/db.YYYY-MM-DD.sqlite ~/kabu-casino-bot/data/database.sqlite
pm2 start kabu-casino
```

---

## 他のボットを同居させる場合

別 Bot のリポジトリも `git clone` して、同じく `pm2 start` するだけ：

```bash
cd ~
git clone ... other-bot
cd other-bot
npm install && npm run build
pm2 start ecosystem.config.js  # 各 Bot で名前が違うので衝突なし
pm2 save
```

`pm2 list` で全 Bot の状態が一覧表示される。

---

## トラブルシューティング

### `better-sqlite3` のネイティブビルドが失敗
→ `sudo apt install build-essential python3-dev` を試す

### `pm2: command not found` after reboot
→ `nvm use 24 && npm install -g pm2` を再実行、`pm2 startup` を再度

### Bot が反応しない
1. `pm2 list` で `online` になってるか
2. `pm2 logs kabu-casino --err` でエラー確認
3. `.env` の `DISCORD_TOKEN` が正しいか

### メモリ不足
`pm2 monit` で確認。常時 400MB 超えるようなら 4GB プランへアップグレード検討。

### スラッシュコマンドが古い
1. `.env` の `GUILD_ID` 設定（特定サーバー即時反映）or global なら最大1時間待つ
2. `npm run deploy` 再実行
3. Discord クライアント再起動（キャッシュクリア）
