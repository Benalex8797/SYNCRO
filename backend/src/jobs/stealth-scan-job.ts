import cron from 'node-cron';
import logger from '../config/logger';
import { runWithCorrelationId } from '../middleware/requestContext';
import { stealthScanner } from '../services/stealth-scanner';

/**
 * Scans Stellar ledger for stealth payments every minute.
 * Cursor position is persisted in Redis for resumable scanning.
 */
export function startStealthScanJob(): void {
  cron.schedule('* * * * *', () =>
    runWithCorrelationId('cron:stealth-scan', async (cid) => {
      if (process.env.STEALTH_PAYMENTS_ENABLED !== 'true') return;

      try {
        const detected = await stealthScanner.scanLedgerBatch();
        if (detected > 0) {
          logger.info('Stealth payments detected', { correlationId: cid, detected });
        }
      } catch (error) {
        logger.error('Stealth scan job failed', { correlationId: cid, error });
      }
    }),
  );

  logger.info('Stealth scan cron job scheduled (every minute)');
}
