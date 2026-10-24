import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { signJwt, jwtAuth, healthHandler, type JwtVariables } from '@omnimesh/node';

export interface UserRecord {
  email: string;
  passwordHash: string;
}

/** Replace with your database (Neon/Supabase). Compute nodes must not keep users in memory. */
export interface UserStore {
  findByEmail(email: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<boolean>;
}

/** Demo only: data lives in one process, so each node would see different users. */
export class MemoryUserStore implements UserStore {
  private users = new Map<string, UserRecord>();
  async findByEmail(email: string) {
    return this.users.get(email) ?? null;
  }
  async create(user: UserRecord) {
    if (this.users.has(user.email)) return false;
    this.users.set(user.email, user);
    return true;
  }
}

export interface AuthAppOptions {
  jwtSecret: string;
  users: UserStore;
  bcryptCost?: number;
  tokenTtlSeconds?: number;
  maxFailedLogins?: number;
  lockoutMs?: number;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function parseCredentials(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) return null;
  return { email: normalized, password };
}

export function createAuthApp(options: AuthAppOptions) {
  const { jwtSecret, users } = options;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET (>= 32 chars) is required');
  const cost = options.bcryptCost ?? 12;
  const tokenTtl = options.tokenTtlSeconds ?? 900; // short-lived access tokens limit damage from a leak
  const maxFailed = options.maxFailedLogins ?? 5;
  const lockoutMs = options.lockoutMs ?? 15 * 60_000;

  // Failed-login counters per IP and per account. Per process here; use shared Redis when
  // running several nodes so an attacker cannot spread guesses across them.
  const failures = new Map<string, { count: number; until: number }>();
  const isLocked = (k: string) => {
    const f = failures.get(k);
    if (!f) return false;
    if (Date.now() > f.until) {
      failures.delete(k);
      return false;
    }
    return f.count >= maxFailed;
  };
  const recordFailure = (k: string) => {
    if (failures.size > 100_000) failures.clear();
    const f = failures.get(k);
    if (!f || Date.now() > f.until) failures.set(k, { count: 1, until: Date.now() + lockoutMs });
    else f.count++;
  };

  // Compared against when the email is unknown, so response time does not reveal which emails exist
  const dummyHash = bcrypt.hashSync('omnimesh-timing-equalizer', cost);
  const invalid = { error: 'Invalid email or password', code: 'ERR_INVALID_CREDENTIALS' };

  const app = new Hono<{ Variables: JwtVariables }>();
  app.get('/health', healthHandler({ providerId: 'auth-service' }));

  app.post('/auth/signup', async (c) => {
    const creds = parseCredentials(await c.req.json().catch(() => null));
    if (!creds) return c.json({ error: 'A valid email and password are required', code: 'ERR_BAD_REQUEST' }, 400);
    // bcrypt only uses the first 72 bytes
    const bytes = new TextEncoder().encode(creds.password).length;
    if (creds.password.length < 10 || bytes > 72) {
      return c.json({ error: 'Password must be 10 to 72 characters', code: 'ERR_WEAK_PASSWORD' }, 400);
    }
    await users.create({ email: creds.email, passwordHash: await bcrypt.hash(creds.password, cost) });
    // Same answer whether or not the account already existed, so signup cannot be used to probe emails
    return c.json({ status: 'ok' }, 201);
  });

  app.post('/auth/login', async (c) => {
    const creds = parseCredentials(await c.req.json().catch(() => null));
    if (!creds) return c.json({ error: 'A valid email and password are required', code: 'ERR_BAD_REQUEST' }, 400);

    const ipKey = `ip:${c.req.header('cf-connecting-ip') || 'unknown'}`;
    const accountKey = `acct:${creds.email}`;
    if (isLocked(ipKey) || isLocked(accountKey)) {
      c.header('Retry-After', String(Math.ceil(lockoutMs / 1000)));
      return c.json({ error: 'Too many attempts. Try again later.', code: 'ERR_RATE_LIMITED' }, 429);
    }

    const user = await users.findByEmail(creds.email);
    const ok = await bcrypt.compare(creds.password, user?.passwordHash ?? dummyHash);
    if (!user || !ok) {
      recordFailure(ipKey);
      recordFailure(accountKey);
      return c.json(invalid, 401);
    }

    failures.delete(accountKey);
    const token = await signJwt({ sub: user.email }, jwtSecret, { expiresInSeconds: tokenTtl });
    return c.json({ token, tokenType: 'Bearer', expiresIn: tokenTtl });
  });

  app.get('/auth/me', jwtAuth({ secret: jwtSecret }) as any, (c) => c.json({ user: c.get('user') }));

  return app;
}
