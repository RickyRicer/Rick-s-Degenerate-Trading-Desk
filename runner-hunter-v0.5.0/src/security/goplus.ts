import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { APP_VERSION } from "../version.js";
import type { TokenSnapshot } from "../types/index.js";
import type { SecurityReport } from "./types.js";

const CHAIN_IDS: Record<string, string> = {
  ethereum: "1", bsc: "56", arbitrum: "42161", polygon: "137", base: "8453",
  optimism: "10", avalanche: "43114", linea: "59144", mantle: "5000",
  scroll: "534352", blast: "81457", robinhood: "4663"
};

const asNum = (v: unknown): number | undefined => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v); return Number.isFinite(n) ? n : undefined;
};
const yes = (v: unknown): boolean | undefined => v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : undefined;
const pct = (v: unknown): number | undefined => { const n = asNum(v); return n === undefined ? undefined : n * 100; };
const fnStatus = (v: any): boolean | undefined => yes(v?.status ?? v);

function topPercent(holders: any[] | undefined) {
  if (!Array.isArray(holders)) return undefined;
  let total = 0, saw = false;
  for (const h of holders.slice(0, 10)) {
    const tag = String(h?.tag ?? "").toLowerCase();
    const locked = yes(h?.is_locked) === true;
    if (locked || tag.includes("burn") || tag.includes("dead") || tag.includes("locker")) continue;
    const p = asNum(h?.percent);
    if (p !== undefined) { total += p; saw = true; }
  }
  return saw ? total * 100 : undefined;
}

function lpLockedPercent(lpHolders: any[] | undefined) {
  if (!Array.isArray(lpHolders)) return undefined;
  let total = 0, saw = false;
  for (const h of lpHolders) {
    if (yes(h?.is_locked) !== true) continue;
    const p = asNum(h?.percent);
    if (p !== undefined) { total += p; saw = true; }
  }
  return saw ? total * 100 : undefined;
}

async function fetchGoPlus(url: string) {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": `runner-hunter/${APP_VERSION}` };
  if (config.goplusAccessToken) headers.authorization = `Bearer ${config.goplusAccessToken}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`GoPlus HTTP ${r.status} ${r.statusText}`);
  const body = await r.json() as any;
  if (body?.code !== undefined && body.code !== 1) throw new Error(`GoPlus: ${body?.message ?? `code ${body.code}`}`);
  return body;
}

async function debugRaw(token: TokenSnapshot, body: unknown) {
  if (!config.securityDebugLog) return;
  try {
    const dir = join(process.cwd(), "security-debug");
    await mkdir(dir, { recursive: true });
    const safe = token.tokenAddress.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = join(dir, `${token.chainId}-${safe}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(body, null, 2), "utf8");
    console.log(`[security-debug] wrote ${file}`);
  } catch (e: any) {
    console.warn(`[security-debug] unable to write raw response: ${e?.message ?? String(e)}`);
  }
}

function unknown(provider = "GoPlus", note?: string): SecurityReport {
  return {
    provider, status: "UNKNOWN", checked: false, hardFlags: [], warnings: [], positives: [],
    coverageNotes: note ? [note] : ["Security coverage unavailable"],
    bundleRisk: "UNKNOWN", bundleNotes: ["Wallet-link/bundle clustering not connected yet"]
  };
}

function evaluateEvm(raw: any): SecurityReport {
  const hardFlags: string[] = [], warnings: string[] = [], positives: string[] = [], coverageNotes: string[] = [];
  const isHoneypot = yes(raw?.is_honeypot);
  const cannotBuy = yes(raw?.cannot_buy);
  const cannotSellAll = yes(raw?.cannot_sell_all);
  const openSource = yes(raw?.is_open_source);
  const proxy = yes(raw?.is_proxy);
  const mintable = yes(raw?.is_mintable);
  const transferPausable = yes(raw?.transfer_pausable);
  const modifiableTax = yes(raw?.slippage_modifiable);
  const blacklist = yes(raw?.is_blacklisted ?? raw?.blacklist);
  const buyTaxPercent = pct(raw?.buy_tax);
  const sellTaxPercent = pct(raw?.sell_tax);
  const top10Percent = topPercent(raw?.holders);
  const ownerPercent = pct(raw?.owner_percent);
  const creatorPercent = pct(raw?.creator_percent);
  const holderCount = asNum(raw?.holder_count);
  const locked = lpLockedPercent(raw?.lp_holders);

  // Hard FAIL means a positively observed dangerous condition, not merely missing coverage.
  if (isHoneypot === true) hardFlags.push("Honeypot detected");
  if (cannotBuy === true) hardFlags.push("Token cannot be bought normally");
  if (sellTaxPercent !== undefined && sellTaxPercent >= config.securityMaxSellTaxPercent) hardFlags.push(`Sell tax ${sellTaxPercent.toFixed(1)}%`);
  if (buyTaxPercent !== undefined && buyTaxPercent >= config.securityMaxBuyTaxPercent) hardFlags.push(`Buy tax ${buyTaxPercent.toFixed(1)}%`);
  if (top10Percent !== undefined && top10Percent >= config.securityMaxTop10Percent) hardFlags.push(`Top holders control ${top10Percent.toFixed(1)}%`);

  if (cannotSellAll === true) warnings.push("Contract may restrict selling the full balance");
  if (proxy === true) warnings.push("Proxy/upgradeable contract");
  if (mintable === true) warnings.push("Mint function remains available");
  if (transferPausable === true) warnings.push("Transfers can be paused");
  if (modifiableTax === true) warnings.push("Trading tax can be modified");
  if (blacklist === true) warnings.push("Blacklist controls detected");
  if (ownerPercent !== undefined && ownerPercent >= 5) warnings.push(`Owner holds ${ownerPercent.toFixed(1)}%`);
  if (creatorPercent !== undefined && creatorPercent >= 5) warnings.push(`Creator holds ${creatorPercent.toFixed(1)}%`);
  if (locked !== undefined && locked < 50) warnings.push(`Only ${locked.toFixed(1)}% of detected LP is locked`);

  if (isHoneypot === false) positives.push("No honeypot detected");
  if (openSource === true) positives.push("Contract source verified/open");
  if (buyTaxPercent !== undefined && sellTaxPercent !== undefined && buyTaxPercent < 5 && sellTaxPercent < 5) positives.push(`Low taxes (${buyTaxPercent.toFixed(1)}%/${sellTaxPercent.toFixed(1)}%)`);
  if (top10Percent !== undefined && top10Percent < 30) positives.push(`Top-holder concentration ${top10Percent.toFixed(1)}%`);

  // GoPlus documents that closed-source contracts can prevent it from detecting other risk items.
  // Treat this as incomplete coverage, not proof of a malicious contract. UNKNOWN is still trade-blocking.
  if (openSource === false) coverageNotes.push("Contract source is not verified/open; GoPlus says other risk checks may be unavailable");
  else if (openSource === undefined) coverageNotes.push("Contract source-verification status was not returned");

  // Do not treat a verified contract as fully safe unless the core runtime-risk
  // fields were actually returned. Blockscout can verify source, but it cannot
  // substitute for honeypot/sellability/tax coverage.
  if (isHoneypot === undefined) coverageNotes.push("Honeypot result was not returned");
  if (cannotBuy === undefined) coverageNotes.push("Buy/sellability result was not returned");
  if (buyTaxPercent === undefined) coverageNotes.push("Buy-tax result was not returned");
  if (sellTaxPercent === undefined) coverageNotes.push("Sell-tax result was not returned");

  const status = hardFlags.length ? "FAIL" : coverageNotes.length ? "UNKNOWN" : warnings.length ? "WARN" : "PASS";
  return {
    provider: "GoPlus", checked: true, status, hardFlags, warnings, positives, coverageNotes,
    holderCount, top10Percent, ownerPercent, creatorPercent, buyTaxPercent, sellTaxPercent,
    isHoneypot, openSource, proxy, mintable, liquidityLockedPercent: locked,
    bundleRisk: "UNKNOWN", bundleNotes: ["Holder concentration checked when available; linked-wallet/bundle clustering is not connected yet"], raw
  };
}

function evaluateSolana(raw: any): SecurityReport {
  const hardFlags: string[] = [], warnings: string[] = [], positives: string[] = [], coverageNotes: string[] = [];
  const mintable = fnStatus(raw?.mintable);
  const freezable = fnStatus(raw?.freezable);
  const closable = fnStatus(raw?.closable);
  const balanceMutable = fnStatus(raw?.balance_mutable_authority);
  const nonTransferable = yes(raw?.non_transferable);
  const defaultFrozen = String(raw?.default_account_state ?? "") === "2";
  const top10Percent = topPercent(raw?.holders);
  const holderCount = asNum(raw?.holder_count);

  if (nonTransferable === true) hardFlags.push("Token is non-transferable");
  if (defaultFrozen) hardFlags.push("New token accounts default to frozen");
  if (balanceMutable === true) hardFlags.push("Authority can modify holder balances");
  if (top10Percent !== undefined && top10Percent >= config.securityMaxTop10Percent) hardFlags.push(`Top holders control ${top10Percent.toFixed(1)}%`);
  if (yes(raw?.creator?.malicious_address) === true) hardFlags.push("Creator flagged as malicious");

  if (mintable === true) warnings.push("Mint authority remains active");
  if (freezable === true) warnings.push("Freeze authority remains active");
  if (closable === true) warnings.push("Token program can be closed");
  if (fnStatus(raw?.transfer_fee_upgradable) === true) warnings.push("Transfer fee can be upgraded");
  if (fnStatus(raw?.transfer_hook_upgradable) === true) warnings.push("Transfer hook can be upgraded");
  if (raw?.transfer_hook?.address) warnings.push("Transfer hook is configured");

  if (mintable === false) positives.push("Mint authority disabled");
  if (freezable === false) positives.push("Freeze authority disabled");
  if (top10Percent !== undefined && top10Percent < 30) positives.push(`Top-holder concentration ${top10Percent.toFixed(1)}%`);

  const lpHolders = Array.isArray(raw?.dex) ? raw.dex.flatMap((d: any) => d?.lp_holders ?? []) : raw?.lp_holders;
  const locked = lpLockedPercent(lpHolders);
  if (locked !== undefined && locked >= 50) positives.push(`Detected locked LP ${locked.toFixed(1)}%`);
  else if (locked !== undefined) warnings.push(`Only ${locked.toFixed(1)}% of detected LP is locked`);

  if (mintable === undefined && freezable === undefined && top10Percent === undefined) coverageNotes.push("Core Solana authority/holder fields were not returned");
  const status = hardFlags.length ? "FAIL" : coverageNotes.length ? "UNKNOWN" : warnings.length ? "WARN" : "PASS";
  return {
    provider: "GoPlus Solana", checked: true, status, hardFlags, warnings, positives, coverageNotes,
    holderCount, top10Percent, mintable, freezable, liquidityLockedPercent: locked,
    bundleRisk: "UNKNOWN", bundleNotes: ["Holder concentration checked when available; linked-wallet/bundle clustering is not connected yet"], raw
  };
}

export async function getGoPlusSecurityReport(token: TokenSnapshot): Promise<SecurityReport> {
  if (!config.securityDeepDiveEnabled) return unknown("GoPlus", "Deep-dive security disabled");
  try {
    let body: any;
    if (token.chainId === "solana") {
      body = await fetchGoPlus(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(token.tokenAddress)}`);
    } else {
      const chainId = CHAIN_IDS[token.chainId];
      if (!chainId) return unknown("GoPlus", `No GoPlus chain mapping for ${token.chainId}`);
      body = await fetchGoPlus(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(token.tokenAddress)}`);
    }
    await debugRaw(token, body);
    const result = body?.result ?? {};
    const raw = result[token.tokenAddress.toLowerCase()] ?? result[token.tokenAddress] ?? Object.values(result)[0];
    if (!raw || typeof raw !== "object") return unknown("GoPlus", "No security record returned for token");
    const report = token.chainId === "solana" ? evaluateSolana(raw) : evaluateEvm(raw);
    console.log(`[GoPlus] ${token.chainId}:${token.symbol} status=${report.status} openSource=${report.openSource ?? "n/a"} hard=${report.hardFlags.length} warnings=${report.warnings.length} coverage=${report.coverageNotes.length}`);
    return report;
  } catch (e: any) {
    return unknown("GoPlus", `Security lookup unavailable: ${e?.message ?? String(e)}`);
  }
}
