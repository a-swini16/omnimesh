import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth, omniErrorHandler } from '@omnimesh/node';
import { createAuthApp, MemoryUserStore } from './app.js';

// Password hashing is CPU-heavy: run this on a compute node (Oracle/Koyeb/Render), never inside the edge Worker
const app = new Hono();
app.onError(omniErrorHandler);
app.use('*', gatewayAuth());
app.route('/', createAuthApp({ jwtSecret: process.env.JWT_SECRET ?? '', users: new MemoryUserStore() }));

const port = Number(process.env.PORT) || 3001;
console.log(`[OmniMesh Auth Service] Running on port ${port}...`);

serve({ fetch: app.fetch, port });
