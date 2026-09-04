import type { TokenSnapshot } from "../types/index.js";
import { CoveMcpClient, extractMcpContent } from "../coveMcp.js";

export interface CoveSecurityIntel {
  checked: boolean;
  available: boolean;
  notes: string[];
  hardFlags: string[];
  positives: string[];
  warnings: string[];
  isHoneypot?: boolean;
  canBuy?: boolean;
  canSell?: boolean;
  buyTaxPercent?: number;
  sellTaxPercent?: number;
  top10Percent?: number;
  liquidityLocked?: boolean;
  raw?: any;
}

const client = new CoveMcpClient();

function flatten(value: any, prefix = "", out: Record<string, any> = {}) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) { value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out)); return out; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix.toLowerCase()] = value;
  return out;
}
function find(flat: Record<string, any>, patterns: RegExp[]) {
  const entry = Object.entries(flat).find(([k]) => patterns.some(p => p.test(k)));
  return entry?.[1];
}
function asBool(v: any): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const x = v.toLowerCase();
    if (["true","yes","1","pass","safe","allowed"].includes(x)) return true;
    if (["false","no","0","fail","unsafe","blocked"].includes(x)) return false;
  }
  return undefined;
}
function asPct(v: any): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).replace("%", ""));
  if (!Number.isFinite(n)) return undefined;
  return n <= 1 && n >= 0 ? n * 100 : n;
}

function buildArgs(schema: any, token: TokenSnapshot) {
  const props = schema?.properties ?? {};
  const args: Record<string, any> = {};
  const chainNames: Record<string, string> = { robinhood: "robinhood", solana: "solana", bsc: "bnb", ethereum: "ethereum", base: "base", arbitrum: "arbitrum" };
  const chainIds: Record<string, number> = { robinhood: 4663, bsc: 56, ethereum: 1, base: 8453, arbitrum: 42161 };
  for (const key of Object.keys(props)) {
    const k = key.toLowerCase();
    if (/^(token_?address|contract_?address|address|mint|ca)$/.test(k)) args[key] = token.tokenAddress;
    else if (/^(chain|network|chain_?name)$/.test(k)) args[key] = chainNames[token.chainId] ?? token.chainId;
    else if (/^chain_?id$/.test(k) && chainIds[token.chainId]) args[key] = chainIds[token.chainId];
  }
  return args;
}

export async function getCoveSecurityIntel(token: TokenSnapshot): Promise<CoveSecurityIntel> {
  if (!client.configured()) return { checked: false, available: false, notes: ["Cove read token not configured"], hardFlags: [], positives: [], warnings: [] };
  try {
    const tool = await client.findTool("get_token_security_report", "token_security_report", "get_token_security");
    if (!tool) return { checked: true, available: false, notes: ["Cove MCP security tool not exposed by this account"], hardFlags: [], positives: [], warnings: [] };
    const result = await client.callTool(tool.name, buildArgs(tool.inputSchema, token));
    const raw = extractMcpContent(result);
    const flat = flatten(raw);
    const hardFlags: string[] = [], positives: string[] = [], warnings: string[] = [], notes: string[] = [];
    const honeypot = asBool(find(flat, [/honeypot/, /is_honeypot/]));
    const canBuy = asBool(find(flat, [/can.?buy/, /buyable/, /buy.?allowed/]));
    const canSell = asBool(find(flat, [/can.?sell/, /sellable/, /sell.?allowed/]));
    const buyTax = asPct(find(flat, [/buy.?tax/, /buy.?fee/]));
    const sellTax = asPct(find(flat, [/sell.?tax/, /sell.?fee/]));
    const top10 = asPct(find(flat, [/top.?10.*(percent|pct|concentration|share)/, /top10/]));
    const locked = asBool(find(flat, [/liquidity.*lock/, /lp.*lock/]));
    if (honeypot === true) hardFlags.push("Cove security report flags honeypot behavior");
    if (honeypot === false) positives.push("Cove reports no honeypot behavior");
    if (canBuy === false) hardFlags.push("Cove reports token cannot be bought normally");
    if (canSell === false) hardFlags.push("Cove reports token cannot be sold normally");
    if (canBuy === true) positives.push("Cove buyability check passed");
    if (canSell === true) positives.push("Cove sellability check passed");
    if (buyTax !== undefined || sellTax !== undefined) notes.push(`Cove tax: ${buyTax ?? "?"}% buy / ${sellTax ?? "?"}% sell`);
    if (locked === true) positives.push("Cove reports liquidity lock evidence");
    if (locked === false) warnings.push("Cove did not report liquidity as locked");
    console.log(`[Cove] ${token.chainId}:${token.symbol} security tool=${tool.name} honeypot=${honeypot ?? "n/a"} buy=${canBuy ?? "n/a"} sell=${canSell ?? "n/a"} tax=${buyTax ?? "?"}/${sellTax ?? "?"}`);
    return { checked: true, available: true, notes, hardFlags, positives, warnings, isHoneypot: honeypot, canBuy, canSell, buyTaxPercent: buyTax, sellTaxPercent: sellTax, top10Percent: top10, liquidityLocked: locked, raw };
  } catch (e: any) {
    console.warn(`[Cove] ${token.chainId}:${token.symbol} security unavailable: ${e?.message ?? String(e)}`);
    return { checked: true, available: false, notes: [`Cove MCP security unavailable: ${e?.message ?? String(e)}`], hardFlags: [], positives: [], warnings: [] };
  }
}

export async function getCoveMcpStatus() {
  if (!client.configured()) return { configured: false, tools: [] as string[], error: "COVE_READ_TOKEN is missing", metadata: client.getMetadata() };
  try {
    const tools = await client.listTools();
    return { configured: true, tools: tools.map(t => t.name).sort(), error: undefined, metadata: client.getMetadata() };
  } catch (e: any) {
    return { configured: true, tools: [] as string[], error: e?.message ?? String(e), metadata: client.getMetadata() };
  }
}
