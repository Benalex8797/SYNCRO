import logger from '../../config/logger';
import { STATIC_RATES_USD } from './static-rates';
import type { ExchangeRateProvider, CachedRates, ExchangeRateResponse } from './types';

/**
 * How long a freshly-fetched result is considered "live" before the service
 * will attempt to re-fetch from providers. Defaults to 1 hour.
 * Override via EXCHANGE_RATE_TTL_MS environment variable.
 */
const DEFAULT_TTL_MS = 3_600_000; // 1 hour

function getTtl(): number {
  const env = process.env.EXCHANGE_RATE_TTL_MS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

/**
 * Result type returned by the internal fetch helper so the public methods
 * know which data source was used.
 */
type FetchResult =
  | { source: 'live'; rates: Record<string, number> }
  | { source: 'stale-cache'; rates: Record<string, number> }
  | { source: 'static-fallback'; rates: Record<string, number> };

export class ExchangeRateService {
  private cache = new Map<string, CachedRates>();
  private readonly ttl: number;
  private providers: ExchangeRateProvider[];

  constructor(providers: ExchangeRateProvider[], ttlMs?: number) {
    this.providers = providers;
    this.ttl = ttlMs ?? getTtl();
  }

  /**
   * Returns exchange rates for the given base currency.
   * Fetch order:
   *   1. In-memory cache (if within TTL)
   *   2. Live providers (tried in order; partial results accepted)
   *   3. Stale in-memory cache (if all providers fail but a prior entry exists)
   *   4. Static hardcoded rates (last resort)
   */
  async getRates(baseCurrency: string): Promise<Record<string, number>> {
    const result = await this.getRatesWithSource(baseCurrency);
    return result.rates;
  }

  async getRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;

    // Always fetch USD-based rates and cross-convert
    const rates = await this.getRates('USD');
    const fromRate = from === 'USD' ? 1 : rates[from];
    const toRate = to === 'USD' ? 1 : rates[to];

    if (!fromRate || !toRate) {
      throw new Error(`Cannot convert between ${from} and ${to}: missing rate`);
    }

    return toRate / fromRate;
  }

  async convert(amount: number, from: string, to: string): Promise<number> {
    const rate = await this.getRate(from, to);
    return amount * rate;
  }

  async getExchangeRateResponse(baseCurrency: string): Promise<ExchangeRateResponse> {
    const result = await this.getRatesWithSource(baseCurrency);
    const cached = this.cache.get(baseCurrency);

    return {
      base: baseCurrency,
      rates: result.rates,
      cachedAt: cached
        ? new Date(cached.fetchedAt).toISOString()
        : new Date().toISOString(),
      stale: result.source !== 'live',
      source: result.source,
    };
  }

  /** Test helper: expire cache entry to simulate TTL expiry */
  expireCacheForTesting(baseCurrency: string): void {
    const cached = this.cache.get(baseCurrency);
    if (cached) {
      cached.fetchedAt = 0;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getRatesWithSource(baseCurrency: string): Promise<FetchResult> {
    const cached = this.cache.get(baseCurrency);
    const isFresh = cached !== undefined && Date.now() - cached.fetchedAt < this.ttl;

    if (isFresh) {
      return { source: 'live', rates: cached!.rates };
    }

    try {
      const allRates = await this.fetchFromProviders(baseCurrency);
      this.cache.set(baseCurrency, { rates: allRates, fetchedAt: Date.now() });
      return { source: 'live', rates: allRates };
    } catch (error) {
      logger.error('All exchange rate providers failed', { baseCurrency, error });

      // Fallback 1: stale cache
      if (cached) {
        logger.warn('Returning stale cached rates', {
          baseCurrency,
          cachedAt: new Date(cached.fetchedAt).toISOString(),
        });
        return { source: 'stale-cache', rates: cached.rates };
      }

      // Fallback 2: static rates
      logger.warn('Returning static fallback rates — no live data or cache available', {
        baseCurrency,
      });
      return { source: 'static-fallback', rates: this.buildStaticRates(baseCurrency) };
    }
  }

  /**
   * Tries each provider in order and merges results.
   * A single provider failure is logged as a warning and does not abort the
   * overall fetch — partial results from other providers are still used.
   * Only throws (AggregateError) when zero rates were collected from any provider.
   */
  private async fetchFromProviders(baseCurrency: string): Promise<Record<string, number>> {
    const allRates: Record<string, number> = {};
    const errors: Error[] = [];

    for (const provider of this.providers) {
      try {
        const rates = await provider.getRates(baseCurrency);
        Object.assign(allRates, rates);
        logger.debug(`Provider ${provider.getName()} succeeded`, {
          baseCurrency,
          rateCount: Object.keys(rates).length,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Provider ${provider.getName()} failed`, {
          baseCurrency,
          error: err.message,
        });
        errors.push(err);
      }
    }

    if (Object.keys(allRates).length === 0) {
      throw new AggregateError(errors, 'All providers failed');
    }

    return allRates;
  }

  private buildStaticRates(baseCurrency: string): Record<string, number> {
    if (baseCurrency === 'USD') {
      return { ...STATIC_RATES_USD };
    }

    const usdToBase = STATIC_RATES_USD[baseCurrency];
    if (usdToBase) {
      const rates: Record<string, number> = {};
      for (const [currency, usdRate] of Object.entries(STATIC_RATES_USD)) {
        rates[currency] = usdRate / usdToBase;
      }
      return rates;
    }

    // Unknown base currency — return USD-based static rates as best effort
    return { ...STATIC_RATES_USD };
  }
}
