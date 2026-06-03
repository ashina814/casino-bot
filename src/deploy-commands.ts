import { REST, Routes } from "discord.js";
import { config } from "./config";
import { asobuCommand } from "./games/asobu";
import { raceCommand } from "./games/keiba/command";
import { stocksCommand } from "./games/stocks/index";
import { profileCommand } from "./games/profile";
import { casinoCommand } from "./ui/home";
import { adminCommand } from "./admin/commands";
import { shoutenCommand } from "./games/shouten";
import { zashikiCommand } from "./games/zashiki";
import { exchangeCommand } from "./games/exchange";
import { boardCommand } from "./games/board";
import { sashiCommand } from "./games/sashi";
import { tipCommand } from "./games/tip";
import { takuCommand } from "./games/takutate";
import { chohanCommand } from "./games/chohan";
import { saiCommand } from "./games/saishoubu";
import { vipCommand } from "./games/vip";

async function deployCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const body = [
    asobuCommand.toJSON(),
    raceCommand.toJSON(),
    stocksCommand.toJSON(),
    profileCommand.toJSON(),
    casinoCommand.toJSON(),
    adminCommand.toJSON(),
    shoutenCommand.toJSON(),
    zashikiCommand.toJSON(),
    exchangeCommand.toJSON(),
    boardCommand.toJSON(),
    sashiCommand.toJSON(),
    tipCommand.toJSON(),
    takuCommand.toJSON(),
    chohanCommand.toJSON(),
    saiCommand.toJSON(),
    vipCommand.toJSON(),
  ];
  if (config.guildId) {
    // 開発用: 特定 guild に即時デプロイ
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    console.log(`✅ ${body.length} slash commands deployed to guild ${config.guildId}.`);
  } else {
    // 本番用: 全 guild にグローバルデプロイ（反映に最大1時間）
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log(`✅ ${body.length} slash commands deployed globally (反映に最大1時間).`);
  }
}

deployCommands().catch((error) => {
  console.error("Failed to deploy commands:", error);
  process.exit(1);
});
