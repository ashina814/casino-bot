#!/usr/bin/env bash
# VPS 上で実行するデプロイスクリプト
#
# 使い方:
#   $ ~/kabu-casino-bot/scripts/deploy.sh
#
# 動作:
#   1. git pull で最新コード取得
#   2. npm install で依存更新
#   3. npm run build でビルド
#   4. pm2 で再起動 + ログ表示
#
# 初回のみ:
#   $ pm2 start ecosystem.config.js
#   $ pm2 startup    # 出力されたコマンドを root で実行
#   $ pm2 save

set -e  # エラーで即停止

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "🏮 [deploy] kabu-casino-bot 更新開始"
echo "📁 $PROJECT_DIR"

# 1. 最新コード取得
echo "🔄 [1/4] git pull..."
git pull --rebase

# 2. 依存関係更新（差分のみ）
echo "📦 [2/4] npm install..."
npm install --omit=optional

# 3. ビルド
echo "🔨 [3/4] npm run build..."
npm run build

# 4. デプロイ（スラッシュコマンドが変わってる時のみ実行を推奨。普段はコメントアウト可）
# echo "🚀 [3.5/4] slash commands deploy..."
# npm run deploy

# 5. pm2 で再起動
echo "♻️  [4/4] pm2 restart..."
if pm2 describe kabu-casino > /dev/null 2>&1; then
  pm2 restart kabu-casino --update-env
else
  pm2 start ecosystem.config.js
fi

echo "✅ デプロイ完了 — ログ表示中（Ctrl+C で抜ける）"
pm2 logs kabu-casino --lines 30
