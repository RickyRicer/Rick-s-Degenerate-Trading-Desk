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
  deployerName?: string;
  deployerIsContract?: boolean;
  deployerVerified?: boolean;
  notes: string[];
  raw?: unknown;
}

const CHAIN_ID = 4663;
const BASE = `https://api.blockscout.com/${CHAIN_ID}/api/v2`;
const addressCache = new Map<string, any>();

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
        { maxBuffer: 10 * 1024 * 1024 }
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

export async function getRobinhoodBlockscoutReport(token: TokenSnapshot): Promise<BlockscoutContractReport> {
  if (token.chainId !== "robinhood") return { checked: false, notes: [] };
  if (!config.blockscoutApiKey) {
    const message = "BLOCKSCOUT_API_KEY is missing; Robinhood source verification unavailable";
    console.warn(`[Blockscout] robinhood:${token.symbol} ${message}`);
    return { checked: false, notes: [message] };
  }

  try {
    const raw = await getAddressInfo(token.tokenAddress);
    await debugRaw(token, raw);

    const sourceVerified = typeof raw?.is_verified === "boolean" ? raw.is_verified : undefined;
    const implementationAddress = typeof raw?.implementation_address === "string" && raw.implementation_address
      ? raw.implementation_address
      : undefined;
    const proxy = implementationAddress !== undefined;
    const notes: string[] = [];
    const creatorAddress = typeof raw?.creator_address_hash === "string" ? raw.creator_address_hash : undefined;
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

    if (proxy) notes.push(`Proxy/implementation detected: ${implementationAddress}`);

    const report: BlockscoutContractReport = {
      checked: true,
      sourceVerified,
      isContract: typeof raw?.is_contract === "boolean" ? raw.is_contract : undefined,
      proxy,
      creatorAddress,
      creationTransactionHash: typeof raw?.creation_transaction_hash === "string" ? raw.creation_transaction_hash : undefined,
      creationStatus: typeof raw?.creation_status === "string" ? raw.creation_status : undefined,
      contractName: typeof raw?.name === "string" ? raw.name : undefined,
      implementationAddress,
      deployerName,
      deployerIsContract,
      deployerVerified,
      notes,
      raw
    };

    console.log(`[Blockscout] robinhood:${token.symbol} verified=${report.sourceVerified ?? "n/a"} proxy=${report.proxy ?? "n/a"} creator=${report.creatorAddress ?? "n/a"} deployer=${report.deployerName ?? (report.deployerIsContract ? "contract" : report.deployerIsContract === false ? "wallet" : "n/a")}`);
    return report;
  } catch (e: any) {
    const message = `Robinhood Blockscout PRO lookup unavailable: ${e?.message ?? String(e)}`;
    console.warn(`[Blockscout] robinhood:${token.symbol} ${message}`);
    return { checked: false, notes: [message] };
  }
}
