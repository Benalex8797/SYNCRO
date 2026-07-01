# Request Correlation IDs

## Overview

Every HTTP request and async job in the backend carries a **correlation ID** (`requestId`) that flows automatically through all log entries, audit events, async call stacks, Sentry breadcrumbs, and blockchain transaction data via Node.js `AsyncLocalStorage`.

## How It Works

### HTTP Requests

`requestIdMiddleware` (registered first in `backend/src/index.ts`) assigns a **UUID v7** (time-ordered) correlation ID to every request:

1. If the upstream load balancer sends `X-Correlation-ID` or `X-Request-ID`, that value is reused.
2. Otherwise a new `uuidv7()` is generated (time-ordered, better database index locality).
3. The ID is stored in `AsyncLocalStorage` and echoed back in both the canonical `X-Correlation-ID` and legacy `x-request-id` response headers.
4. A Sentry breadcrumb is recorded with the correlation ID for end-to-end tracing in Sentry.

The Winston logger reads the store on every log call and injects `requestId` (and `userId` when available) automatically — no manual propagation needed.

### Async Jobs (Cron)

Cron jobs use `runWithCorrelationId(label, fn)` from `backend/src/middleware/requestContext.ts`:

```ts
runWithCorrelationId('cron:process-reminders', async (cid) => {
  logger.info('Starting', { correlationId: cid }); // also auto-injected by logger
  await reminderEngine.processReminders();
});
```

The generated ID has the format `<label>:<uuid-v7>`, e.g. `cron:process-reminders:019f107b…`.

### Audit Events

`auditApiKeyEvent` reads `getRequestId()` and stores the correlation ID in `metadata.correlationId` so audit log entries can be cross-referenced with application logs.

### Blockchain Transactions

All blockchain log entries (`blockchain_logs`) include the correlation ID in the `event_data` payload as `correlationId`, enabling end-to-end tracing from API request → database → blockchain transaction.

### Sentry Breadcrumbs

Each request adds a Sentry breadcrumb with the correlation ID. This allows the Sentry dashboard to show the correlation ID in every error/event's breadcrumb trail, making it easy to jump from a Sentry alert to the relevant application logs.

## Tracing a Request

1. Find the `X-Correlation-ID` (or `x-request-id`) header in the client response (or from the client's network tab).
2. Search application logs: `grep '"requestId":"<id>"' logs/combined-*.log`
3. Cross-reference audit logs: query `audit_logs` where `metadata->>'correlationId' = '<id>'`.
4. Cross-reference blockchain logs: query `blockchain_logs` where `event_data->>'correlationId' = '<id>'`.
5. Search Sentry breadcrumbs for the correlation ID to find related events.

## Passing IDs to External Providers

When making outbound HTTP calls to external providers, forward the correlation ID as a header:

```ts
import { getRequestId } from '../middleware/requestContext';

fetch(url, {
  headers: { 'X-Correlation-ID': getRequestId() ?? '' },
});
```

This is recommended for any new provider integrations.
