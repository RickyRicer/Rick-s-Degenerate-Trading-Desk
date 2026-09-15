export type SecurityStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";
export type BundleRisk = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type EvidenceStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface SecurityEvidence {
  id: string;
  label: string;
  status: EvidenceStatus;
  source: string;
  detail: string;
  critical?: boolean;
}

export interface SecurityReport {
  provider: string;
  status: SecurityStatus;
  checked: boolean;
  hardFlags: string[];
  warnings: string[];
  positives: string[];
  coverageNotes: string[];
  evidence?: SecurityEvidence[];
  holderCount?: number;
  top10Percent?: number;
  ownerPercent?: number;
  creatorPercent?: number;
  buyTaxPercent?: number;
  sellTaxPercent?: number;
  isHoneypot?: boolean;
  cannotBuy?: boolean;
  cannotSellAll?: boolean;
  blacklist?: boolean;
  transferPausable?: boolean;
  modifiableTax?: boolean;
  openSource?: boolean;
  sourceVerified?: boolean;
  proxy?: boolean;
  mintable?: boolean;
  freezable?: boolean;
  liquidityLockedPercent?: number;
  creatorAddress?: string;
  creationTransactionHash?: string;
  deployerName?: string;
  deployerIsContract?: boolean;
  deployerVerified?: boolean;
  deployerIsKnownInfrastructure?: boolean;
  deployerInfrastructureName?: string;
  deployerInfrastructureKind?: "launchpad" | "router" | "factory";
  deployerInfrastructureConfidence?: "HIGH" | "MEDIUM";
  deployerScanCount?: number;
  relatedDeployments?: string[];
  rpcChecked?: boolean;
  ownerAddress?: string;
  paused?: boolean;
  top1Percent?: number;
  holderIntelSource?: string;
  implementationAddress?: string;
  implementationName?: string;
  implementationVerified?: boolean;
  inspectedContractAddress?: string;
  abiFunctionNames?: string[];
  abiCapabilities?: string[];
  bundleRisk: BundleRisk;
  bundleNotes: string[];
  raw?: unknown;
}
