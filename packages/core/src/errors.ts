/**
 * OmniMesh Standardized Error Hierarchy
 */

export class OmniMeshError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code = 'OMNIMESH_ERROR', statusCode = 500) {
    super(message);
    this.name = 'OmniMeshError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GatewaySecretError extends OmniMeshError {
  constructor(message = 'Unauthorized: Invalid or missing X-Gateway-Secret header') {
    super(message, 'ERR_GATEWAY_SECRET_INVALID', 403);
    this.name = 'GatewaySecretError';
  }
}

export class TimeoutError extends OmniMeshError {
  public readonly upstreamUrl: string;
  public readonly timeoutMs: number;

  constructor(upstreamUrl: string, timeoutMs: number) {
    super(`Upstream request to ${upstreamUrl} timed out after ${timeoutMs}ms`, 'ERR_UPSTREAM_TIMEOUT', 504);
    this.name = 'TimeoutError';
    this.upstreamUrl = upstreamUrl;
    this.timeoutMs = timeoutMs;
  }
}

export class CircuitBreakerOpenError extends OmniMeshError {
  public readonly upstreamUrl: string;

  constructor(upstreamUrl: string) {
    super(`Circuit breaker open for upstream node: ${upstreamUrl}`, 'ERR_CIRCUIT_BREAKER_OPEN', 503);
    this.name = 'CircuitBreakerOpenError';
    this.upstreamUrl = upstreamUrl;
  }
}

export class BudgetExceededError extends OmniMeshError {
  public readonly attempts: number;
  public readonly totalBudgetMs: number;

  constructor(attempts: number, totalBudgetMs: number) {
    super(
      `OmniMesh failover budget exhausted (${attempts} attempts, ${totalBudgetMs}ms budget)`,
      'ERR_BUDGET_EXCEEDED',
      503
    );
    this.name = 'BudgetExceededError';
    this.attempts = attempts;
    this.totalBudgetMs = totalBudgetMs;
  }
}

export class IdempotencyRequiredError extends OmniMeshError {
  constructor(method: string, path: string) {
    super(
      `Unsafe mutation retry prevented: ${method} ${path} failed on upstream node and lacks an 'Idempotency-Key' header.`,
      'ERR_IDEMPOTENCY_KEY_REQUIRED',
      503
    );
    this.name = 'IdempotencyRequiredError';
  }
}

export class ConfigValidationError extends OmniMeshError {
  public readonly errors: unknown[];

  constructor(message: string, errors: unknown[] = []) {
    super(message, 'ERR_CONFIG_VALIDATION', 400);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

/**
 * Thrown by adapters whose deployment is not automated through the provider API.
 * The message tells the developer the real way to deploy, instead of reporting a fake success.
 */
export class DeployNotAutomatedError extends OmniMeshError {
  constructor(displayName: string, howToDeploy: string) {
    super(`${displayName}: automatic deploy is not implemented. ${howToDeploy}`, 'ERR_DEPLOY_NOT_AUTOMATED', 501);
    this.name = 'DeployNotAutomatedError';
  }
}
