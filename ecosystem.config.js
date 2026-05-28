/**
 * PM2 設定ファイル
 *
 * VPS 上で `pm2 start ecosystem.config.js` で起動。
 * - クラッシュ時自動再起動
 * - JST タイムゾーン（cron が JST で動く）
 * - メモリ上限 500MB で監視（暴走防止）
 * - ログを logs/ 配下に分離
 */
module.exports = {
  apps: [
    {
      name: "casino-bot",
      script: "dist/index.js",
      cwd: __dirname,

      // 実行環境
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",  // cron が JST で動くよう強制
      },

      // クラッシュ復旧
      autorestart: true,
      max_restarts: 10,
      min_uptime: "60s",       // 60秒未満でクラッシュした場合は問題と見なす
      restart_delay: 3000,      // クラッシュ後 3秒待ってから再起動

      // メモリ監視（リーク検出時の自動再起動）
      max_memory_restart: "500M",

      // ログ
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // インスタンス数（Discord Bot は 1個固定）
      instances: 1,
      exec_mode: "fork",
    },
  ],
};
