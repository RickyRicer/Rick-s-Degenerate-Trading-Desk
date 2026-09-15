import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import type { TokenSnapshot, TradeIntent } from "../types/index.js";
import type { SecurityReport } from "../security/types.js";

const schema = z.object({
  decision: z.enum(["BUY", "WATCH", "IGNORE"]),
  confidence: z.number().min(0).max(100),
  score: z.number().min(0).max(100),
  suggestedUsd: z.number().min(0),
  reasons: z.preprocess(v => Array.isArray(v) ? v.slice(0, 5) : v, z.array(z.string()).max(5)),
  riskFlags: z.preprocess(v => Array.isArray(v) ? v.slice(0, 5) : v, z.array(z.string()).max(5))
});


function marketForPrompt(token: TokenSnapshot) {
  return {
    chainId: token.chainId,
    dexId: token.dexId,
    pairAddress: token.pairAddress,
    tokenAddress: token.tokenAddress,
    symbol: token.symbol,
    name: token.name,
    priceUsd: token.priceUsd,
    liquidityUsd: token.liquidityUsd,
    marketCap: token.marketCap,
    volume1h: token.volume1h,
    volume24h: token.volume24h,
    buys1h: token.buys1h,
    sells1h: token.sells1h,
    priceChange1h: token.priceChange1h,
    pairCreatedAt: token.pairCreatedAt,
    runnerScore: token.runnerScore,
    runnerSignals: token.runnerSignals,
    fiveMinuteWindow: {
      volumeUsd: token.hasVolume5m ? token.volume5m : null,
      buys: token.hasTxns5m ? token.buys5m : null,
      sells: token.hasTxns5m ? token.sells5m : null,
      priceChangePercent: token.hasPriceChange5m ? token.priceChange5m : null,
      volumeAvailable: token.hasVolume5m,
      transactionsAvailable: token.hasTxns5m,
      priceChangeAvailable: token.hasPriceChange5m
    }
  };
}

function securityForPrompt(security?: SecurityReport) {
  if (!security) return { status: "UNKNOWN", checked: false };
  return {
    provider: security.provider,
    status: security.status,
    checked: security.checked,
    hardFlags: security.hardFlags,
    warnings: security.warnings,
    positives: security.positives,
    coverageNotes: security.coverageNotes,
    holderCount: security.holderCount,
    top10Percent: security.top10Percent,
    ownerPercent: security.ownerPercent,
    creatorPercent: security.creatorPercent,
    buyTaxPercent: security.buyTaxPercent,
    sellTaxPercent: security.sellTaxPercent,
    isHoneypot: security.isHoneypot,
    sourceVerified: security.sourceVerified,
    proxy: security.proxy,
    creatorAddress: security.creatorAddress,
    mintable: security.mintable,
    freezable: security.freezable,
    liquidityLockedPercent: security.liquidityLockedPercent,
    bundleRisk: security.bundleRisk,
    bundleNotes: security.bundleNotes
  };
}

export async function analyzeToken(token: TokenSnapshot, security?: SecurityReport): Promise<TradeIntent> {
  if (security?.status === "FAIL") {
    return {
      analysisSource: "AUTO",
      decision: "IGNORE",
      confidence: 100,
      score: 0,
      suggestedUsd: 0,
      reasons: ["Hard security failure; OpenAI analysis skipped to avoid wasting an API call."],
      riskFlags: security.hardFlags.slice(0, 5)
    };
  }

  if (!config.openaiApiKey) {
    const score = token.runnerScore ?? 0;
    return {
      analysisSource: "AUTO",
      decision: score >= 75 ? "BUY" : score >= 50 ? "WATCH" : "IGNORE",
      confidence: Math.min(85, Math.max(40, score)),
      score,
      suggestedUsd: Math.min(config.maxTradeUsd, 25),
      reasons: token.runnerSignals?.length ? token.runnerSignals : ["Deterministic Runner Score only"],
      riskFlags: security?.hardFlags?.length ? security.hardFlags : ["OpenAI analysis unavailable"]
    };
  }

  const client = new OpenAI({ apiKey: config.openaiApiKey });
  const prompt = `You are the final analyst for a PAPER-TRADING cross-chain micro-cap runner hunter. The candidate was already shortlisted by deterministic code.

Important rules:
- Runner Score measures early-runner quality and momentum, NOT contract safety.
- Security data below is authoritative only for fields actually returned. Never invent missing fields.
- Missing bundle clustering is UNKNOWN, not automatically bad. Do not lower a candidate solely because linked-wallet/bundle data is not connected yet.
- If security status is FAIL, decision must be IGNORE. (In normal operation FAIL candidates are rejected before this prompt.)
- If security is UNKNOWN, security verification is incomplete. Usually prefer WATCH; do not pretend it is safe.
- fiveMinuteWindow uses null for unavailable values. null means NOT PROVIDED, never zero/stale/inactive.
- Only describe 5m activity as zero/inactive when its availability flag is true and the numeric value is actually 0.
- Be skeptical of extreme overextension, weak buy pressure, or poor liquidity quality.

Token market data:\n${JSON.stringify(marketForPrompt(token), null, 2)}

Security deep dive:\n${JSON.stringify(securityForPrompt(security), null, 2)}

Return JSON only with: decision (BUY|WATCH|IGNORE), confidence 0-100, score 0-100, suggestedUsd 0-${config.maxTradeUsd}, reasons string[], riskFlags string[]. Use AT MOST 5 reasons and 5 riskFlags.`;
  const response = await client.responses.create({ model: config.openaiModel, input: prompt });
  const text = response.output_text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  return { ...schema.parse(JSON.parse(text)), analysisSource: "AI" };
}
