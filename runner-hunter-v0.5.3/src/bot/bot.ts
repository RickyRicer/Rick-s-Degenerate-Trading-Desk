import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import type { Broker } from "../broker/Broker.js";
import { analyzeToken } from "../agent/analyze.js";
import { evaluateRisk } from "../risk/riskEngine.js";
import { getToken, scanRunners, type ScanScope } from "../market/dexscreener.js";
import { getSecurityReport } from "../security/index.js";
import { compactTokenCard, leaderboardHeader, positionsText, tokenCard } from "./format.js";
import { APP_VERSION } from "../version.js";
import { getCoveMcpStatus } from "../security/cove.js";

function addTokenButtons(
  keyboard: InlineKeyboard,
  token: { tokenAddress: string; url?: string },
  buy?: { enabled: boolean; usd: number; key: string },
  deepKey?: string
) {
  if (token.url) keyboard.url("📈 DEX Screener", token.url);
  if (deepKey) keyboard.text("🔍 Deep Dive", `deep:${deepKey}`);
  if (buy?.enabled) keyboard.row().text(`🧪 Paper Buy $${buy.usd}`, `buy:${buy.key}`);
  return keyboard;
}

function scanPickerKeyboard() {
  return new InlineKeyboard()
    .text("🔥 All", "scan:all").text("🟣 SOL", "scan:sol")
    .row()
    .text("🟢 RH", "scan:rh").text("🟡 BSC", "scan:bsc")
    .row()
    .text("🔷 EVM", "scan:evm");
}

function parseScope(raw: string | undefined): ScanScope | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "all") return "all";
  if (["sol", "solana"].includes(value)) return "sol";
  if (["rh", "robinhood"].includes(value)) return "rh";
  if (["bsc", "bnb", "bnbchain"].includes(value)) return "bsc";
  if (value === "evm") return "evm";
  return undefined;
}

export function createBot(broker: Broker) {
  if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const bot = new Bot(config.telegramToken);
  const pending = new Map<string, any>();

  bot.use(async (ctx, next) => {
    if (config.authorizedTelegramUserId && ctx.from?.id !== config.authorizedTelegramUserId) {
      await ctx.reply("Unauthorized."); return;
    }
    await next();
  });

  async function runScan(ctx: any, scope: ScanScope) {
    await ctx.reply(`Scanning DEX Screener for ${scope === "all" ? "cross-chain" : scope.toUpperCase()} runner candidates...`);
    try {
      const tokens = await scanRunners(scope, config.runnerAiFinalists);
      if (!tokens.length) return void ctx.reply("No candidates passed the Runner Hunter prefilters this scan.");
      await ctx.reply(leaderboardHeader(scope, tokens.length));
      const positions = await broker.getPositions();

      // Security first pass lets us identify repeated deployers across the same scan.
      const secured: Array<{ token: typeof tokens[number]; security: Awaited<ReturnType<typeof getSecurityReport>> }> = [];
      for (const token of tokens) secured.push({ token, security: await getSecurityReport(token) });
      const deployerGroups = new Map<string, string[]>();
      for (const { token, security } of secured) {
        if (!security.creatorAddress) continue;
        const key = security.creatorAddress.toLowerCase();
        deployerGroups.set(key, [...(deployerGroups.get(key) ?? []), token.symbol]);
      }
      for (const { security } of secured) {
        if (!security.creatorAddress) continue;
        const related = deployerGroups.get(security.creatorAddress.toLowerCase()) ?? [];
        security.deployerScanCount = related.length;
        security.relatedDeployments = related;
      }

      let rank = 0;
      for (const { token, security } of secured) {
        rank += 1;
        const risk = evaluateRisk(token, positions, security);
        const analysis = await analyzeToken(token, security);
        const key = `${token.chainId}:${token.tokenAddress}`.slice(0, 48);
        pending.set(key, { token, analysis, risk, security });
        const keyboard = addTokenButtons(new InlineKeyboard(), token, {
          enabled: analysis.decision === "BUY" && risk.approved,
          usd: analysis.suggestedUsd,
          key
        }, key);
        await ctx.reply(compactTokenCard(token, analysis, risk.flags, rank, security), { reply_markup: keyboard, parse_mode: "HTML" });
      }
    } catch (e: any) { await ctx.reply(`Scan failed: ${e.message}`); }
  }

  bot.command("start", async ctx => {
    await ctx.reply(
      `Runner Hunter v${APP_VERSION} is online in ${config.brokerMode.toUpperCase()} mode.\n\n` +
      "Use the Menu button beside the message box, or type a command.\n\n" +
      "Commands:\n/scan — choose chain\n/scan all\n/scan sol\n/scan rh\n/scan bsc\n/scan evm\n" +
      "/analyze <address>\n/analyze <chain> <address>\n/portfolio\n/positions\n/help\n\n" +
      "Pipeline: DEX Screener → Runner Score → multi-source on-chain security → AI → hard risk gate."
    );
  });

  bot.command("help", async ctx => {
    await ctx.reply(
      "Runner Hunter commands:\n" +
      "/scan — chain picker\n/scan all | sol | rh | bsc | evm\n" +
      "/analyze <address> or /analyze <chain> <address>\n" +
      "/positions\n/portfolio\n/cove — test Cove MCP read access"
    );
  });

  bot.command("portfolio", async ctx => {
    const b = await broker.getBalance();
    await ctx.reply(`Cash: $${b.cashUsd.toFixed(2)}\nEquity: $${b.equityUsd.toFixed(2)}`);
  });

  bot.command("positions", async ctx => { await ctx.reply(positionsText(await broker.getPositions())); });

  bot.command("cove", async ctx => {
    await ctx.reply("🌊 Checking Cove MCP read access...");
    const status = await getCoveMcpStatus();
    if (!status.configured) return void ctx.reply("Cove MCP is not configured. Add COVE_READ_TOKEN to .env. Do not paste the token into Telegram.");
    if (status.error) return void ctx.reply(`Cove MCP check failed: ${status.error}`);

    const server = status.metadata.serverInfo?.name
      ? `${status.metadata.serverInfo.name}${status.metadata.serverInfo.version ? ` v${status.metadata.serverInfo.version}` : ""}`
      : "Cove";
    const toolLines = status.tools.length
      ? status.tools.slice(0, 40).map(n => `• ${n}`).join("\n")
      : "No tools returned by tools/list.";

    await ctx.reply(
      `✅ Cove MCP connected\n` +
      `Server: ${server}\n` +
      `Protocol: ${status.metadata.protocolVersion ?? "unknown"}\n` +
      `Session: ${status.metadata.sessionIdPresent ? "active" : "stateless / none"}\n` +
      `Tools exposed: ${status.tools.length}\n\n${toolLines}`
    );
  });

  bot.command("analyze", async ctx => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!args.length) return void ctx.reply("Usage: /analyze <address> OR /analyze <chain> <address>");
    const address = args.length > 1 ? args[1] : args[0];
    const chainId = args.length > 1 ? ({ sol: "solana", rh: "robinhood", bsc: "bsc" } as Record<string, string>)[args[0].toLowerCase()] ?? args[0].toLowerCase() : undefined;
    try {
      await ctx.reply("🔍 Running market + security deep dive...");
      const token = await getToken(address, chainId);
      const security = await getSecurityReport(token);
      const positions = await broker.getPositions();
      const risk = evaluateRisk(token, positions, security);
      const analysis = await analyzeToken(token, security);
      const key = `${token.chainId}:${token.tokenAddress}`.slice(0, 48);
      pending.set(key, { token, analysis, risk, security });
      const keyboard = addTokenButtons(new InlineKeyboard(), token, {
        enabled: analysis.decision === "BUY" && risk.approved,
        usd: analysis.suggestedUsd,
        key
      });
      await ctx.reply(tokenCard(token, analysis, risk.flags, undefined, security), { reply_markup: keyboard, parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`Analyze failed: ${e.message}`); }
  });

  bot.command("scan", async ctx => {
    const raw = (ctx.match ?? "").trim();
    if (!raw) {
      await ctx.reply("Choose a scan scope:", { reply_markup: scanPickerKeyboard() });
      return;
    }
    const scope = parseScope(raw);
    if (!scope) return void ctx.reply("Unknown scope. Try /scan all, /scan sol, /scan rh, /scan bsc, or /scan evm");
    await runScan(ctx, scope);
  });

  bot.callbackQuery(/^scan:(all|sol|rh|bsc|evm)$/, async ctx => {
    const scope = ctx.match[1] as ScanScope;
    await ctx.answerCallbackQuery({ text: `Scanning ${scope.toUpperCase()}` });
    await runScan(ctx, scope);
  });

  bot.callbackQuery(/^deep:(.+)$/, async ctx => {
    const key = ctx.match[1];
    const item = pending.get(key);
    if (!item) return void ctx.answerCallbackQuery({ text: "Analysis expired" });
    await ctx.answerCallbackQuery({ text: "Opening deep dive" });
    const keyboard = addTokenButtons(new InlineKeyboard(), item.token, {
      enabled: item.analysis.decision === "BUY" && item.risk.approved,
      usd: item.analysis.suggestedUsd,
      key
    });
    await ctx.reply(tokenCard(item.token, item.analysis, item.risk.flags, undefined, item.security), { reply_markup: keyboard, parse_mode: "HTML" });
  });

  bot.callbackQuery(/^buy:(.+)$/, async ctx => {
    const key = ctx.match[1];
    const item = pending.get(key);
    if (!item) return void ctx.answerCallbackQuery({ text: "Analysis expired" });
    const positions = await broker.getPositions();
    const risk = evaluateRisk(item.token, positions, item.security);
    if (!risk.approved) return void ctx.answerCallbackQuery({ text: `Blocked: ${risk.flags[0]}` });
    const amount = Math.min(item.analysis.suggestedUsd, config.maxTradeUsd);
    try {
      const trade = await broker.buy(item.token, amount);
      await ctx.answerCallbackQuery({ text: "Paper buy executed" });
      await ctx.reply(`✅ MOCK BUY\n${item.token.chainId.toUpperCase()} | ${trade.symbol}\n$${trade.usdAmount.toFixed(2)} at $${trade.priceUsd}`);
    } catch (e: any) { await ctx.reply(`Buy failed: ${e.message}`); }
  });

  return bot;
}

export async function configureBotMenu(bot: Bot) {
  await bot.api.setMyCommands([
    { command: "scan", description: "Scan for runner candidates" },
    { command: "analyze", description: "Analyze a contract address" },
    { command: "positions", description: "View open positions" },
    { command: "portfolio", description: "View paper portfolio" },
    { command: "cove", description: "Check Cove MCP access" },
    { command: "help", description: "Show bot commands" }
  ]);
  await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
}
