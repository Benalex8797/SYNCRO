export interface EncryptedData {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface SubscriptionMetadata {
  name: string;
  price: number;
  cycle: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  provider: string;
}

const VALID_CYCLES = new Set(['weekly', 'monthly', 'quarterly', 'yearly']);

function validateSubscriptionMetadata(data: unknown): data is SubscriptionMetadata {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    obj.name.length > 0 &&
    typeof obj.price === 'number' &&
    isFinite(obj.price) &&
    obj.price >= 0 &&
    typeof obj.cycle === 'string' &&
    VALID_CYCLES.has(obj.cycle) &&
    typeof obj.provider === 'string' &&
    obj.provider.length > 0
  );
}

export async function encryptSubscriptionMetadata(
  key: string,
  metadata: SubscriptionMetadata
): Promise<EncryptedData> {
  if (!validateSubscriptionMetadata(metadata)) {
    throw new Error('Invalid subscription metadata schema');
  }
  const plaintext = JSON.stringify(metadata);
  return encryptMetadata(plaintext, key);
}

export async function decryptSubscriptionMetadata(
  key: string,
  encrypted: EncryptedData
): Promise<SubscriptionMetadata> {
  const plaintext = await decryptMetadata(encrypted, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('Decrypted data is not valid JSON');
  }
  if (!validateSubscriptionMetadata(parsed)) {
    throw new Error('Decrypted data does not match subscription metadata schema');
  }
  return parsed;
}

export async function encryptMetadata(plaintext: string, keyHex: string): Promise<EncryptedData> {
  const keyBytes = hexToBytes(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintextBytes
  );
  const ciphertextWithTag = new Uint8Array(ciphertextBuffer);
  const authTag = ciphertextWithTag.slice(-16);
  const ciphertext = ciphertextWithTag.slice(0, -16);

  return {
    iv: bytesToHex(iv),
    authTag: bytesToHex(authTag),
    ciphertext: bytesToHex(ciphertext),
  };
}

export async function decryptMetadata(encrypted: EncryptedData, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const iv = hexToBytes(encrypted.iv);
  const authTag = hexToBytes(encrypted.authTag);
  const ciphertext = hexToBytes(encrypted.ciphertext);
  const ciphertextWithTag = new Uint8Array(ciphertext.length + authTag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(authTag, ciphertext.length);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  try {
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      key,
      ciphertextWithTag.buffer as ArrayBuffer
    );
    return new TextDecoder().decode(plaintextBuffer);
  } catch {
    throw new Error('Decryption failed: invalid key or corrupted data');
  }
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
