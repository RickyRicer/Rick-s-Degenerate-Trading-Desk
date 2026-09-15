import { config } from "../config.js";
import type { TokenSnapshot } from "../types/index.js";

export interface HolderIntel {
  checked: boolean;
  holderCount?: number;
  top10Percent?: number;
  top1Percent?: number;
  contractHolderCount?: number;
  notes: string[];
}

const BASE = "https://api.blockscout.com/4663/api/v2";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
  const delays = [0, 400, 1000];
  let last: Response | undefined;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    const response = await fetch(url, { headers });
    last = response;
    if (response.ok || (response.status !== 429 && response.status < 500)) return response;
    if (i < delays.length - 1) console.warn(`[Holders] Blockscout HTTP ${response.status}; retrying ${i + 2}/${delays.length}`);
  }
  return last!;
}

export async function getRobinhoodHolderIntel(token: TokenSnapshot, totalSupply?: bigint): Promise<HolderIntel> {
  if (token.chainId !== "robinhood" || !config.blockscoutApiKey) return { checked: false, notes: [] };
  try {
    const headers = { accept: "application/json", authorization: `Bearer ${config.blockscoutApiKey}` };
    const [holdersRes, countersRes] = await Promise.all([
      fetchWithRetry(`${BASE}/tokens/${encodeURIComponent(token.tokenAddress)}/holders`, headers),
      fetchWithRetry(`${BASE}/tokens/${encodeURIComponent(token.tokenAddress)}/counters`, headers)
    ]);
    if (!holdersRes.ok) throw new Error(`holders HTTP ${holdersRes.status}`);
    const holdersBody = await holdersRes.json() as any;
    const countersBody = countersRes.ok ? await countersRes.json() as any : undefined;
    const items = Array.isArray(holdersBody?.items) ? holdersBody.items.slice(0, 10) : [];
    const values = items.map((x: any) => { try { return BigInt(x?.value ?? "0"); } catch { return 0n; } });
    const sum = values.reduce((a: bigint, b: bigint) => a + b, 0n);
    const pct = (v: bigint) => totalSupply && totalSupply > 0n ? Number((v * 10000n) / totalSupply) / 100 : undefined;
    const report: HolderIntel = {
      checked: true,
      holderCount: Number.isFinite(Number(countersBody?.token_holders_count)) ? Number(countersBody.token_holders_count) : undefined,
      top10Percent: pct(sum),
      top1Percent: values[0] !== undefined ? pct(values[0]) : undefined,
      contractHolderCount: items.filter((x: any) => x?.address_hash?.is_contract === true || x?.address?.is_contract === true).length,
      notes: []
    };
    if (report.top10Percent !== undefined) report.notes.push(`Top 10 holders: ${report.top10Percent.toFixed(1)}% of supply`);
    if (report.top1Percent !== undefined) report.notes.push(`Largest holder: ${report.top1Percent.toFixed(1)}% of supply`);
    console.log(`[Holders] robinhood:${token.symbol} count=${report.holderCount ?? "n/a"} top10=${report.top10Percent?.toFixed(1) ?? "n/a"}% top1=${report.top1Percent?.toFixed(1) ?? "n/a"}%`);
    return report;
  } catch (e: any) {
    const note = `Blockscout holder intelligence unavailable: ${e?.message ?? String(e)}`;
    console.warn(`[Holders] robinhood:${token.symbol} ${note}`);
    return { checked: false, notes: [note] };
  }
}
