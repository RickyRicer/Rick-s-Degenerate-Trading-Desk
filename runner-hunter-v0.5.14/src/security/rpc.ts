import { config } from "../config.js";
import type { TokenSnapshot } from "../types/index.js";

export interface RpcSecurityReport {
  checked: boolean;
  codePresent?: boolean;
  ownerAddress?: string;
  paused?: boolean;
  totalSupply?: bigint;
  runtimeCapabilities?: string[];
  runtimeSelectors?: string[];
  minimalProxyImplementation?: string;
  delegatecallPresent?: boolean;
  notes: string[];
}

const SELECTORS = {
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  totalSupply: "0x18160ddd"
};

// These are deliberately limited to high-confidence, widely-used EVM selectors.
// Presence is a warning/coverage hint only. Absence is never treated as proof that
// a capability does not exist because contracts can dispatch dynamically.
const RUNTIME_SELECTOR_HINTS: Record<string, string> = {
  "40c10f19": "mint(address,uint256)",
  "a0712d68": "mint(uint256)",
  "8456cb59": "pause()",
  "3f4ba83a": "unpause()",
  "8da5cb5b": "owner()",
  "f2fde38b": "transferOwnership(address)",
  "715018a6": "renounceOwnership()"
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

function inspectRuntimeBytecode(code?: string) {
  if (!code || code === "0x") return { selectors: [] as string[], capabilities: [] as string[], delegatecallPresent: false };
  const hex = code.toLowerCase().replace(/^0x/, "");
  const selectors: string[] = [];
  const capabilities: string[] = [];
  for (const [selector, label] of Object.entries(RUNTIME_SELECTOR_HINTS)) {
    // Solidity dispatchers commonly encode PUSH4 <selector> as 63xxxxxxxx.
    if (hex.includes(`63${selector}`)) {
      selectors.push(`0x${selector}`);
      capabilities.push(label);
    }
  }

  // EIP-1167 minimal-proxy runtime pattern. If present we can extract the
  // implementation address without source verification.
  const minimal = hex.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  const minimalProxyImplementation = minimal ? `0x${minimal[1]}` : undefined;

  // 0xf4 is DELEGATECALL. This is only a heuristic hint, never a proxy verdict.
  const delegatecallPresent = /f4/.test(hex);
  return { selectors, capabilities, minimalProxyImplementation, delegatecallPresent };
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
    const runtime = inspectRuntimeBytecode(typeof code === "string" ? code : undefined);
    const report: RpcSecurityReport = {
      checked: true,
      codePresent: typeof code === "string" && code !== "0x",
      ownerAddress: decodeAddress(ownerRaw),
      paused: decodeBool(pausedRaw),
      totalSupply: decodeUint(supplyRaw),
      runtimeCapabilities: runtime.capabilities,
      runtimeSelectors: runtime.selectors,
      minimalProxyImplementation: runtime.minimalProxyImplementation,
      delegatecallPresent: runtime.delegatecallPresent,
      notes: []
    };
    if (report.codePresent) report.notes.push("Contract bytecode confirmed by Robinhood Chain RPC");
    if (report.ownerAddress) report.notes.push(`owner() exposed: ${report.ownerAddress}`);
    if (report.paused === true) report.notes.push("paused() currently returns true");
    else if (report.paused === false) report.notes.push("paused() currently returns false");
    if (report.minimalProxyImplementation) report.notes.push(`EIP-1167 minimal proxy runtime → ${report.minimalProxyImplementation}`);
    if (report.runtimeCapabilities?.length) report.notes.push(`Runtime selector hints: ${report.runtimeCapabilities.join(", ")}`);
    console.log(`[RPC] robinhood:${token.symbol} code=${report.codePresent ?? "n/a"} owner=${report.ownerAddress ?? "n/a"} paused=${report.paused ?? "n/a"} selectors=${report.runtimeCapabilities?.length ?? 0} minimalProxy=${report.minimalProxyImplementation ?? "n/a"}`);
    return report;
  } catch (e: any) {
    const note = `Robinhood RPC inspection unavailable: ${e?.message ?? String(e)}`;
    console.warn(`[RPC] robinhood:${token.symbol} ${note}`);
    return { checked: false, notes: [note] };
  }
}
