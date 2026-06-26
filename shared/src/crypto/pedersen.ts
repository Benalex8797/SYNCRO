import { sha256 } from '@noble/hashes/sha256';
import { RistrettoPoint } from '@noble/curves/ed25519';

const DOMAIN_PREFIX = 'Syncro-Pedersen-v1';
const RISTRETTO_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

function groupOrder(): bigint {
  return RISTRETTO_ORDER;
}

const G = RistrettoPoint.hashToCurve(sha256(new TextEncoder().encode(DOMAIN_PREFIX + '-G')));
const H = RistrettoPoint.hashToCurve(sha256(new TextEncoder().encode(DOMAIN_PREFIX + '-H')));

export interface PedersenCommitment {
  commitment: string;
  blindingFactor: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function scalarToHex(scalar: bigint): string {
  const hex = scalar.toString(16).padStart(64, '0');
  return hex;
}

export function hexToScalar(hex: string): bigint {
  return BigInt('0x' + hex) % groupOrder();
}

function bytesToScalar(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result % groupOrder();
}

function hashToScalar(...parts: string[]): bigint {
  const input = parts.join('||');
  const hash = sha256(new TextEncoder().encode(input));
  return bytesToScalar(hash);
}

function randomScalar(): bigint {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return bytesToScalar(bytes);
}

function modGroupOrder(n: bigint): bigint {
  const L = groupOrder();
  return ((n % L) + L) % L;
}

export function commit(value: bigint, blindingFactor?: bigint): PedersenCommitment {
  const v = modGroupOrder(value);
  const r = blindingFactor !== undefined ? modGroupOrder(blindingFactor) : randomScalar();
  const C = G.multiply(v).add(H.multiply(r));
  return {
    commitment: C.toHex(),
    blindingFactor: scalarToHex(r),
  };
}

export function verify(value: bigint, blindingFactor: bigint, commitment: string): boolean {
  try {
    const v = modGroupOrder(value);
    const r = modGroupOrder(blindingFactor);
    const expected = G.multiply(v).add(H.multiply(r));
    return expected.toHex() === commitment;
  } catch {
    return false;
  }
}

export function createEventCommitment(
  eventType: string,
  eventData: string,
): PedersenCommitment {
  const v = hashToScalar(DOMAIN_PREFIX, 'event', eventType, eventData);
  return commit(v);
}

export function verifyEventCommitment(
  eventType: string,
  eventData: string,
  blindingFactor: string,
  commitment: string,
): boolean {
  const v = hashToScalar(DOMAIN_PREFIX, 'event', eventType, eventData);
  return verify(v, hexToScalar(blindingFactor), commitment);
}

export function computeEventHash(eventType: string, eventData: string): string {
  const hash = sha256(
    new TextEncoder().encode([DOMAIN_PREFIX, 'event', eventType, eventData].join('||')),
  );
  return bytesToHex(hash);
}
