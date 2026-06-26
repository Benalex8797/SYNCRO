import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../config/logger';

const router = Router();

/**
 * Verify the x-paystack-signature header using HMAC-SHA512.
 *
 * Paystack signs every webhook payload with HMAC-SHA512 using the
 * secret key as the signing key. The resulting hex digest is sent in the
 * `x-paystack-signature` header.
 *
 * Reference: https://paystack.com/docs/payments/webhooks/#verify-events
 *
 * Returns true if the signature matches, false otherwise.
 * If PAYSTACK_SECRET_KEY is not configured, the check is skipped in
 * non-production environments (dev/test). In production the request is
 * rejected to prevent unverified events from being processed.
 */
function verifyPaystackSignature(req: Request): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers['x-paystack-signature'] as string | undefined;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[PaystackWebhook] PAYSTACK_SECRET_KEY not configured — rejecting webhook in production');
      return false;
    }
    // Development / test: skip verification with a warning
    logger.warn('[PaystackWebhook] PAYSTACK_SECRET_KEY not set — skipping signature check (non-production)');
    return true;
  }

  if (!signature) {
    logger.warn('[PaystackWebhook] Missing x-paystack-signature header');
    return false;
  }

  // req.body is the raw Buffer when express.raw() is applied upstream.
  // If it has already been parsed to an object, re-serialize for hashing.
  const rawBody: Buffer | string =
    Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

  const hash = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(signature, 'hex'),
  );

  if (!isValid) {
    logger.warn('[PaystackWebhook] Signature mismatch — possible spoofed request', {
      ip: req.ip,
    });
  }

  return isValid;
}

/**
 * POST /api/webhooks/paystack
 *
 * Inbound Paystack webhook endpoint.
 *
 * - No JWT authentication (Paystack cannot send auth tokens).
 * - Verified via x-paystack-signature HMAC-SHA512.
 * - Always returns HTTP 200 to Paystack to prevent retries; errors are
 *   logged internally.
 *
 * Supported events:
 *   charge.success — marks the associated transaction as paid
 */
router.post('/', (req: Request, res: Response) => {
  // Acknowledge immediately so Paystack does not time out and retry
  // (Paystack expects a 200 within ~30 s).
  res.sendStatus(200);

  if (!verifyPaystackSignature(req)) {
    logger.warn('[PaystackWebhook] Rejected — invalid signature');
    return;
  }

  const event = Buffer.isBuffer(req.body)
    ? JSON.parse(req.body.toString('utf8'))
    : req.body;

  const { event: eventType, data } = event ?? {};

  logger.info('[PaystackWebhook] Received event', { eventType, reference: data?.reference });

  switch (eventType) {
    case 'charge.success':
      handleChargeSuccess(data);
      break;

    default:
      // Log unknown events so we can add handlers later without silent drops
      logger.info('[PaystackWebhook] Unhandled event type', { eventType });
  }
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

interface ChargeSuccessData {
  reference: string;
  amount: number;       // kobo
  currency: string;
  status: string;
  paid_at: string;
  customer: { email: string; id: number };
  metadata?: Record<string, unknown>;
}

/**
 * Handle `charge.success`.
 *
 * A charge.success event is fired when a Paystack transaction completes
 * successfully. The canonical flow is:
 *
 *   1. Client calls POST /api/payments/paystack/initialize → gets authorization_url
 *   2. User completes payment on the Paystack-hosted page
 *   3. Paystack POSTs charge.success to this webhook
 *   4. (Optional) Client also calls GET /api/payments/paystack/verify/:reference
 *      as a belt-and-braces check
 *
 * At a minimum, log the successful charge. Extend this function to update
 * your database (e.g., mark a wallet-top-up as settled, grant paid access,
 * etc.) once the relevant data model is in place.
 */
function handleChargeSuccess(data: ChargeSuccessData): void {
  if (!data?.reference) {
    logger.error('[PaystackWebhook] charge.success received without reference', { data });
    return;
  }

  logger.info('[PaystackWebhook] charge.success processed', {
    reference: data.reference,
    amountKobo: data.amount,
    currency: data.currency,
    email: data.customer?.email,
    paidAt: data.paid_at,
  });

  // TODO: Persist the completed payment record / update wallet balance.
  // Example:
  //   await walletService.creditFromPaystack({
  //     reference: data.reference,
  //     amountKobo: data.amount,
  //     email: data.customer.email,
  //     paidAt: new Date(data.paid_at),
  //   });
}

export default router;
