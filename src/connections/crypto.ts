import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { ConnectionSecretMaterial, EncryptedSecretEnvelope } from './types';

function asJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function fromJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class ConnectionCryptoService {
  private readonly defaultKey?: string;
  private readonly keyId: string;

  constructor(options: { defaultKey?: string; keyId?: string } = {}) {
    this.defaultKey = options.defaultKey;
    this.keyId = options.keyId ?? 'system';
  }

  encrypt(value: ConnectionSecretMaterial, keyOverride?: string): EncryptedSecretEnvelope {
    const keyMaterial = this.resolveKeyMaterial(keyOverride);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(keyMaterial, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(asJson(value), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      algorithm: 'aes-256-gcm',
      keyId: this.keyId,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: new Date().toISOString(),
    };
  }

  decrypt<T extends ConnectionSecretMaterial = ConnectionSecretMaterial>(envelope: EncryptedSecretEnvelope, keyOverride?: string): T {
    if (envelope.algorithm !== 'aes-256-gcm') {
      throw new Error('unsupported encryption algorithm');
    }
    const keyMaterial = this.resolveKeyMaterial(keyOverride);
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const key = scryptSync(keyMaterial, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return fromJson<T>(clear.toString('utf8'));
  }

  private resolveKeyMaterial(override?: string): string {
    const key = override ?? this.defaultKey ?? process.env.POKE_CONNECTIONS_KEY ?? process.env.POKE_ENCRYPTION_KEY ?? process.env.CONNECTIONS_KEY;
    if (!key) {
      throw new Error('missing connection encryption key');
    }
    return key;
  }
}
