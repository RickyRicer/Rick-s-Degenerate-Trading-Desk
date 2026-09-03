import type { TokenSnapshot } from "../types/index.js";
import { config } from "../config.js";
import { getGoPlusSecurityReport } from "./goplus.js";
import { getRobinhoodBlockscoutReport } from "./blockscout.js";
import { getRobinhoodRpcSecurity } from "./rpc.js";
import { getRobinhoodHolderIntel } from "./holders.js";
import type { SecurityReport, SecurityStatus } from "./types.js";

function uniq(items: string[]) { return [...new Set(items.filter(Boolean))]; }
function recalcStatus(report: SecurityReport): SecurityStatus {
  if (report.hardFlags.length) return "FAIL";
  if (report.coverageNotes.length) return "UNKNOWN";
  if (report.warnings.length) return "WARN";
  return "PASS";
}

export async function getSecurityReport(token: TokenSnapshot): Promise<SecurityReport> {
  const goPlus = await getGoPlusSecurityReport(token);
  if (token.chainId !== "robinhood") return goPlus;

  const [blockscout, rpc] = await Promise.all([
    getRobinhoodBlockscoutReport(token),
    getRobinhoodRpcSecurity(token)
  ]);
  const holders = await getRobinhoodHolderIntel(token, rpc.totalSupply);
  const coverageNotes = [...goPlus.coverageNotes];
  const warnings = [...goPlus.warnings];
  const positives = [...goPlus.positives];
  const hardFlags = [...goPlus.hardFlags];

  // Source verification is independently established by Blockscout.
  if (blockscout.checked && blockscout.sourceVerified === true) {
    for (let i = coverageNotes.length - 1; i >= 0; i--) if (/source|open source|verification/i.test(coverageNotes[i])) coverageNotes.splice(i, 1);
    positives.push("Source verified independently on Robinhood Blockscout");
  } else if (blockscout.checked && blockscout.sourceVerified === false) {
    for (let i = coverageNotes.length - 1; i >= 0; i--) if (/source|open source|verification/i.test(coverageNotes[i])) coverageNotes.splice(i, 1);
    coverageNotes.push("Contract source is not verified on Robinhood Blockscout");
  } else if (!blockscout.checked) coverageNotes.push(...blockscout.notes);

  // Direct RPC is a separate evidence source; GoPlus no longer owns these facts.
  if (rpc.checked && rpc.codePresent === true) positives.push("Contract bytecode confirmed directly by Robinhood Chain RPC");
  if (rpc.paused === true) hardFlags.push("Contract paused() is currently true");
  if (rpc.ownerAddress) warnings.push(`Owner/admin function exposed (${rpc.ownerAddress.slice(0, 8)}…${rpc.ownerAddress.slice(-4)})`);
  if (!rpc.checked) coverageNotes.push(...rpc.notes);

  // Independent holder concentration from Blockscout supersedes missing GoPlus holder data.
  let top10Percent = holders.top10Percent ?? goPlus.top10Percent;
  let holderCount = holders.holderCount ?? goPlus.holderCount;
  if (holders.top10Percent !== undefined) {
    if (holders.top10Percent >= config.securityMaxTop10Percent) hardFlags.push(`Top holders control ${holders.top10Percent.toFixed(1)}%`);
    else if (holders.top10Percent < 30) positives.push(`Blockscout top-10 concentration ${holders.top10Percent.toFixed(1)}%`);
  }
  if (holders.top1Percent !== undefined && holders.top1Percent >= 25) warnings.push(`Largest holder controls ${holders.top1Percent.toFixed(1)}%`);
  if (!holders.checked) warnings.push(...holders.notes);

  if (blockscout.proxy === true && goPlus.proxy !== true) warnings.push("Blockscout reports a proxy/implementation contract");

  const merged: SecurityReport = {
    ...goPlus,
    provider: "Multi-source: RPC + Blockscout + GoPlus",
    checked: goPlus.checked || blockscout.checked || rpc.checked || holders.checked,
    hardFlags: uniq(hardFlags), warnings: uniq(warnings), positives: uniq(positives), coverageNotes: uniq(coverageNotes),
    sourceVerified: blockscout.sourceVerified,
    proxy: goPlus.proxy === true || blockscout.proxy === true ? true : goPlus.proxy,
    creatorAddress: blockscout.creatorAddress, creationTransactionHash: blockscout.creationTransactionHash,
    deployerName: blockscout.deployerName, deployerIsContract: blockscout.deployerIsContract, deployerVerified: blockscout.deployerVerified,
    rpcChecked: rpc.checked, ownerAddress: rpc.ownerAddress, paused: rpc.paused,
    holderCount, top10Percent, top1Percent: holders.top1Percent, holderIntelSource: holders.checked ? "Blockscout" : undefined,
    raw: { goPlus: goPlus.raw, blockscout: blockscout.raw, rpc, holders }
  };
  merged.status = recalcStatus(merged);
  console.log(`[Security] robinhood:${token.symbol} merged=${merged.status} hard=${merged.hardFlags.length} warnings=${merged.warnings.length} coverage=${merged.coverageNotes.length} sources=rpc,blockscout,goplus`);
  return merged;
}

export type { SecurityReport, SecurityStatus, BundleRisk } from "./types.js";
