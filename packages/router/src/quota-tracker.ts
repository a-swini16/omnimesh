import type { ProviderLimits, UsageSnapshot } from '@omnimesh/core';

export interface QuotaTracker {
  canAcceptTraffic(providerId: string, limits?: ProviderLimits): Promise<boolean>;
  recordRequest(providerId: string, bytes?: number): Promise<void>;
  getUsage(providerId: string, limits?: ProviderLimits): Promise<UsageSnapshot>;
  reset?(): Promise<void>;
}

export class MemoryQuotaTracker implements QuotaTracker {
  private dailyCounts = new Map<string, { count: number; dateStr: string }>();
  private monthlyCounts = new Map<string, { count: number; monthStr: string }>();

  private getTodayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getMonthStr(): string {
    return new Date().toISOString().slice(0, 7);
  }

  async canAcceptTraffic(providerId: string, limits?: ProviderLimits): Promise<boolean> {
    if (!limits) return true;

    const todayStr = this.getTodayStr();
    const today = this.dailyCounts.get(providerId);
    const dayCount = (today && today.dateStr === todayStr) ? today.count : 0;

    // If daily limit defined, proactively divert at 95% of limit to avoid 429
    if (limits.requestsPerDay && dayCount >= limits.requestsPerDay * 0.95) {
      return false;
    }

    const monthStr = this.getMonthStr();
    const month = this.monthlyCounts.get(providerId);
    const monthCount = (month && month.monthStr === monthStr) ? month.count : 0;

    // If monthly limit defined, divert at 95%
    if (limits.requestsPerMonth && monthCount >= limits.requestsPerMonth * 0.95) {
      return false;
    }

    return true;
  }

  async recordRequest(providerId: string, _bytes?: number): Promise<void> {
    const todayStr = this.getTodayStr();
    const today = this.dailyCounts.get(providerId);
    if (!today || today.dateStr !== todayStr) {
      this.dailyCounts.set(providerId, { count: 1, dateStr: todayStr });
    } else {
      today.count += 1;
    }

    const monthStr = this.getMonthStr();
    const month = this.monthlyCounts.get(providerId);
    if (!month || month.monthStr !== monthStr) {
      this.monthlyCounts.set(providerId, { count: 1, monthStr: monthStr });
    } else {
      month.count += 1;
    }
  }

  async getUsage(providerId: string, limits?: ProviderLimits): Promise<UsageSnapshot> {
    const todayStr = this.getTodayStr();
    const today = this.dailyCounts.get(providerId);
    const requestsToday = (today && today.dateStr === todayStr) ? today.count : 0;

    const monthStr = this.getMonthStr();
    const month = this.monthlyCounts.get(providerId);
    const requestsThisMonth = (month && month.monthStr === monthStr) ? month.count : 0;

    let quotaPercentUsed = 0;
    if (limits?.requestsPerDay) {
      quotaPercentUsed = Math.min(100, Math.round((requestsToday / limits.requestsPerDay) * 100));
    } else if (limits?.requestsPerMonth) {
      quotaPercentUsed = Math.min(100, Math.round((requestsThisMonth / limits.requestsPerMonth) * 100));
    }

    return {
      providerId,
      requestsToday,
      requestsThisMonth,
      quotaPercentUsed,
      nearQuotaWarning: quotaPercentUsed >= 80,
      timestamp: new Date().toISOString(),
    };
  }

  async reset(): Promise<void> {
    this.dailyCounts.clear();
    this.monthlyCounts.clear();
  }
}
