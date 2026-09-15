import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { TokenSnapshot } from "../types/index.js";
import { pairAgeMinutes, scoreRunner } from "./runnerScore.js";
import { APP_VERSION } from "../version.js";

const execFileAsync = promisify(execFile);
const DEX_BASE = "https://api.dexscreener.com";

export type ScanScope = "all" | "sol" | "rh" | "bsc" | "evm";

const EVM_CHAINS = new Set([
  "robinhood", "bsc", "ethereum", "base", "arbitrum", "polygon",
  "avalanche", "optimism", "linea", "scroll", "mantle", "blast"
]);

function n(value: unknown): number {
  const x = Number(value ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function normalizePair(pair: any): TokenSnapshot {
  const token: TokenSnapshot = {
    chainId: pair.chainId ?? "",
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    tokenAddress: pair.baseToken?.address ?? "",
    symbol: pair.baseToken?.symbol ?? "?",
    name: pair.baseToken?.name ?? "Unknown",
    priceUsd: n(pair.priceUsd),
    liquidityUsd: n(pair.liquidity?.usd),
    volume5m: n(pair.volume?.m5),
    hasVolume5m: pair.volume?.m5 !== undefined && pair.volume?.m5 !== null,
    volume1h: n(pair.volume?.h1),
    volume24h: n(pair.volume?.h24),
    marketCap: n(pair.marketCap ?? pair.fdv),
    buys5m: n(pair.txns?.m5?.buys),
    sells5m: n(pair.txns?.m5?.sells),
    hasTxns5m: pair.txns?.m5 !== undefined && pair.txns?.m5 !== null,
    buys1h: n(pair.txns?.h1?.buys),
    sells1h: n(pair.txns?.h1?.sells),
    priceChange5m: n(pair.priceChange?.m5),
    hasPriceChange5m: pair.priceChange?.m5 !== undefined && pair.priceChange?.m5 !== null,
    priceChange1h: n(pair.priceChange?.h1),
    pairCreatedAt: pair.pairCreatedAt,
    url: pair.url
  };
  const runner = scoreRunner(token);
  token.runnerScore = runner.score;
  token.runnerSignals = runner.signals;
  return token;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: any }).cause;
  const code = cause?.code ?? (error as any).code;
  const reason = cause?.reason;
  return [error.message, code, reason].filter(Boolean).join(" | ");
}

async function getJson<T>(url: string): Promise<T> {
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "user-agent": `runner-hunter/${APP_VERSION}` }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return (await r.json()) as T;
  } catch (fetchError) {
    if (process.platform !== "win32") {
      throw new Error(`DEX Screener request failed: ${url} :: ${describeError(fetchError)}`);
    }
    try {
      const curl = "C:\\Windows\\System32\\curl.exe";
      const { stdout } = await execFileAsync(
        curl,
        ["--fail", "--silent", "--show-error", "--location", "--max-time", "15", url],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      return JSON.parse(stdout) as T;
    } catch (curlError) {
      throw new Error(
        `DEX Screener request failed: ${url}\n` +
        `Node fetch: ${describeError(fetchError)}\n` +
        `Windows curl fallback: ${describeError(curlError)}`
      );
    }
  }
}

function scopeMatches(chainId: string, scope: ScanScope) {
  if (scope === "all") return true;
  if (scope === "sol") return chainId === "solana";
  if (scope === "rh") return chainId === "robinhood";
  if (scope === "bsc") return chainId === "bsc";
  if (scope === "evm") return EVM_CHAINS.has(chainId);
  return true;
}

function bestPair(pairs: any[], expectedChain?: string): any | undefined {
  const filtered = expectedChain ? pairs.filter(p => p.chainId === expectedChain) : pairs;
  return filtered.sort((a, b) => {
    const liqDiff = n(b.liquidity?.usd) - n(a.liquidity?.usd);
    if (liqDiff !== 0) return liqDiff;
    return n(b.volume?.h1) - n(a.volume?.h1);
  })[0];
}

export async function getToken(address: string, chainId?: string): Promise<TokenSnapshot> {
  const data = await getJson<any>(`${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(address)}`);
  const pairs = data.pairs ?? [];
  const pair = bestPair(pairs, chainId);
  if (!pair) throw new Error(chainId ? `No ${chainId} trading pair found for that address` : "No trading pair found for that address");
  return normalizePair(pair);
}

async function candidateRefs(scope: ScanScope) {
  const [profiles, boosts] = await Promise.all([
    getJson<any[]>(`${DEX_BASE}/token-profiles/latest/v1`),
    getJson<any[]>(`${DEX_BASE}/token-boosts/latest/v1`).catch(() => [])
  ]);

  const seen = new Set<string>();
  const refs: Array<{ chainId: string; tokenAddress: string }> = [];
  for (const item of [...profiles, ...boosts]) {
    const chainId = String(item.chainId ?? "");
    const tokenAddress = String(item.tokenAddress ?? "");
    if (!chainId || !tokenAddress || !scopeMatches(chainId, scope)) continue;
    const key = `${chainId}:${tokenAddress}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ chainId, tokenAddress });
    if (refs.length >= config.runnerCandidateFetchLimit) break;
  }
  return refs;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R | undefined>) {
  const results: R[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      const result = await fn(items[i]);
      if (result !== undefined) results.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function scanRunners(scope: ScanScope = "all", limit = config.runnerAiFinalists): Promise<TokenSnapshot[]> {
  const refs = await candidateRefs(scope);
  const snapshots = await mapWithConcurrency(refs, 5, async ref => {
    try {
      const token = await getToken(ref.tokenAddress, ref.chainId);
      const ageMin = pairAgeMinutes(token);
      if (token.priceUsd <= 0) return undefined;
      if (ageMin !== undefined && ageMin > config.runnerMaxAgeHours * 60) return undefined;
      if (token.liquidityUsd < config.runnerMinLiquidityUsd) return undefined;
      if (token.volume1h < config.runnerMinVolume1hUsd) return undefined;
      return token;
    } catch (error) {
      console.warn(`Skipping ${ref.chainId}:${ref.tokenAddress}: ${describeError(error)}`);
      return undefined;
    }
  });

  return snapshots
    .sort((a, b) => (b.runnerScore ?? 0) - (a.runnerScore ?? 0))
    .slice(0, limit);
}
