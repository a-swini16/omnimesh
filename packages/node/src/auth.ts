import type { Context, Next } from 'hono';

// Base64Url helpers using standard global crypto
function base64UrlEncode(buffer: Uint8Array): string {
  let str = '';
  for (let i = 0; i < buffer.length; i++) {
    str += String.fromCharCode(buffer[i]);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Sign a stateless HS256 JWT using Web Crypto
 */
export async function signJwt(
  payload: Record<string, any>,
  secret: string,
  options: { expiresInSeconds?: number } = {}
): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: Record<string, any> = {
    ...payload,
    iat: now,
  };
  if (options.expiresInSeconds) {
    fullPayload.exp = now + options.expiresInSeconds;
  }

  const encodedHeader = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(enc.encode(JSON.stringify(fullPayload)));
  const data = `${encodedHeader}.${encodedPayload}`;

  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

  return `${data}.${encodedSignature}`;
}

/**
 * Verify a stateless HS256 JWT using Web Crypto (<1ms CPU time)
 */
export async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  // Pin the algorithm so a forged header (e.g. alg: none) can never change how we verify
  if (header?.alg !== 'HS256') {
    throw new Error('Unsupported JWT algorithm');
  }
  const enc = new TextEncoder();
  const data = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  const key = await getHmacKey(secret);
  const isValid = await crypto.subtle.verify('HMAC', key, signature as unknown as BufferSource, enc.encode(data));

  if (!isValid) {
    throw new Error('Invalid JWT signature');
  }

  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload = JSON.parse(payloadJson);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now > payload.exp) {
    throw new Error('JWT token has expired');
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new Error('JWT token is not yet valid');
  }

  return payload;
}

/** Hono context variables set by jwtAuth: `new Hono<{ Variables: JwtVariables }>()` */
export type JwtVariables = { user: Record<string, any> };

export interface JwtAuthOptions {
  secret?: string;
  optional?: boolean;
}

/**
 * Hono Middleware to verify stateless JWT on incoming requests.
 * Attaches decoded claims to `c.set('user', claims)`.
 */
export function jwtAuth(options: JwtAuthOptions = {}) {
  const secret = options.secret || process.env.JWT_SECRET;

  return async function jwtAuthMiddleware(c: Context, next: Next) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (options.optional) {
        return next();
      }
      return c.json({ error: 'Unauthorized: Missing or invalid Bearer token', code: 'ERR_AUTH_REQUIRED' }, 401);
    }

    if (!secret || secret.length < 32) {
      throw new Error('[OmniMesh] JWT_SECRET must be configured with at least 32 characters on this node');
    }

    const token = authHeader.substring(7).trim();
    try {
      const claims = await verifyJwt(token, secret);
      c.set('user', claims);
      await next();
    } catch {
      return c.json({ error: 'Unauthorized: Invalid token', code: 'ERR_TOKEN_INVALID' }, 401);
    }
  };
}
