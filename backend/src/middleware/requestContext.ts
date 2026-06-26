import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/** Shape of the per-request context stored in AsyncLocalStorage */
export interface RequestContext {
  requestId: string;
  /** Populated by auth middleware once the user is known */
  userId?: string;
}

/** Extended Express Request with requestId attached */
export interface RequestWithContext extends Request {
  requestId?: string;
}

/**
 * Singleton AsyncLocalStorage instance.
 * Import this anywhere in the codebase to read the current request context
 * without threading it through function arguments.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Express middleware that assigns a unique requestId to every incoming request.
 *
 * - Respects an upstream `X-Request-ID` header (e.g. from a load balancer) so
 *   IDs remain consistent across service hops.
 * - Stores the context in AsyncLocalStorage so it is automatically available
 *   anywhere down the async call stack.
 * - Echoes the request ID back in the response header so clients can correlate
 *   their requests with server-side logs.
 */
export function requestIdMiddleware(
  req: RequestWithContext,
  res: Response,
  next: NextFunction,
): void {
  const requestId =
    (req.headers['x-request-id'] as string | undefined) || uuidv4();

  // Attach to request object for easy manual passing if needed
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  requestContextStorage.run({ requestId }, () => {
    next();
  });
}

/**
 * Helper to get the current requestId from AsyncLocalStorage.
 * Returns undefined if called outside of a request context.
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

/**
 * Call this from your auth middleware after the user has been verified to
 * attach the userId to the current request context.
 */
export function setRequestUserId(userId: string): void {
  const store = requestContextStorage.getStore();
  if (store) {
    store.userId = userId;
  }
}

/**
 * Run an async job (cron, queue worker, etc.) with a fresh correlation ID
 * so all log entries and audit events produced inside `fn` carry the same ID.
 *
 * Usage:
 *   await runWithCorrelationId('cron:reminder', async () => { ... });
 */
export function runWithCorrelationId<T>(
  label: string,
  fn: (correlationId: string) => Promise<T>,
): Promise<T> {
  const correlationId = `${label}:${uuidv4()}`;
  return requestContextStorage.run({ requestId: correlationId }, () => fn(correlationId));
}
