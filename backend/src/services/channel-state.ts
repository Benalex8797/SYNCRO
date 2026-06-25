import { supabase } from '../config/database';
import logger from '../config/logger';
import { paymentChannelService, type PaymentChannelRecord } from './payment-channel-service';

export type ExpiryAlertDays = 7 | 3 | 1;

export interface ChannelHealthCheck {
  channelId: string;
  userId: string;
  expiryDaysRemaining: number | null;
  renewalsRemaining: number | null;
  expired: boolean;
}

export class ChannelStateService {
  private readonly expiryThresholds: ExpiryAlertDays[] = [7, 3, 1];

  async getAverageRenewalAmount(userId: string): Promise<number> {
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('price')
      .eq('user_id', userId)
      .eq('status', 'active');

    const prices = (subs ?? []).map((s) => Number(s.price)).filter((p) => p > 0);
    if (prices.length === 0) return 10;
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  assessChannel(channel: PaymentChannelRecord, avgRenewal: number): ChannelHealthCheck {
    const balance = channel.channelState?.userBalance ?? Number.parseFloat(channel.balance);
    const renewalsRemaining = avgRenewal > 0 ? balance / avgRenewal : null;

    let expiryDaysRemaining: number | null = null;
    let expired = false;
    if (channel.expiry) {
      const ms = new Date(channel.expiry).getTime() - Date.now();
      expiryDaysRemaining = Math.ceil(ms / (24 * 60 * 60 * 1000));
      expired = expiryDaysRemaining <= 0;
    }

    return {
      channelId: channel.id,
      userId: channel.userId,
      expiryDaysRemaining,
      renewalsRemaining,
      expired,
    };
  }

  getExpiryAlertThreshold(daysRemaining: number | null): ExpiryAlertDays | null {
    if (daysRemaining === null || daysRemaining < 0) return null;
    let match: ExpiryAlertDays | null = null;
    for (const threshold of this.expiryThresholds) {
      if (daysRemaining <= threshold) match = threshold;
    }
    return match;
  }

  isLowBalance(renewalsRemaining: number | null): boolean {
    return renewalsRemaining !== null && renewalsRemaining < 2;
  }

  async listActiveChannels(): Promise<PaymentChannelRecord[]> {
    const { data, error } = await supabase
      .from('payment_channels')
      .select('*')
      .eq('state', 'active');

    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      counterparty: row.counterparty as string,
      balance: String(row.balance ?? 0),
      state: row.state as PaymentChannelRecord['state'],
      lastUpdated: (row.updated_at ?? row.created_at) as string,
      expiry: row.expiry as string | undefined,
      channelState: row.channel_state as PaymentChannelRecord['channelState'],
    }));
  }

  async getChannelPreferences(userId: string): Promise<{
    autoTopUp: boolean;
    autoTopUpAmount: number | null;
  }> {
    const { data } = await supabase
      .from('profiles')
      .select('channel_auto_top_up, channel_auto_top_up_amount')
      .eq('id', userId)
      .maybeSingle();

    return {
      autoTopUp: Boolean(data?.channel_auto_top_up),
      autoTopUpAmount: data?.channel_auto_top_up_amount
        ? Number(data.channel_auto_top_up_amount)
        : null,
    };
  }

  async setChannelPreferences(
    userId: string,
    prefs: { autoTopUp?: boolean; autoTopUpAmount?: number | null },
  ): Promise<void> {
    const { error } = await supabase
      .from('profiles')
      .update({
        ...(prefs.autoTopUp !== undefined && { channel_auto_top_up: prefs.autoTopUp }),
        ...(prefs.autoTopUpAmount !== undefined && {
          channel_auto_top_up_amount: prefs.autoTopUpAmount,
        }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) throw error;
  }

  async closeExpiredChannel(userId: string, channelId: string): Promise<void> {
    await paymentChannelService.initiateClose(userId, channelId);
    await paymentChannelService.finalizeClose(userId, channelId);
    logger.info('Expired channel closed', { userId, channelId });
  }
}

export const channelStateService = new ChannelStateService();
