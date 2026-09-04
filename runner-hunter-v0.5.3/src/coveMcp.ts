import { config } from "./config.js";

type McpTool = { name: string; description?: string; inputSchema?: any };
type RpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
  method?: string;
  params?: any;
};

function parseJsonMaybe(value: string): any | undefined {
  try { return JSON.parse(value); } catch { return undefined; }
}

/**
 * Streamable HTTP can answer with either application/json or an SSE stream.
 * Parse every JSON-RPC message we can find instead of assuming the final data:
 * line is the response to our request.
 */
function parseRpcMessages(text: string): RpcResponse[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const direct = parseJsonMaybe(trimmed);
  if (direct !== undefined) return Array.isArray(direct) ? direct : [direct];

  const messages: RpcResponse[] = [];
  const events = trimmed.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim());
    if (!dataLines.length) continue;

    // SSE permits a single data field to span multiple lines.
    const combined = dataLines.join("\n");
    const parsed = parseJsonMaybe(combined);
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
      continue;
    }

    // Some servers emit one complete JSON value per data line.
    for (const line of dataLines) {
      const item = parseJsonMaybe(line);
      if (item !== undefined) messages.push(item);
    }
  }
  return messages;
}

function summarizeBody(text: string) {
  return text.replace(/\s+/g, " ").slice(0, 300);
}

export class CoveMcpClient {
  private endpoint = config.coveMcpUrl;
  private readToken = config.coveReadToken;
  private sessionId?: string;
  private protocolVersion?: string;
  private serverInfo?: { name?: string; version?: string };
  private initialized = false;
  private toolsCache?: McpTool[];

  configured() { return Boolean(this.readToken); }

  getMetadata() {
    return {
      endpoint: this.endpoint,
      protocolVersion: this.protocolVersion,
      sessionIdPresent: Boolean(this.sessionId),
      serverInfo: this.serverInfo
    };
  }

  private headers(afterInitialize = true): Record<string, string> {
    if (!this.readToken) throw new Error("COVE_READ_TOKEN is missing");
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.readToken}`,
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
    if (!payload) {
      throw new Error(`Cove MCP ${method} returned no JSON-RPC response for request ${id}. content-type=${res.headers.get("content-type") ?? "unknown"}`);
    }
    if (payload?.error) throw new Error(`Cove MCP ${payload.error.code ?? "error"}: ${payload.error.message ?? "request failed"}`);
    return payload?.result ?? payload;
  }

  private async notification(method: string, params?: any) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })
    });
    // Per MCP, accepted notifications normally return 202 with no body.
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
      clientInfo: { name: "runner-hunter", version: "0.5.3" }
    }, { initialization: true });

    this.protocolVersion = typeof result?.protocolVersion === "string" ? result.protocolVersion : "2025-06-18";
    this.serverInfo = result?.serverInfo;

    // Unlike v0.5.2, do not silently swallow this. If the lifecycle handshake is
    // incomplete, tools/list can produce misleading results.
    await this.notification("notifications/initialized");
    this.initialized = true;

    console.log(
      `[Cove MCP] initialized protocol=${this.protocolVersion}` +
      ` session=${this.sessionId ? "yes" : "no"}` +
      ` server=${this.serverInfo?.name ?? "unknown"}${this.serverInfo?.version ? `@${this.serverInfo.version}` : ""}`
    );
  }

  async listTools(): Promise<McpTool[]> {
    if (this.toolsCache) return this.toolsCache;
    await this.initialize();
    const result = await this.rpc("tools/list", {});

    // Standard MCP result is { tools: [...] }. Keep a couple of defensive fallbacks
    // for provider wrappers, but never silently turn an unrecognized shape into [].
    const tools = Array.isArray(result?.tools)
      ? result.tools
      : Array.isArray(result)
        ? result
        : Array.isArray(result?.data?.tools)
          ? result.data.tools
          : undefined;

    if (!tools) {
      const keys = result && typeof result === "object" ? Object.keys(result).join(",") : typeof result;
      throw new Error(`Cove MCP tools/list returned an unexpected result shape (${keys || "empty"})`);
    }

    const cache: McpTool[] = tools.filter((t: any) => t && typeof t.name === "string");
    this.toolsCache = cache;
    console.log(`[Cove MCP] tools/list returned ${cache.length} tools: ${cache.map(t => t.name).join(", ") || "none"}`);
    return cache;
  }

  async callTool(name: string, args: Record<string, any> = {}) {
    await this.initialize();
    return this.rpc("tools/call", { name, arguments: args });
  }

  async findTool(...names: string[]) {
    const tools = await this.listTools();
    const wanted = new Set(names.map(n => n.toLowerCase()));
    return tools.find(t => wanted.has(t.name.toLowerCase()));
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
