jest.mock('../src/config/database', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../src/services/payment-channel-service', () => ({
  paymentChannelService: {
    listChannels: jest.fn(),
    applyOffChainRenewal: jest.fn(),
  },
}));

import { ChannelStateService } from '../src/services/channel-state';
import { supabase } from '../src/config/database';
import { paymentChannelService } from '../src/services/payment-channel-service';

describe('ChannelStateService', () => {
  let service: ChannelStateService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ChannelStateService();
  });

  describe('findPayableChannel', () => {
    it('returns active channel with sufficient balance', async () => {
      (paymentChannelService.listChannels as jest.Mock).mockResolvedValue([
        {
          id: 'ch-1',
          state: 'active',
          balance: '50',
          channelState: { userBalance: 50, executorBalance: 0, sequenceNumber: 0, totalDeposited: 50 },
        },
        {
          id: 'ch-2',
          state: 'active',
          balance: '5',
          channelState: { userBalance: 5, executorBalance: 0, sequenceNumber: 0, totalDeposited: 5 },
        },
      ]);

      const channel = await service.findPayableChannel('user-1', 10);
      expect(channel?.id).toBe('ch-1');
    });

    it('returns null when no channel has enough balance', async () => {
      (paymentChannelService.listChannels as jest.Mock).mockResolvedValue([
        {
          id: 'ch-1',
          state: 'active',
          balance: '5',
          channelState: { userBalance: 5, executorBalance: 0, sequenceNumber: 0, totalDeposited: 5 },
        },
      ]);

      const channel = await service.findPayableChannel('user-1', 10);
      expect(channel).toBeNull();
    });
  });

  describe('applyRenewalPayment', () => {
    it('updates channel state and logs payment locally', async () => {
      const updatedChannel = {
        id: 'ch-1',
        state: 'active',
        balance: '40',
        channelState: { userBalance: 40, executorBalance: 10, sequenceNumber: 1, totalDeposited: 50 },
      };

      (paymentChannelService.applyOffChainRenewal as jest.Mock).mockResolvedValue(updatedChannel);
      (supabase.from as jest.Mock).mockReturnValue({
        insert: jest.fn().mockResolvedValue({ error: null }),
      });

      const result = await service.applyRenewalPayment('ch-1', 'user-1', 'sub-1', 10);

      expect(paymentChannelService.applyOffChainRenewal).toHaveBeenCalledWith('ch-1', 'user-1', 10);
      expect(supabase.from).toHaveBeenCalledWith('channel_payments');
      expect(result.channelState?.sequenceNumber).toBe(1);
    });
  });

  describe('getSettlementSchedule', () => {
    it('defaults to monthly', async () => {
      (supabase.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      });

      const schedule = await service.getSettlementSchedule('user-1');
      expect(schedule).toBe('monthly');
    });

    it('returns quarterly when configured', async () => {
      (supabase.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: { channel_settlement_schedule: 'quarterly' },
        }),
      });

      const schedule = await service.getSettlementSchedule('user-1');
      expect(schedule).toBe('quarterly');
    });
  });
});
