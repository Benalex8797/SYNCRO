# Syncro Backend SDK

Subscription CRUD wrapper for the Syncro backend. Developers should use these SDK methods instead of calling raw API endpoints or Soroban contracts directly.

## Features

- **createSubscription()** – Create subscriptions with validation and backend + on-chain sync
- **updateSubscription()** – Update subscriptions with validation
- **getSubscription()** – Fetch a single subscription by ID
- **cancelSubscription()** – Soft cancel (set status to `cancelled`)
- **deleteSubscription()** – Permanently delete a subscription
- **attachGiftCard()** – Attach gift card info (manual and gift-card subscriptions)
- **Strictly typed configuration** – Type-safe SDK initialization with sensible defaults
- **Automatic retry logic** – Configurable exponential backoff for resilience
- **Request timeout control** – Prevent hanging requests with timeout configuration
- **Batch concurrency control** – Limit concurrent operations for resource management
- **Optional logging** – Debug SDK operations with structured logging

Validation, lifecycle events, and sync (backend + on-chain) are handled automatically.

## Installation

```bash
npm install @syncro/sdk
```

## Quick Start

```typescript
import { init } from "@syncro/sdk";

const sdk = init({
  apiKey: "your-api-key",
  baseURL: "https://api.syncro.example.com",
  enableLogging: true,
  wallet: yourWallet,
});

// Use the SDK
const subscriptions = await sdk.getUserSubscriptions();
```

## Configuration

### @syncro/sdk

Official TypeScript/JavaScript SDK for the **SYNCRO** Subscription Management Platform.

---

## Installation

```bash
npm install @syncro/sdk
# or
npm add @syncro/sdk
```

---

## Quickstart

```typescript
import { init } from '@syncro/sdk';

const sdk = init({
  apiKey: 'your-api-key',
  baseURL: 'https://api.syncro.example.com',
  enableLogging: true,
});

sdk.on('ready', ({ baseURL }) => {
  console.log('SDK ready:', baseURL);
});
```

---

## Subscription Management

### Create a subscription

```typescript
const subscription = await sdk.createSubscription({
  name: 'Netflix',
  price: 15.99,
  billing_cycle: 'monthly',
  category: 'Entertainment',
  next_billing_date: '2026-04-01',
  renewal_url: 'https://netflix.com/account',
});
console.log(subscription.id);
```

### Get a subscription

```typescript
const sub = await sdk.getSubscription('sub-uuid');
console.log(sub.name, sub.status);
```

### Update a subscription

```typescript
const updated = await sdk.updateSubscription('sub-uuid', {
  price: 19.99,
  status: 'paused',
});
```

### List subscriptions (with pagination & filters)

```typescript
const page1 = await sdk.listSubscriptions({
  page: 1,
  limit: 20,
  status: 'active',
  category: 'Entertainment',
});
// page1 = { data: Subscription[], total: number, hasMore: boolean }
console.log(`${page1.total} total, hasMore=${page1.hasMore}`);
```

### Cancel a subscription

```typescript
const result = await sdk.cancelSubscription('sub-uuid');
// result = { success, status, subscription, redirectUrl, blockchain }
```

### Delete a subscription

```typescript
await sdk.deleteSubscription('sub-uuid');
```

---

## Analytics

### Get analytics summary

```typescript
const summary = await sdk.getAnalyticsSummary();
console.log(summary.totalActiveSubscriptions);
console.log(summary.totalMonthlyCost);   // normalised to monthly
console.log(summary.totalAnnualCost);
console.log(summary.upcomingRenewals);   // renewals in next 7 days
console.log(summary.subscriptionsByCategory);
```

### Get renewal history for a subscription

```typescript
const events = await sdk.getRenewalHistory('sub-uuid');
for (const e of events) {
  console.log(e.renewedAt, e.amount, e.status);
}
```

---

## Webhook Management

### Create a webhook

```typescript
const webhook = await sdk.createWebhook({
  url: 'https://yourapp.com/hooks/syncro',
  events: ['subscription.created', 'subscription.cancelled'],
  secret: 'your-webhook-secret',
});
console.log(webhook.id);
```

### List webhooks

```typescript
const webhooks = await sdk.listWebhooks();
```

### Delete a webhook

```typescript
await sdk.deleteWebhook('webhook-uuid');
```

---

## Notifications

### Get notifications

```typescript
// All notifications
const all = await sdk.getNotifications();

// Unread only
const unread = await sdk.getNotifications({ unreadOnly: true });
```

### Mark a notification as read

```typescript
await sdk.markNotificationRead('notification-uuid');
```

---

## Error Handling

The SDK throws typed errors so you can handle them precisely:

```typescript
import {
  SyncroError,
  NotFoundError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
} from '@syncro/sdk';

try {
  await sdk.getSubscription('bad-id');
} catch (err) {
  if (err instanceof NotFoundError) {
    console.error('Not found:', err.message); // err.code === 'NOT_FOUND'
  } else if (err instanceof AuthenticationError) {
    console.error('Check your API key');
  } else if (err instanceof RateLimitError) {
    console.error(`Rate limited. Retry after ${err.retryAfter}s`);
  } else if (err instanceof SyncroError) {
    console.error(`SDK error [${err.code}]:`, err.message);
  }
}
```

---

## Using Types Only (`@syncro/types`)

You can import types without the runtime SDK:

```typescript
import type {
  SubscriptionRecord,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  SubscriptionFilters,
  PaginatedResult,
  AnalyticsSummary,
  RenewalEvent,
  CreateWebhookInput,
  Webhook,
  AppNotification,
} from '@syncro/sdk/types';
```

---

## Event Emitter

The SDK extends `EventEmitter`. Supported events:

| Event | Payload |
|---|---|
| `ready` | `{ baseURL, publicKey }` |
| `cancelling` | `{ subscriptionId }` |
| `success` | `CancellationResult` |
| `failure` | `{ subscriptionId, error }` |
| `subscription:created` | `SubscriptionRecord` |
| `subscription:updated` | `SubscriptionRecord` |
| `subscription:deleted` | `{ id }` |
| `webhook:created` | `Webhook` |
| `webhook:deleted` | `{ id }` |
| `notification:read` | `{ id }` |

---

## Configuration

```typescript
const sdk = init({
  apiKey: 'your-api-key',            // Required
  baseURL: 'http://localhost:3001/api', // Default
  timeout: 30000,                    // ms, default 30s
  enableLogging: false,              // default false
  batchConcurrency: 5,               // default 5
  retryOptions: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  },
});
```

---

## License

MIT
Config Interface

The SDK uses a strictly typed configuration object. All configuration options are validated at initialization.

```typescript
interface SyncroSDKConfig {
  // Required
  apiKey: string;

  // Optional with defaults
  baseURL?: string;              // Default: "http://localhost:3001/api"
  timeout?: number;              // Default: 30000 (ms)
  retryOptions?: RetryOptions;   // Default: see below
  batchConcurrency?: number;     // Default: 5
  enableLogging?: boolean;       // Default: false

  // For blockchain operations
  wallet?: StellarWallet;
  keypair?: StellarKeypair;
}

interface RetryOptions {
  maxRetries?: number;                    // Default: 3
  initialDelayMs?: number;                // Default: 1000
  maxDelayMs?: number;                    // Default: 30000
  retryableStatusCodes?: number[];        // Default: [408, 429, 500, 502, 503, 504]
}
```

### Configuration Examples

#### Basic Configuration

```typescript
import { init } from "@syncro/sdk";

const sdk = init({
  apiKey: "sk_live_...", // Your Syncro API key
  wallet: yourWallet,
});

// Uses defaults:
// - baseURL: http://localhost:3001/api
// - timeout: 30000ms
// - retryOptions: { maxRetries: 3, ... }
// - batchConcurrency: 5
// - enableLogging: false
```

#### Custom Timeout and Retry Configuration

```typescript
const sdk = init({
  apiKey: "sk_live_...", // Your Syncro API key
  baseURL: "https://api.syncro.com",
  timeout: 60000, // 60 seconds
  retryOptions: {
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 60000,
    retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  },
  wallet: yourWallet,
});
```

#### Production Configuration with Logging

```typescript
const sdk = init({
  apiKey: process.env.SYNCRO_API_KEY,
  baseURL: process.env.SYNCRO_API_URL || "https://api.syncro.com",
  timeout: 45000,
  batchConcurrency: 10,
  enableLogging: process.env.NODE_ENV === "development",
  retryOptions: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  },
  wallet: yourWallet,
  keypair: process.env.KEYPAIR ? parseKeypair(process.env.KEYPAIR) : undefined,
});
```

### Configuration Validation

The SDK validates configuration at initialization time and throws clear error messages if invalid:

```typescript
try {
  const sdk = init({
    apiKey: "", // Error! apiKey is required
    baseURL: "invalid-url", // Error! Invalid URL
    timeout: -1000, // Error! timeout must be positive
  });
} catch (error) {
  console.error(error.message);
  // "Invalid SDK configuration: apiKey is required and must be a non-empty string; baseURL must be a valid URL; timeout must be a positive number"
}
```

## Usage

### Lifecycle Events

```typescript
sdk.on("subscription", (event) => {
  console.log(event.type, event.subscriptionId, event.data);
});

sdk.on("giftCard", (event) => {
  console.log(event.type, event.subscriptionId);
});
```

### Create Subscription

```typescript
const result = await sdk.createSubscription({
  name: "Netflix",
  price: 15.99,
  billing_cycle: "monthly",
  source: "manual", // or 'gift_card'
});
```

### Get Subscription

```typescript
const sub = await sdk.getSubscription(subscriptionId);
```

### Update Subscription

```typescript
await sdk.updateSubscription(subscriptionId, { price: 19.99 });
```

### Cancel Subscription

```typescript
// Soft cancel (sets status to 'cancelled')
await sdk.cancelSubscription(subscriptionId);
```

### Delete Subscription

```typescript
// Hard delete
await sdk.deleteSubscription(subscriptionId);
```

### Attach Gift Card

```typescript
await sdk.attachGiftCard(subscriptionId, giftCardHash, provider);
```

## API Reference

### Methods

| Method                                           | Description                                                    |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `createSubscription(input, options?)`            | Create subscription. Emits `subscription` with type `created`. |
| `getSubscription(id)`                            | Get subscription by ID                                         |
| `updateSubscription(id, input, options?)`        | Update subscription. Emits `subscription` with type `updated`. |
| `cancelSubscription(id)`                         | Soft cancel. Emits `subscription` with type `cancelled`.       |
| `deleteSubscription(id)`                         | Hard delete. Emits `subscription` with type `deleted`.         |
| `attachGiftCard(subscriptionId, hash, provider)` | Attach gift card. Emits `giftCard` events.                     |

### Events

- **subscription** – `{ type, subscriptionId, data?, error?, blockchain? }`  
  Types: `created`, `updated`, `cancelled`, `deleted`, `failed`
- **giftCard** – `{ type, subscriptionId, giftCardHash?, provider?, data?, error? }`  
  Types: `attached`, `failed`

### Validation

- `validateSubscriptionCreateInput(input)` – Returns `{ isValid, errors }`
- `validateSubscriptionUpdateInput(input)` – Returns `{ isValid, errors }`
- `validateGiftCardHash(hash)` – Returns boolean

## Defaults and Behavior

### Default Configuration Values

| Option             | Default Value                              | Description                           |
| ------------------ | ------------------------------------------ | ------------------------------------- |
| `baseURL`          | `http://localhost:3001/api`                | Backend API endpoint                  |
| `timeout`          | `30000` (30 seconds)                       | Request timeout                       |
| `batchConcurrency` | `5`                                        | Max concurrent operations             |
| `enableLogging`    | `false`                                    | Logging disabled by default           |
| **Retry Defaults** |                                            |                                       |
| `maxRetries`       | `3`                                        | Number of retry attempts              |
| `initialDelayMs`   | `1000` (1 second)                          | Initial delay between retries         |
| `maxDelayMs`       | `30000` (30 seconds)                       | Maximum delay between retries         |
| `statusCodes`      | `[408, 429, 500, 502, 503, 504]`          | HTTP codes triggering retries         |

### Retry Logic

The SDK implements automatic exponential backoff retry logic:

- Attempts up to `maxRetries` times
- Waits `initialDelayMs * (2 ^ attemptNumber)` milliseconds between retries
- Caps delay at `maxDelayMs`
- Only retries on specified HTTP status codes

Example: With defaults, retries would occur with delays of: 1s, 2s, 4s

### Logging

When `enableLogging` is enabled, the SDK logs:

```
[SyncroSDK] Initializing with config: { ... }
[SyncroSDK] Fetching subscription: sub_123
[SyncroSDK] Retrying request (attempt 1/3) after 1000ms
[SyncroSDK] Cache hit for key: syncro_subs_<api_key_hash>
```

## Error Handling

```typescript
try {
  const sdk = init({
    apiKey: "invalid-key",
    wallet: null, // Error! wallet or keypair required
  });
} catch (error) {
  // SDK validates and throws:
  // "Invalid SDK configuration: apiKey is required..."
}

try {
  await sdk.getSubscription("invalid-id");
} catch (error) {
  // Network error, SDK automatically retries based on configuration
  // If all retries fail, final error is thrown
  console.error("Failed to fetch subscription:", error.message);
}
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import { init } from "@syncro/sdk";
import type {
  SyncroSDKConfig,
  RetryOptions,
  Subscription,
  CancellationResult,
} from "@syncro/sdk";

// All configuration options are type-safe
const config: SyncroSDKConfig = {
  apiKey: process.env.API_KEY!,
  baseURL: "https://api.syncro.com",
  timeout: 30000,
  enableLogging: true,
  retryOptions: {
    maxRetries: 3,
  },
};

const sdk = init(config);
```

