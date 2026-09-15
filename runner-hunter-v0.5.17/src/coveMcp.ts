import { config } from "./config.js";

export type McpTool = { name: string; description?: string; inputSchema?: any };

export class CoveToolError extends Error {
  rawResult: any;
  constructor(message: string, rawResult: any) {
    super(message);
    this.name = "CoveToolError";
    this.rawResult = rawResult;
  }
}
type RpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
  method?: string;
  params?: any;
};

const HARD_DENY_TOOLS = new Set([
  "request_payout",
  "withdraw_usdc",
  "withdraw_token",
  "transfer_usdc",
  "transfer_token"
]);

const READ_ONLY_TOOL_ALLOW = new Set([
  "get_balance",
  "get_positions",
  "get_order_status",
  "get_trading_history",
  "get_token_info",
  "get_token_security_report",
  "get_limit_orders",
  "get_settings",
  "get_earnings",
  "get_deposit_addresses",
  "get_profile",
  "list_accounts",
  "search_tokens",
  "export_trades",
  "sync_positions"
]);

// Deliberately narrow: no settings changes, transfers, withdrawals, payouts, or live-wallet controls.
const PAPER_WRITE_TOOL_ALLOW = new Set([
  "buy_token",
  "sell_token",
  "create_limit_buy",
  "create_stop_loss",
  "create_take_profit",
  "create_trailing_stop",
  "create_dca_ladder",
  "cancel_limit_order",
  "cancel_limit_orders",
  "cancel_dca_group",
  "update_limit_order",
  "get_order_status",
  "reconcile_market_order"
]);

function parseJsonMaybe(value: string): any | undefined {
  try { return JSON.parse(value); } catch { return undefined; }
}

function parseRpcMessages(text: string): RpcResponse[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const direct = parseJsonMaybe(trimmed);
  if (direct !== undefined) return Array.isArray(direct) ? direct : [direct];

  const messages: RpcResponse[] = [];
  const events = trimmed.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
    if (!dataLines.length) continue;
    const combined = dataLines.join("\n");
    const parsed = parseJsonMaybe(combined);
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) messages.push(...parsed); else messages.push(parsed);
      continue;
    }
    for (const line of dataLines) {
      const item = parseJsonMaybe(line);
      if (item !== undefined) messages.push(item);
    }
  }
  return messages;
}

function summarizeBody(text: string) { return text.replace(/\s+/g, " ").slice(0, 300); }

export function schemaSummary(tool: McpTool): string {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return `${tool.name}(${props.join(", ") || "no args"})${required.length ? ` required=[${required.join(", ")}]` : ""}`;
}

export class CoveMcpClient {
  private endpoint = config.coveMcpUrl;
  private token: string;
  private access: "read" | "paper-write";
  private sessionId?: string;
  private protocolVersion?: string;
  private serverInfo?: { name?: string; version?: string };
  private initialized = false;
  private toolsCache?: McpTool[];
  private clientVersion: string;

  constructor(options: { token?: string; access?: "read" | "paper-write"; clientVersion?: string } = {}) {
    this.access = options.access ?? "read";
    this.token = options.token ?? (this.access === "paper-write" ? config.coveWriteToken : config.coveReadToken);
    this.clientVersion = options.clientVersion ?? "0.5.10";
  }

  configured() { return Boolean(this.token); }
  getMetadata() {
    return { endpoint: this.endpoint, protocolVersion: this.protocolVersion, sessionIdPresent: Boolean(this.sessionId), serverInfo: this.serverInfo, access: this.access };
  }

  private headers(afterInitialize = true): Record<string, string> {
    if (!this.token) throw new Error(this.access === "paper-write" ? "COVE_WRITE_TOKEN is missing" : "COVE_READ_TOKEN is missing");
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (afterInitialize && this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return headers;
  }

  private async rpc(method: string, params?: any, options: { initialization?: boolean } = {}): Promise<any> {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(!options.initialization),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    const messages = parseRpcMessages(text);
    const matching = messages.find(msg => String(msg?.id) === String(id));
    const payload: any = matching ?? (messages.length === 1 ? messages[0] : undefined);
    if (!res.ok) {
      const detail = payload?.error?.message ?? summarizeBody(text) ?? "request failed";
      throw new Error(`Cove MCP HTTP ${res.status}: ${detail}`);
    }
    if (!payload) throw new Error(`Cove MCP ${method} returned no JSON-RPC response for request ${id}. content-type=${res.headers.get("content-type") ?? "unknown"}`);
    if (payload?.error) throw new Error(`Cove MCP ${payload.error.code ?? "error"}: ${payload.error.message ?? "request failed"}`);
    return payload?.result ?? payload;
  }

  private async notification(method: string, params?: any) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cove MCP notification ${method} HTTP ${res.status}: ${summarizeBody(text)}`);
    }
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: `runner-hunter-${this.access}`, version: this.clientVersion }
    }, { initialization: true });
    this.protocolVersion = typeof result?.protocolVersion === "string" ? result.protocolVersion : "2025-06-18";
    this.serverInfo = result?.serverInfo;
    await this.notification("notifications/initialized");
    this.initialized = true;
    console.log(`[Cove MCP:${this.access}] initialized protocol=${this.protocolVersion} session=${this.sessionId ? "yes" : "no"} server=${this.serverInfo?.name ?? "unknown"}${this.serverInfo?.version ? `@${this.serverInfo.version}` : ""}`);
  }

  async listTools(): Promise<McpTool[]> {
    if (this.toolsCache) return this.toolsCache;
    await this.initialize();
    const result = await this.rpc("tools/list", {});
    const tools = Array.isArray(result?.tools) ? result.tools : Array.isArray(result) ? result : Array.isArray(result?.data?.tools) ? result.data.tools : undefined;
    if (!tools) {
      const keys = result && typeof result === "object" ? Object.keys(result).join(",") : typeof result;
      throw new Error(`Cove MCP tools/list returned an unexpected result shape (${keys || "empty"})`);
    }
    const cache: McpTool[] = tools.filter((t: any) => t && typeof t.name === "string");
    this.toolsCache = cache;
    console.log(`[Cove MCP:${this.access}] tools/list returned ${cache.length} tools: ${cache.map(t => t.name).join(", ") || "none"}`);
    if (config.coveMcpDebug) for (const tool of cache) console.log(`[Cove MCP:${this.access} schema] ${schemaSummary(tool)}`);
    return cache;
  }

  async findTool(...names: string[]) {
    const tools = await this.listTools();
    const wanted = new Set(names.map(n => n.toLowerCase()));
    return tools.find(t => wanted.has(t.name.toLowerCase()));
  }

  private async callAllowedTool(name: string, args: Record<string, any>, allow: Set<string>) {
    const normalized = name.toLowerCase();
    if (HARD_DENY_TOOLS.has(normalized)) throw new Error(`Cove tool '${name}' is hard-denied by Runner Hunter`);
    if (!allow.has(normalized)) throw new Error(`Cove tool '${name}' is not allowed for ${this.access}`);
    await this.initialize();
    if (config.coveMcpDebug) console.log(`[Cove MCP:${this.access} call] ${name} args=${JSON.stringify(args)}`);
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result?.isError === true) {
      const content = extractMcpContent(result);
      throw new CoveToolError(`Cove tool '${name}' returned an error: ${typeof content === "string" ? content : JSON.stringify(content).slice(0, 700)}`, result);
    }
    return result;
  }

  async callReadTool(name: string, args: Record<string, any> = {}) {
    return this.callAllowedTool(name, args, READ_ONLY_TOOL_ALLOW);
  }

  async callPaperWriteTool(name: string, args: Record<string, any> = {}) {
    if (this.access !== "paper-write") throw new Error("Paper write call attempted with a read-only Cove client");
    return this.callAllowedTool(name, args, PAPER_WRITE_TOOL_ALLOW);
  }

  getSafetySummary() {
    return {
      hardDenied: [...HARD_DENY_TOOLS].sort(),
      readAllowed: [...READ_ONLY_TOOL_ALLOW].sort(),
      paperWriteAllowed: [...PAPER_WRITE_TOOL_ALLOW].sort()
    };
  }
}

export function extractMcpContent(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const content = result?.content;
  if (!Array.isArray(content)) return result;
  const values = content.map((item: any) => {
    if (item?.type === "text" && typeof item.text === "string") {
      try { return JSON.parse(item.text); } catch { return item.text; }
    }
    return item?.structuredContent ?? item?.json ?? item;
  });
  return values.length === 1 ? values[0] : values;
}
