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

      // Portfolio state is required to authorize a buy, but it should not be
      // required to discover/analyze candidates. If Cove positions are
      // temporarily unavailable, continue the scan and fail execution closed.
      let positions: Awaited<ReturnType<Broker["getPositions"]>> = [];
      let positionsError: string | undefined;
      try {
        positions = await broker.getPositions();
      } catch (e: any) {
        positionsError = e?.message ?? String(e);
        console.warn(`[Bot] scan portfolio lookup unavailable; execution blocked: ${positionsError}`);
        await ctx.reply("⚠️ Cove positions are temporarily unavailable. Scan will continue, but Paper Buy will remain blocked until portfolio state can be verified.");
      }

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
        if (positionsError) {
          risk.flags.push("Portfolio state unavailable — paper execution blocked");
          risk.approved = false;
        }
        const analysis = await analyzeToken(token, security);
        const key = `${token.chainId}:${token.tokenAddress}`.slice(0, 48);
        pending.set(key, { token, analysis, risk, security, approvedAtMs: analysis.decision === "BUY" && risk.approved ? Date.now() : undefined });
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
      "/positions\n/portfolio\n/cove — check Cove MCP + paper readiness"
    );
  });

  bot.command("portfolio", async ctx => {
    try {
      const b = await broker.getBalance();
      await ctx.reply(`Cash: $${b.cashUsd.toFixed(2)}\nEquity: $${b.equityUsd.toFixed(2)}`);
    } catch (e: any) {
      console.warn(`[Bot] /portfolio blocked: ${e?.message ?? String(e)}`);
      await ctx.reply(`Portfolio unavailable: ${e?.message ?? String(e)}\n\nThe bot is still running. Use /cove for sanitized account diagnostics.`);
    }
  });

  bot.command("positions", async ctx => {
    try {
      await ctx.reply(positionsText(await broker.getPositions()));
    } catch (e: any) {
      console.warn(`[Bot] /positions blocked: ${e?.message ?? String(e)}`);
      await ctx.reply(`Positions unavailable: ${e?.message ?? String(e)}\n\nThe bot is still running. Use /cove for sanitized account diagnostics.`);
    }
  });

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

    const schemas = status.targetSchemas.length ? `\n\n🎯 Runner Hunter targets:\n${status.targetSchemas.map(x => `• ${x}`).join("\n")}` : "";
    await ctx.reply(
      `✅ Cove MCP connected\n` +
      `Server: ${server}\n` +
      `Protocol: ${status.metadata.protocolVersion ?? "unknown"}\n` +
      `Session: ${status.metadata.sessionIdPresent ? "active" : "stateless / none"}\n` +
      `Tools exposed: ${status.tools.length}\n` +
      `Safety: read-only allowlist active • money-out hard-denied\n` +
      `Broker mode: ${config.brokerMode}${config.brokerMode === "cove-paper" ? " • manual paper orders only" : ""}\n\n${toolLines}${schemas}`
    );

    if (config.brokerMode === "cove-paper" && "getPaperAccountDiagnostics" in (broker as any)) {
      try {
        const diag = await (broker as any).getPaperAccountDiagnostics();
        const lines: string[] = ["🧪 Cove credential/account diagnostics"];
        let currentCredential = "";
        for (const source of diag.sources ?? []) {
          if (source.credential !== currentCredential) {
            currentCredential = source.credential;
            lines.push(`\n🔐 ${currentCredential}`);
          }
          lines.push(`${source.source}: score=${source.paperScore}${source.detectedAccountId ? ` • PAPER account=${source.detectedAccountId}` : ""}`);
          if (source.fields?.length) {
            for (const field of source.fields.slice(0, 12)) lines.push(`• ${field.path}: ${field.value}`);
          } else {
            lines.push(`• ${typeof source.preview === "string" ? source.preview : "No paper/profile fields detected"}`);
          }
        }
        if (diag.observedAccountIds?.length) lines.push(`\nObserved account IDs: ${diag.observedAccountIds.join(", ")}`);
        if (diag.verification) {
          lines.push("\n🔒 Authoritative paper verification");
          lines.push(`• read profile isPaper=true: ${diag.verification.readIsPaper ? "yes" : "no"}`);
          lines.push(`• read-write profile isPaper=true: ${diag.verification.writeIsPaper ? "yes" : "no"}`);
          lines.push(`• credentials resolve to same account: ${diag.verification.matchingAccount ? "yes" : "no"}`);
          lines.push(`• write token canTrade=true: ${diag.verification.writeCanTrade ? "yes" : "no"}`);
          lines.push(`• money-out disabled: ${diag.verification.moneyOutDisabled ? "yes" : "no"}`);
          lines.push(`• account source: ${diag.verification.accountSource}`);
        }
        lines.push(diag.ok
          ? `\n✅ PAPER account authoritatively verified: ${diag.accountId}`
          : "\n❌ PAPER credentials were not authoritatively verified. Writes remain blocked.");
        await ctx.reply(lines.join("\n").slice(0, 3900));
      } catch (e: any) {
        await ctx.reply(`Cove diagnostics unavailable: ${e?.message ?? String(e)}`);
      }
    }
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
      let positions: Awaited<ReturnType<Broker["getPositions"]>> = [];
      let positionsError: string | undefined;
      try {
        positions = await broker.getPositions();
      } catch (e: any) {
        positionsError = e?.message ?? String(e);
        console.warn(`[Bot] analyze portfolio lookup unavailable; execution blocked: ${positionsError}`);
      }
      const risk = evaluateRisk(token, positions, security);
      if (positionsError) {
        risk.flags.push("Portfolio state unavailable — paper execution blocked");
        risk.approved = false;
      }
      const analysis = await analyzeToken(token, security);
      const key = `${token.chainId}:${token.tokenAddress}`.slice(0, 48);
      pending.set(key, { token, analysis, risk, security, approvedAtMs: analysis.decision === "BUY" && risk.approved ? Date.now() : undefined });
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
    try {
      // Re-read portfolio state and market state immediately before execution.
      // Portfolio failures always block. Market refresh prevents a stale scan card from
      // executing after liquidity/price conditions materially changed.
      const positions = await broker.getPositions();
      const freshToken = await getToken(item.token.tokenAddress, item.token.chainId);
      const risk = evaluateRisk(freshToken, positions, item.security);

      if (!risk.approved) {
        const approvedAtMs = Number(item.approvedAtMs ?? 0);
        const elapsedMs = approvedAtMs ? Date.now() - approvedAtMs : Number.POSITIVE_INFINITY;
        const graceMs = config.paperEligibilityWindowMinutes * 60_000;
        const liquidityOnly = risk.flags.length === 1 && /^Liquidity below \$/i.test(risk.flags[0] ?? "");
        const graceAllowed =
          item.analysis.decision === "BUY" &&
          item.risk?.approved === true &&
          elapsedMs <= graceMs &&
          liquidityOnly &&
          freshToken.liquidityUsd >= config.paperLiquidityGraceFloorUsd;

        if (!graceAllowed) {
          return void ctx.answerCallbackQuery({ text: `Blocked: ${risk.flags[0] ?? "risk gate failed"}` });
        }

        console.info(
          `[Bot] paper liquidity grace used for ${freshToken.chainId}:${freshToken.symbol} ` +
          `liq=$${Math.round(freshToken.liquidityUsd)} floor=$${config.paperMinLiquidityUsd} ` +
          `hardFloor=$${config.paperLiquidityGraceFloorUsd}`
        );
      }

      const amount = Math.min(item.analysis.suggestedUsd, config.maxTradeUsd);
      const trade = await broker.buy(freshToken, amount);
      await ctx.answerCallbackQuery({ text: trade.mode === "cove-paper" ? "Cove paper buy submitted" : "Mock paper buy executed" });
      const modeLabel = trade.mode === "cove-paper" ? "COVE PAPER BUY" : "MOCK BUY";
      await ctx.reply(`✅ ${modeLabel}\n${item.token.chainId.toUpperCase()} | ${trade.symbol}\n$${trade.usdAmount.toFixed(2)} at $${trade.priceUsd}\nOrder: ${trade.id}`);
    } catch (e: any) {
      await ctx.answerCallbackQuery({ text: "Paper buy blocked: portfolio/execution check failed" }).catch(() => undefined);
      await ctx.reply(`Buy blocked: ${e?.message ?? String(e)}`);
    }
  });

  bot.catch(async err => {
    const message = err?.error instanceof Error ? err.error.message : String(err?.error ?? err);
    console.error(`[Telegram] Unhandled update error: ${message}`);
    try {
      await err.ctx.reply(`Runner Hunter caught an internal error: ${message}\n\nThe bot is still running.`);
    } catch {
      // Avoid a second failure if Telegram itself is unavailable.
    }
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
