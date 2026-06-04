/**
 * GilBeinBOT 両替API 疎通スモークテスト
 *
 * 使い方:
 *   npx tsx scripts/exchange-smoke.ts                # health のみ
 *   npx tsx scripts/exchange-smoke.ts balance        # health + balance
 *   npx tsx scripts/exchange-smoke.ts quote 100 e2i  # quote: 100 をエテル→Gil
 *   npx tsx scripts/exchange-smoke.ts quote 100 i2e  # quote: 100 を Gil→エテル
 *
 * env: EXCHANGE_API_BASE_URL / EXCHANGE_API_KEY /
 *      TEST_EXCHANGE_GUILD_ID / TEST_EXCHANGE_USER_ID
 */
import "dotenv/config";
import {
  isExchangeApiAvailable,
  gilHealth,
  gilBalance,
  gilQuote,
  type GilDirection,
} from "../src/core/gilApi.js";

function dump(label: string, v: unknown) {
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(v, null, 2));
}

async function main() {
  if (!isExchangeApiAvailable()) {
    console.error("EXCHANGE_API_BASE_URL / EXCHANGE_API_KEY が未設定だよ。");
    process.exit(1);
  }

  console.log("BASE_URL =", process.env.EXCHANGE_API_BASE_URL);
  console.log("API_KEY  =", (process.env.EXCHANGE_API_KEY ?? "").slice(0, 4) + "***");

  const guildId = process.env.TEST_EXCHANGE_GUILD_ID ?? "";
  const userId = process.env.TEST_EXCHANGE_USER_ID ?? "";

  const health = await gilHealth();
  dump("GET /api/v1/health", health);
  if (!health.ok) process.exit(1);

  const mode = process.argv[2];
  if (!mode) return;

  if (!guildId || !userId) {
    console.error("\nTEST_EXCHANGE_GUILD_ID / TEST_EXCHANGE_USER_ID を .env に入れてね。");
    process.exit(1);
  }

  if (mode === "balance") {
    const bal = await gilBalance(guildId, userId);
    dump("GET /api/v1/balance", bal);
    return;
  }

  if (mode === "quote") {
    const amount = Number(process.argv[3] ?? 100);
    const dirArg = process.argv[4] ?? "e2i";
    const direction: GilDirection =
      dirArg === "i2e" ? "internal_to_external" : "external_to_internal";
    const q = await gilQuote({ guildId, userId, direction, amount });
    dump(`POST /api/v1/exchange/quote (${direction}, ${amount})`, q);
    return;
  }

  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
