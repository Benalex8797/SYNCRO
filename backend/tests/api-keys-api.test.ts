const insertMock = jest.fn();
const selectMock = jest.fn();
const updateMock = jest.fn();

const fromImplementation = (tableName: string) => {
  console.log('FROM MOCK CALLED for table', tableName);

  if (tableName === 'audit_logs') {
    return { insert: jest.fn().mockResolvedValue({ error: null }) };
  }

  if (tableName !== 'api_keys') {
    return undefined;
  }

  const queryBuilder = {
    select: (...args: any[]) => {
      const query: any = {
        eq: () => query,
        order: () => query,
        single: () => {
          query._single = true;
          return query;
        },
        maybeSingle: () => {
          query._maybeSingle = true;
          return query;
        },
        then: (resolve: any, reject: any) => {
          const result = selectMock(...args);
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
    update: (...args: any[]) => {
      const query: any = {
        eq: () => query,
        then: (resolve: any, reject: any) => {
          const result = updateMock(...args);
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
    insert: (...args: any[]) => insertMock(...args),
  };

  const result = queryBuilder;
  console.log('FROM MOCK RETURNING', result);
  return result;
};

const fromMock = jest.fn(fromImplementation);

const supabaseMock = {
  supabase: {
    from: fromMock,
    auth: { getUser: jest.fn() },
    __mocks: { insertMock, selectMock, updateMock, fromMock },
  },
};

jest.mock('../src/config/database', () => supabaseMock);


jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req: any, _res: any, next: any) => next(),
  requireScope: (_scope: string) => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const auditInsertMock = jest.fn().mockResolvedValue({ error: null });
jest.mock('../src/services/audit-service', () => ({
  auditApiKeyEvent: jest.fn().mockResolvedValue(undefined),
  auditService: { insertEntry: auditInsertMock },
}));

import express from 'express';
import request from 'supertest';
import apiKeysRoutes from '../src/routes/api-keys';
import { supabase } from '../src/config/database';
import { auditApiKeyEvent } from '../src/services/audit-service';

describe('/api/keys routes', () => {
  let app: express.Application;
  const userId = 'user-123';

  beforeEach(() => {
    console.log('SUPABASE FROM (mocked)', (supabase as any).from);
    (supabase as any).from.mockImplementation(fromImplementation);
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: userId, authMethod: 'jwt', scopes: ['subscriptions:read', 'subscriptions:write'] };
      next();
    });
    app.use('/api/keys', apiKeysRoutes);

    (supabase as any).__mocks.insertMock.mockReset().mockImplementation(async (payload: any) => {
      console.log('INSERT MOCK CALLED', payload);
      return { data: [{ id: 'key-id' }], error: null };
    });
    (supabase as any).__mocks.selectMock.mockReset();
    (supabase as any).__mocks.updateMock.mockReset();
  });

  it('creates a new API key and returns raw key', async () => {
    (supabase as any).__mocks.insertMock.mockResolvedValue({ data: [{ id: 'key-id' }], error: null });

    const res = await request(app)
      .post('/api/keys')
      .send({ name: 'my-service', scopes: ['subscriptions:read', 'subscriptions:write'] });

    console.log('CREATE KEY RESPONSE', res.status, res.body);
    console.log('from calls', (supabase as any).from.mock.calls);
    expect((supabase as any).from).toHaveBeenCalledWith('api_keys');
    expect((supabase as any).__mocks.insertMock).toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.key).toMatch(/^sk_[0-9a-f]{64}$/);
    expect((supabase as any).__mocks.insertMock).toHaveBeenCalled();
    expect(auditApiKeyEvent).toHaveBeenCalledWith(
      'api_key.created',
      userId,
      expect.objectContaining({ keyName: 'my-service', scopes: ['subscriptions:read', 'subscriptions:write'] }),
    );
  });

  it('lists API keys for user', async () => {
    const entries = [{ id: 'key-1', service_name: 'demo', scopes: ['subscriptions:read'] }];
    (supabase as any).__mocks.selectMock.mockResolvedValue({ data: entries, error: null });

    const res = await request(app).get('/api/keys');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(entries);
    expect((supabase as any).__mocks.selectMock).toHaveBeenCalled();
  });

  it('revokes an API key and emits audit event', async () => {
    (supabase as any).__mocks.selectMock.mockResolvedValueOnce({ data: { id: 'key-id' }, error: null });
    (supabase as any).__mocks.updateMock.mockResolvedValue({ data: { id: 'key-id', revoked: true }, error: null });

    const res = await request(app).delete('/api/keys/key-id');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect((supabase as any).__mocks.selectMock).toHaveBeenCalled();
    expect((supabase as any).__mocks.updateMock).toHaveBeenCalled();
    expect(auditApiKeyEvent).toHaveBeenCalledWith(
      'api_key.revoked',
      userId,
      expect.objectContaining({ keyId: 'key-id' }),
    );
  });

  it('returns usage stats', async () => {
    const record = { id: 'key-id', service_name: 'demo', scopes: ['subscriptions:read'], request_count: 10, last_used_at: 'now' };
    (supabase as any).__mocks.selectMock.mockResolvedValue({ data: record, error: null });

    const res = await request(app).get('/api/keys/key-id/usage');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(record);
  });
});
