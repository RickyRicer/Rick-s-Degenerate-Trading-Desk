import type { BrokerBalance, BrokerTradeResult, Position, TokenSnapshot } from "../types/index.js";

export interface Broker {
  getBalance(): Promise<BrokerBalance>;
  getPositions(): Promise<Position[]>;
  buy(token: TokenSnapshot, usdAmount: number): Promise<BrokerTradeResult>;
  sell(token: TokenSnapshot, usdAmount?: number): Promise<BrokerTradeResult>;
}
