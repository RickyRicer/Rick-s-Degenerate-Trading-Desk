import type { Position, TokenSnapshot, TradeIntent } from "../types/index.js";
import type { SecurityReport } from "../security/types.js";
import { pairAgeMinutes } from "../market/runnerScore.js";
import { APP_VERSION } from "../version.js";

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (x: number) => `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
function compactMoney(x: number) {
  const abs = Math.abs(x);
  const opts: Intl.NumberFormatOptions = { maximumFractionDigits: 1 };
  if (abs >= 1_000_000_000) return `$${(x / 1_000_000_000).toLocaleString(undefined, opts)}B`;
  if (abs >= 1_000_000) return `$${(x / 1_000_000).toLocaleString(undefined, opts)}M`;
  if (abs >= 1_000) return `$${(x / 1_000).toLocaleString(undefined, opts)}K`;
  return money(x);
}
function pct(x: number) { return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`; }
function decisionIcon(d: TradeIntent["decision"]) { return d === "BUY" ? "🟢" : d === "WATCH" ? "🟡" : "🔴"; }
function bullets(items: string[], max = 4) { return items.slice(0, max).map(i => `• ${html(i)}`).join("\n"); }
function chainLabel(chainId: string) {
  const known: Record<string, string> = { solana: "SOL", robinhood: "RH", bsc: "BSC", ethereum: "ETH", base: "BASE", arbitrum: "ARB" };
  return known[chainId] ?? chainId.toUpperCase();
}
function ageText(t: TokenSnapshot) {
  const m = pairAgeMinutes(t);
  if (m === undefined) return "?";
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}
function securityIcon(s?: SecurityReport) {
  if (!s?.checked) return "⚪";
  if (s.status === "PASS") return "🟢";
  if (s.status === "WARN") return "🟡";
  if (s.status === "FAIL") return "🔴";
  return "⚪";
}
function securityLabel(s?: SecurityReport) {
  return s?.status === "UNKNOWN" && s?.checked ? "UNKNOWN" : (s?.checked ? s.status : "UNKNOWN");
}
function shortRisk(flag: string) {
  return flag
    .replace(/^Security:\s*/i, "")
    .replace(/Security verification incomplete/i, "Security incomplete")
    .replace(/Liquidity below \$/i, "Liquidity < $")
    .replace(/24h volume below \$/i, "24h vol < $");
}

export function leaderboardHeader(scope: string, count: number) {
  return `🔥 RUNNER HUNTER v${APP_VERSION}\n${scope.toUpperCase()} • ${count} finalists\nDEX Screener → Runner Score → Multi-source Security → AI → Risk`;
}

export function compactTokenCard(t: TokenSnapshot, a: TradeIntent, riskFlags: string[] = [], rank?: number, security?: SecurityReport) {
  const ratio = t.sells1h ? (t.buys1h / t.sells1h).toFixed(2) : t.buys1h ? "∞" : "0";
  const eligible = a.decision === "BUY" && riskFlags.length === 0;
  const title = `${rank ? `#${rank} ` : ""}${html(chainLabel(t.chainId))} | ${html(t.symbol)}`;
  const fiveMinMove = t.hasPriceChange5m ? pct(t.priceChange5m) : "N/A";
  const fiveMinVol = t.hasVolume5m ? compactMoney(t.volume5m) : "N/A";
  const flowIcon = Number(ratio) >= 1.2 ? "🟢" : Number(ratio) < 0.8 ? "🔴" : "⚪";
  const analyst = a.analysisSource === "AUTO" ? "AUTO" : "AI";
  const lines = [
    `🔥 ${title} — ${html(t.name)}`,
    `Runner ${t.runnerScore ?? "?"}/100 • Age ${ageText(t)}`,
    `CA: <code>${html(t.tokenAddress)}</code>`,
    "",
    `MC ${compactMoney(t.marketCap)} • Liq ${compactMoney(t.liquidityUsd)}`,
    `5m ${fiveMinMove} / ${fiveMinVol} • 1h ${pct(t.priceChange1h)} / ${compactMoney(t.volume1h)}`,
    `${flowIcon} Flow ${t.buys1h}B / ${t.sells1h}S (${ratio}x)`,
    "",
    `${securityIcon(security)} Security: ${securityLabel(security)} • 🫧 Bundle: ${security?.bundleRisk ?? "UNKNOWN"}`,
    ...(security?.deployerScanCount && security.deployerScanCount > 1 ? [`🏭 Same deployer: ${security.deployerScanCount} scan tokens${security.deployerName ? ` • ${html(security.deployerName)}` : ""}`] : []),
    `${decisionIcon(a.decision)} ${analyst}: ${a.decision} ${a.score}/100 • ${a.confidence}% conf.`
  ];

  const topRisks = riskFlags.slice(0, 2).map(shortRisk);
  if (topRisks.length) lines.push(`⚠️ ${topRisks.map(html).join(" • ")}`);
  if (eligible) lines.push(`✅ PAPER ELIGIBLE • Suggested ${money(a.suggestedUsd)}`);
  else if (riskFlags.length) lines.push("🚫 PAPER BLOCKED");
  else lines.push(`⏸ No trade • ${a.decision}`);
  return lines.join("\n");
}

export function tokenCard(t: TokenSnapshot, a?: TradeIntent, riskFlags: string[] = [], rank?: number, security?: SecurityReport) {
  const ratio = t.sells1h ? (t.buys1h / t.sells1h).toFixed(2) : t.buys1h ? "∞" : "0";
  const hardRiskPassed = riskFlags.length === 0;
  const tradeEligible = Boolean(a && a.decision === "BUY" && hardRiskPassed);
  const title = `${rank ? `#${rank} ` : ""}${html(chainLabel(t.chainId))} | ${html(t.symbol)} — ${html(t.name)}`;
  const lines = [
    `🔍 ${title} DEEP DIVE`,
    `Runner Score: ${t.runnerScore ?? "?"}/100 | Age: ${ageText(t)}`,
    `CA: <code>${html(t.tokenAddress)}</code>`,
    "",
    `MC: ${compactMoney(t.marketCap)} | Liq: ${compactMoney(t.liquidityUsd)}`,
    `Vol 5m: ${t.hasVolume5m ? compactMoney(t.volume5m) : "N/A"} | 1h: ${compactMoney(t.volume1h)}`,
    `5m: ${t.hasPriceChange5m ? pct(t.priceChange5m) : "N/A"} | 1h: ${pct(t.priceChange1h)}`,
    `1h buys/sells: ${t.buys1h}/${t.sells1h} (${ratio}x)`
  ];
  if (t.runnerSignals?.length) lines.push("", "Runner signals:", bullets(t.runnerSignals, 3));

  const secLabel = security?.status === "UNKNOWN" && security?.checked ? "PARTIAL / UNKNOWN" : (security?.checked ? security.status : "UNKNOWN");
  lines.push("", `${securityIcon(security)} SECURITY — ${secLabel}${security?.provider ? ` (${security.provider})` : ""}`);
  if (security?.checked) {
    const facts: string[] = [];
    if (security.isHoneypot !== undefined) facts.push(`Honeypot: ${security.isHoneypot ? "YES" : "no"}`);
    if (security.buyTaxPercent !== undefined || security.sellTaxPercent !== undefined) facts.push(`Tax: ${(security.buyTaxPercent ?? 0).toFixed(1)}%/${(security.sellTaxPercent ?? 0).toFixed(1)}%`);
    if (security.top10Percent !== undefined) facts.push(`Top holders: ${security.top10Percent.toFixed(1)}%`);
    if (security.holderCount !== undefined) facts.push(`Holders: ${Math.round(security.holderCount).toLocaleString()}`);
    if (security.top1Percent !== undefined) facts.push(`Top 1: ${security.top1Percent.toFixed(1)}%`);
    if (security.rpcChecked) facts.push("RPC: checked");
    if (security.sourceVerified !== undefined) facts.push(`Source: ${security.sourceVerified ? "verified" : "unverified"}`);
    if (security.proxy === true) facts.push("Proxy: yes");
    if (facts.length) lines.push(facts.join(" | "));
    if (security.hardFlags.length) lines.push("🛑 Security failures:", bullets(security.hardFlags, 4));
    if (security.coverageNotes.length) lines.push("⚪ Coverage gaps:", bullets(security.coverageNotes, 3));
    if (security.warnings.length) lines.push("⚠️ Security warnings:", bullets(security.warnings, 4));
    if (security.positives.length) lines.push("✅ Security positives:", bullets(security.positives, 3));
  } else if (security?.warnings?.length) {
    lines.push(bullets(security.warnings, 2));
  }
  if (security?.creatorAddress) {
    const deployerKind = security.deployerIsContract === true ? "contract" : security.deployerIsContract === false ? "wallet" : "address";
    const deployerTitle = security.deployerName ? `${html(security.deployerName)} (${deployerKind})` : deployerKind;
    lines.push("", `🏭 Deployer: ${deployerTitle}`, `<code>${html(security.creatorAddress)}</code>`);
    if (security.deployerScanCount && security.deployerScanCount > 1) lines.push(`Seen on ${security.deployerScanCount} scan candidates: ${(security.relatedDeployments ?? []).map(html).join(" • ")}`);
    if (security.ownerAddress) lines.push(`Owner/admin: <code>${html(security.ownerAddress)}</code>`);
    if (security.creationTransactionHash) lines.push(`Deploy tx: <code>${html(security.creationTransactionHash)}</code>`);
  }
  lines.push(`🫧 Bundle risk: ${security?.bundleRisk ?? "UNKNOWN"}`);
  if (security?.bundleNotes?.length) lines.push(bullets(security.bundleNotes, 1));

  if (!a) return lines.join("\n");
  const analyst = a.analysisSource === "AUTO" ? "AUTO" : "AI";
  lines.push("", `${decisionIcon(a.decision)} ${analyst}: ${a.decision} — ${a.score}/100`, `Confidence: ${a.confidence}%`);
  if (a.reasons.length) lines.push("", "Why:", bullets(a.reasons, 3));
  const softRisks = a.riskFlags.filter(flag => !riskFlags.some(r => r.includes(flag)));
  if (softRisks.length) lines.push("", "⚠️ Agent concerns:", bullets(softRisks, 4));
  if (riskFlags.length) lines.push("", "🛑 Hard risk gate:", bullets(riskFlags, 4));

  if (tradeEligible) lines.push("", "✅ PAPER TRADE ELIGIBLE", `Suggested: ${money(a.suggestedUsd)}`);
  else if (!hardRiskPassed) lines.push("", "🚫 PAPER TRADE BLOCKED");
  else lines.push("", `⏸ NO TRADE OFFERED — AI says ${a.decision}`);
  return lines.join("\n");
}

export function positionsText(positions: Position[]) {
  if (!positions.length) return "No open positions.";
  return positions.map(p => {
    const value = p.quantity * p.currentPriceUsd;
    const pnl = value - p.costUsd;
    return `${p.chainId ? `${chainLabel(p.chainId)} | ` : ""}${p.symbol}: ${money(value)} | P&L ${money(pnl)} | entry $${p.entryPriceUsd}`;
  }).join("\n");
}
