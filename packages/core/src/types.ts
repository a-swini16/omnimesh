/**
 * OmniMesh Core Types
 * System Architecture v2 (October 2026)
 */

export type ProviderTier = 'free' | 'trial-credit' | 'paid';

export type ProviderRole =
  | 'edge-router'
  | 'compute'
  | 'database'
  | 'cache'
  | 'storage'
  | 'cron';

export interface ProviderLimits {
  requestsPerDay?: number;
  requestsPerMonth?: number;
  bandwidthGbPerMonth?: number;
  ramMb?: number;
  vCpu?: number;
  storageMb?: number;
  maxCpuExecutionMs?: number;
  sleepsIfIdle?: boolean;
  idleSleepMinutes?: number;
  lastVerified: string; // ISO date string (YYYY-MM-DD)
  sourceUrl: string;    // Official documentation/pricing URL
}

export interface UsageSnapshot {
  providerId: string;
  requestsToday?: number;
  requestsThisMonth?: number;
  bandwidthGbThisMonth?: number;
  storageMbUsed?: number;
  quotaPercentUsed: number; // 0 to 100
  nearQuotaWarning: boolean; // true if >= 80%
  timestamp: string;
}

export interface DeployResult {
  providerId: string;
  success: boolean;
  url: string;
  deploymentId: string;
  role: ProviderRole;
  logsUrl?: string;
  createdAt: string;
}

export interface ProviderAdapter {
  id: string;                    // e.g. "koyeb", "render", "oracle", "cloudflare"
  displayName: string;
  requiresCard: boolean;
  tier: ProviderTier;
  roles: ProviderRole[];
  limits: ProviderLimits;        // Loaded from limits.json, never hardcoded in logic
  validateCredentials(config: Record<string, string>): Promise<boolean>;
  deploy(appPath: string, config: Record<string, string>): Promise<DeployResult>;
  healthUrl(deployment: DeployResult | { url: string }): string;
  getUsage?(config: Record<string, string>): Promise<UsageSnapshot>;
  destroy(deployment: DeployResult, config: Record<string, string>): Promise<void>;
}

export type NodeHealthStatus = 'healthy' | 'degraded' | 'dead';

export interface NodeHealthInfo {
  url: string;
  status: NodeHealthStatus;
  lastChecked: number;
  latencyMs?: number;
  deadSince?: number;
  consecutiveFailures: number;
  failureReason?: string;
}

export interface SharedHealthStore {
  isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean>;
  markNodeDead(url: string, reason?: string): Promise<void>;
  markNodeHealthy(url: string, latencyMs?: number): Promise<void>;
  getAllNodeHealth(): Promise<Record<string, NodeHealthInfo>>;
}

export interface PoolRouteCandidate {
  url: string;
  providerId?: string;
  weight?: number;
  isBackup?: boolean;
}
