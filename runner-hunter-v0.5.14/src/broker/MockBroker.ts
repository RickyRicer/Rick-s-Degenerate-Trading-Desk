import { randomUUID } from "node:crypto";
import type { Broker } from "./Broker.js";
import type { BrokerBalance, BrokerTradeResult, Position, TokenSnapshot } from "../types/index.js";
import { config } from "../config.js";

export class MockBroker implements Broker {
  private cash = config.startingCashUsd;
  private positions = new Map<string, Position>();

  private key(token: TokenSnapshot) { return `${token.chainId}:${token.tokenAddress}`.toLowerCase(); }

  async getBalance(): Promise<BrokerBalance> {
    const positionValue = [...this.positions.values()].reduce((sum, p) => sum + p.quantity * p.currentPriceUsd, 0);
    return { cashUsd: this.cash, equityUsd: this.cash + positionValue };
  }

  async getPositions(): Promise<Position[]> { return [...this.positions.values()]; }

  async buy(token: TokenSnapshot, usdAmount: number): Promise<BrokerTradeResult> {
    if (usdAmount > this.cash) throw new Error("Insufficient mock cash");
    const quantity = usdAmount / token.priceUsd;
    const key = this.key(token);
    const existing = this.positions.get(key);
    if (existing) {
      const oldCost = existing.quantity * existing.entryPriceUsd;
      const newQty = existing.quantity + quantity;
      existing.entryPriceUsd = (oldCost + usdAmount) / newQty;
      existing.quantity = newQty;
      existing.costUsd += usdAmount;
      existing.currentPriceUsd = token.priceUsd;
    } else {
      this.positions.set(key, {
        tokenAddress: token.tokenAddress,
        chainId: token.chainId,
        symbol: token.symbol,
        quantity,
        entryPriceUsd: token.priceUsd,
        currentPriceUsd: token.priceUsd,
        costUsd: usdAmount,
        openedAt: new Date().toISOString()
      });
    }
    this.cash -= usdAmount;
    return { id: randomUUID(), mode: "mock", side: "BUY", tokenAddress: token.tokenAddress, symbol: token.symbol, usdAmount, priceUsd: token.priceUsd, timestamp: new Date().toISOString() };
  }

  async sell(token: TokenSnapshot, usdAmount?: number): Promise<BrokerTradeResult> {
    const key = this.key(token);
    const p = this.positions.get(key);
    if (!p) throw new Error("No open position");
    p.currentPriceUsd = token.priceUsd;
    const positionValue = p.quantity * token.priceUsd;
    const sellUsd = Math.min(usdAmount ?? positionValue, positionValue);
    const qtyToSell = sellUsd / token.priceUsd;
    p.quantity -= qtyToSell;
    this.cash += sellUsd;
    if (p.quantity <= 1e-12) this.positions.delete(key);
    return { id: randomUUID(), mode: "mock", side: "SELL", tokenAddress: token.tokenAddress, symbol: token.symbol, usdAmount: sellUsd, priceUsd: token.priceUsd, timestamp: new Date().toISOString() };
  }
}
