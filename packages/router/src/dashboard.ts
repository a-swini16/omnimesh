import type { Hono } from 'hono';
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from './dashboard-assets.generated.js';

/**
 * Operator dashboard at /_omnimesh/dashboard. The page holds no data: its script reads the
 * token-protected status and catalog APIs with the token the operator types in.
 * Sources live in packages/router/dashboard/ and are bundled by `pnpm build:dashboard`.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export function registerDashboard(app: Hono, enabled: () => boolean): void {
  const serve = (body: string, type: string) => (c: any) =>
    enabled()
      ? c.body(body, 200, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8` })
      : c.json({ error: 'Not Found' }, 404);

  app.get('/_omnimesh/dashboard', serve(DASHBOARD_HTML, 'text/html'));
  app.get('/_omnimesh/dashboard/app.css', serve(DASHBOARD_CSS, 'text/css'));
  app.get('/_omnimesh/dashboard/app.js', serve(DASHBOARD_JS, 'text/javascript'));
}
