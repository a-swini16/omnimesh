import type { Context } from 'hono';

/**
 * Hono `app.onError` handler for compute nodes.
 * Malformed JSON becomes a 400 instead of a 500, so bad input from one client is not treated as a
 * broken node, and internal errors are logged but never sent to clients (they can hold SQL, hosts or secrets).
 *
 *   app.onError(omniErrorHandler);
 */
export function omniErrorHandler(err: Error, c: Context): Response | Promise<Response> {
  // HTTPException and similar errors already carry the response the app meant to send
  const withResponse = err as Error & { getResponse?: () => Response };
  if (typeof withResponse.getResponse === 'function') return withResponse.getResponse();

  if (err instanceof SyntaxError) {
    return c.json({ error: 'Request body is not valid JSON.', code: 'ERR_BAD_JSON' }, 400);
  }

  console.error('[OmniMesh] unhandled error:', err);
  return c.json({ error: 'Internal Server Error', code: 'ERR_INTERNAL' }, 500);
}
