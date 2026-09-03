import type { TokenSnapshot } from "../types/index.js";
import { getGoPlusSecurityReport } from "./goplus.js";
import { getRobinhoodBlockscoutReport } from "./blockscout.js";
import type { SecurityReport, SecurityStatus } from "./types.js";

function uniq(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function recalcStatus(report: SecurityReport): SecurityStatus {
  if (report.hardFlags.length) return "FAIL";
  if (report.coverageNotes.length) return "UNKNOWN";
  if (report.warnings.length) return "WARN";
  return "PASS";
}

export async function getSecurityReport(token: TokenSnapshot): Promise<SecurityReport> {
  const goPlus = await getGoPlusSecurityReport(token);
  if (token.chainId !== "robinhood") return goPlus;

  const blockscout = await getRobinhoodBlockscoutReport(token);
  const coverageNotes = [...goPlus.coverageNotes];
  const warnings = [...goPlus.warnings];
  const positives = [...goPlus.positives];

  // Blockscout is our independent Robinhood source-verification check.
  // If Blockscout verifies the source, remove only the GoPlus source-verification
  // coverage gap. Any missing honeypot/tax/sellability fields remain UNKNOWN.
  if (blockscout.checked && blockscout.sourceVerified === true) {
    for (let i = coverageNotes.length - 1; i >= 0; i -= 1) {
      if (/source|open source|verification/i.test(coverageNotes[i])) coverageNotes.splice(i, 1);
    }
    positives.push("Source verified independently on Robinhood Blockscout");
  } else if (blockscout.checked && blockscout.sourceVerified === false) {
    for (let i = coverageNotes.length - 1; i >= 0; i -= 1) {
      if (/source|open source|verification/i.test(coverageNotes[i])) coverageNotes.splice(i, 1);
    }
    coverageNotes.push("Contract source is not verified on Robinhood Blockscout");
  } else if (!blockscout.checked) {
    coverageNotes.push(...blockscout.notes);
  } else {
    coverageNotes.push("Robinhood Blockscout did not return source-verification status");
  }

  if (blockscout.proxy === true && goPlus.proxy !== true) warnings.push("Blockscout reports a proxy/implementation contract");

  const merged: SecurityReport = {
    ...goPlus,
    provider: "GoPlus + Blockscout",
    checked: goPlus.checked || blockscout.checked,
    sourceVerified: blockscout.sourceVerified,
    proxy: goPlus.proxy === true || blockscout.proxy === true ? true : goPlus.proxy,
    creatorAddress: blockscout.creatorAddress,
    creationTransactionHash: blockscout.creationTransactionHash,
    deployerName: blockscout.deployerName,
    deployerIsContract: blockscout.deployerIsContract,
    deployerVerified: blockscout.deployerVerified,
    warnings: uniq(warnings),
    positives: uniq(positives),
    coverageNotes: uniq(coverageNotes),
    raw: { goPlus: goPlus.raw, blockscout: blockscout.raw }
  };
  merged.status = recalcStatus(merged);

  console.log(`[Security] robinhood:${token.symbol} merged=${merged.status} verified=${merged.sourceVerified ?? "n/a"} hard=${merged.hardFlags.length} warnings=${merged.warnings.length} coverage=${merged.coverageNotes.length}`);
  return merged;
}

export type { SecurityReport, SecurityStatus, BundleRisk } from "./types.js";
