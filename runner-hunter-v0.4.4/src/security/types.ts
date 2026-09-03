export type SecurityStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";
export type BundleRisk = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface SecurityReport {
  provider: string;
  status: SecurityStatus;
  checked: boolean;
  hardFlags: string[];
  warnings: string[];
  positives: string[];
  coverageNotes: string[];
  holderCount?: number;
  top10Percent?: number;
  ownerPercent?: number;
  creatorPercent?: number;
  buyTaxPercent?: number;
  sellTaxPercent?: number;
  isHoneypot?: boolean;
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
  deployerScanCount?: number;
  relatedDeployments?: string[];
  bundleRisk: BundleRisk;
  bundleNotes: string[];
  raw?: unknown;
}
