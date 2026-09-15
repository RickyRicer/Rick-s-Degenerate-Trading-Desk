import { randomUUID } from "node:crypto";
import type { Broker } from "./Broker.js";
import type { BrokerBalance, BrokerTradeResult, Position, TokenSnapshot } from "../types/index.js";
import { config } from "../config.js";
import { CoveMcpClient, CoveToolError, extractMcpContent, schemaSummary, type McpTool } from "../coveMcp.js";

const read = new CoveMcpClient({ access: "read", clientVersion: "0.5.17" });
const write = new CoveMcpClient({ access: "paper-write", clientVersion: "0.5.17" });

function flatten(value: any, prefix = "", out: Record<string, any> = {}) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) { value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out)); return out; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix.toLowerCase()] = value;
  return out;
}

function firstValue(flat: Record<string, any>, patterns: RegExp[]) {
  return Object.entries(flat).find(([k]) => patterns.some(p => p.test(k)))?.[1];
}

function asNumber(v: any): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,% ,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asString(v: any): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

function objectText(v: any): string {
  try { return JSON.stringify(v).toLowerCase(); } catch { return String(v).toLowerCase(); }
}

function collectObjects(value: any, out: any[] = []): any[] {
  if (!value || typeof value !== "object") return out;
  if (!Array.isArray(value)) out.push(value);
  if (Array.isArray(value)) for (const item of value) collectObjects(item, out);
  else for (const item of Object.values(value)) collectObjects(item, out);
  return out;
}

function idFromObject(obj: any): string | undefined {
  const flat = flatten(obj);
  return asString(firstValue(flat, [/(^|\.)(account_?id|accountid|id)$/, /account.*\.id$/]));
}

function paperScore(obj: any): number {
  const flat = flatten(obj);
  let score = 0;

  // Strongest signal: explicit boolean paper/sandbox flags. A field named
  // `isPaper` must not count as paper merely because the key contains the word.
  for (const [key, raw] of Object.entries(flat)) {
    const k = key.toLowerCase();
    if (!/(^|\.)(ispaper|paper|issandbox|sandbox|issimulated|simulated|isdemo|demo)$/.test(k)) continue;
    if (raw === true || String(raw).toLowerCase() === "true") score += 40;
    else if (raw === false || String(raw).toLowerCase() === "false") score -= 40;
  }

  // Named mode/profile/type fields are also useful, but weaker than an explicit flag.
  for (const [key, raw] of Object.entries(flat)) {
    if (!/(^|\.)(name|type|mode|environment|profile|accounttype|wallettype)$/.test(key)) continue;
    const value = String(raw).trim().toLowerCase();
    if (/^(paper|sandbox|simulation|simulated|demo|test|testnet)$/.test(value)) score += 20;
    if (/^(live|real|mainnet)$/.test(value)) score -= 30;
    if (value === "main") score -= 10;
  }

  return score;
}


function sanitizeDiagnosticValue(value: any, depth = 0): any {
  if (depth > 5) return "[max-depth]";
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitizeDiagnosticValue(v, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /bearer\s+[a-z0-9._-]{12,}/i.test(value)) return "[redacted]";
    return value;
  }
  const out: Record<string, any> = {};
  for (const [key, v] of Object.entries(value)) {
    if (/token|secret|authorization|api.?key|password|credential/i.test(key)) { out[key] = "[redacted]"; continue; }
    out[key] = sanitizeDiagnosticValue(v, depth + 1);
  }
  return out;
}

function diagnosticFields(raw: any): Array<{ path: string; value: string }> {
  const flat = flatten(raw);
  const priority = [
    /accountid$/i,
    /profileid$/i,
    /ispaper$/i,
    /cantrade$/i,
    /canmoneyout$/i,
    /isprimary$/i,
    /isdefault$/i,
    /(^|\.)name$/i,
    /(^|\.)kind$/i,
    /(^|\.)type$/i,
    /(^|\.)mode$/i,
    /environment$/i,
    /(^|\.)source$/i,
    /accountids?\[\d+\]$/i
  ];
  const entries = Object.entries(flat).filter(([key]) => priority.some(p => p.test(key)));
  entries.sort(([a], [b]) => {
    const ai = priority.findIndex(p => p.test(a));
    const bi = priority.findIndex(p => p.test(b));
    return ai - bi;
  });
  return entries.slice(0, 16).map(([path, value]) => ({ path, value: String(value).slice(0, 180) }));
}


function accountIdsFromObject(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: any) => {
    if (typeof v !== "string") return;
    const x = v.trim();
    if (!x || seen.has(x)) return;
    seen.add(x); out.push(x);
  };

  for (const [key, value] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if (/^account_?id$|^accountid$/.test(k)) push(value);
    if (/^account_?ids$|^accountids$/.test(k) && Array.isArray(value)) for (const v of value) push(v);
  }
  return out;
}

function explicitPaperProfile(raw: any): { accountIds: string[]; raw: any } | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  // Cove currently returns the authoritative paper flag inside `profile`, while
  // `accountIds` may live beside that object rather than inside it.  Treat the
  // entire get_profile response as one trust boundary instead of requiring both
  // fields to be siblings on the same object.
  const flat = flatten(raw);
  const explicitPaper = Object.entries(flat).some(([path, value]) =>
    /(^|\.)(ispaper|is_paper)$/.test(path) &&
    (value === true || String(value).trim().toLowerCase() === "true")
  );
  if (!explicitPaper) return undefined;

  const accountIds: string[] = [];
  const seen = new Set<string>();
  const push = (value: any) => {
    if (typeof value !== "string") return;
    const id = value.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    accountIds.push(id);
  };

  for (const [path, value] of Object.entries(flat)) {
    if (/(^|\.)(accountids?|account_ids?)\[\d+\]$/.test(path)) push(value);
    else if (/(^|\.)(accountid|account_id)$/.test(path)) push(value);
  }

  // Keep the old object-local extraction as a compatibility fallback for Cove
  // response shapes where IDs are not flattened under a conventional path.
  if (!accountIds.length) {
    for (const obj of collectObjects(raw)) {
      for (const id of accountIdsFromObject(obj)) push(id);
    }
  }

  return accountIds.length ? { accountIds, raw } : undefined;
}

function listedAccount(raw: any, accountId: string): { raw: any; canTrade?: boolean; canMoneyOut?: boolean; source?: string } | undefined {
  for (const obj of collectObjects(raw)) {
    if (!obj || typeof obj !== "object") continue;
    const id = idFromObject(obj);
    if (id !== accountId) continue;
    const flat = flatten(obj);
    const bool = (names: RegExp[]) => {
      const v = firstValue(flat, names);
      if (v === undefined) return undefined;
      if (v === true || String(v).toLowerCase() === "true") return true;
      if (v === false || String(v).toLowerCase() === "false") return false;
      return undefined;
    };
    return {
      raw: obj,
      canTrade: bool([/(^|\.)cantrade$/i]),
      canMoneyOut: bool([/(^|\.)canmoneyout$/i]),
      source: asString(firstValue(flat, [/(^|\.)source$/i]))
    };
  }
  return undefined;
}

function findPaperAccount(raw: any): { accountId: string; raw: any; score: number } | undefined {
  const candidates = collectObjects(raw)
    .map(obj => ({ obj, id: idFromObject(obj), score: paperScore(obj) }))
    .filter(x => x.id && x.score >= 20)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best?.id ? { accountId: best.id, raw: best.obj, score: best.score } : undefined;
}

function chooseEnum(values: any[], token?: TokenSnapshot) {
  if (!token) return undefined;
  const aliases: Record<string, Array<string | number>> = {
    robinhood: ["robinhood", "robinhood chain", "rh", 4663, "4663"],
    solana: ["solana", "sol"],
    bsc: ["bnb", "bnb chain", "bsc", 56, "56"],
    ethereum: ["ethereum", "eth", 1, "1"],
    base: ["base", 8453, "8453"],
    arbitrum: ["arbitrum", "arb", 42161, "42161"]
  };
  const wanted = aliases[token.chainId] ?? [token.chainId];
  return values.find(v => wanted.some(w => String(v).toLowerCase() === String(w).toLowerCase()));
}

function chainValue(token: TokenSnapshot, numeric: boolean, numericOverride?: number) {
  const ids: Record<string, number> = { robinhood: 4663, bsc: 56, ethereum: 1, base: 8453, arbitrum: 42161 };
  if (numeric) return numericOverride ?? ids[token.chainId] ?? token.chainId;
  const names: Record<string, string> = { robinhood: "robinhood", solana: "solana", bsc: "bnb", ethereum: "ethereum", base: "base", arbitrum: "arbitrum" };
  return names[token.chainId] ?? token.chainId;
}

function buildToolArgs(tool: McpTool, context: {
  accountId?: string;
  token?: TokenSnapshot;
  usdAmount?: number;
  orderId?: string;
  idempotencyKey?: string;
  numericChainId?: number;
}) {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const args: Record<string, any> = {};

  // Cove tools such as get_positions expose both accountId and accountIds but
  // explicitly require callers to choose ONE. Prefer the singular verified
  // Paper account whenever the schema offers it; only fall back to accountIds
  // when accountId is not available.
  const propKeys = Object.keys(props);
  const singularAccountKey = propKeys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, "") === "accountid");
  const pluralAccountKey = propKeys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, "") === "accountids");
  if (context.accountId) {
    if (singularAccountKey) args[singularAccountKey] = context.accountId;
    else if (pluralAccountKey) args[pluralAccountKey] = [context.accountId];
  }

  for (const [key, prop] of Object.entries<any>(props)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const desc = String(prop?.description ?? "").toLowerCase();
    const enums = Array.isArray(prop?.enum) ? prop.enum : undefined;

    if (enums && context.token) {
      const selected = chooseEnum(enums, context.token);
      if (selected !== undefined) { args[key] = selected; continue; }
      const usdEnum = enums.find((v: any) => /usd|usdc|dollar|quote/i.test(String(v)));
      if (context.usdAmount !== undefined && usdEnum !== undefined && /amount.*type|denom|currency|unit/.test(normalized + desc)) { args[key] = usdEnum; continue; }
    }

    // Account scope was handled above as an exclusive singular/plural choice.
    // Never let a broad description match populate the other form too.
    if (normalized === "accountid" || normalized === "accountids") continue;

    // These optional Cove execution controls are NOT token identifiers.  Older
    // generic description matching could accidentally stuff a token address or
    // another string into them.  Leave them absent unless Runner Hunter has an
    // explicit, schema-valid value to send.
    if (normalized === "surplusofferid" || normalized === "confirmhighimpact") continue;
    if (context.token && ["tokenaddress","contractaddress","address","mint","mintaddress","token"].includes(normalized)) { args[key] = context.token.tokenAddress; continue; }
    if (context.token && /token.*address|contract.*address|mint address/.test(desc)) { args[key] = context.token.tokenAddress; continue; }
    if (context.token && ["chainid","networkid"].includes(normalized)) { args[key] = chainValue(context.token, true, context.numericChainId); continue; }
    if (context.token && ["chain","network","chainname","networkname"].includes(normalized)) { args[key] = chainValue(context.token, false); continue; }
    if (context.usdAmount !== undefined && ["usdamount","amountusd","amountinusd","spendusd","spendamount","quoteamount"].includes(normalized)) { args[key] = context.usdAmount; continue; }
    if (context.usdAmount !== undefined && normalized === "amount") { args[key] = context.usdAmount; continue; }
    if (context.usdAmount !== undefined && /amount.*usd|usd.*amount|usdc.*amount|spend.*amount/.test(normalized + desc)) { args[key] = context.usdAmount; continue; }
    if (context.orderId && ["orderid","id"].includes(normalized) && /order|id/.test(desc || normalized)) { args[key] = context.orderId; continue; }
    if (context.idempotencyKey && ["idempotencykey","idempotency","clientrequestid","requestid"].includes(normalized)) { args[key] = context.idempotencyKey; continue; }
    if (context.idempotencyKey && /idempot/.test(desc)) { args[key] = context.idempotencyKey; continue; }
  }

  const missing = required.filter(k => args[k] === undefined && props[k]?.default === undefined);
  if (missing.length) throw new Error(`${tool.name} schema has unmapped required field(s): ${missing.join(", ")}. ${schemaSummary(tool)}`);
  return args;
}

async function resolveCoveNumericChainId(token: TokenSnapshot): Promise<number | undefined> {
  // EVM chains have stable numeric IDs locally. Solana does not have an EVM
  // chain ID, so ask Cove's own token metadata and reuse whatever numeric
  // network/chain identifier Cove reports for that token. This avoids guessing
  // a provider-specific Solana ID.
  const staticIds: Record<string, number> = { robinhood: 4663, bsc: 56, ethereum: 1, base: 8453, arbitrum: 42161 };
  if (staticIds[token.chainId] !== undefined) return staticIds[token.chainId];

  try {
    const infoTool = await read.findTool("get_token_info");
    if (!infoTool) return undefined;
    const raw = extractMcpContent(await read.callReadTool(infoTool.name, buildToolArgs(infoTool, { token })));
    const flat = flatten(raw);
    for (const [path, value] of Object.entries(flat)) {
      if (!/(^|\.)(chainid|chain_id|networkid|network_id)$/.test(path)) continue;
      const n = asNumber(value);
      if (n !== undefined && Number.isInteger(n)) return n;
    }
  } catch (e: any) {
    console.warn(`[CoveBroker] could not resolve numeric Cove chain ID for ${token.chainId}:${token.symbol}: ${e?.message ?? String(e)}`);
  }
  return undefined;
}

function compactIdempotencyKey(side: "BUY" | "SELL") {
  // Cove requires 8-64 chars and only [A-Za-z0-9_-]. UUID hex is ideal and
  // avoids embedding long token addresses (especially Solana mints).
  return `rh_${side.toLowerCase()}_${randomUUID().replace(/-/g, "")}`;
}

function parseBalance(raw: any): BrokerBalance {
  const flat = flatten(raw);
  const cash = asNumber(firstValue(flat, [/(available|cash|spendable).*usdc/, /usdc.*(available|cash|balance)/, /(^|\.)cashusd$/, /(^|\.)balance$/]));
  const equity = asNumber(firstValue(flat, [/(total|equity|portfolio).*usd/, /(^|\.)equityusd$/, /net.*value/])) ?? cash;
  if (cash === undefined) throw new Error(`Cove get_balance returned an unfamiliar shape; enable COVE_MCP_DEBUG=true and retry /portfolio`);
  return { cashUsd: cash, equityUsd: equity ?? cash };
}

function candidatePositionObjects(raw: any): any[] {
  const directArrays: any[][] = [];
  const visit = (v: any, key = "") => {
    if (Array.isArray(v)) {
      if (/position|holding|asset|token/i.test(key)) directArrays.push(v);
      for (const x of v) visit(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, k);
    }
  };
  visit(raw);
  const source = directArrays.sort((a,b) => b.length-a.length)[0];
  return source?.filter(x => x && typeof x === "object") ?? [];
}

function parsePositions(raw: any): Position[] {
  const objects = candidatePositionObjects(raw);
  return objects.map((obj): Position | undefined => {
    const flat = flatten(obj);
    const tokenAddress = asString(firstValue(flat, [/token.*address$/, /contract.*address$/, /mint.*address$/, /(^|\.)address$/]));
    const symbol = asString(firstValue(flat, [/symbol$/])) ?? "?";
    const quantity = asNumber(firstValue(flat, [/quantity$/, /token.*amount$/, /(^|\.)amount$/, /balance$/]));
    const currentPriceUsd = asNumber(firstValue(flat, [/current.*price/, /price.*usd/, /usd.*price/, /mark.*price/])) ?? 0;
    const costUsd = asNumber(firstValue(flat, [/cost.*usd/, /cost.*basis/, /invested/, /entry.*value/])) ?? 0;
    const entryPriceUsd = asNumber(firstValue(flat, [/entry.*price/, /average.*price/, /avg.*price/])) ?? (quantity && costUsd ? costUsd / quantity : currentPriceUsd);
    const chainId = asString(firstValue(flat, [/chain.*name$/, /network.*name$/, /(^|\.)chain$/]));
    if (!tokenAddress || quantity === undefined || quantity <= 0) return undefined;
    return { tokenAddress, chainId, symbol, quantity, entryPriceUsd, currentPriceUsd, costUsd, openedAt: new Date().toISOString() };
  }).filter((x): x is Position => Boolean(x));
}


function findExactContinuation(raw: any): Record<string, any> | undefined {
  const preferredKeys = new Set([
    "continuation", "continuationargs", "continuationarguments", "singlewalletcontinuation",
    "nextargs", "nextarguments", "arguments", "args"
  ]);

  const candidates: Record<string, any>[] = [];
  const visit = (value: any, parentKey = "") => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const keys = Object.keys(value);
      const normalizedParent = parentKey.toLowerCase().replace(/[^a-z0-9]/g, "");
      const looksLikeArgs = keys.some(k => /accountids|tokenaddress|chainid|amountusd|idempotencykey|surplusofferid|confirmimpactpromptids|confirmhighimpact|maxsurplususd|transactiondelayms/i.test(k));
      if (preferredKeys.has(normalizedParent) || looksLikeArgs) candidates.push(value as Record<string, any>);
      for (const [k, v] of Object.entries(value)) visit(v, k);
    } else {
      for (const v of value) visit(v, parentKey);
    }
  };
  visit(raw);

  return candidates.find(obj => {
    const keys = new Set(Object.keys(obj).map(k => k.toLowerCase().replace(/[^a-z0-9]/g, "")));
    return keys.has("accountids") && keys.has("tokenaddress") && keys.has("chainid") && keys.has("idempotencykey");
  });
}

function validateContinuation(args: Record<string, any>, expected: { accountId: string; token: TokenSnapshot; maxUsd: number }) {
  const accountIds = args.accountIds ?? args.accountids;
  if (!Array.isArray(accountIds) || accountIds.length !== 1 || accountIds[0] !== expected.accountId) {
    throw new Error("Cove continuation did not target exactly the verified Paper account. Writes remain blocked.");
  }
  const tokenAddress = args.tokenAddress ?? args.tokenaddress;
  if (typeof tokenAddress !== "string" || tokenAddress.toLowerCase() !== expected.token.tokenAddress.toLowerCase()) {
    throw new Error("Cove continuation token address did not match the requested token. Writes remain blocked.");
  }
  const amountUsd = asNumber(args.amountUsd ?? args.amountusd);
  if (amountUsd !== undefined && (amountUsd <= 0 || amountUsd > expected.maxUsd || amountUsd > config.maxTradeUsd)) {
    throw new Error("Cove continuation amount exceeded the approved Paper trade size. Writes remain blocked.");
  }
  for (const k of Object.keys(args)) {
    if (/provider/i.test(k)) throw new Error("Cove continuation contained a provider override; Runner Hunter will not submit it.");
    if (/withdraw|transfer|payout|moneyout/i.test(k)) throw new Error("Cove continuation contained a forbidden money-out field; writes remain blocked.");
  }
}

function parseTrade(raw: any, token: TokenSnapshot, usdAmount: number, side: "BUY" | "SELL"): BrokerTradeResult {
  const flat = flatten(raw);
  const id = asString(firstValue(flat, [/order.*id$/, /transaction.*id$/, /trade.*id$/, /(^|\.)id$/])) ?? randomUUID();
  const price = asNumber(firstValue(flat, [/fill.*price/, /execution.*price/, /price.*usd/, /(^|\.)price$/])) ?? token.priceUsd;
  const actualUsd = asNumber(firstValue(flat, [/usd.*amount/, /amount.*usd/, /quote.*amount/, /filled.*value/])) ?? usdAmount;
  return { id, mode: "cove-paper", side, tokenAddress: token.tokenAddress, symbol: token.symbol, usdAmount: actualUsd, priceUsd: price, timestamp: new Date().toISOString() };
}

export class CoveBroker implements Broker {
  private paperAccountId?: string;
  private accountChecked = false;

  private async paperAccount(): Promise<string> {
    if (this.paperAccountId) return this.paperAccountId;
    if (!read.configured()) throw new Error("COVE_READ_TOKEN is missing");
    if (!write.configured()) throw new Error("COVE_WRITE_TOKEN is missing. cove-paper mode requires a read-write token.");

    const observations: Array<{ client: string; tool: string; raw: any }> = [];
    for (const [clientName, client] of [["read", read], ["read-write", write]] as const) {
      for (const toolName of ["list_accounts", "get_profile"] as const) {
        const tool = await client.findTool(toolName);
        if (!tool) continue;
        try {
          const raw = extractMcpContent(await client.callReadTool(tool.name, buildToolArgs(tool, {})));
          observations.push({ client: clientName, tool: toolName, raw });
        } catch (e: any) {
          console.warn(`[CoveBroker] ${clientName} ${toolName} probe failed: ${e?.message ?? String(e)}`);
        }
      }
    }

    const readProfileRaw = observations.find(x => x.client === "read" && x.tool === "get_profile")?.raw;
    const writeProfileRaw = observations.find(x => x.client === "read-write" && x.tool === "get_profile")?.raw;
    const writeAccountsRaw = observations.find(x => x.client === "read-write" && x.tool === "list_accounts")?.raw;

    const readPaper = explicitPaperProfile(readProfileRaw);
    const writePaper = explicitPaperProfile(writeProfileRaw);
    const readId = readPaper?.accountIds[0];
    const writeId = writePaper?.accountIds[0];
    const writeListed = writeId && writeAccountsRaw ? listedAccount(writeAccountsRaw, writeId) : undefined;

    this.accountChecked = true;
    const samePaperAccount = Boolean(readId && writeId && readId === writeId);
    const writeCanTrade = writeListed?.canTrade === true;
    const moneyOutSafe = writeListed?.canMoneyOut !== true;
    const paperSourceSafe = !writeListed?.source || writeListed.source.toLowerCase() === "paper";

    if (!samePaperAccount || !writeCanTrade || !moneyOutSafe || !paperSourceSafe) {
      throw new Error("Runner Hunter could not authoritatively verify matching Cove PAPER credentials (isPaper=true on both profiles, same account ID, write canTrade=true, money-out disabled). Writes remain blocked. Run /cove for diagnostics.");
    }

    this.paperAccountId = writeId!;
    console.log(`[CoveBroker] PAPER account authoritatively verified via both credentials: ${this.paperAccountId}`);
    return this.paperAccountId;
  }

  async getBalance(): Promise<BrokerBalance> {
    const accountId = await this.paperAccount();
    const tool = await read.findTool("get_balance");
    if (!tool) throw new Error("Cove does not expose get_balance");
    const raw = extractMcpContent(await read.callReadTool(tool.name, buildToolArgs(tool, { accountId })));
    return parseBalance(raw);
  }

  async getPositions(): Promise<Position[]> {
    const accountId = await this.paperAccount();
    const tool = await read.findTool("get_positions");
    if (!tool) throw new Error("Cove does not expose get_positions");
    const raw = extractMcpContent(await read.callReadTool(tool.name, buildToolArgs(tool, { accountId })));
    return parsePositions(raw);
  }

  private async marketOrder(side: "BUY" | "SELL", token: TokenSnapshot, usdAmount: number): Promise<BrokerTradeResult> {
    const accountId = await this.paperAccount();
    if (usdAmount <= 0) throw new Error("Trade amount must be greater than zero");
    if (usdAmount > config.maxTradeUsd) throw new Error(`Trade amount exceeds MAX_TRADE_USD ($${config.maxTradeUsd})`);

    const tool = await write.findTool(side === "BUY" ? "buy_token" : "sell_token");
    if (!tool) throw new Error(`Cove does not expose ${side === "BUY" ? "buy_token" : "sell_token"}`);
    const idempotencyKey = compactIdempotencyKey(side);
    const numericChainId = await resolveCoveNumericChainId(token);
    const chainProp = Object.entries<any>(tool.inputSchema?.properties ?? {}).find(([k]) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === "chainid")?.[1];
    if (chainProp?.type === "number" && numericChainId === undefined) {
      throw new Error(`Cove buy/sell schema requires a numeric chainId, but Cove token metadata did not provide one for ${token.chainId}. Writes remain blocked.`);
    }
    const args = buildToolArgs(tool, { accountId, token, usdAmount, idempotencyKey, numericChainId });
    let raw: any;
    try {
      raw = extractMcpContent(await write.callPaperWriteTool(tool.name, args));
    } catch (e: any) {
      if (!(e instanceof CoveToolError)) throw e;

      const continuation = findExactContinuation(e.rawResult);
      if (!continuation) {
        if (config.coveMcpDebug) {
          const safe = sanitizeDiagnosticValue(e.rawResult);
          console.log(`[CoveBroker] buy/sell offer rejection raw=${JSON.stringify(safe).slice(0, 5000)}`);
        }
        throw new Error(`${e.message}. Cove referenced an offer continuation, but no exact continuation arguments were present in the MCP result. Enable COVE_MCP_DEBUG=true and capture the sanitized raw offer/rejection line.`);
      }

      validateContinuation(continuation, { accountId, token, maxUsd: usdAmount });
      if (continuation.confirmHighImpact !== undefined || continuation.confirmImpactPromptIds !== undefined) {
        throw new Error("Cove returned a continuation requiring explicit high-impact confirmation. Runner Hunter will not auto-confirm price-impact prompts.");
      }

      if (config.coveMcpDebug) console.log(`[CoveBroker] submitting exact Cove single-wallet continuation keys=${Object.keys(continuation).join(",")}`);
      raw = extractMcpContent(await write.callPaperWriteTool(tool.name, continuation));
    }
    const trade = parseTrade(raw, token, usdAmount, side);
    console.log(`[CoveBroker] PAPER ${side} submitted ${token.chainId}:${token.symbol} $${usdAmount.toFixed(2)} order=${trade.id}`);

    // Best-effort reconciliation. Failure here does not resubmit the order.
    try {
      const reconcile = await write.findTool("reconcile_market_order");
      if (reconcile && trade.id) {
        const recArgs = buildToolArgs(reconcile, { accountId, token, orderId: trade.id, idempotencyKey });
        const rec = extractMcpContent(await write.callPaperWriteTool(reconcile.name, recArgs));
        if (config.coveMcpDebug) console.log(`[CoveBroker] reconcile result=${JSON.stringify(rec).slice(0, 1000)}`);
      }
    } catch (e: any) {
      console.warn(`[CoveBroker] order ${trade.id} submitted; reconciliation unavailable: ${e?.message ?? String(e)}`);
    }
    return trade;
  }

  async buy(token: TokenSnapshot, usdAmount: number): Promise<BrokerTradeResult> {
    return this.marketOrder("BUY", token, usdAmount);
  }

  async sell(token: TokenSnapshot, usdAmount?: number): Promise<BrokerTradeResult> {
    if (usdAmount === undefined) throw new Error("Cove paper sell requires an explicit USD amount in v0.5.10");
    return this.marketOrder("SELL", token, usdAmount);
  }

  async getPaperAccountStatus() {
    try {
      const accountId = await this.paperAccount();
      return { ok: true as const, accountId, checked: this.accountChecked };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e), checked: this.accountChecked };
    }
  }

  async getPaperAccountDiagnostics() {
    const clients = [
      { label: "READ TOKEN", client: read, configured: read.configured() },
      { label: "READ-WRITE TOKEN", client: write, configured: write.configured() }
    ] as const;

    const sources: Array<{
      credential: string;
      source: string;
      paperScore: number;
      detectedAccountId?: string;
      fields: Array<{ path: string; value: string }>;
      preview: any;
    }> = [];

    for (const entry of clients) {
      if (!entry.configured) {
        sources.push({ credential: entry.label, source: "configuration", paperScore: 0, fields: [], preview: "credential not configured" });
        continue;
      }
      for (const toolName of ["list_accounts", "get_profile"] as const) {
        try {
          const tool = await entry.client.findTool(toolName);
          if (!tool) {
            sources.push({ credential: entry.label, source: toolName, paperScore: 0, fields: [], preview: "tool not exposed" });
            continue;
          }
          const raw = extractMcpContent(await entry.client.callReadTool(tool.name, buildToolArgs(tool, {})));
          const found = findPaperAccount(raw);
          const score = Math.max(-100, ...collectObjects(raw).map(paperScore));
          const preview = sanitizeDiagnosticValue(raw);
          sources.push({ credential: entry.label, source: toolName, paperScore: score, detectedAccountId: found?.accountId, fields: diagnosticFields(preview), preview });
          if (config.coveMcpDebug) console.log(`[CoveBroker diagnostic:${entry.label}] ${toolName}=${JSON.stringify(preview).slice(0, 5000)}`);
        } catch (e: any) {
          sources.push({ credential: entry.label, source: toolName, paperScore: 0, fields: [], preview: `error: ${e?.message ?? String(e)}` });
        }
      }
    }

    const detected = sources
      .filter(x => x.detectedAccountId)
      .sort((a, b) => b.paperScore - a.paperScore)[0];

    const rawBy = (credential: string, source: string) =>
      sources.find(x => x.credential === credential && x.source === source)?.preview;
    const readPaper = explicitPaperProfile(rawBy("READ TOKEN", "get_profile"));
    const writePaper = explicitPaperProfile(rawBy("READ-WRITE TOKEN", "get_profile"));
    const authoritativeAccountId = readPaper?.accountIds[0] && writePaper?.accountIds[0] && readPaper.accountIds[0] === writePaper.accountIds[0]
      ? readPaper.accountIds[0]
      : undefined;
    const writeListed = authoritativeAccountId ? listedAccount(rawBy("READ-WRITE TOKEN", "list_accounts"), authoritativeAccountId) : undefined;
    const authoritativeOk = Boolean(
      authoritativeAccountId &&
      writeListed?.canTrade === true &&
      writeListed?.canMoneyOut !== true &&
      (!writeListed?.source || writeListed.source.toLowerCase() === "paper")
    );

    // Expose whether both credentials appear to resolve to the same account/profile.
    const accountIds = new Set<string>();
    for (const source of sources) {
      for (const field of source.fields) {
        if (/accountids?\[?0?\]?|accountid/i.test(field.path) && field.value) accountIds.add(field.value);
      }
    }

    return {
      ok: authoritativeOk,
      accountId: authoritativeAccountId,
      sources,
      observedAccountIds: [...accountIds],
      verification: {
        readIsPaper: Boolean(readPaper),
        writeIsPaper: Boolean(writePaper),
        matchingAccount: Boolean(authoritativeAccountId),
        writeCanTrade: writeListed?.canTrade === true,
        moneyOutDisabled: writeListed?.canMoneyOut !== true,
        accountSource: writeListed?.source ?? "unknown"
      }
    };
  }
}
