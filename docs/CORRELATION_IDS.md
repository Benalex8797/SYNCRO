# Request Correlation IDs

## Overview

Every HTTP request and async job in the backend carries a **correlation ID** (`requestId`) that flows automatically through all log entries, audit events, and async call stacks via Node.js `AsyncLocalStorage`.

## How It Works

### HTTP Requests

`requestIdMiddleware` (registered first in `backend/src/index.ts`) assigns a correlation ID to every request:

1. If the upstream load balancer sends `X-Request-ID`, that value is reused.
2. Otherwise a new `uuidv4()` is generated.
3. The ID is stored in `AsyncLocalStorage` and echoed back in the `x-request-id` response header.

The Winston logger reads the store on every log call and injects `requestId` (and `userId` when available) automatically — no manual propagation needed.

### Async Jobs (Cron)

Cron jobs use `runWithCorrelationId(label, fn)` from `backend/src/middleware/requestContext.ts`:

```ts
runWithCorrelationId('cron:process-reminders', async (cid) => {
  logger.info('Starting', { correlationId: cid }); // also auto-injected by logger
  await reminderEngine.processReminders();
});
```

The generated ID has the format `<label>:<uuid>`, e.g. `cron:process-reminders:4f3a…`.

### Audit Events

`auditApiKeyEvent` reads `getRequestId()` and stores the correlation ID in `metadata.correlationId` so audit log entries can be cross-referenced with application logs.

## Tracing a Request

1. Find the `x-request-id` header in the client response (or from the client's network tab).
2. Search application logs: `grep '"requestId":"<id>"' logs/combined-*.log`
3. Cross-reference audit logs: query `audit_logs` where `metadata->>'correlationId' = '<id>'`.

## Passing IDs to External Providers

When making outbound HTTP calls to external providers, forward the correlation ID as a header:

```ts
import { getRequestId } from '../middleware/requestContext';

fetch(url, {
  headers: { 'X-Request-ID': getRequestId() ?? '' },
});
```

This is recommended for any new provider integrations.
