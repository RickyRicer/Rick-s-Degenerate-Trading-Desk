import type { TokenSnapshot } from "../types/index.js";
import { config } from "../config.js";
import { getGoPlusSecurityReport } from "./goplus.js";
import { getRobinhoodBlockscoutReport } from "./blockscout.js";
import { getRobinhoodRpcSecurity } from "./rpc.js";
import { getRobinhoodHolderIntel } from "./holders.js";
import { getCoveSecurityIntel } from "./cove.js";
import type { SecurityEvidence, SecurityReport, SecurityStatus } from "./types.js";
import { identifyKnownInfrastructure } from "./infrastructure.js";

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
  else if (rpc.minimalProxyImplementation) out.push(evidence("proxy", "Proxy / upgradeability", "WARN", "Robinhood RPC", `EIP-1167 minimal proxy runtime → ${rpc.minimalProxyImplementation}`));
  else if (blockscout.checked) out.push(evidence("proxy", "Proxy / upgradeability", "PASS", "Blockscout", "No proxy reported"));
  else out.push(evidence("proxy", "Proxy / upgradeability", "UNKNOWN", "Blockscout + RPC", rpc.delegatecallPresent ? "Blockscout proxy status unavailable; runtime contains DELEGATECALL heuristic" : "Proxy status unavailable"));

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

  if (goPlus.cannotSellAll === true) out.push(evidence("sellability", "Sellability", "WARN", "GoPlus", "GoPlus reports the full balance may not be sellable"));
  else if (goPlus.cannotSellAll === false) out.push(evidence("sellability", "Sellability", "PASS", "GoPlus", "No full-balance sell restriction reported", true));
  else out.push(evidence("sellability", "Sellability", "UNKNOWN", "GoPlus", "Sellability result unavailable", true));

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

  // Runtime selector inspection supplements missing Blockscout ABI coverage. A
  // detected selector is meaningful evidence; absence is intentionally not PASS.
  const runtimeCaps = new Set(rpc.runtimeCapabilities ?? []);
  const promoteRuntimeWarn = (id: string, labels: string[], detail: string) => {
    if (!labels.some(x => runtimeCaps.has(x))) return;
    const i = out.findIndex(e => e.id === id);
    const item = evidence(id, out[i]?.label ?? id, "WARN", "Robinhood RPC bytecode", detail);
    if (i >= 0 && out[i].status === "UNKNOWN") out[i] = item;
    else if (i < 0) out.push(item);
  };
  promoteRuntimeWarn("mint", ["mint(address,uint256)", "mint(uint256)"], "Common public mint selector detected in runtime bytecode");
  promoteRuntimeWarn("pause", ["pause()", "unpause()"], "Common pause/unpause selector detected in runtime bytecode");

  if (rpc.paused === true) out.push(evidence("pausedState", "Current paused state", "FAIL", "Robinhood RPC", "paused() currently true", true));
  else if (rpc.paused === false) out.push(evidence("pausedState", "Current paused state", "PASS", "Robinhood RPC", "paused() currently false"));
  else if (abiAvailable && inspectedSource && !caps.has("pause controls")) out.push(evidence("pausedState", "Current paused state", "PASS", capabilitySource, "No pause mechanism exposed in verified ABI; paused() is not applicable"));
  else if (caps.has("pause controls") || runtimeCaps.has("pause()") || runtimeCaps.has("unpause()")) out.push(evidence("pausedState", "Current paused state", "UNKNOWN", "RPC + contract capability evidence", "Pause controls appear to exist but current paused state could not be established", true));
  else out.push(evidence("pausedState", "Current paused state", "UNKNOWN", "RPC + Blockscout", "Pause-state coverage unavailable"));

  if (rpc.ownerAddress) out.push(evidence("admin", "Owner / admin", "WARN", "Robinhood RPC", `owner() address exposed: ${rpc.ownerAddress}; retained powers not established`));
  else if (caps.has("admin/role controls")) out.push(evidence("admin", "Owner / admin", "WARN", capabilitySource, "Admin/role functions detected in ABI"));
  else if (abiAvailable && inspectedSource) out.push(evidence("admin", "Owner / admin", "PASS", capabilitySource, "No obvious public owner/admin mutation functions found"));
  else out.push(evidence("admin", "Owner / admin", "UNKNOWN", "RPC + Blockscout", "Admin model not established"));

  return out;
}

function evidenceItemInfrastructure(label: string, kind: string, confidence: "HIGH" | "MEDIUM", reason: string): SecurityEvidence {
  return evidence(
    "deployerInfrastructure",
    "Deployment infrastructure",
    "PASS",
    "Runner Hunter registry",
    `${label} recognized as known ${kind} infrastructure (${confidence.toLowerCase()} confidence) • ${reason}`
  );
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
  if (rpc.ownerAddress) warnings.push(`owner() address exposed (${rpc.ownerAddress.slice(0, 8)}…${rpc.ownerAddress.slice(-4)}); retained admin powers are unverified`);
  if (rpc.minimalProxyImplementation) warnings.push(`EIP-1167 minimal proxy detected → ${rpc.minimalProxyImplementation}`);
  if (rpc.runtimeCapabilities?.some(x => x.startsWith("mint("))) warnings.push("Runtime bytecode exposes a common mint selector");
  if (rpc.runtimeCapabilities?.some(x => x === "pause()" || x === "unpause()")) warnings.push("Runtime bytecode exposes common pause/unpause selectors");

  const concentrationValues = [
    holders.top10Percent !== undefined ? { source: "Blockscout", value: holders.top10Percent } : undefined,
    goPlus.top10Percent !== undefined ? { source: "GoPlus", value: goPlus.top10Percent } : undefined,
    cove.top10Percent !== undefined ? { source: "Cove", value: cove.top10Percent } : undefined
  ].filter((x): x is { source: string; value: number } => Boolean(x));
  const conservativeConcentration = concentrationValues.sort((a, b) => b.value - a.value)[0];
  const top10Percent = conservativeConcentration?.value;
  const holderCount = holders.holderCount ?? goPlus.holderCount;
  if (top10Percent !== undefined) {
    const detail = concentrationValues.map(x => `${x.source} ${x.value.toFixed(1)}%`).join(" • ");
    if (top10Percent >= config.securityMaxTop10Percent) hardFlags.push(`Top holders control ${top10Percent.toFixed(1)}% (conservative multi-source value)`);
    else if (top10Percent < 30) positives.push(`Conservative top-10 concentration ${top10Percent.toFixed(1)}%`);
    if (concentrationValues.length > 1 && Math.max(...concentrationValues.map(x => x.value)) - Math.min(...concentrationValues.map(x => x.value)) >= 5) warnings.push(`Holder concentration differs by provider (${detail}); using ${top10Percent.toFixed(1)}%`);
  }
  if (holders.top1Percent !== undefined && holders.top1Percent >= 25) warnings.push(`Largest holder controls ${holders.top1Percent.toFixed(1)}%`);
  if (!holders.checked) warnings.push(...holders.notes);

  const evidence = buildRobinhoodEvidence(goPlus, blockscout, rpc, holders);

  const infrastructure = identifyKnownInfrastructure({
    creatorAddress: blockscout.creatorAddress,
    deployerName: blockscout.deployerName,
    deployerIsContract: blockscout.deployerIsContract,
    deployerVerified: blockscout.deployerVerified
  });
  if (infrastructure) {
    positives.push(`${infrastructure.label} recognized as known ${infrastructure.kind} infrastructure`);
    evidence.push(evidenceItemInfrastructure(infrastructure.label, infrastructure.kind, infrastructure.confidence, infrastructure.reason));
  }

  if (top10Percent !== undefined) {
    const i = evidence.findIndex(e => e.id === "holders");
    const sourceDetail = concentrationValues.map(x => `${x.source} ${x.value.toFixed(1)}%`).join(" • ");
    const status: SecurityEvidence["status"] = top10Percent >= config.securityMaxTop10Percent ? "FAIL" : top10Percent >= 45 ? "WARN" : "PASS";
    const item: SecurityEvidence = { id: "holders", label: "Holder concentration", status, source: "Multi-source conservative", detail: `Using highest reported top-10 concentration ${top10Percent.toFixed(1)}%${sourceDetail ? ` (${sourceDetail})` : ""}`, critical: status === "FAIL" };
    if (i >= 0) evidence[i] = item; else evidence.push(item);
  }

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

  // Composite tradeability fallback where providers omit a dedicated honeypot
  // or sellability boolean. There are two deliberately separate graduation paths:
  //
  // 1) Direct path: concrete buy + sell + tax checks all pass.
  // 2) Verified-contract path: a verified, non-proxy contract has explicit sell-tax
  //    evidence below the hard threshold and its verified ABI exposes no mutable
  //    fee, blacklist, pause, or mint controls. This is treated as WARN rather than
  //    PASS because a dedicated honeypot/sell simulation result is still absent.
  //
  // Neither path invents a honeypot result. High/unknown sell tax still fails closed.
  const evidenceById = (id: string) => evidence.find(e => e.id === id);
  const buyEv = evidenceById("buyability");
  const sellEv = evidenceById("sellability");
  const taxEv = evidenceById("tax");
  const sourceEv = evidenceById("source");
  const proxyEv = evidenceById("proxy");
  const bytecodeEv = evidenceById("bytecode");
  const holdersEv = evidenceById("holders");
  const mintEv = evidenceById("mint");
  const pauseEv = evidenceById("pause");
  const blacklistEv = evidenceById("blacklist");
  const feeControlEv = evidenceById("feeControl");

  const directTradeabilityCovered =
    buyEv?.status === "PASS" &&
    sellEv?.status === "PASS" &&
    (taxEv?.status === "PASS" || taxEv?.status === "WARN");

  if (directTradeabilityCovered) {
    evidence.push({ id: "tradeability", label: "Runtime tradeability", status: "PASS", source: "GoPlus + Cove composite", detail: "Current buyability, sellability, and trading-tax checks all returned usable non-failing results", critical: true });
    const honey = evidenceById("honeypot");
    if (honey?.status === "UNKNOWN") {
      honey.critical = false;
      honey.detail = `${honey.detail}; dedicated flag unavailable, but current buy/sell/tax checks passed`;
    }
    if (infrastructure && rpc.codePresent === true) {
      const source = evidenceById("source");
      if (source?.status === "UNKNOWN") {
        source.critical = false;
        source.detail = `${source.detail}; known ${infrastructure.label} deployment infrastructure + runtime tradeability coverage available`;
      }
    }
  } else {
    const explicitSellTax = cove.sellTaxPercent ?? goPlus.sellTaxPercent;
    const explicitBuyTax = cove.buyTaxPercent ?? goPlus.buyTaxPercent;
    const taxWithinHardLimit =
      explicitSellTax !== undefined &&
      explicitSellTax < config.securityMaxSellTaxPercent &&
      (explicitBuyTax === undefined || explicitBuyTax < config.securityMaxBuyTaxPercent);

    const verifiedContractSellSideCoverage =
      sourceEv?.status === "PASS" &&
      proxyEv?.status === "PASS" &&
      bytecodeEv?.status === "PASS" &&
      buyEv?.status === "PASS" &&
      taxWithinHardLimit &&
      (taxEv?.status === "PASS" || taxEv?.status === "WARN") &&
      holdersEv?.status !== "FAIL" &&
      mintEv?.status === "PASS" &&
      pauseEv?.status === "PASS" &&
      blacklistEv?.status === "PASS" &&
      feeControlEv?.status === "PASS";

    if (verifiedContractSellSideCoverage) {
      const taxSource = cove.sellTaxPercent !== undefined ? "Cove MCP" : "GoPlus";
      evidence.push({
        id: "sellSideCoverage",
        label: "Sell-side coverage",
        status: "PASS",
        source: `${taxSource} + verified ABI`,
        detail: `Explicit sell tax ${explicitSellTax!.toFixed(1)}% is below the hard limit and verified ABI exposes no public fee/tax, blacklist, pause, or mint mutation controls`,
        critical: true
      });

      if (sellEv?.status === "UNKNOWN") {
        sellEv.critical = false;
        sellEv.detail = `${sellEv.detail}; dedicated sellability flag unavailable, but explicit sell-tax evidence and verified immutable trade controls passed`;
      }
      const honey = evidenceById("honeypot");
      if (honey?.status === "UNKNOWN") {
        honey.critical = false;
        honey.detail = `${honey.detail}; dedicated honeypot flag unavailable, but verified-contract sell-side coverage passed`;
      }
      warnings.push("Dedicated honeypot/sellability flags unavailable; security graduated with verified-contract sell-side evidence");
      positives.push(`Explicit sell tax ${explicitSellTax!.toFixed(1)}% with no public fee/tax mutation controls in verified ABI`);
    }
  }

  if (cove.liquidityLocked !== undefined || goPlus.liquidityLockedPercent !== undefined) {
    const gp = goPlus.liquidityLockedPercent;
    const cv = cove.liquidityLockedPercent;
    const coveLocked = cove.liquidityLocked === true;
    const goPlusLocked = gp !== undefined ? gp >= 50 : undefined;
    const conflict = cove.liquidityLocked !== undefined && goPlusLocked !== undefined && coveLocked !== goPlusLocked;

    // Remove provider-specific lock prose that can otherwise contradict the
    // normalized evidence immediately below. Preserve other provider findings.
    const isLockLine = (x: string) => /(?:detected LP is locked|locked LP|liquidity lock evidence|liquidity as locked)/i.test(x);
    for (let i = warnings.length - 1; i >= 0; i--) if (isLockLine(warnings[i])) warnings.splice(i, 1);
    for (let i = positives.length - 1; i >= 0; i--) if (isLockLine(positives[i])) positives.splice(i, 1);

    if (conflict) {
      const detail = `Providers disagree on LP lock state${gp !== undefined ? ` • GoPlus ${gp.toFixed(1)}% locked` : ""}${cv !== undefined ? ` • Cove ${cv.toFixed(1)}% locked` : cove.liquidityLocked !== undefined ? ` • Cove reports ${coveLocked ? "locked" : "unlocked"}` : ""}`;
      warnings.push(detail);
      evidence.push({ id: "liquidityLock", label: "Liquidity lock", status: "UNKNOWN", source: "GoPlus + Cove", detail });
    } else {
      const locked = cove.liquidityLocked ?? goPlusLocked;
      const detailParts = [
        gp !== undefined ? `GoPlus ${gp.toFixed(1)}%` : undefined,
        cv !== undefined ? `Cove ${cv.toFixed(1)}%` : cove.liquidityLocked !== undefined ? `Cove ${coveLocked ? "locked" : "unlocked"}` : undefined
      ].filter(Boolean);
      evidence.push({ id: "liquidityLock", label: "Liquidity lock", status: locked ? "PASS" : "WARN", source: "GoPlus + Cove", detail: `${locked ? "Lock evidence consistent" : "LP not sufficiently locked"}${detailParts.length ? ` • ${detailParts.join(" • ")}` : ""}` });
      if (locked) positives.push("Liquidity lock evidence is consistent across available providers");
      else warnings.push("Available providers do not show sufficient LP lock");
    }
  }
  if (cove.mintAuthorityActive !== undefined) {
    evidence.push({ id: "coveMint", label: "Mint authority", status: cove.mintAuthorityActive ? "WARN" : "PASS", source: "Cove MCP", detail: cove.mintAuthorityActive ? "Active mint authority/control reported" : "No active mint authority reported" });
  }
  if (cove.freezeAuthorityActive !== undefined) {
    evidence.push({ id: "coveFreeze", label: "Freeze authority", status: cove.freezeAuthorityActive ? "WARN" : "PASS", source: "Cove MCP", detail: cove.freezeAuthorityActive ? "Active freeze authority/control reported" : "No active freeze authority reported" });
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
    provider: `Multi-source: RPC + Blockscout + GoPlus${cove.available ? " + Cove" : ""}`,
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
    deployerIsKnownInfrastructure: Boolean(infrastructure),
    deployerInfrastructureName: infrastructure?.label,
    deployerInfrastructureKind: infrastructure?.kind,
    deployerInfrastructureConfidence: infrastructure?.confidence,
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
    buyTaxPercent: cove.buyTaxPercent ?? goPlus.buyTaxPercent,
    sellTaxPercent: cove.sellTaxPercent ?? goPlus.sellTaxPercent,
    isHoneypot: cove.isHoneypot ?? goPlus.isHoneypot,
    cannotBuy: cove.canBuy !== undefined ? !cove.canBuy : goPlus.cannotBuy,
    cannotSellAll: cove.canSell !== undefined ? !cove.canSell : goPlus.cannotSellAll,
    holderIntelSource: holders.checked ? "Blockscout" : undefined,
    raw: { goPlus: goPlus.raw, blockscout: blockscout.raw, rpc, holders, cove: cove.raw }
  };
  merged.status = recalcStatus(merged);
  const unknownCritical = evidence.filter(e => e.critical && e.status === "UNKNOWN").length;
  console.log(`[Security] robinhood:${token.symbol} merged=${merged.status} hard=${merged.hardFlags.length} warnings=${merged.warnings.length} criticalUnknown=${unknownCritical} evidence=${evidence.length} sources=rpc,blockscout,goplus${cove.available ? ",cove" : ""}`);
  return merged;
}

export type { SecurityReport, SecurityStatus, BundleRisk, SecurityEvidence } from "./types.js";
