import { config } from "../config.js";
import type { Position, TokenSnapshot } from "../types/index.js";
import type { SecurityReport } from "../security/types.js";

export function evaluateRisk(token: TokenSnapshot, positions: Position[], security?: SecurityReport) {
  const flags: string[] = [];
  const isPaperMode = config.brokerMode === "cove-paper" || config.brokerMode === "mock";
  const liquidityFloor = isPaperMode ? config.paperMinLiquidityUsd : config.minLiquidityUsd;
  if (token.liquidityUsd < liquidityFloor) flags.push(`Liquidity below $${liquidityFloor.toLocaleString()}`);
  if (token.volume24h < config.min24hVolumeUsd) flags.push(`24h volume below $${config.min24hVolumeUsd.toLocaleString()}`);
  if (token.marketCap > config.maxMarketCapUsd) flags.push(`Market cap above $${config.maxMarketCapUsd.toLocaleString()}`);
  if (positions.length >= config.maxOpenPositions) flags.push("Maximum open positions reached");
  if (token.priceUsd <= 0) flags.push("Invalid price");
  const alreadyOpen = positions.some(p => p.tokenAddress === token.tokenAddress && (!p.chainId || p.chainId === token.chainId));
  if (alreadyOpen) flags.push("Position already open");

  if (!security?.checked) flags.push("Security deep dive unavailable");
  else if (security.status === "UNKNOWN") flags.push("Security verification incomplete");
  if (security?.hardFlags?.length) flags.push(...security.hardFlags.map(f => `Security: ${f}`));

  return { approved: flags.length === 0, flags };
}
