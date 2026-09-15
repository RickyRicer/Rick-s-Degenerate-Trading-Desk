import type { TokenSnapshot } from "../types/index.js";

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

export function pairAgeMinutes(token: TokenSnapshot, now = Date.now()): number | undefined {
  if (!token.pairCreatedAt || token.pairCreatedAt <= 0) return undefined;
  return Math.max(0, (now - token.pairCreatedAt) / 60000);
}

export function scoreRunner(token: TokenSnapshot): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  const ageMin = pairAgeMinutes(token);

  if (ageMin !== undefined) {
    if (ageMin <= 15) { score += 20; signals.push("very new pair"); }
    else if (ageMin <= 60) { score += 17; signals.push("new pair under 1h"); }
    else if (ageMin <= 360) { score += 13; signals.push("pair under 6h"); }
    else if (ageMin <= 1440) { score += 9; signals.push("pair under 24h"); }
    else if (ageMin <= 4320) score += 4;
  }

  const mc = token.marketCap;
  if (mc > 0 && mc < 100_000) score += 5;
  else if (mc <= 2_000_000) { score += 15; signals.push("early market-cap range"); }
  else if (mc <= 10_000_000) { score += 10; signals.push("small-cap range"); }
  else if (mc <= 25_000_000) score += 6;

  const liqToMc = mc > 0 ? token.liquidityUsd / mc : 0;
  if (liqToMc >= 0.10) { score += 14; signals.push("strong liquidity vs market cap"); }
  else if (liqToMc >= 0.05) { score += 10; signals.push("healthy liquidity ratio"); }
  else if (liqToMc >= 0.02) score += 6;

  const volToLiq = token.liquidityUsd > 0 ? token.volume1h / token.liquidityUsd : 0;
  if (volToLiq >= 0.5 && volToLiq <= 5) { score += 15; signals.push("strong 1h turnover"); }
  else if (volToLiq > 5) { score += 10; signals.push("extreme 1h turnover"); }
  else if (volToLiq >= 0.2) score += 8;

  const buyRatio = token.sells1h > 0
    ? token.buys1h / token.sells1h
    : token.buys1h > 10 ? 9 : 1;
  if (buyRatio >= 2) { score += 12; signals.push("heavy 1h buy pressure"); }
  else if (buyRatio >= 1.4) { score += 9; signals.push("positive 1h buy pressure"); }
  else if (buyRatio >= 1.1) score += 5;
  else if (buyRatio < 0.7) score -= 6;

  const tx1h = token.buys1h + token.sells1h;
  if (tx1h >= 500) { score += 10; signals.push("high transaction velocity"); }
  else if (tx1h >= 150) score += 7;
  else if (tx1h >= 50) score += 4;

  if (token.hasVolume5m && token.volume1h > 0 && token.volume5m > 0) {
    const expected5m = token.volume1h / 12;
    const acceleration = expected5m > 0 ? token.volume5m / expected5m : 0;
    if (acceleration >= 2) { score += 8; signals.push("5m volume accelerating"); }
    else if (acceleration >= 1.2) score += 5;
  }

  if (token.hasPriceChange5m) {
    if (token.priceChange5m >= 2 && token.priceChange5m <= 25) score += 5;
    else if (token.priceChange5m > 25 && token.priceChange5m <= 60) score += 2;
    else if (token.priceChange5m < -15) score -= 5;
  }

  if (token.priceChange1h >= 5 && token.priceChange1h <= 80) { score += 6; signals.push("constructive 1h momentum"); }
  else if (token.priceChange1h > 150) { score -= 6; signals.push("already extremely extended"); }
  else if (token.priceChange1h < -25) score -= 7;

  if (["solana", "robinhood", "bsc"].includes(token.chainId)) score += 3;

  return { score: Math.round(clamp(score)), signals: signals.slice(0, 5) };
}
