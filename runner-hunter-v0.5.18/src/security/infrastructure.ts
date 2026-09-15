import type { SecurityReport } from "./types.js";

export interface KnownInfrastructureMatch {
  id: string;
  label: string;
  kind: "launchpad" | "router" | "factory";
  confidence: "HIGH" | "MEDIUM";
  reason: string;
}

// Address-attested infrastructure only. Human-readable explorer labels are useful
// display metadata, but they are NOT an identity proof: labels can be stale,
// ambiguous, or applied to lookalike contracts. Never trust a name alone.
const PONS_V2_LAUNCH_DEPLOYER = "0x3711cea4feade896c913c68f01eda97cb06d1a42";
const PONS_V2_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";

function norm(address?: string) {
  return typeof address === "string" ? address.trim().toLowerCase() : "";
}

export function identifyKnownInfrastructure(
  report: Pick<SecurityReport, "creatorAddress" | "deployerName" | "deployerIsContract" | "deployerVerified">
): KnownInfrastructureMatch | undefined {
  const creator = norm(report.creatorAddress);

  if (creator === PONS_V2_LAUNCH_DEPLOYER) {
    return {
      id: "pons-v2",
      label: "Pons V2",
      kind: "launchpad",
      confidence: "HIGH",
      reason: `Creator address exactly matches the published Pons V2 Launch Deployer (${PONS_V2_LAUNCH_DEPLOYER})`
    };
  }

  // Some explorers may attribute creation to the factory itself depending on the
  // CREATE2/deployment trace they expose. Exact factory matching is also safe to
  // recognize as Pons infrastructure, but a mere "PonsV2LaunchDeployer" label
  // is intentionally ignored.
  if (creator === PONS_V2_FACTORY) {
    return {
      id: "pons-v2-factory",
      label: "Pons V2",
      kind: "factory",
      confidence: "HIGH",
      reason: `Creator address exactly matches the published Pons V2 Factory (${PONS_V2_FACTORY})`
    };
  }

  return undefined;
}
