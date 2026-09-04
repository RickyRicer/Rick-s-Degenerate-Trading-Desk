import type { TokenSnapshot } from "../types/index.js";
import { config } from "../config.js";
import { getGoPlusSecurityReport } from "./goplus.js";
import { getRobinhoodBlockscoutReport } from "./blockscout.js";
import { getRobinhoodRpcSecurity } from "./rpc.js";
import { getRobinhoodHolderIntel } from "./holders.js";
import { getCoveSecurityIntel } from "./cove.js";
import type { SecurityEvidence, SecurityReport, SecurityStatus } from "./types.js";

function uniq(items: string[]) { return [...new Set(items.filter(Boolean))]; }

function recalcStatus(report: SecurityReport): SecurityStatus {
  if (report.hardFlags.length || report.evidence?.some(e => e.status === "FAIL")) return "FAIL";
  if (report.evidence?.some(e => e.critical && e.status === "UNKNOWN")) return "UNKNOWN";
  if (report.coverageNotes.length) return "UNKNOWN";
  if (report.warnings.length || report.evidence?.some(e => e.status === "WARN")) return "WARN";
  return "PASS";
}

function evidence(id: string, label: string, status: SecurityEvidence["status"], source: string, detail: string, critical = false): SecurityEvidence {
  return { id, label, status, source, detail, critical };
}

function buildRobinhoodEvidence(
  goPlus: SecurityReport,
  blockscout: Awaited<ReturnType<typeof getRobinhoodBlockscoutReport>>,
  rpc: Awaited<ReturnType<typeof getRobinhoodRpcSecurity>>,
  holders: Awaited<ReturnType<typeof getRobinhoodHolderIntel>>
): SecurityEvidence[] {
  const out: SecurityEvidence[] = [];

  if (blockscout.sourceVerified === true && (!blockscout.proxy || blockscout.implementationVerified === true)) {
    out.push(evidence("source", "Source / implementation", "PASS", "Blockscout", blockscout.proxy ? "Proxy and implementation source verified" : "Contract source verified", true));
  } else if (blockscout.sourceVerified === false) {
    out.push(evidence("source", "Source / implementation", "UNKNOWN", "Blockscout", "Contract source is not verified", true));
  } else if (blockscout.proxy && blockscout.implementationVerified !== true) {
    out.push(evidence("source", "Source / implementation", "UNKNOWN", "Blockscout", "Proxy implementation source is not verified", true));
  } else {
    out.push(evidence("source", "Source / implementation", "UNKNOWN", "Blockscout", "Source verification unavailable", true));
  }

  out.push(rpc.codePresent === true
    ? evidence("bytecode", "Contract bytecode", "PASS", "Robinhood RPC", "Runtime bytecode present")
    : rpc.checked
      ? evidence("bytecode", "Contract bytecode", "FAIL", "Robinhood RPC", "No runtime bytecode at token address", true)
      : evidence("bytecode", "Contract bytecode", "UNKNOWN", "Robinhood RPC", "RPC bytecode check unavailable", true));

  if (blockscout.proxy === true) out.push(evidence("proxy", "Proxy / upgradeability", "WARN", "Blockscout", `Proxy detected${blockscout.implementationName ? ` → ${blockscout.implementationName}` : ""}`));
  else if (blockscout.checked) out.push(evidence("proxy", "Proxy / upgradeability", "PASS", "Blockscout", "No proxy reported"));
  else out.push(evidence("proxy", "Proxy / upgradeability", "UNKNOWN", "Blockscout", "Proxy status unavailable"));

  if (holders.top10Percent !== undefined) {
    const p = holders.top10Percent;
    if (p >= config.securityMaxTop10Percent) out.push(evidence("holders", "Holder concentration", "FAIL", "Blockscout", `Top 10 control ${p.toFixed(1)}%`, true));
    else if (p >= 45) out.push(evidence("holders", "Holder concentration", "WARN", "Blockscout", `Top 10 control ${p.toFixed(1)}%`));
    else out.push(evidence("holders", "Holder concentration", "PASS", "Blockscout", `Top 10 control ${p.toFixed(1)}%`));
  } else out.push(evidence("holders", "Holder concentration", "UNKNOWN", "Blockscout", "Holder concentration unavailable"));

  if (goPlus.isHoneypot === true) out.push(evidence("honeypot", "Honeypot", "FAIL", "GoPlus", "Honeypot detected", true));
  else if (goPlus.isHoneypot === false) out.push(evidence("honeypot", "Honeypot", "PASS", "GoPlus", "No honeypot detected", true));
  else out.push(evidence("honeypot", "Honeypot", "UNKNOWN", "GoPlus", "Honeypot result unavailable", true));

  if (goPlus.cannotBuy === true) out.push(evidence("buyability", "Buyability", "FAIL", "GoPlus", "Normal buys reported blocked", true));
  else if (goPlus.cannotBuy === false) out.push(evidence("buyability", "Buyability", "PASS", "GoPlus", "No buy restriction reported", true));
  else out.push(evidence("buyability", "Buyability", "UNKNOWN", "GoPlus", "Buyability result unavailable", true));

  if (goPlus.buyTaxPercent !== undefined && goPlus.sellTaxPercent !== undefined) {
    const buy = goPlus.buyTaxPercent, sell = goPlus.sellTaxPercent;
    const detail = `${buy.toFixed(1)}% buy / ${sell.toFixed(1)}% sell`;
    if (buy >= config.securityMaxBuyTaxPercent || sell >= config.securityMaxSellTaxPercent) out.push(evidence("tax", "Trading tax", "FAIL", "GoPlus", detail, true));
    else if (buy >= 5 || sell >= 5 || goPlus.modifiableTax === true) out.push(evidence("tax", "Trading tax", "WARN", "GoPlus", `${detail}${goPlus.modifiableTax ? " • modifiable" : ""}`));
    else out.push(evidence("tax", "Trading tax", "PASS", "GoPlus", detail, true));
  } else out.push(evidence("tax", "Trading tax", "UNKNOWN", "GoPlus", "Buy/sell tax results unavailable", true));

  const caps = new Set(blockscout.abiCapabilities ?? []);
  const abiAvailable = (blockscout.abiFunctionNames?.length ?? 0) > 0;
  const inspectedSource = blockscout.sourceVerified === true && (!blockscout.proxy || blockscout.implementationVerified === true);
  const capabilitySource = blockscout.proxy && blockscout.implementationAddress ? "Blockscout implementation ABI" : "Blockscout ABI";

  const capCheck = (id: string, label: string, cap: string, detail: string) => {
    if (caps.has(cap)) out.push(evidence(id, label, "WARN", capabilitySource, detail));
    else if (abiAvailable && inspectedSource) out.push(evidence(id, label, "PASS", capabilitySource, `No public ${label.toLowerCase()} capability found in verified ABI`));
    else out.push(evidence(id, label, "UNKNOWN", capabilitySource, "Verified ABI coverage unavailable"));
  };
  capCheck("mint", "Mint controls", "mint controls", "Public mint-related function detected");
  capCheck("pause", "Pause controls", "pause controls", "Public pause/unpause capability detected");
  capCheck("blacklist", "Blacklist controls", "blacklist controls", "Public blacklist/blocklist capability detected");
  capCheck("feeControl", "Fee/tax controls", "fee/tax controls", "Public fee/tax modification capability detected");

  if (rpc.paused === true) out.push(evidence("pausedState", "Current paused state", "FAIL", "Robinhood RPC", "paused() currently true", true));
  else if (rpc.paused === false) out.push(evidence("pausedState", "Current paused state", "PASS", "Robinhood RPC", "paused() currently false"));
  else out.push(evidence("pausedState", "Current paused state", "UNKNOWN", "Robinhood RPC", "paused() is not exposed or could not be decoded"));

  if (rpc.ownerAddress) out.push(evidence("admin", "Owner / admin", "WARN", "Robinhood RPC", `owner() exposed: ${rpc.ownerAddress}`));
  else if (caps.has("admin/role controls")) out.push(evidence("admin", "Owner / admin", "WARN", capabilitySource, "Admin/role functions detected in ABI"));
  else if (abiAvailable && inspectedSource) out.push(evidence("admin", "Owner / admin", "PASS", capabilitySource, "No obvious public owner/admin mutation functions found"));
  else out.push(evidence("admin", "Owner / admin", "UNKNOWN", "RPC + Blockscout", "Admin model not established"));

  return out;
}

export async function getSecurityReport(token: TokenSnapshot): Promise<SecurityReport> {
  const goPlus = await getGoPlusSecurityReport(token);
  if (token.chainId !== "robinhood") return goPlus;

  const [blockscout, rpc, cove] = await Promise.all([
    getRobinhoodBlockscoutReport(token),
    getRobinhoodRpcSecurity(token),
    getCoveSecurityIntel(token)
  ]);
  const holders = await getRobinhoodHolderIntel(token, rpc.totalSupply);
  const warnings = [...goPlus.warnings];
  const positives = [...goPlus.positives];
  const hardFlags = [...goPlus.hardFlags, ...cove.hardFlags];
  warnings.push(...cove.warnings);
  positives.push(...cove.positives);

  if (blockscout.sourceVerified === true) positives.push("Source verified independently on Robinhood Blockscout");
  if (blockscout.proxy === true) warnings.push(`Proxy/upgradeable contract${blockscout.implementationName ? ` (${blockscout.implementationName})` : ""}`);
  if (blockscout.abiCapabilities?.length) warnings.push(...blockscout.abiCapabilities.map(cap => `Verified ABI exposes ${cap}`));

  if (rpc.checked && rpc.codePresent === true) positives.push("Contract bytecode confirmed directly by Robinhood Chain RPC");
  if (rpc.paused === true) hardFlags.push("Contract paused() is currently true");
  if (rpc.ownerAddress) warnings.push(`Owner/admin function exposed (${rpc.ownerAddress.slice(0, 8)}…${rpc.ownerAddress.slice(-4)})`);

  const top10Percent = holders.top10Percent ?? goPlus.top10Percent;
  const holderCount = holders.holderCount ?? goPlus.holderCount;
  if (holders.top10Percent !== undefined) {
    if (holders.top10Percent >= config.securityMaxTop10Percent) hardFlags.push(`Top holders control ${holders.top10Percent.toFixed(1)}%`);
    else if (holders.top10Percent < 30) positives.push(`Blockscout top-10 concentration ${holders.top10Percent.toFixed(1)}%`);
  }
  if (holders.top1Percent !== undefined && holders.top1Percent >= 25) warnings.push(`Largest holder controls ${holders.top1Percent.toFixed(1)}%`);
  if (!holders.checked) warnings.push(...holders.notes);

  const evidence = buildRobinhoodEvidence(goPlus, blockscout, rpc, holders);

  // Cove is an independent execution/security sensor. When it returns a concrete
  // buy/sell/honeypot/tax result, use that evidence instead of leaving the same
  // control UNKNOWN merely because GoPlus omitted it.
  const replaceEvidence = (id: string, status: SecurityEvidence["status"], detail: string, critical = true) => {
    const i = evidence.findIndex(e => e.id === id);
    const item: SecurityEvidence = { id, label: id === "honeypot" ? "Honeypot" : id === "buyability" ? "Buyability" : id === "sellability" ? "Sellability" : id === "tax" ? "Trading tax" : id, status, source: "Cove MCP", detail, critical };
    if (i >= 0) evidence[i] = item; else evidence.push(item);
  };
  if (cove.isHoneypot === true) replaceEvidence("honeypot", "FAIL", "Cove reports honeypot behavior");
  else if (cove.isHoneypot === false) replaceEvidence("honeypot", "PASS", "Cove reports no honeypot behavior");
  if (cove.canBuy === false) replaceEvidence("buyability", "FAIL", "Cove reports normal buys blocked");
  else if (cove.canBuy === true) replaceEvidence("buyability", "PASS", "Cove buyability check passed");
  if (cove.canSell === false) replaceEvidence("sellability", "FAIL", "Cove reports normal sells blocked");
  else if (cove.canSell === true) replaceEvidence("sellability", "PASS", "Cove sellability check passed");
  if (cove.buyTaxPercent !== undefined && cove.sellTaxPercent !== undefined) {
    const buy = cove.buyTaxPercent, sell = cove.sellTaxPercent;
    replaceEvidence("tax", buy >= config.securityMaxBuyTaxPercent || sell >= config.securityMaxSellTaxPercent ? "FAIL" : (buy >= 5 || sell >= 5 ? "WARN" : "PASS"), `${buy.toFixed(1)}% buy / ${sell.toFixed(1)}% sell`);
  }

  const evidenceHard = evidence.filter(e => e.status === "FAIL").map(e => `${e.label}: ${e.detail}`);
  hardFlags.push(...evidenceHard);

  // Coverage is now derived from explicit critical controls instead of inheriting
  // opaque provider-specific "coverage=N" counts.
  const coverageNotes = evidence
    .filter(e => e.critical && e.status === "UNKNOWN")
    .map(e => `${e.label}: ${e.detail}`);

  const merged: SecurityReport = {
    ...goPlus,
    provider: "Multi-source: RPC + Blockscout + GoPlus",
    checked: goPlus.checked || blockscout.checked || rpc.checked || holders.checked,
    hardFlags: uniq(hardFlags),
    warnings: uniq(warnings),
    positives: uniq(positives),
    coverageNotes: uniq(coverageNotes),
    evidence,
    sourceVerified: blockscout.sourceVerified,
    proxy: goPlus.proxy === true || blockscout.proxy === true ? true : goPlus.proxy,
    creatorAddress: blockscout.creatorAddress,
    creationTransactionHash: blockscout.creationTransactionHash,
    deployerName: blockscout.deployerName,
    deployerIsContract: blockscout.deployerIsContract,
    deployerVerified: blockscout.deployerVerified,
    implementationAddress: blockscout.implementationAddress,
    implementationName: blockscout.implementationName,
    implementationVerified: blockscout.implementationVerified,
    inspectedContractAddress: blockscout.inspectedContractAddress,
    abiFunctionNames: blockscout.abiFunctionNames,
    abiCapabilities: blockscout.abiCapabilities,
    rpcChecked: rpc.checked,
    ownerAddress: rpc.ownerAddress,
    paused: rpc.paused,
    holderCount,
    top10Percent,
    top1Percent: holders.top1Percent,
    holderIntelSource: holders.checked ? "Blockscout" : undefined,
    raw: { goPlus: goPlus.raw, blockscout: blockscout.raw, rpc, holders, cove: cove.raw }
  };
  merged.status = recalcStatus(merged);
  const unknownCritical = evidence.filter(e => e.critical && e.status === "UNKNOWN").length;
  console.log(`[Security] robinhood:${token.symbol} merged=${merged.status} hard=${merged.hardFlags.length} warnings=${merged.warnings.length} criticalUnknown=${unknownCritical} evidence=${evidence.length} sources=rpc,blockscout,goplus${cove.available ? ",cove" : ""}`);
  return merged;
}

export type { SecurityReport, SecurityStatus, BundleRisk, SecurityEvidence } from "./types.js";
