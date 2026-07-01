import { Buffer } from 'buffer';

type WalletInfo = {
  publicKey: string;
  network: 'testnet' | 'mainnet';
  connectedAt: number;
};

type WalletEventType = 'walletConnected' | 'walletDisconnected';
type WalletEventHandler = (info?: WalletInfo) => void;

class StellarWalletService {
  private wallet: WalletInfo | null = null;
  private listeners: Map<WalletEventType, Set<WalletEventHandler>> = new Map();
  private readonly STORAGE_KEY = 'stellar_wallet_session';

  constructor() {
    this.loadSession();
  }

  async deriveEncryptionKey(secretKey: string): Promise<Buffer> {
    const encoder = new TextEncoder();
    const baseKeyMaterial = encoder.encode(secretKey);

    const baseKey = await crypto.subtle.importKey(
      'raw',
      baseKeyMaterial,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );

    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: encoder.encode('syncro:on-chain-subscription-encryption-v1'),
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const exportedKey = await crypto.subtle.exportKey('raw', derivedKey);
    return Buffer.from(exportedKey);
  }

  async connect(network: 'testnet' | 'mainnet' = 'testnet'): Promise<WalletInfo> {
    if (typeof window === 'undefined') throw new Error('Wallet connection requires browser');

    const freighter = (window as any).freighter;
    if (!freighter) throw new Error('Freighter wallet not installed');

    const publicKey = await freighter.getPublicKey();
    if (!publicKey) throw new Error('Failed to get public key');

    this.wallet = { publicKey, network, connectedAt: Date.now() };
    this.saveSession();
    this.emit('walletConnected', this.wallet);

    return this.wallet;
  }

  disconnect(): void {
    const wasConnected = this.wallet !== null;
    this.wallet = null;
    this.clearSession();
    if (wasConnected) this.emit('walletDisconnected');
  }

  getWallet(): WalletInfo | null {
    return this.wallet;
  }

  isConnected(): boolean {
    return this.wallet !== null;
  }

  async signTransaction(xdr: string): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not connected');

    const freighter = (window as any).freighter;
    if (!freighter) throw new Error('Freighter wallet not available');

    const signedXdr = await freighter.signTransaction(xdr, {
      network: this.wallet.network === 'mainnet' ? 'PUBLIC' : 'TESTNET',
      networkPassphrase: this.wallet.network === 'mainnet' 
        ? 'Public Global Stellar Network ; September 2015'
        : 'Test SDF Network ; September 2015',
    });

    return signedXdr;
  }

  on(event: WalletEventType, handler: WalletEventHandler): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: WalletEventType, handler: WalletEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: WalletEventType, info?: WalletInfo): void {
    this.listeners.get(event)?.forEach(handler => handler(info));
  }

  private saveSession(): void {
    if (typeof window === 'undefined' || !this.wallet) return;
    sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.wallet));
  }

  private loadSession(): void {
    if (typeof window === 'undefined') return;
    const stored = sessionStorage.getItem(this.STORAGE_KEY);
    if (stored) {
      try {
        this.wallet = JSON.parse(stored);
      } catch {}
    }
  }

  private clearSession(): void {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(this.STORAGE_KEY);
  }
}

export const stellarWallet = new StellarWalletService();
export type { WalletInfo, WalletEventType };
