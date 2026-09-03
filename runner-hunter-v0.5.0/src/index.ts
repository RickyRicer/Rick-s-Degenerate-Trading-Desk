import { config } from "./config.js";
import { MockBroker } from "./broker/MockBroker.js";
import { CoveBroker } from "./broker/CoveBroker.js";
import { createBot } from "./bot/bot.js";
import { APP_VERSION } from "./version.js";

const broker = config.brokerMode === "cove" ? new CoveBroker() : new MockBroker();
console.log(`Starting Runner Hunter v${APP_VERSION} in ${config.brokerMode.toUpperCase()} mode...`);
const bot = createBot(broker);
bot.start();
