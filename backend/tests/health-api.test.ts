import request from 'supertest';
import express from 'express';
import { healthService } from '../src/services/health-service';
import { adminAuth } from '../src/middleware/admin';

jest.mock('../src/services/health-service', () => ({
  healthService: {
    getAdminHealth: jest.fn(),
  },
}));

jest.mock('../src/config/logger');

const app = express();

app.get('/api/admin/health', adminAuth, async (req, res) => {
  try {
    const includeHistory = req.query.history !== 'false';
    const health = await healthService.getAdminHealth(includeHistory);
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(health);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch health status' });
  }
});

describe('Admin Health API', () => {
  it('should return 401 if x-admin-api-key is missing', async () => {
    const response = await request(app).get('/api/admin/health');
    expect(response.status).toBe(401);
  });

  it('should return 403 if x-admin-api-key is incorrect', async () => {
    const response = await request(app)
      .get('/api/admin/health')
      .set('x-admin-api-key', 'wrong-key');
    expect(response.status).toBe(403);
  });

  it('should return 200 and health payload when healthy', async () => {
    (healthService.getAdminHealth as jest.Mock).mockResolvedValue({
      status: 'healthy',
      timestamp: '2025-01-01T00:00:00.000Z',
      metrics: {
        failedRenewalsLastHour: 0,
        contractErrorsLastHour: 0,
        lastAgentActivityAt: new Date().toISOString(),
        pendingReminders: 0,
        processedRemindersLast24h: 10,
      },
      alerts: [],
      thresholds: {
        failedRenewalsPerHour: 10,
        contractErrorsPerHour: 5,
        agentInactivityHours: 24,
      },
      history: [],
    });

    const response = await request(app)
      .get('/api/admin/health')
      .set('x-admin-api-key', process.env.ADMIN_API_KEY!);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
    expect(response.body.metrics).toBeDefined();
    expect(response.body.alerts).toEqual([]);
    expect(response.body.thresholds).toBeDefined();
  });

  it('should return 503 when status is unhealthy', async () => {
    (healthService.getAdminHealth as jest.Mock).mockResolvedValue({
      status: 'unhealthy',
      timestamp: '2025-01-01T00:00:00.000Z',
      metrics: { failedRenewalsLastHour: 20, contractErrorsLastHour: 8 },
      alerts: [
        {
          id: 'failed_renewals',
          message: 'Failed renewals exceed threshold',
          severity: 'critical',
          value: 20,
          threshold: 10,
          triggeredAt: new Date().toISOString(),
        },
      ],
      thresholds: {},
      history: [],
    });

    const response = await request(app)
      .get('/api/admin/health')
      .set('x-admin-api-key', process.env.ADMIN_API_KEY!);

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('unhealthy');
    expect(response.body.alerts).toHaveLength(1);
    expect(response.body.alerts[0].id).toBe('failed_renewals');
  });

  it('should pass history=false to getAdminHealth when query param is set', async () => {
    (healthService.getAdminHealth as jest.Mock).mockResolvedValue({
      status: 'healthy',
      timestamp: '2025-01-01T00:00:00.000Z',
      metrics: {},
      alerts: [],
      thresholds: {},
    });

    await request(app)
      .get('/api/admin/health?history=false')
      .set('x-admin-api-key', process.env.ADMIN_API_KEY!);

    expect(healthService.getAdminHealth).toHaveBeenCalledWith(false);
  });
});
