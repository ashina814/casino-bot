#!/usr/bin/env bash
# SQLite データベース日次バックアップ
#
# VPS の crontab に登録：
#   0 4 * * * /home/USER/kabu-casino-bot/scripts/backup.sh
#
# 7日以上前のバックアップは自動削除。

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$PROJECT_DIR/data/database.sqlite"
BACKUP_DIR="$PROJECT_DIR/data/backup"
DATE=$(date +%F)

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB" ]; then
  echo "❌ DB not found: $DB"
  exit 1
fi

# SQLite の安全な online backup（VACUUM INTO 推奨だが、シンプルなコピーでも WAL のおかげで概ね安全）
sqlite3 "$DB" ".backup '$BACKUP_DIR/db.$DATE.sqlite'" 2>/dev/null \
  || cp "$DB" "$BACKUP_DIR/db.$DATE.sqlite"

# 7日以上前のバックアップを削除
find "$BACKUP_DIR" -name 'db.*.sqlite' -mtime +7 -delete

echo "✅ Backup: $BACKUP_DIR/db.$DATE.sqlite"
echo "📊 Current backups:"
ls -lh "$BACKUP_DIR"/db.*.sqlite 2>/dev/null | tail -10
