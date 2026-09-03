export type Decision = "BUY" | "WATCH" | "IGNORE";

export interface TokenSnapshot {
  chainId: string;
  dexId?: string;
  pairAddress?: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5m: number;
  hasVolume5m: boolean;
  volume1h: number;
  volume24h: number;
  marketCap: number;
  buys5m: number;
  sells5m: number;
  hasTxns5m: boolean;
  buys1h: number;
  sells1h: number;
  priceChange5m: number;
  hasPriceChange5m: boolean;
  priceChange1h: number;
  pairCreatedAt?: number;
  url?: string;
  runnerScore?: number;
  runnerSignals?: string[];
}

export interface TradeIntent {
  analysisSource?: "AI" | "AUTO";
  decision: Decision;
  confidence: number;
  score: number;
  suggestedUsd: number;
  reasons: string[];
  riskFlags: string[];
}

export interface Position {
  tokenAddress: string;
  chainId?: string;
  symbol: string;
  quantity: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  costUsd: number;
  openedAt: string;
}

export interface BrokerBalance {
  cashUsd: number;
  equityUsd: number;
}

export interface BrokerTradeResult {
  id: string;
  mode: "mock" | "cove-paper" | "cove-live";
  side: "BUY" | "SELL";
  tokenAddress: string;
  symbol: string;
  usdAmount: number;
  priceUsd: number;
  timestamp: string;
}
