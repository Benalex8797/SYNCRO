import logger from '../config/logger';
import { supabase } from '../config/database';
import { detectStealthDestination } from '@syncro/shared/crypto';
import {
  decodeStealthMemo,
  extractStealthPubkeyFromTx,
  isStealthMemo,
} from '@syncro/shared/stealth-derive';
import type { StealthPaymentRecord } from '@syncro/shared';
import { getScanCursor, setScanCursor } from '../lib/scan-cursor-store';
import { secretProvider } from './secret-provider';
import { decrypt } from '../utils/encryption';

export interface HorizonPaymentOp {
  type: string;
  destination?: string;
  amount?: string;
  asset_type?: string;
}

export interface HorizonTransaction {
  id: string;
  hash: string;
  ledger: number;
  created_at: string;
  paging_token?: string;
  memo_type?: string;
  memo?: string;
  memo_return?: string;
  _embedded?: { operations?: HorizonPaymentOp[] };
}

export interface StealthScanResult {
  detected: number;
  scanned: number;
  cursor: string | null;
}

export class StealthScanner {
  private horizonUrl(): string {
    return (
      process.env.HORIZON_URL ??
      process.env.STELLAR_HORIZON_URL ??
      'https://horizon-testnet.stellar.org'
    );
  }

  /**
   * Scan Stellar ledger for payments to derived stealth addresses.
   * Viewing key is resolved server-side and never exposed to clients.
   */
  async scanLedgerForUser(userId: string): Promise<StealthScanResult> {
    const keys = await this.resolveViewingKeys(userId);
    if (!keys) return { detected: 0, scanned: 0, cursor: null };

    const cursor = await getScanCursor(userId);
    const txs = await this.fetchTransactions(cursor ?? undefined);
    let detected = 0;

    for (const tx of txs) {
      const payment = this.scanTransactionForStealth(tx, keys);
      if (payment) {
        const stored = await this.storeStealthPayment(payment, userId);
        if (stored) detected++;
      }
    }

    const nextCursor =
      txs.length > 0 ? txs[txs.length - 1]!.paging_token ?? null : cursor;
    if (nextCursor) {
      await setScanCursor(userId, nextCursor);
    }

    return { detected, scanned: txs.length, cursor: nextCursor };
  }

  scanTransactionForStealth(
    tx: HorizonTransaction,
    keys: { viewPrivateKey: string; spendPublicKey: string },
  ): Omit<StealthPaymentRecord, 'subscriptionId' | 'approvalId' | 'cycleId'> | null {
    const memoType = tx.memo_type ?? 'none';
    const memoValue = tx.memo_return ?? tx.memo ?? '';
    if (!isStealthMemo(memoType, memoValue)) return null;

    let ephemeralPubkey: string;
    try {
      ephemeralPubkey = decodeStealthMemo(memoValue);
    } catch {
      const fromTx = extractStealthPubkeyFromTx({
        memo: { type: memoType, value: memoValue },
      });
      if (!fromTx) return null;
      ephemeralPubkey = fromTx;
    }

    let stealthAddresses: string[];
    try {
      if (ephemeralPubkey.length === 64) {
        stealthAddresses = ['02', '03'].map((prefix) =>
          detectStealthDestination(keys.viewPrivateKey, keys.spendPublicKey, prefix + ephemeralPubkey),
        );
      } else {
        stealthAddresses = [
          detectStealthDestination(keys.viewPrivateKey, keys.spendPublicKey, ephemeralPubkey),
        ];
      }
    } catch (err) {
      logger.warn('Stealth destination derivation failed', {
        txHash: tx.hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const ops = tx._embedded?.operations ?? [];
    const paymentOp = ops.find(
      (op) => op.type === 'payment' && stealthAddresses.includes(op.destination ?? ''),
    );
    if (!paymentOp) return null;

    const stealthAddress = paymentOp.destination!;

    return {
      stealthAddress,
      ephemeralPubkey,
      amount: Number.parseFloat(paymentOp.amount ?? '0'),
      createdAt: tx.created_at,
      transactionHash: tx.hash,
    };
  }

  async storeStealthPayment(
    record: Omit<StealthPaymentRecord, 'subscriptionId' | 'approvalId' | 'cycleId'> & {
      asset?: string;
      ledger?: number;
    },
    userId: string,
  ): Promise<boolean> {
    const { error } = await supabase.from('stealth_payments').insert({
      user_id: userId,
      transaction_hash: record.transactionHash,
      ephemeral_pubkey: record.ephemeralPubkey,
      recipient_address: record.stealthAddress,
      amount: record.amount,
      asset: record.asset ?? 'XLM',
      ledger: record.ledger ?? 0,
      timestamp: record.createdAt,
    });

    if (error) {
      if (error.code === '23505') return false; // duplicate tx
      logger.warn('Failed to store stealth payment', { error: error.message });
      return false;
    }
    return true;
  }

  async getUserStealthPayments(userId: string, limit = 100): Promise<StealthPaymentRecord[]> {
    const { data, error } = await supabase
      .from('stealth_payments')
      .select('*')
      .eq('user_id', userId)
      .order('detected_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      subscriptionId: '',
      approvalId: '',
      cycleId: '',
      stealthAddress: row.recipient_address as string,
      ephemeralPubkey: row.ephemeral_pubkey as string,
      amount: Number(row.amount),
      createdAt: row.timestamp as string,
      transactionHash: row.transaction_hash as string,
    }));
  }

  /** Legacy audit path — scans renewal_logs for locally recorded stealth renewals. */
  async scanForPayments(userId: string): Promise<StealthPaymentRecord[]> {
    const onChain = await this.getUserStealthPayments(userId);
    if (onChain.length > 0) return onChain;

    const { data: profile } = await supabase
      .from('profiles')
      .select('stealth_meta_address')
      .eq('id', userId)
      .single();

    const metaRaw = profile?.stealth_meta_address as string | null;
    if (!metaRaw) return [];

    const parts = metaRaw.replace('syncro:stealth:v1:', '').split(':');
    if (parts.length !== 2) return [];

    const [spendPubkey, viewPubkey] = parts;
    const metaAddress = { spendPublicKey: spendPubkey, viewPublicKey: viewPubkey };

    const { data: subs } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId);

    const records: StealthPaymentRecord[] = [];

    for (const sub of subs ?? []) {
      const { data: logs } = await supabase
        .from('renewal_logs')
        .select('approval_id, transaction_hash, created_at')
        .eq('subscription_id', sub.id)
        .eq('status', 'success')
        .not('stealth_address', 'is', null);

      for (const log of logs ?? []) {
        const cycleId = `${sub.id}:${log.approval_id ?? '0'}`;
        records.push({
          subscriptionId: sub.id,
          approvalId: String(log.approval_id ?? ''),
          stealthAddress: '',
          ephemeralPubkey: '',
          amount: 0,
          cycleId,
          createdAt: log.created_at,
          transactionHash: log.transaction_hash ?? undefined,
        });
      }
    }

    return records;
  }

  private async resolveViewingKeys(
    userId: string,
  ): Promise<{ viewPrivateKey: string; spendPublicKey: string } | null> {
    const envView = await secretProvider.getSecret('STEALTH_VIEW_PRIVKEY');
    const envSpend = process.env.STEALTH_SPEND_PUBKEY;
    if (envView && envSpend) {
      return { viewPrivateKey: envView, spendPublicKey: envSpend };
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('stealth_meta_address, stealth_view_key_encrypted')
      .eq('id', userId)
      .single();

    const raw = profile?.stealth_meta_address as string | null;
    if (!raw?.startsWith('syncro:stealth:v1:')) return null;

    const [spend, viewPub] = raw.replace('syncro:stealth:v1:', '').split(':');
    const encrypted = profile?.stealth_view_key_encrypted as string | null;
    if (!spend || !viewPub || !encrypted) return null;

    try {
      const viewPrivateKey = decrypt(encrypted);
      return { viewPrivateKey, spendPublicKey: spend };
    } catch {
      return null;
    }
  }

  private async fetchTransactions(cursor?: string): Promise<HorizonTransaction[]> {
    const limit = Number(process.env.STEALTH_SCAN_BATCH_SIZE ?? 50);
    const url = new URL(`${this.horizonUrl()}/transactions`);
    url.searchParams.set('order', 'asc');
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Horizon request failed: ${res.status}`);
    }

    const body = (await res.json()) as { _embedded?: { records?: HorizonTransaction[] } };
    return body._embedded?.records ?? [];
  }
}

export const stealthScanner = new StealthScanner();
