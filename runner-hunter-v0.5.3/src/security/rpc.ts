import { config } from "../config.js";
import type { TokenSnapshot } from "../types/index.js";

export interface RpcSecurityReport {
  checked: boolean;
  codePresent?: boolean;
  ownerAddress?: string;
  paused?: boolean;
  totalSupply?: bigint;
  notes: string[];
}

const SELECTORS = {
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  totalSupply: "0x18160ddd"
};

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(config.robinhoodRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const body = await r.json() as any;
  if (body?.error) throw new Error(body.error?.message ?? "RPC error");
  return body?.result;
}

async function call(to: string, data: string): Promise<string | undefined> {
  try { return await rpc("eth_call", [{ to, data }, "latest"]); } catch { return undefined; }
}

function decodeAddress(hex?: string) {
  if (!hex || hex === "0x" || hex.length < 42) return undefined;
  const a = `0x${hex.slice(-40)}`;
  return /^0x0{40}$/i.test(a) ? undefined : a;
}
function decodeBool(hex?: string) {
  if (!hex || hex === "0x") return undefined;
  try { return BigInt(hex) !== 0n; } catch { return undefined; }
}
function decodeUint(hex?: string) {
  if (!hex || hex === "0x") return undefined;
  try { return BigInt(hex); } catch { return undefined; }
}

export async function getRobinhoodRpcSecurity(token: TokenSnapshot): Promise<RpcSecurityReport> {
  if (token.chainId !== "robinhood") return { checked: false, notes: [] };
  try {
    const [code, ownerRaw, pausedRaw, supplyRaw] = await Promise.all([
      rpc("eth_getCode", [token.tokenAddress, "latest"]),
      call(token.tokenAddress, SELECTORS.owner),
      call(token.tokenAddress, SELECTORS.paused),
      call(token.tokenAddress, SELECTORS.totalSupply)
    ]);
    const report: RpcSecurityReport = {
      checked: true,
      codePresent: typeof code === "string" && code !== "0x",
      ownerAddress: decodeAddress(ownerRaw),
      paused: decodeBool(pausedRaw),
      totalSupply: decodeUint(supplyRaw),
      notes: []
    };
    if (report.codePresent) report.notes.push("Contract bytecode confirmed by Robinhood Chain RPC");
    if (report.ownerAddress) report.notes.push(`owner() exposed: ${report.ownerAddress}`);
    if (report.paused === true) report.notes.push("paused() currently returns true");
    else if (report.paused === false) report.notes.push("paused() currently returns false");
    console.log(`[RPC] robinhood:${token.symbol} code=${report.codePresent ?? "n/a"} owner=${report.ownerAddress ?? "n/a"} paused=${report.paused ?? "n/a"}`);
    return report;
  } catch (e: any) {
    const note = `Robinhood RPC inspection unavailable: ${e?.message ?? String(e)}`;
    console.warn(`[RPC] robinhood:${token.symbol} ${note}`);
    return { checked: false, notes: [note] };
  }
}
