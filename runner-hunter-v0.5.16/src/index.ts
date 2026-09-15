import { config } from "./config.js";
import { MockBroker } from "./broker/MockBroker.js";
import { CoveBroker } from "./broker/CoveBroker.js";
import { configureBotMenu, createBot } from "./bot/bot.js";
import { APP_VERSION } from "./version.js";

if (!["mock", "cove-paper"].includes(config.brokerMode)) {
  throw new Error(`Unsupported BROKER_MODE='${config.brokerMode}'. v0.5.10 supports only 'mock' and 'cove-paper'. Live trading is intentionally unavailable.`);
}
const broker = config.brokerMode === "cove-paper" ? new CoveBroker() : new MockBroker();
console.log(`Starting Runner Hunter v${APP_VERSION} in ${config.brokerMode.toUpperCase()} mode...`);
const bot = createBot(broker);
try {
  await configureBotMenu(bot);
  console.log("Telegram command menu configured.");
} catch (e: any) {
  console.warn(`Telegram menu setup failed: ${e?.message ?? String(e)}`);
}
bot.start();
