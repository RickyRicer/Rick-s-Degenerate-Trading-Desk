import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { APP_VERSION } from "../version.js";
import type { TokenSnapshot } from "../types/index.js";

const execFileAsync = promisify(execFile);

export interface BlockscoutContractReport {
  checked: boolean;
  sourceVerified?: boolean;
  isContract?: boolean;
  proxy?: boolean;
  creatorAddress?: string;
  creationTransactionHash?: string;
  creationStatus?: string;
  contractName?: string;
  implementationAddress?: string;
  implementationName?: string;
  implementationVerified?: boolean;
  inspectedContractAddress?: string;
  abiFunctionNames?: string[];
  abiCapabilities?: string[];
  deployerName?: string;
  deployerIsContract?: boolean;
  deployerVerified?: boolean;
  notes: string[];
  raw?: unknown;
}

const CHAIN_ID = 4663;
const BASE = `https://api.blockscout.com/${CHAIN_ID}/api/v2`;
const addressCache = new Map<string, any>();
const contractCache = new Map<string, any>();

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: any }).cause;
  const code = cause?.code ?? (error as any).code;
  const reason = cause?.reason;
  return [error.message, code, reason].filter(Boolean).join(" | ");
}

async function debugRaw(token: TokenSnapshot, body: unknown) {
  if (!config.securityDebugLog) return;
  try {
    const dir = join(process.cwd(), "security-debug");
    await mkdir(dir, { recursive: true });
    const safe = token.tokenAddress.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = join(dir, `blockscout-${token.chainId}-${safe}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(body, null, 2), "utf8");
    console.log(`[security-debug] wrote ${file}`);
  } catch (e: any) {
    console.warn(`[security-debug] unable to write Blockscout response: ${e?.message ?? String(e)}`);
  }
}

async function getJson(url: string): Promise<any> {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${config.blockscoutApiKey}`,
    "user-agent": `runner-hunter/${APP_VERSION}`
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Blockscout HTTP ${response.status} ${response.statusText}`);
    return await response.json();
  } catch (fetchError) {
    if (process.platform !== "win32") throw fetchError;
    try {
      const curl = "C:\\Windows\\System32\\curl.exe";
      const { stdout } = await execFileAsync(
        curl,
        [
          "--fail", "--silent", "--show-error", "--location", "--max-time", "15",
          "-H", "accept: application/json",
          "-H", `authorization: Bearer ${config.blockscoutApiKey}`,
          "-H", `user-agent: runner-hunter/${APP_VERSION}`,
          url
        ],
        { maxBuffer: 20 * 1024 * 1024 }
      );
      return JSON.parse(stdout);
    } catch (curlError) {
      throw new Error(`Node fetch: ${describeError(fetchError)} | Windows curl fallback: ${describeError(curlError)}`);
    }
  }
}

async function getAddressInfo(address: string): Promise<any> {
  const key = address.toLowerCase();
  if (addressCache.has(key)) return addressCache.get(key);
  const raw = await getJson(`${BASE}/addresses/${encodeURIComponent(address)}`);
  addressCache.set(key, raw);
  return raw;
}

async function getSmartContract(address: string): Promise<any | undefined> {
  const key = address.toLowerCase();
  if (contractCache.has(key)) return contractCache.get(key);
  try {
    const raw = await getJson(`${BASE}/smart-contracts/${encodeURIComponent(address)}`);
    contractCache.set(key, raw);
    return raw;
  } catch (e: any) {
    // Unverified contracts may not have a smart-contract resource. Address metadata
    // is still useful, so don't fail the whole Blockscout report for a 404-like miss.
    const text = describeError(e);
    if (/HTTP 404|not found/i.test(text)) {
      contractCache.set(key, undefined);
      return undefined;
    }
    throw e;
  }
}

function parseAbiFunctions(raw: any): string[] {
  let abi = raw?.abi;
  if (typeof abi === "string") {
    try { abi = JSON.parse(abi); } catch { abi = undefined; }
  }
  if (!Array.isArray(abi)) return [];
  return [...new Set(
    abi
      .filter((entry: any) => entry?.type === "function" && typeof entry?.name === "string")
      .map((entry: any) => entry.name.trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function classifyCapabilities(functions: string[]): string[] {
  const caps = new Set<string>();
  for (const fn of functions) {
    const n = fn.toLowerCase();
    if (/^(mint|mintto)$|mint/.test(n)) caps.add("mint controls");
    if (/pause|unpause|setpaused/.test(n)) caps.add("pause controls");
    if (/blacklist|blocklist|denylist|ban(address|account)?/.test(n)) caps.add("blacklist controls");
    if (/tax|setfee|fee(rate|percent|bps)?|fees/.test(n)) caps.add("fee/tax controls");
    if (/maxtx|maxwallet|walletlimit|transactionlimit|setlimit/.test(n)) caps.add("wallet/tx limits");
    if (/enabletrading|opentrading|settrading|tradingenabled/.test(n)) caps.add("trading controls");
    if (/upgradeto|upgradeandcall|setimplementation|changeadmin/.test(n)) caps.add("upgrade controls");
    if (/owner|ownership|grantrole|revokerole|setadmin|admin/.test(n)) caps.add("admin/role controls");
  }
  return [...caps];
}

function implementationFrom(...objects: any[]): string | undefined {
  for (const raw of objects) {
    const candidates = [
      raw?.implementation_address,
      raw?.implementation_address_hash,
      raw?.implementation?.address,
      raw?.implementations?.[0]?.address,
      raw?.implementations?.[0]?.address_hash
    ];
    for (const value of candidates) if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export async function getRobinhoodBlockscoutReport(token: TokenSnapshot): Promise<BlockscoutContractReport> {
  if (token.chainId !== "robinhood") return { checked: false, notes: [] };
  if (!config.blockscoutApiKey) {
    const message = "BLOCKSCOUT_API_KEY is missing; Robinhood source verification unavailable";
    console.warn(`[Blockscout] robinhood:${token.symbol} ${message}`);
    return { checked: false, notes: [message] };
  }

  try {
    const [addressRaw, contractRaw] = await Promise.all([
      getAddressInfo(token.tokenAddress),
      getSmartContract(token.tokenAddress)
    ]);

    const sourceVerified = typeof addressRaw?.is_verified === "boolean"
      ? addressRaw.is_verified
      : typeof contractRaw?.is_verified === "boolean"
        ? contractRaw.is_verified
        : contractRaw ? true : undefined;

    const implementationAddress = implementationFrom(addressRaw, contractRaw);
    const proxy = implementationAddress !== undefined || contractRaw?.is_proxy === true;
    let inspectedContractAddress = token.tokenAddress;
    let inspectedRaw = contractRaw;
    let implementationName: string | undefined;
    let implementationVerified: boolean | undefined;
    let implementationRaw: any | undefined;

    if (implementationAddress) {
      const [implAddressRaw, implContractRaw] = await Promise.all([
        getAddressInfo(implementationAddress).catch(() => undefined),
        getSmartContract(implementationAddress).catch(() => undefined)
      ]);
      implementationRaw = implContractRaw;
      implementationName =
        (typeof implContractRaw?.name === "string" && implContractRaw.name.trim() ? implContractRaw.name.trim() : undefined) ??
        (typeof implAddressRaw?.name === "string" && implAddressRaw.name.trim() ? implAddressRaw.name.trim() : undefined);
      implementationVerified = typeof implAddressRaw?.is_verified === "boolean"
        ? implAddressRaw.is_verified
        : implContractRaw ? true : undefined;
      if (implContractRaw) {
        inspectedContractAddress = implementationAddress;
        inspectedRaw = implContractRaw;
      }
    }

    const abiFunctionNames = parseAbiFunctions(inspectedRaw);
    const abiCapabilities = classifyCapabilities(abiFunctionNames);
    const notes: string[] = [];
    const creatorAddress = typeof addressRaw?.creator_address_hash === "string" ? addressRaw.creator_address_hash : undefined;
    let deployerName: string | undefined;
    let deployerIsContract: boolean | undefined;
    let deployerVerified: boolean | undefined;

    if (creatorAddress) {
      try {
        const creator = await getAddressInfo(creatorAddress);
        deployerName = typeof creator?.name === "string" && creator.name.trim() ? creator.name.trim() : undefined;
        deployerIsContract = typeof creator?.is_contract === "boolean" ? creator.is_contract : undefined;
        deployerVerified = typeof creator?.is_verified === "boolean" ? creator.is_verified : undefined;
      } catch (creatorError) {
        notes.push(`Deployer metadata lookup unavailable: ${describeError(creatorError)}`);
      }
    }

    if (sourceVerified === true) notes.push("Source verified on Robinhood Blockscout");
    else if (sourceVerified === false) notes.push("Source is not verified on Robinhood Blockscout");
    else notes.push("Blockscout did not return source-verification status");

    if (proxy) {
      notes.push(implementationAddress
        ? `Proxy detected; implementation ${implementationAddress}${implementationName ? ` (${implementationName})` : ""}`
        : "Proxy detected; implementation address unavailable");
    }
    if (abiFunctionNames.length) notes.push(`Verified ABI inspected (${abiFunctionNames.length} public functions)`);

    const report: BlockscoutContractReport = {
      checked: true,
      sourceVerified,
      isContract: typeof addressRaw?.is_contract === "boolean" ? addressRaw.is_contract : undefined,
      proxy,
      creatorAddress,
      creationTransactionHash: typeof addressRaw?.creation_transaction_hash === "string" ? addressRaw.creation_transaction_hash : undefined,
      creationStatus: typeof addressRaw?.creation_status === "string" ? addressRaw.creation_status : undefined,
      contractName: typeof contractRaw?.name === "string" ? contractRaw.name : typeof addressRaw?.name === "string" ? addressRaw.name : undefined,
      implementationAddress,
      implementationName,
      implementationVerified,
      inspectedContractAddress,
      abiFunctionNames,
      abiCapabilities,
      deployerName,
      deployerIsContract,
      deployerVerified,
      notes,
      raw: { address: addressRaw, contract: contractRaw, implementation: implementationRaw }
    };

    await debugRaw(token, report.raw);
    console.log(`[Blockscout] robinhood:${token.symbol} verified=${report.sourceVerified ?? "n/a"} proxy=${report.proxy ?? "n/a"} impl=${report.implementationName ?? report.implementationAddress ?? "n/a"} abi=${report.abiFunctionNames?.length ?? 0} caps=${report.abiCapabilities?.join(",") || "none"} creator=${report.creatorAddress ?? "n/a"} deployer=${report.deployerName ?? (report.deployerIsContract ? "contract" : report.deployerIsContract === false ? "wallet" : "n/a")}`);
    return report;
  } catch (e: any) {
    const message = `Robinhood Blockscout PRO lookup unavailable: ${e?.message ?? String(e)}`;
    console.warn(`[Blockscout] robinhood:${token.symbol} ${message}`);
    return { checked: false, notes: [message] };
  }
}
