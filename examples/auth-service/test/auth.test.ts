import { describe, it, expect } from 'vitest';
import { createAuthApp, MemoryUserStore } from '../src/app.js';
import { verifyJwt } from '@omnimesh/node';

const JWT_SECRET = 'j'.repeat(32);
const post = (app: any, path: string, body: unknown, ip = '198.51.100.1') =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });

describe('[H-2] auth-service reference example', () => {
  const make = () => createAuthApp({ jwtSecret: JWT_SECRET, users: new MemoryUserStore(), bcryptCost: 4 });

  it('only issues a token for the right password', async () => {
    const app = make();
    expect((await post(app, '/auth/signup', { email: 'a@x.io', password: 'correct horse battery' })).status).toBe(201);
    expect((await post(app, '/auth/login', { email: 'a@x.io', password: 'wrong password!!' })).status).toBe(401);

    const ok = await post(app, '/auth/login', { email: 'a@x.io', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    const { token, expiresIn } = (await ok.json()) as any;
    expect(expiresIn).toBeLessThanOrEqual(900);
    expect((await verifyJwt(token, JWT_SECRET)).sub).toBe('a@x.io');
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const app = make();
    await post(app, '/auth/signup', { email: 'a@x.io', password: 'correct horse battery' });
    const unknown = await (await post(app, '/auth/login', { email: 'nobody@x.io', password: 'whatever12' })).json();
    const wrong = await (await post(app, '/auth/login', { email: 'a@x.io', password: 'whatever12' })).json();
    expect(unknown).toEqual(wrong);
  });

  it('rate-limits brute force per account even across many IPs', async () => {
    const app = make();
    await post(app, '/auth/signup', { email: 'a@x.io', password: 'correct horse battery' });
    for (let i = 0; i < 5; i++) await post(app, '/auth/login', { email: 'a@x.io', password: `guess-${i}xx` }, `203.0.113.${i}`);
    const blocked = await post(app, '/auth/login', { email: 'a@x.io', password: 'correct horse battery' }, '203.0.113.99');
    expect(blocked.status).toBe(429);
  });

  it('rejects weak passwords and malformed bodies', async () => {
    const app = make();
    expect((await post(app, '/auth/signup', { email: 'a@x.io', password: 'short' })).status).toBe(400);
    expect((await post(app, '/auth/login', 'not-an-object')).status).toBe(400);
  });
});
