import type { Broker } from "./Broker.js";
import type { BrokerBalance, BrokerTradeResult, Position, TokenSnapshot } from "../types/index.js";

// Placeholder adapter. Once Cove MCP access is approved, we will map their
// authenticated MCP tools into this interface without changing the bot/agent code.
export class CoveBroker implements Broker {
  async getBalance(): Promise<BrokerBalance> {
    throw new Error("Cove MCP adapter not configured yet");
  }
  async getPositions(): Promise<Position[]> {
    throw new Error("Cove MCP adapter not configured yet");
  }
  async buy(_token: TokenSnapshot, _usdAmount: number): Promise<BrokerTradeResult> {
    throw new Error("Cove MCP adapter not configured yet");
  }
  async sell(_token: TokenSnapshot, _usdAmount?: number): Promise<BrokerTradeResult> {
    throw new Error("Cove MCP adapter not configured yet");
  }
}
