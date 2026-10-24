export interface BufferedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: ArrayBuffer | ReadableStream<Uint8Array> | null;
  bodyBuffer: ArrayBuffer | null;
  canRetry: boolean;
  hasIdempotencyKey: boolean;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Buffer incoming request body safely.
 * Payloads <= maxBufferBytes are buffered for safe failover retry.
 * Larger payloads are streamed directly without retry capability.
 */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export async function prepareBufferedRequest(
  request: Request,
  maxBufferBytes = 1048576,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
): Promise<BufferedRequest> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);

  const idempotencyKey = headers.get('idempotency-key') || headers.get('Idempotency-Key');
  const hasIdempotencyKey = Boolean(idempotencyKey);

  // GET and HEAD have no body
  if (['GET', 'HEAD'].includes(method)) {
    return {
      method,
      url,
      headers,
      body: null,
      bodyBuffer: null,
      canRetry: true,
      hasIdempotencyKey,
    };
  }

  const contentLengthHeader = headers.get('content-length');
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

  // Nothing above the hard cap reaches a node: free tiers pay for that bandwidth and memory
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw new BodyTooLargeError(maxBodyBytes);
  }

  // If payload exceeds buffer limit, stream directly without buffering
  if (contentLength !== null && contentLength > maxBufferBytes) {
    return {
      method,
      url,
      headers,
      body: request.body,
      bodyBuffer: null,
      canRetry: false, // Cannot replay unbuffered streams
      hasIdempotencyKey,
    };
  }

  // Buffer into memory, but never read more than maxBufferBytes: a chunked body with no
  // Content-Length could otherwise exhaust the isolate's memory
  const bodyBuffer = await readBodyWithLimit(request, maxBufferBytes);

  // Retries are safe for idempotent methods OR if an Idempotency-Key is provided
  const isSafeMethod = IDEMPOTENT_METHODS.has(method);
  const canRetry = isSafeMethod || hasIdempotencyKey;

  return {
    method,
    url,
    headers,
    body: bodyBuffer,
    bodyBuffer,
    canRetry,
    hasIdempotencyKey,
  };
}

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

async function readBodyWithLimit(request: Request, limit: number): Promise<ArrayBuffer | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Executes a single fetch request wrapped in an AbortController timeout.
 */
export async function fetchWithTimeout(
  targetUrl: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(targetUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
