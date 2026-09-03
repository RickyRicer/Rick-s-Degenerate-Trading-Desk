import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  authorizedTelegramUserId: process.env.AUTHORIZED_TELEGRAM_USER_ID
    ? Number(process.env.AUTHORIZED_TELEGRAM_USER_ID)
    : undefined,
  brokerMode: process.env.BROKER_MODE ?? "mock",
  coveReadToken: process.env.COVE_READ_TOKEN ?? "",
  coveWriteToken: process.env.COVE_WRITE_TOKEN ?? "",
  goplusAccessToken: process.env.GOPLUS_ACCESS_TOKEN ?? "",
  blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY ?? "",
  securityDeepDiveEnabled: bool("SECURITY_DEEP_DIVE_ENABLED", true),
  securityDebugLog: bool("SECURITY_DEBUG_LOG", false),
  securityMaxBuyTaxPercent: num("SECURITY_MAX_BUY_TAX_PERCENT", 15),
  securityMaxSellTaxPercent: num("SECURITY_MAX_SELL_TAX_PERCENT", 15),
  securityMaxTop10Percent: num("SECURITY_MAX_TOP10_PERCENT", 60),
  startingCashUsd: num("STARTING_PAPER_CASH_USD", 1000),
  maxTradeUsd: num("MAX_TRADE_USD", 25),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 50000),
  min24hVolumeUsd: num("MIN_24H_VOLUME_USD", 25000),
  maxMarketCapUsd: num("MAX_MARKET_CAP_USD", 25000000),
  runnerCandidateFetchLimit: num("RUNNER_CANDIDATE_FETCH_LIMIT", 36),
  runnerAiFinalists: num("RUNNER_AI_FINALISTS", 5),
  runnerMaxAgeHours: num("RUNNER_MAX_AGE_HOURS", 72),
  runnerMinLiquidityUsd: num("RUNNER_MIN_LIQUIDITY_USD", 10000),
  runnerMinVolume1hUsd: num("RUNNER_MIN_VOLUME_1H_USD", 5000)
};
