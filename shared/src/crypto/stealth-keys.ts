import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';

/**
 * Converts an Ed25519 public key to Curve25519 public key.
 * @param ed25519PubKey Ed25519 public key as hex string.
 * @returns Curve25519 public key as hex string.
 */
export function ed25519ToCurve25519PubKey(ed25519PubKey: string): string {
  const pubKeyBytes = hexToBytes(ed25519PubKey);
  const montgomeryBytes = edwardsToMontgomeryPub(pubKeyBytes);
  return bytesToHex(montgomeryBytes);
}

/**
 * Converts an Ed25519 secret key to Curve25519 secret key.
 * @param ed25519SecKey Ed25519 secret key as hex string.
 * @returns Curve25519 secret key as hex string.
 */
export function ed25519ToCurve25519SecKey(ed25519SecKey: string): string {
  const secKeyBytes = hexToBytes(ed25519SecKey);
  const montgomeryBytes = edwardsToMontgomeryPriv(secKeyBytes);
  return bytesToHex(montgomeryBytes);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
