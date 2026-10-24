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
export async function prepareBufferedRequest(
  request: Request,
  maxBufferBytes = 1048576
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

  // Safe to buffer into memory
  try {
    const bodyBuffer = await request.arrayBuffer();
    if (bodyBuffer.byteLength > maxBufferBytes) {
      return {
        method,
        url,
        headers,
        body: bodyBuffer,
        bodyBuffer: null,
        canRetry: false,
        hasIdempotencyKey,
      };
    }

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
  } catch {
    return {
      method,
      url,
      headers,
      body: null,
      bodyBuffer: null,
      canRetry: false,
      hasIdempotencyKey,
    };
  }
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
