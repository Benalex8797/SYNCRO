import { ChannelStateService } from '../src/services/channel-state';

describe('ChannelStateService', () => {
  let service: ChannelStateService;

  beforeEach(() => {
    service = new ChannelStateService();
  });

  describe('assessChannel', () => {
    it('flags low balance when fewer than 2 renewals remain', () => {
      const health = service.assessChannel(
        {
          id: 'ch-1',
          userId: 'u-1',
          counterparty: 'SYNCRO',
          balance: '15',
          state: 'active',
          lastUpdated: new Date().toISOString(),
          channelState: {
            sequenceNumber: 1,
            userBalance: 15,
            executorBalance: 0,
            totalDeposited: 15,
          },
        },
        10,
      );
      expect(health.renewalsRemaining).toBe(1.5);
      expect(service.isLowBalance(health.renewalsRemaining)).toBe(true);
    });

    it('detects expiry threshold alerts', () => {
      const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const health = service.assessChannel(
        {
          id: 'ch-1',
          userId: 'u-1',
          counterparty: 'SYNCRO',
          balance: '100',
          state: 'active',
          lastUpdated: new Date().toISOString(),
          expiry: inThreeDays,
        },
        10,
      );
      expect(service.getExpiryAlertThreshold(health.expiryDaysRemaining)).toBe(3);
    });
  });
});
