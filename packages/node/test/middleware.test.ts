import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  gatewayAuth,
  validateGatewaySecretOrThrow,
  signJwt,
  verifyJwt,
  jwtAuth,
  idempotency,
  MemoryIdempotencyStore,
  UpstashRedisIdempotencyStore,
  healthHandler,
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
});
