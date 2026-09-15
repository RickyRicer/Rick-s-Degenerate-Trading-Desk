import type { TokenSnapshot } from "../types/index.js";
import { CoveMcpClient, extractMcpContent, schemaSummary, type McpTool } from "../coveMcp.js";

export interface CoveSecurityIntel {
  checked: boolean;
  available: boolean;
  notes: string[];
  hardFlags: string[];
  positives: string[];
  warnings: string[];
  verdict?: string;
  isHoneypot?: boolean;
  canBuy?: boolean;
  canSell?: boolean;
  buyTaxPercent?: number;
  sellTaxPercent?: number;
  top10Percent?: number;
  liquidityLocked?: boolean;
  liquidityLockedPercent?: number;
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  tokenInfo?: any;
  raw?: any;
}

const client = new CoveMcpClient({ access: "read", clientVersion: "0.5.5" });
const writeClient = new CoveMcpClient({ access: "paper-write", clientVersion: "0.5.5" });

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

function findEntry(flat: Record<string, any>, patterns: RegExp[]) {
  return Object.entries(flat).find(([k]) => patterns.some(p => p.test(k)));
}

function asBool(v: any): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const x = v.trim().toLowerCase();
    if (["true","yes","1","pass","safe","allowed","enabled","active","locked"].includes(x)) return true;
    if (["false","no","0","fail","unsafe","blocked","disabled","inactive","unlocked","none","null"].includes(x)) return false;
  }
  return undefined;
}

function asPct(v: any): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).replace("%", "").trim());
  if (!Number.isFinite(n)) return undefined;
  return n <= 1 && n >= 0 ? n * 100 : n;
}

function asString(v: any): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

const chainNames: Record<string, string[]> = {
  robinhood: ["robinhood", "robinhood chain", "rh"],
  solana: ["solana", "sol"],
  bsc: ["bnb", "bnb chain", "bsc"],
  ethereum: ["ethereum", "eth"],
  base: ["base"],
  arbitrum: ["arbitrum", "arb"]
};
const chainIds: Record<string, number> = { robinhood: 4663, bsc: 56, ethereum: 1, base: 8453, arbitrum: 42161 };

function chooseEnum(values: any[], token: TokenSnapshot): any | undefined {
  const aliases = chainNames[token.chainId] ?? [token.chainId];
  for (const candidate of values) {
    if (aliases.some(a => String(candidate).toLowerCase() === a.toLowerCase())) return candidate;
    if (chainIds[token.chainId] !== undefined && String(candidate) === String(chainIds[token.chainId])) return candidate;
  }
  return undefined;
}

function valueForProperty(key: string, schema: any, token: TokenSnapshot): any | undefined {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const desc = String(schema?.description ?? "").toLowerCase();
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : undefined;

  if (enumValues) {
    const selected = chooseEnum(enumValues, token);
    if (selected !== undefined) return selected;
  }

  if (["tokenaddress","contractaddress","address","mint","mintaddress","ca","token","tokenid"].includes(k) || /token.*address|contract.*address|mint address/.test(desc)) {
    return token.tokenAddress;
  }
  if (["chainid","networkid"].includes(k) || /numeric chain id|evm chain id/.test(desc)) {
    return chainIds[token.chainId] ?? token.chainId;
  }
  if (["chain","network","chainname","networkname"].includes(k) || /chain name|network name|blockchain/.test(desc)) {
    return (chainNames[token.chainId] ?? [token.chainId])[0];
  }
  if (["symbol","tokensymbol"].includes(k)) return token.symbol;
  if (["pairaddress","pair","pooladdress"].includes(k) && token.pairAddress) return token.pairAddress;
  return undefined;
}

function buildArgs(tool: McpTool, token: TokenSnapshot) {
  const schema = tool.inputSchema ?? {};
  const props = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const args: Record<string, any> = {};

  for (const [key, propSchema] of Object.entries<any>(props)) {
    const value = valueForProperty(key, propSchema, token);
    if (value !== undefined) args[key] = value;
  }

  const missing = required.filter(key => args[key] === undefined && props[key]?.default === undefined);
  if (missing.length) {
    throw new Error(`${tool.name} schema has unmapped required field(s): ${missing.join(", ")}. ${schemaSummary(tool)}`);
  }
  return args;
}

async function callTokenTool(toolNames: string[], token: TokenSnapshot): Promise<{ tool?: McpTool; raw?: any; error?: string }> {
  const tool = await client.findTool(...toolNames);
  if (!tool) return { error: `No matching tool exposed (${toolNames.join(" / ")})` };
  try {
    const result = await client.callReadTool(tool.name, buildArgs(tool, token));
    return { tool, raw: extractMcpContent(result) };
  } catch (e: any) {
    return { tool, error: e?.message ?? String(e) };
  }
}

function authorityActive(flat: Record<string, any>, kind: "mint" | "freeze"): boolean | undefined {
  const boolValue = asBool(find(flat, [new RegExp(`${kind}.*(active|enabled|authority.*present)`), new RegExp(`(${kind}able|can.*${kind})`)]));
  if (boolValue !== undefined) return boolValue;
  const entry = findEntry(flat, [new RegExp(`${kind}.*authority`)]);
  if (!entry) return undefined;
  const value = entry[1];
  if (value === null || value === undefined || value === "" || String(value).toLowerCase() === "none") return false;
  if (typeof value === "string") return true;
  return undefined;
}

export async function getCoveSecurityIntel(token: TokenSnapshot): Promise<CoveSecurityIntel> {
  if (!client.configured()) return { checked: false, available: false, notes: ["Cove read token not configured"], hardFlags: [], positives: [], warnings: [] };

  try {
    const [securityCall, infoCall] = await Promise.all([
      callTokenTool(["get_token_security_report", "token_security_report", "get_token_security"], token),
      callTokenTool(["get_token_info"], token)
    ]);

    if (!securityCall.raw) {
      const detail = securityCall.error ?? "Cove security report unavailable";
      console.warn(`[Cove] ${token.chainId}:${token.symbol} security unavailable: ${detail}`);
      return { checked: true, available: false, notes: [detail], hardFlags: [], positives: [], warnings: [], tokenInfo: infoCall.raw };
    }

    const raw = securityCall.raw;
    // Cove exposes useful security/tradeability fields across both tools. Search
    // the security report first, but include get_token_info as a secondary evidence
    // source instead of discarding it. Prefixes keep diagnostics attributable.
    const flat = flatten({ security: raw, info: infoCall.raw });
    const hardFlags: string[] = [], positives: string[] = [], warnings: string[] = [], notes: string[] = [];

    const verdict = asString(find(flat, [/audit.*verdict/, /security.*verdict/, /overall.*verdict/, /risk.*verdict/, /verdict$/]));
    const honeypot = asBool(find(flat, [/is.?honeypot/, /honeypot/])) ?? (() => {
      const v = verdict?.toLowerCase();
      return v?.includes("honeypot") ? true : undefined;
    })();
    const canBuy = asBool(find(flat, [/can.?buy/, /buyable/, /buy.?allowed/, /buy.?simulation.*success/])) ;
    const canSell = asBool(find(flat, [/can.?sell/, /sellable/, /sell.?allowed/, /sell.?simulation.*success/]));
    const buyTax = asPct(find(flat, [/buy.?tax/, /buy.?fee/]));
    const sellTax = asPct(find(flat, [/sell.?tax/, /sell.?fee/]));
    const top10 = asPct(find(flat, [/top.?10.*(percent|pct|concentration|share)/, /top10.*holder/, /top10/])) ;
    const lockedPct = asPct(find(flat, [/liquidity.*lock.*(percent|pct)/, /lp.*lock.*(percent|pct)/]));
    const locked = lockedPct !== undefined ? lockedPct > 0 : asBool(find(flat, [/liquidity.*locked/, /lp.*locked/, /liquidity.*lock/])) ;
    const mintAuthorityActive = authorityActive(flat, "mint");
    const freezeAuthorityActive = authorityActive(flat, "freeze");

    if (verdict) notes.push(`Cove verdict: ${verdict}`);
    if (securityCall.tool) notes.push(`Cove tool: ${securityCall.tool.name}`);
    if (infoCall.error) notes.push(`Cove token info unavailable: ${infoCall.error}`);

    if (honeypot === true) hardFlags.push("Cove security report flags honeypot behavior");
    if (honeypot === false) positives.push("Cove reports no honeypot behavior");
    if (canBuy === false) hardFlags.push("Cove reports token cannot be bought normally");
    if (canSell === false) hardFlags.push("Cove reports token cannot be sold normally");
    if (canBuy === true) positives.push("Cove buyability check passed");
    if (canSell === true) positives.push("Cove sellability check passed");
    if (buyTax !== undefined || sellTax !== undefined) notes.push(`Cove tax: ${buyTax ?? "?"}% buy / ${sellTax ?? "?"}% sell`);
    if (locked === true) positives.push(`Cove reports liquidity lock evidence${lockedPct !== undefined ? ` (${lockedPct.toFixed(1)}%)` : ""}`);
    if (locked === false) warnings.push("Cove did not report liquidity as locked");
    if (mintAuthorityActive === true) warnings.push("Cove reports active mint authority/control");
    if (mintAuthorityActive === false) positives.push("Cove reports no active mint authority");
    if (freezeAuthorityActive === true) warnings.push("Cove reports active freeze authority/control");
    if (freezeAuthorityActive === false) positives.push("Cove reports no active freeze authority");

    console.log(
      `[Cove] ${token.chainId}:${token.symbol} security tool=${securityCall.tool?.name ?? "?"}` +
      ` verdict=${verdict ?? "n/a"} honeypot=${honeypot ?? "n/a"} buy=${canBuy ?? "n/a"} sell=${canSell ?? "n/a"}` +
      ` tax=${buyTax ?? "?"}/${sellTax ?? "?"} top10=${top10 ?? "?"} lock=${lockedPct ?? locked ?? "?"}`
    );

    return {
      checked: true,
      available: true,
      notes,
      hardFlags,
      positives,
      warnings,
      verdict,
      isHoneypot: honeypot,
      canBuy,
      canSell,
      buyTaxPercent: buyTax,
      sellTaxPercent: sellTax,
      top10Percent: top10,
      liquidityLocked: locked,
      liquidityLockedPercent: lockedPct,
      mintAuthorityActive,
      freezeAuthorityActive,
      tokenInfo: infoCall.raw,
      raw: { security: raw, tokenInfo: infoCall.raw }
    };
  } catch (e: any) {
    console.warn(`[Cove] ${token.chainId}:${token.symbol} security unavailable: ${e?.message ?? String(e)}`);
    return { checked: true, available: false, notes: [`Cove MCP security unavailable: ${e?.message ?? String(e)}`], hardFlags: [], positives: [], warnings: [] };
  }
}

export async function getCoveMcpStatus() {
  if (!client.configured()) return { configured: false, tools: [] as string[], targetSchemas: [] as string[], paperSchemas: [] as string[], paperWriteConfigured: writeClient.configured(), error: "COVE_READ_TOKEN is missing", metadata: client.getMetadata(), safety: client.getSafetySummary() };
  try {
    const tools = await client.listTools();
    const targetSchemas = tools
      .filter(t => ["get_token_info", "get_token_security_report", "get_balance", "get_positions", "list_accounts", "get_profile"].includes(t.name))
      .map(schemaSummary);
    let paperSchemas: string[] = [];
    if (writeClient.configured()) {
      try {
        const writeTools = await writeClient.listTools();
        paperSchemas = writeTools.filter(t => ["buy_token", "sell_token", "reconcile_market_order", "get_order_status"].includes(t.name)).map(schemaSummary);
      } catch (e: any) {
        paperSchemas = [`write MCP unavailable: ${e?.message ?? String(e)}`];
      }
    }
    return { configured: true, tools: tools.map(t => t.name).sort(), targetSchemas, paperSchemas, paperWriteConfigured: writeClient.configured(), error: undefined, metadata: client.getMetadata(), safety: client.getSafetySummary() };
  } catch (e: any) {
    return { configured: true, tools: [] as string[], targetSchemas: [] as string[], paperSchemas: [] as string[], paperWriteConfigured: writeClient.configured(), error: e?.message ?? String(e), metadata: client.getMetadata(), safety: client.getSafetySummary() };
  }
}
