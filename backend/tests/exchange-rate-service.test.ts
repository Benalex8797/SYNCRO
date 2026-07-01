import { FiatRateProvider } from '../src/services/exchange-rate/fiat-provider';

// Mock logger
jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('FiatRateProvider', () => {
  const provider = new FiatRateProvider();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns rates from ExchangeRate-API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base: 'USD',
        rates: { EUR: 0.92, GBP: 0.79, NGN: 1520 },
      }),
    });

    const rates = await provider.getRates('USD');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.exchangerate-api.com/v4/latest/USD'
    );
    expect(rates.EUR).toBe(0.92);
    expect(rates.NGN).toBe(1520);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(provider.getRates('USD')).rejects.toThrow('Fiat rate API returned status 500');
  });

  it('supports fiat currencies', () => {
    expect(provider.supportsCurrency('USD')).toBe(true);
    expect(provider.supportsCurrency('NGN')).toBe(true);
    expect(provider.supportsCurrency('XLM')).toBe(false);
  });
});

import { ExchangeRateService } from '../src/services/exchange-rate/exchange-rate-service';
import type { ExchangeRateProvider } from '../src/services/exchange-rate/types';

function createMockProvider(
  name: string,
  currencies: string[],
  rates: Record<string, number>
): ExchangeRateProvider {
  return {
    getName: () => name,
    supportsCurrency: (c) => currencies.includes(c),
    getRates: jest.fn().mockResolvedValue(rates),
  };
}

describe('ExchangeRateService', () => {
  let fiatProvider: ExchangeRateProvider;
  let frankfurterProvider: ExchangeRateProvider;
  let cryptoProvider: ExchangeRateProvider;
  let service: ExchangeRateService;

  beforeEach(() => {
    fiatProvider = createMockProvider(
      'fiat',
      ['USD', 'EUR', 'NGN'],
      { USD: 1, EUR: 0.92, GBP: 0.79, NGN: 1520 }
    );
    frankfurterProvider = createMockProvider(
      'Frankfurter',
      ['USD', 'EUR', 'NGN'],
      { USD: 1, EUR: 0.91, GBP: 0.78, NGN: 1510 }
    );
    cryptoProvider = createMockProvider(
      'crypto',
      ['XLM', 'USDC'],
      { XLM: 8.5, USDC: 1 }
    );
    service = new ExchangeRateService([fiatProvider, frankfurterProvider, cryptoProvider]);
  });

  it('returns combined fiat and crypto rates', async () => {
    const rates = await service.getRates('USD');
    expect(rates.EUR).toBe(0.92);
    expect(rates.XLM).toBe(8.5);
  });

  it('caches rates within TTL', async () => {
    await service.getRates('USD');
    await service.getRates('USD');

    expect(fiatProvider.getRates).toHaveBeenCalledTimes(1);
    expect(cryptoProvider.getRates).toHaveBeenCalledTimes(1);
  });

  it('converts between two currencies', async () => {
    const result = await service.convert(100, 'USD', 'EUR');
    expect(result).toBeCloseTo(92, 0);
  });

  it('converts through USD intermediary', async () => {
    const result = await service.convert(1, 'EUR', 'NGN');
    // 1 EUR -> USD = 1/0.92 ~= 1.087 -> NGN = 1.087 * 1520 ~= 1652
    expect(result).toBeCloseTo(1652.17, 0);
  });

  it('falls back to Frankfurter when primary fiat provider fails', async () => {
    (fiatProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('ExchangeRate-API down'));

    const rates = await service.getRates('USD');

    // Frankfurter rates should be used for fiat; crypto still comes from CoinGecko mock
    expect(rates.EUR).toBe(0.91);
    expect(rates.XLM).toBe(8.5);
    expect(frankfurterProvider.getRates).toHaveBeenCalledTimes(1);
  });

  it('returns stale cache when all providers fail', async () => {
    // First call succeeds and populates cache
    await service.getRates('USD');

    // All providers throw on the next attempt
    (fiatProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('API down'));
    (frankfurterProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('API down'));
    (cryptoProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('API down'));

    // Force cache expiry
    service.expireCacheForTesting('USD');

    const rates = await service.getRates('USD');
    expect(rates.EUR).toBe(0.92); // stale cached value from first call
  });

  it('returns static fallback when no cache exists and all providers fail', async () => {
    const failProvider = createMockProvider('fail', ['USD', 'EUR'], {});
    (failProvider.getRates as jest.Mock).mockRejectedValue(new Error('API down'));
    const failFrankfurter = createMockProvider('failFrankfurter', ['USD', 'EUR'], {});
    (failFrankfurter.getRates as jest.Mock).mockRejectedValue(new Error('API down'));
    const failCryptoProvider = createMockProvider('failCrypto', ['XLM'], {});
    (failCryptoProvider.getRates as jest.Mock).mockRejectedValue(new Error('API down'));

    const failService = new ExchangeRateService([failProvider, failFrankfurter, failCryptoProvider]);
    const rates = await failService.getRates('USD');

    // Should return static fallback rates
    expect(rates.EUR).toBe(0.92);
    expect(rates.XLM).toBe(8.5);
  });

  describe('getExchangeRateResponse', () => {
    it('returns source=live on a fresh fetch', async () => {
      const response = await service.getExchangeRateResponse('USD');
      expect(response.stale).toBe(false);
      expect(response.source).toBe('live');
    });

    it('returns source=stale-cache when all providers fail but cache exists', async () => {
      // Populate cache
      await service.getRates('USD');
      service.expireCacheForTesting('USD');

      (fiatProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('down'));
      (frankfurterProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('down'));
      (cryptoProvider.getRates as jest.Mock).mockRejectedValueOnce(new Error('down'));

      const response = await service.getExchangeRateResponse('USD');
      expect(response.stale).toBe(true);
      expect(response.source).toBe('stale-cache');
    });

    it('returns source=static-fallback when all providers fail and no cache exists', async () => {
      const failProvider = createMockProvider('fail', ['USD'], {});
      (failProvider.getRates as jest.Mock).mockRejectedValue(new Error('down'));
      const failFrankfurter = createMockProvider('failF', ['USD'], {});
      (failFrankfurter.getRates as jest.Mock).mockRejectedValue(new Error('down'));
      const failCrypto = createMockProvider('failC', ['XLM'], {});
      (failCrypto.getRates as jest.Mock).mockRejectedValue(new Error('down'));

      const failService = new ExchangeRateService([failProvider, failFrankfurter, failCrypto]);
      const response = await failService.getExchangeRateResponse('USD');

      expect(response.stale).toBe(true);
      expect(response.source).toBe('static-fallback');
    });

    it('returns source=live on a cache hit within TTL', async () => {
      // First call populates cache
      await service.getExchangeRateResponse('USD');
      // Second call should hit cache
      const response = await service.getExchangeRateResponse('USD');
      expect(response.stale).toBe(false);
      expect(response.source).toBe('live');
      // Providers called only once (cache hit on second call)
      expect(fiatProvider.getRates).toHaveBeenCalledTimes(1);
    });
  });

  describe('configurable TTL', () => {
    it('respects a custom TTL passed to the constructor', async () => {
      const shortTtlService = new ExchangeRateService(
        [fiatProvider, frankfurterProvider, cryptoProvider],
        100 // 100 ms TTL
      );

      await shortTtlService.getRates('USD');
      expect(fiatProvider.getRates).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      await shortTtlService.getRates('USD');
      // Should have re-fetched after TTL expired
      expect(fiatProvider.getRates).toHaveBeenCalledTimes(2);
    });
  });
});
