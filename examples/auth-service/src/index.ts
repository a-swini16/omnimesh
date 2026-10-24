import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth, signJwt, jwtAuth, healthHandler } from '@omnimesh/node';

const app = new Hono();
const JWT_SECRET = process.env.JWT_SECRET || 'shared_jwt_secret_min_32_characters_long_for_security';

app.use('*', gatewayAuth());
app.get('/health', healthHandler({ providerId: 'auth-service' }));

// 1. Issue stateless JWT without hitting a database (<1ms CPU time)
app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json() as any;

  // In production: verify against hashed credentials
  if (!email || !password) {
    return c.json({ error: 'Email and password required' }, 400);
  }

  const token = await signJwt(
    { sub: email, role: 'developer', permissions: ['read', 'write'] },
    JWT_SECRET,
    { expiresInSeconds: 86400 } // 24 hours
  );

  return c.json({
    token,
    tokenType: 'Bearer',
    expiresIn: 86400,
  });
});

// 2. Route protected by stateless JWT verification
app.get('/auth/me', jwtAuth({ secret: JWT_SECRET }), (c) => {
  const user = c.get('user');
  return c.json({ user });
});

const port = Number(process.env.PORT) || 3001;
console.log(`[OmniMesh Auth Service] Running on port ${port}...`);

serve({ fetch: app.fetch, port });
