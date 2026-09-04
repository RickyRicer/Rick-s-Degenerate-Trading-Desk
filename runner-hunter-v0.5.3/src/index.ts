import { config } from "./config.js";
import { MockBroker } from "./broker/MockBroker.js";
import { CoveBroker } from "./broker/CoveBroker.js";
import { configureBotMenu, createBot } from "./bot/bot.js";
import { APP_VERSION } from "./version.js";

const broker = config.brokerMode === "cove" ? new CoveBroker() : new MockBroker();
console.log(`Starting Runner Hunter v${APP_VERSION} in ${config.brokerMode.toUpperCase()} mode...`);
const bot = createBot(broker);
try {
  await configureBotMenu(bot);
  console.log("Telegram command menu configured.");
} catch (e: any) {
  console.warn(`Telegram menu setup failed: ${e?.message ?? String(e)}`);
}
bot.start();
