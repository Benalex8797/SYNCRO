jest.mock('../src/config/database', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  })),
}));

jest.mock('@syncro/shared/crypto', () => ({
  deriveStealthAddressFromEphemeral: jest.fn().mockReturnValue('abcd1234ef567890'),
  deriveEphemeralStealthAddress: jest.fn().mockReturnValue({
    ephemeralPubkey: 'aa'.repeat(32),
    stealthAddress: 'bb'.repeat(32),
  }),
}));

import { StealthScanner } from '../src/services/stealth-scanner';
import { supabase } from '../src/config/database';
import { deriveStealthAddressFromEphemeral } from '@syncro/shared/crypto';

describe('StealthScanner', () => {
  let scanner: StealthScanner;

  beforeEach(() => {
    jest.clearAllMocks();
    scanner = new StealthScanner();
  });

  describe('parseMetaAddress', () => {
    it('parses syncro stealth meta address format', () => {
      const spend = '0'.repeat(66);
      const view = '1'.repeat(66);
      const meta = scanner.parseMetaAddress(`syncro:stealth:v1:${spend}:${view}`);
      expect(meta?.spendPublicKey).toBe(spend);
      expect(meta?.viewPublicKey).toBe(view);
    });
  });

  describe('scanTransactionForStealth', () => {
    it('detects stealth payment from memo_return', () => {
      const ephemeral = Buffer.alloc(32, 0xab).toString('base64');
      const tx = {
        id: 'tx-1',
        hash: 'hash-1',
        ledger: 100,
        created_at: new Date().toISOString(),
        memo: { type: 'return', value: ephemeral },
      };
      const payment = {
        id: 'pay-1',
        transaction_hash: 'hash-1',
        type: 'payment',
        from: 'GFROM',
        to: 'abcd1234ef567890',
        amount: '10',
        asset_type: 'native',
        created_at: tx.created_at,
      };

      const record = scanner.scanTransactionForStealth(
        tx,
        payment,
        { spendPublicKey: 's'.repeat(66), viewPublicKey: 'v'.repeat(66) },
        'f'.repeat(64),
      );

      expect(deriveStealthAddressFromEphemeral).toHaveBeenCalled();
      expect(record?.transactionHash).toBe('hash-1');
      expect(record?.amount).toBe(10);
    });
  });

  describe('getUserStealthPayments', () => {
    it('returns stored stealth payments', async () => {
      (supabase.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({
          data: [
            {
              recipient_address: 'addr',
              ephemeral_pubkey: 'ephemeral',
              amount: 5,
              timestamp: '2026-01-01T00:00:00Z',
              transaction_hash: 'txhash',
            },
          ],
          error: null,
        }),
      });

      const payments = await scanner.getUserStealthPayments('user-1');
      expect(payments).toHaveLength(1);
      expect(payments[0].transactionHash).toBe('txhash');
    });
  });
});
