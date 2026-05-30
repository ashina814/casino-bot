import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

type AppConfig = {
  discordToken: string;
  clientId: string;
  /** Guild ID は任意。設定するとそのサーバーにのみコマンド即時デプロイ。未設定なら global コマンド（全サーバー、反映に最大1h） */
  guildId: string | null;
  raceChannelId: string;
  /** オーナー Discord ユーザーID。経済監視ダッシュボードで集計から除外する。未設定なら除外なし。 */
  ownerId: string | null;
  dbPath: string;
  initialBalance: number;
  /** Gil-bot 両替API。未設定なら /両替 は「準備中」応答 */
  exchangeApiBaseUrl: string | null;
  exchangeApiKey: string | null;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: AppConfig = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("CLIENT_ID"),
  guildId: process.env.GUILD_ID && process.env.GUILD_ID.trim() !== "" ? process.env.GUILD_ID.trim() : null,
  raceChannelId: process.env.RACE_CHANNEL_ID ?? "",
  ownerId: process.env.OWNER_ID && process.env.OWNER_ID.trim() !== "" ? process.env.OWNER_ID.trim() : null,
  dbPath: path.resolve(process.cwd(), "data/database.sqlite"),
  initialBalance: 3000,
  exchangeApiBaseUrl: process.env.EXCHANGE_API_BASE_URL && process.env.EXCHANGE_API_BASE_URL.trim() !== "" ? process.env.EXCHANGE_API_BASE_URL.trim() : null,
  exchangeApiKey: process.env.EXCHANGE_API_KEY && process.env.EXCHANGE_API_KEY.trim() !== "" ? process.env.EXCHANGE_API_KEY.trim() : null,
};
