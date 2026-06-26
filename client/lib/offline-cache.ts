/**
 * Offline cache utilities.
 *
 * Persists a lightweight snapshot of subscription data to localStorage so the
 * offline page can display real data without a network connection.
 *
 * Key: "syncro_offline_subscriptions"
 * Value: JSON-serialised OfflineSubscription[]
 */

export interface OfflineSubscription {
  id: string;
  name: string;
  status: string;
  billing_cycle: string;
  next_renewal: string | null;
  price: number;
  category: string | null;
}

const STORAGE_KEY = 'syncro_offline_subscriptions';
const TIMESTAMP_KEY = 'syncro_offline_subscriptions_ts';

export function saveSubscriptionsOffline(subs: OfflineSubscription[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subs));
    localStorage.setItem(TIMESTAMP_KEY, new Date().toISOString());
  } catch {
    // Storage quota exceeded or private browsing — silently ignore
  }
}

export function loadOfflineSubscriptions(): OfflineSubscription[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OfflineSubscription[];
  } catch {
    return [];
  }
}

export function getOfflineCacheTimestamp(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TIMESTAMP_KEY);
}

export function clearOfflineCache(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(TIMESTAMP_KEY);
}
