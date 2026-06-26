import { supabase } from '../config/database';
import logger from '../config/logger';
import {
  paymentChannelService,
  type PaymentChannelRecord,
} from './payment-channel-service';

export type SettlementSchedule = 'monthly' | 'quarterly';

export interface ChannelPaymentLog {
  channelId: string;
  userId: string;
  subscriptionId: string;
  amount: number;
  sequenceNumber: number;
}

export interface ChannelSettlementCandidate {
  channelId: string;
  userId: string;
  executorBalance: number;
}

export class ChannelStateService {
  /**
   * Returns the newest active channel with sufficient off-chain balance.
   */
  async findPayableChannel(
    userId: string,
    amount: number,
  ): Promise<PaymentChannelRecord | null> {
    const channels = await paymentChannelService.listChannels(userId);
    for (const channel of channels) {
      if (channel.state !== 'active') continue;
      const balance =
        channel.channelState?.userBalance ?? Number.parseFloat(channel.balance);
      if (balance >= amount) return channel;
    }
    return null;
  }

  /**
   * Applies an off-chain state update and records the payment locally (not on-chain).
   */
  async applyRenewalPayment(
    channelId: string,
    userId: string,
    subscriptionId: string,
    amount: number,
  ): Promise<PaymentChannelRecord> {
    const updated = await paymentChannelService.applyOffChainRenewal(
      channelId,
      userId,
      amount,
    );

    await this.logChannelPayment({
      channelId,
      userId,
      subscriptionId,
      amount,
      sequenceNumber: updated.channelState?.sequenceNumber ?? 0,
    });

    return updated;
  }

  async logChannelPayment(payment: ChannelPaymentLog): Promise<void> {
    const { error } = await supabase.from('channel_payments').insert({
      channel_id: payment.channelId,
      user_id: payment.userId,
      subscription_id: payment.subscriptionId,
      amount: payment.amount,
      sequence_number: payment.sequenceNumber,
      created_at: new Date().toISOString(),
    });

    if (error) {
      logger.warn('Failed to log channel payment', {
        channelId: payment.channelId,
        error: error.message,
      });
    }
  }

  async getSettlementSchedule(userId: string): Promise<SettlementSchedule> {
    const { data } = await supabase
      .from('profiles')
      .select('channel_settlement_schedule')
      .eq('id', userId)
      .maybeSingle();

    return data?.channel_settlement_schedule === 'quarterly' ? 'quarterly' : 'monthly';
  }

  /**
   * Active channels whose executor-side balance should be settled on-chain.
   */
  async getChannelsDueForSettlement(): Promise<ChannelSettlementCandidate[]> {
    const { data: channels, error } = await supabase
      .from('payment_channels')
      .select('id, user_id, channel_state, last_settlement_at, state')
      .eq('state', 'active');

    if (error) throw error;

    const due: ChannelSettlementCandidate[] = [];
    const now = Date.now();

    for (const row of channels ?? []) {
      const state = row.channel_state as { executorBalance?: number } | null;
      const executorBalance = state?.executorBalance ?? 0;
      if (executorBalance <= 0) continue;

      const schedule = await this.getSettlementSchedule(row.user_id as string);
      const intervalMs =
        schedule === 'quarterly'
          ? 90 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;

      const lastSettlement = row.last_settlement_at
        ? new Date(row.last_settlement_at as string).getTime()
        : 0;

      if (now - lastSettlement >= intervalMs) {
        due.push({
          channelId: row.id as string,
          userId: row.user_id as string,
          executorBalance,
        });
      }
    }

    return due;
  }

  async markChannelSettled(channelId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('payment_channels')
      .update({
        last_settlement_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', channelId)
      .eq('user_id', userId);

    if (error) throw error;
  }
}

export const channelStateService = new ChannelStateService();
