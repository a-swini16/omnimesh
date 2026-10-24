import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  gatewayAuth,
  expressGatewayAuth,
  validateGatewaySecretOrThrow,
  signJwt,
  verifyJwt,
  jwtAuth,
  idempotency,
  MemoryIdempotencyStore,
  UpstashRedisIdempotencyStore,
  healthHandler,
  omniErrorHandler,
} from '../src/index.js';

const TEST_SECRET = 'a'.repeat(32); // 32 characters secure secret
const WRONG_SECRET = 'b'.repeat(32);

describe('@omnimesh/node Middleware Suite', () => {
  describe('Origin Gateway Authentication', () => {
    it('throws error if secret is less than 32 characters', () => {
      expect(() => validateGatewaySecretOrThrow('short-secret')).toThrow(
        /OmniMesh Security Violation/
      );
    });

    it('rejects requests without X-Gateway-Secret with 403', async () => {
      const app = new Hono();
      app.use('*', gatewayAuth({ secret: TEST_SECRET }));
      app.get('/api/test', (c) => c.text('ok'));

      const res = await app.request('/api/test');
      expect(res.status).toBe(403);
      const json = await res.json() as { code: string };
      expect(json.code).toBe('ERR_GATEWAY_SECRET_INVALID');
    });

    it('rejects requests with incorrect X-Gateway-Secret with 403', async () => {
      const app = new Hono();
      app.use('*', gatewayAuth({ secret: TEST_SECRET }));
      app.get('/api/test', (c) => c.text('ok'));

      const res = await app.request('/api/test', {
        headers: { 'X-Gateway-Secret': WRONG_SECRET },
      });
      expect(res.status).toBe(403);
    });

    it('allows requests with valid X-Gateway-Secret', async () => {
      const app = new Hono();
      app.use('*', gatewayAuth({ secret: TEST_SECRET }));
      app.get('/api/test', (c) => c.text('ok'));

      const res = await app.request('/api/test', {
        headers: { 'X-Gateway-Secret': TEST_SECRET },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });
  });

  describe('Stateless JWT Authentication', () => {
    it('signs and verifies valid JWT claims', async () => {
      const claims = { sub: 'usr_123', role: 'developer' };
      const token = await signJwt(claims, TEST_SECRET, { expiresInSeconds: 60 });
      const verified = await verifyJwt(token, TEST_SECRET);

      expect(verified.sub).toBe('usr_123');
      expect(verified.role).toBe('developer');
      expect(verified.exp).toBeDefined();
    });

    it('rejects invalid or tampered JWT', async () => {
      const token = await signJwt({ sub: 'usr_123' }, TEST_SECRET);
      await expect(verifyJwt(token, WRONG_SECRET)).rejects.toThrow();
    });

    it('jwtAuth middleware secures routes', async () => {
      const app = new Hono<{ Variables: { user: any } }>();
      app.use('/protected/*', jwtAuth({ secret: TEST_SECRET }));
      app.get('/protected/profile', (c) => {
        const user = c.get('user');
        return c.json({ user });
      });

      // No token -> 401
      const unauth = await app.request('/protected/profile');
      expect(unauth.status).toBe(401);

      // Valid token -> 200
      const token = await signJwt({ id: 'u1' }, TEST_SECRET);
      const authRes = await app.request('/protected/profile', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(authRes.status).toBe(200);
      const json = await authRes.json() as any;
      expect(json.user.id).toBe('u1');
    });
  });

  describe('Distributed Idempotency Engine', () => {
    it('executes fresh mutating request and caches result', async () => {
      const app = new Hono();
      const store = new MemoryIdempotencyStore();
      let callCount = 0;

      app.use('*', idempotency({ store }));
      app.post('/api/charge', async (c) => {
        callCount++;
        return c.json({ orderId: 'ord_123', count: callCount }, 201);
      });

      const key = 'idem_uuid_1001';

      // First call
      const res1 = await app.request('/api/charge', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
      });
      expect(res1.status).toBe(201);
      const json1 = await res1.json() as any;
      expect(json1.count).toBe(1);

      // Replay identical call
      const res2 = await app.request('/api/charge', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
      });
      expect(res2.status).toBe(201);
      expect(res2.headers.get('X-Omni-Idempotent-Replay')).toBe('true');
      const json2 = await res2.json() as any;
      expect(json2.count).toBe(1); // Call count was not incremented!
      expect(callCount).toBe(1);   // Backend was not executed twice!
    });
  });

  describe('Standard /health Route', () => {
    it('returns healthy status and metadata', async () => {
      const app = new Hono();
      app.get('/health', healthHandler({ providerId: 'koyeb' }));

      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('healthy');
      expect(json.provider).toBe('koyeb');
      expect(json.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('hardening', () => {
    it('rejects JWTs whose header claims a different algorithm', async () => {
      const token = await signJwt({ sub: 'u' }, TEST_SECRET);
      const [, payload, sig] = token.split('.');
      const noneHeader = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '');
      await expect(verifyJwt(`${noneHeader}.${payload}.${sig}`, TEST_SECRET)).rejects.toThrow(/algorithm/);
    });

    it('scopes idempotency keys per caller so users cannot read each other\'s replays', async () => {
      const app = new Hono();
      app.use('*', idempotency({ store: new MemoryIdempotencyStore() }));
      app.post('/api/charge', (c) => c.json({ owner: c.req.header('authorization') }, 201));
      await app.request('/api/charge', { method: 'POST', headers: { 'Idempotency-Key': 'k1', Authorization: 'Bearer alice' } });
      const res = await app.request('/api/charge', { method: 'POST', headers: { 'Idempotency-Key': 'k1', Authorization: 'Bearer mallory' } });
      expect(res.headers.get('X-Omni-Idempotent-Replay')).toBeNull();
      expect(((await res.json()) as any).owner).toBe('Bearer mallory');
    });

    it('UpstashRedisIdempotencyStore fails closed when not configured', () => {
      expect(() => new UpstashRedisIdempotencyStore('', '')).toThrow(/required/);
    });
  });

  describe('[C-1] idempotency store must be shared across nodes', () => {
    it('refuses the per-process memory default in production (a failover retry would charge twice)', () => {
      const prev = process.env.NODE_ENV;
      const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
      process.env.NODE_ENV = 'production';
      delete process.env.UPSTASH_REDIS_REST_URL;
      try {
        expect(() => idempotency()).toThrow(/shared/);
      } finally {
        process.env.NODE_ENV = prev;
        if (prevUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      }
    });

    it('two nodes sharing one store run a retried write exactly once', async () => {
      const store = new MemoryIdempotencyStore(); // stands in for shared Redis
      let writes = 0;
      const makeNode = () => {
        const app = new Hono();
        app.use('*', idempotency({ store }));
        app.post('/api/pay', (c) => { writes++; return c.json({ ok: true }, 201); });
        return app;
      };
      const nodeA = makeNode();
      const nodeB = makeNode();
      const req = { method: 'POST', headers: { 'Idempotency-Key': 'pay-1' }, body: '{"amount":50}' };
      await nodeA.request('/api/pay', req);
      const retry = await nodeB.request('/api/pay', req); // router failover lands on node B
      expect(retry.headers.get('X-Omni-Idempotent-Replay')).toBe('true');
      expect(writes).toBe(1);
    });
  });

  it('[H-1] rejects the same Idempotency-Key with a different body instead of replaying', async () => {
    const app = new Hono();
    let orders = 0;
    app.use('*', idempotency({ store: new MemoryIdempotencyStore() }));
    app.post('/api/orders', async (c) => { orders++; return c.json(await c.req.json(), 201); });
    const send = (body: string) =>
      app.request('/api/orders', { method: 'POST', headers: { 'Idempotency-Key': 'o-1', 'Content-Type': 'application/json' }, body });

    expect((await send('{"item":"phone"}')).status).toBe(201);
    expect((await send('{"item":"phone"}')).headers.get('X-Omni-Idempotent-Replay')).toBe('true');
    const reused = await send('{"item":"laptop"}');
    expect(reused.status).toBe(422);
    expect(((await reused.json()) as any).code).toBe('ERR_IDEMPOTENCY_KEY_REUSED');
    expect(orders).toBe(1);
  });

  it('[H-7] omniErrorHandler turns malformed JSON into 400 and hides internal errors', async () => {
    const app = new Hono();
    app.onError(omniErrorHandler);
    app.post('/api/items', async (c) => c.json(await c.req.json(), 201));
    app.get('/api/crash', () => { throw new Error('db password=hunter2 at 10.0.0.5'); });

    const bad = await app.request('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"broken' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).code).toBe('ERR_BAD_JSON');

    const crash = await app.request('/api/crash');
    expect(crash.status).toBe(500);
    expect(await crash.text()).not.toContain('hunter2');
  });

  describe('[M-2] gateway secret rotation', () => {
    const CURRENT = 'c'.repeat(32);
    const PREVIOUS = 'p'.repeat(32);
    const app = () => {
      const a = new Hono();
      a.use('*', gatewayAuth({ secret: CURRENT, previousSecrets: [PREVIOUS] }));
      a.get('/x', (c) => c.text('ok'));
      return a;
    };
    const call = (secret: string) => app().request('/x', { headers: { 'X-Gateway-Secret': secret } });

    it('accepts the current and the previous secret during a rotation window, nothing else', async () => {
      expect((await call(CURRENT)).status).toBe(200);
      expect((await call(PREVIOUS)).status).toBe(200);
      expect((await call('z'.repeat(32))).status).toBe(403);
    });

    it('reads GATEWAY_SECRET_PREVIOUS from the environment and rejects weak previous secrets', async () => {
      process.env.GATEWAY_SECRET_PREVIOUS = PREVIOUS;
      try {
        const a = new Hono();
        a.use('*', gatewayAuth({ secret: CURRENT }));
        a.get('/x', (c) => c.text('ok'));
        expect((await a.request('/x', { headers: { 'X-Gateway-Secret': PREVIOUS } })).status).toBe(200);
      } finally {
        delete process.env.GATEWAY_SECRET_PREVIOUS;
      }
      expect(() => gatewayAuth({ secret: CURRENT, previousSecrets: ['short'] })).toThrow(/32/);
    });

    it('the Express middleware supports rotation too', () => {
      const mw = expressGatewayAuth({ secret: CURRENT, previousSecrets: [PREVIOUS] });
      let passed = false;
      mw({ headers: { 'x-gateway-secret': PREVIOUS } }, { status: () => ({ json: () => {} }) }, () => { passed = true; });
      expect(passed).toBe(true);
    });
  });

  describe('[M-4] JWT claims', () => {
    const S = TEST_SECRET;

    it('signs with a 15-minute expiry by default and rejects tokens without exp', async () => {
      const claims = await verifyJwt(await signJwt({ sub: 'u' }, S), S);
      expect(claims.exp - claims.iat).toBe(900);
      const forever = await signJwt({ sub: 'u' }, S, { expiresInSeconds: null });
      await expect(verifyJwt(forever, S)).rejects.toThrow(/exp/);
    });

    it('allows small clock skew (30 s) but not more', async () => {
      await expect(verifyJwt(await signJwt({ sub: 'u' }, S, { expiresInSeconds: -10 }), S)).resolves.toBeTruthy();
      await expect(verifyJwt(await signJwt({ sub: 'u' }, S, { expiresInSeconds: -120 }), S)).rejects.toThrow(/expired/);
    });

    it('checks issuer and audience when configured, including in jwtAuth', async () => {
      const token = await signJwt({ sub: 'u' }, S, { issuer: 'omnimesh-auth', audience: 'api' });
      await expect(verifyJwt(token, S, { issuer: 'omnimesh-auth', audience: 'api' })).resolves.toBeTruthy();
      await expect(verifyJwt(token, S, { audience: 'billing' })).rejects.toThrow(/audience/);
      await expect(verifyJwt(token, S, { issuer: 'evil' })).rejects.toThrow(/issuer/);

      const app = new Hono();
      app.use('*', jwtAuth({ secret: S, audience: 'billing' }));
      app.get('/x', (c) => c.text('ok'));
      expect((await app.request('/x', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    });
  });
});
