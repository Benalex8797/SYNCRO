import { ReminderEngine } from '../src/services/reminder-engine';
import { supabase } from '../src/config/database';
import { slackService } from '../src/services/slack-service';
import { blockchainService } from '../src/services/blockchain-service';
import { userPreferenceService } from '../src/services/user-preference-service';

jest.mock('../src/config/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  __esModule: true,
}));

jest.mock('../src/config/database', () => ({
  supabase: {
    from: jest.fn(),
    auth: {
      admin: {
        getUserById: jest.fn(),
      },
    },
  },
}));

jest.mock('../src/services/email-service', () => ({
  emailService: {
    sendReminderEmail: jest.fn(),
  },
}));

jest.mock('../src/services/push-service', () => ({
  pushService: {
    sendPushNotification: jest.fn(),
  },
}));

jest.mock('../src/services/slack-service', () => ({
  slackService: {
    sendReminderNotification: jest.fn().mockResolvedValue({
      success: true,
      metadata: { channel: 'slack' },
    }),
  },
}));

jest.mock('../src/services/blockchain-service', () => ({
  blockchainService: {
    logReminderEvent: jest.fn().mockResolvedValue({ success: true }),
  },
}));

jest.mock('../src/services/user-preference-service', () => ({
  userPreferenceService: {
    getPreferences: jest.fn().mockResolvedValue({
      user_id: 'user-1',
      notification_channels: ['slack'],
      reminder_timing: [7, 3, 1],
      email_opt_ins: {
        marketing: false,
        reminders: false,
        updates: true,
      },
      automation_flags: {
        auto_renew: false,
        auto_retry: true,
      },
      risk_notification_threshold: 'HIGH',
      quiet_hours_enabled: false,
      quiet_hours_start: '22:00',
      quiet_hours_end: '07:00',
      quiet_hours_timezone: 'UTC',
      critical_alerts_only: false,
      currency: 'USD',
      timezone: 'UTC',
      locale: 'en',
      calendar_sync_enabled: false,
      calendar_export_reminders: false,
      updated_at: new Date().toISOString(),
    }),
  },
}));

describe('ReminderEngine Slack delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (userPreferenceService.getPreferences as jest.Mock).mockResolvedValue({
      user_id: 'user-1',
      notification_channels: ['slack'],
      reminder_timing: [7, 3, 1],
      email_opt_ins: {
        marketing: false,
        reminders: false,
        updates: true,
      },
      automation_flags: {
        auto_renew: false,
        auto_retry: true,
      },
      risk_notification_threshold: 'HIGH',
      quiet_hours_enabled: false,
      quiet_hours_start: '22:00',
      quiet_hours_end: '07:00',
      quiet_hours_timezone: 'UTC',
      critical_alerts_only: false,
      currency: 'USD',
      timezone: 'UTC',
      locale: 'en',
      calendar_sync_enabled: false,
      calendar_export_reminders: false,
      updated_at: new Date().toISOString(),
    });

    (slackService.sendReminderNotification as jest.Mock).mockResolvedValue({
      success: true,
      metadata: { channel: 'slack' },
    });

    (blockchainService.logReminderEvent as jest.Mock).mockResolvedValue({
      success: true,
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'reminder_schedules') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
          upsert: jest.fn().mockResolvedValue({ error: null }),
          single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
        };
      }

      if (table === 'subscriptions') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: {
              id: 'sub-1',
              user_id: 'user-1',
              name: 'Netflix',
              provider: 'Netflix',
              category: 'Streaming',
              price: 15.99,
              billing_cycle: 'monthly',
              status: 'active',
              next_billing_date: '2026-06-01T00:00:00Z',
              logo_url: null,
              website_url: null,
              renewal_url: 'https://netflix.com/account',
              notes: null,
              tags: [],
              expired_at: null,
              active_until: '2026-06-01T00:00:00Z',
              is_trial: false,
              trial_ends_at: null,
              trial_converts_to_price: null,
              credit_card_required: false,
              created_at: '2026-05-01T00:00:00Z',
              updated_at: '2026-05-01T00:00:00Z',
            },
            error: null,
          }),
        };
      }

      if (table === 'user_preferences') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: {
              user_id: 'user-1',
              notification_channels: ['slack'],
              reminder_timing: [7, 3, 1],
              email_opt_ins: {
                marketing: false,
                reminders: false,
                updates: true,
              },
              automation_flags: {
                auto_renew: false,
                auto_retry: true,
              },
              risk_notification_threshold: 'HIGH',
              quiet_hours_enabled: false,
              quiet_hours_start: '22:00',
              quiet_hours_end: '07:00',
              quiet_hours_timezone: 'UTC',
              critical_alerts_only: false,
              currency: 'USD',
              timezone: 'UTC',
              locale: 'en',
              calendar_sync_enabled: false,
              calendar_export_reminders: false,
              updated_at: new Date().toISOString(),
            },
            error: null,
          }),
        };
      }

      if (table === 'notification_deliveries') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  id: 'delivery-1',
                  reminder_schedule_id: 'reminder-1',
                  user_id: 'user-1',
                  channel: 'slack',
                  status: 'pending',
                  attempt_count: 0,
                  max_attempts: 3,
                  last_attempt_at: null,
                  next_retry_at: null,
                  error_message: null,
                  metadata: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnThis(),
          eq: jest.fn().mockResolvedValue({ error: null }),
        };
      }

      if (table === 'blockchain_logs') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { id: 'log-1' },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnThis(),
          eq: jest.fn().mockResolvedValue({ error: null }),
        };
      }

      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        gt: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(),
        lt: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockResolvedValue({ error: null }),
        single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
      };
    });
  });

  it('sends Slack notifications and records delivery status', async () => {
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'reminder_schedules') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [
                  {
                    id: 'reminder-1',
                    subscription_id: 'sub-1',
                    user_id: 'user-1',
                    reminder_date: '2026-05-25',
                    reminder_type: 'renewal',
                    days_before: 7,
                    status: 'pending',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                ],
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === 'subscriptions') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: {
              id: 'sub-1',
              user_id: 'user-1',
              name: 'Netflix',
              provider: 'Netflix',
              category: 'Streaming',
              price: 15.99,
              billing_cycle: 'monthly',
              status: 'active',
              next_billing_date: '2026-06-01T00:00:00Z',
              logo_url: null,
              website_url: null,
              renewal_url: 'https://netflix.com/account',
              notes: null,
              tags: [],
              expired_at: null,
              active_until: '2026-06-01T00:00:00Z',
              is_trial: false,
              trial_ends_at: null,
              trial_converts_to_price: null,
              credit_card_required: false,
              created_at: '2026-05-01T00:00:00Z',
              updated_at: '2026-05-01T00:00:00Z',
            },
            error: null,
          }),
        };
      }

      if (table === 'notification_deliveries') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  id: 'delivery-1',
                  reminder_schedule_id: 'reminder-1',
                  user_id: 'user-1',
                  channel: 'slack',
                  status: 'pending',
                  attempt_count: 0,
                  max_attempts: 3,
                  last_attempt_at: null,
                  next_retry_at: null,
                  error_message: null,
                  metadata: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === 'user_preferences') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: {
              user_id: 'user-1',
              notification_channels: ['slack'],
              reminder_timing: [7, 3, 1],
              email_opt_ins: {
                marketing: false,
                reminders: false,
                updates: true,
              },
              automation_flags: {
                auto_renew: false,
                auto_retry: true,
              },
              risk_notification_threshold: 'HIGH',
              quiet_hours_enabled: false,
              quiet_hours_start: '22:00',
              quiet_hours_end: '07:00',
              quiet_hours_timezone: 'UTC',
              critical_alerts_only: false,
              currency: 'USD',
              timezone: 'UTC',
              locale: 'en',
              calendar_sync_enabled: false,
              calendar_export_reminders: false,
              updated_at: new Date().toISOString(),
            },
            error: null,
          }),
        };
      }

      if (table === 'blockchain_logs') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { id: 'log-1' },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        gt: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(),
        lt: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockResolvedValue({ error: null }),
        single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
      };
    });

    const engine = new ReminderEngine();
    await (engine as any).processReminder({
      id: 'reminder-1',
      subscription_id: 'sub-1',
      user_id: 'user-1',
      reminder_date: '2026-05-25',
      reminder_type: 'renewal',
      days_before: 7,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(slackService.sendReminderNotification).toHaveBeenCalledTimes(1);
    expect(blockchainService.logReminderEvent).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        subscription: expect.objectContaining({ id: 'sub-1' }),
      }),
      ['slack'],
    );
  });
});
