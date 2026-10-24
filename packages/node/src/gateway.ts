import type { Context, Next } from 'hono';

export interface GatewayAuthOptions {
  secret?: string;
  /**
   * Secrets still accepted while a rotation is in progress (default: GATEWAY_SECRET_PREVIOUS, comma-separated).
   * Rotate by deploying nodes with the new secret plus the old one here, then the router, then removing the old one.
   */
  previousSecrets?: string[];
  headerName?: string;
}

/** Current secret plus any previous ones, all validated as strong. */
function acceptedSecrets(options: GatewayAuthOptions): string[] {
  const previous =
    options.previousSecrets ??
    (process.env.GATEWAY_SECRET_PREVIOUS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [validateGatewaySecretOrThrow(options.secret), ...previous.map((p) => validateGatewaySecretOrThrow(p))];
}

/** Compares against every accepted secret without stopping early, so timing reveals nothing. */
function matchesAny(provided: string, secrets: string[]): boolean {
  let ok = false;
  for (const secret of secrets) ok = timingSafeEqual(provided, secret) || ok;
  return ok;
}

/**
 * Validate that the gateway secret is cryptographically secure.
 * Rejects startup if secret is missing or under 32 characters.
 */
export function validateGatewaySecretOrThrow(secret?: string): string {
  const resolved = secret || process.env.GATEWAY_SECRET;
  if (!resolved || typeof resolved !== 'string' || resolved.trim().length < 32) {
    throw new Error(
      '[OmniMesh Security Violation] GATEWAY_SECRET is required and must be at least 32 characters long. ' +
      'Fail-closed policy prevents running backend nodes without origin protection.'
    );
  }
  return resolved.trim();
}

/**
 * Constant-time string comparison so the secret cannot be guessed byte-by-byte via response timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

/**
 * Hono Middleware to enforce X-Gateway-Secret validation.
 * Unauthenticated requests are immediately blocked with 403 Forbidden.
 */
export function gatewayAuth(options: GatewayAuthOptions = {}) {
  const secrets = acceptedSecrets(options);
  const headerName = (options.headerName || 'X-Gateway-Secret').toLowerCase();

  return async function gatewayAuthMiddleware(c: Context, next: Next) {
    // Standard bypass for health checks if explicitly allowed or check header
    const providedSecret = c.req.header(headerName);

    if (!providedSecret || !matchesAny(providedSecret, secrets)) {
      return c.json(
        {
          error: 'Forbidden: Missing or invalid origin authentication header.',
          code: 'ERR_GATEWAY_SECRET_INVALID',
          hint: 'Backend nodes only accept traffic routed through the OmniMesh Edge Router.',
        },
        403
      );
    }

    await next();
  };
}

/**
 * Express / Connect compatible middleware for X-Gateway-Secret verification.
 */
export function expressGatewayAuth(options: GatewayAuthOptions = {}) {
  const secrets = acceptedSecrets(options);
  const headerName = (options.headerName || 'x-gateway-secret').toLowerCase();

  return function expressGatewayAuthMiddleware(req: any, res: any, next: any) {
    const provided = req.headers[headerName];
    if (typeof provided !== 'string' || !matchesAny(provided, secrets)) {
      return res.status(403).json({
        error: 'Forbidden: Missing or invalid origin authentication header.',
        code: 'ERR_GATEWAY_SECRET_INVALID',
        hint: 'Backend nodes only accept traffic routed through the OmniMesh Edge Router.',
      });
    }
    next();
  };
}
