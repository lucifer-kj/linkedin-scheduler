import { describe, it, expect } from 'vitest';
import { TokenEncryption } from './encryption.js';

describe('TokenEncryption (AES-256-GCM)', () => {
  const masterKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const sampleToken = 'AQVn8_LinkedInSecretAccessToken_xyz123456789';

  it('should encrypt and decrypt back to the original plaintext', () => {
    const encrypted = TokenEncryption.encrypt(sampleToken, masterKeyHex);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toHaveLength(24); // 12 bytes = 24 hex characters
    expect(encrypted.authTag).toHaveLength(32); // 16 bytes = 32 hex characters

    const decrypted = TokenEncryption.decrypt(
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      masterKeyHex
    );

    expect(decrypted).toBe(sampleToken);
  });

  it('should generate distinct IVs and ciphertexts for identical plaintexts (IND-CPA security)', () => {
    const enc1 = TokenEncryption.encrypt(sampleToken, masterKeyHex);
    const enc2 = TokenEncryption.encrypt(sampleToken, masterKeyHex);

    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('should fail decryption when ciphertext is tampered with', () => {
    const encrypted = TokenEncryption.encrypt(sampleToken, masterKeyHex);
    const tamperedCiphertext = encrypted.ciphertext.slice(0, -2) + 'aa';

    expect(() => {
      TokenEncryption.decrypt(
        tamperedCiphertext,
        encrypted.iv,
        encrypted.authTag,
        masterKeyHex
      );
    }).toThrow();
  });

  it('should fail decryption when authentication tag is tampered with', () => {
    const encrypted = TokenEncryption.encrypt(sampleToken, masterKeyHex);
    const tamperedTag = encrypted.authTag.slice(0, -2) + '00';

    expect(() => {
      TokenEncryption.decrypt(
        encrypted.ciphertext,
        encrypted.iv,
        tamperedTag,
        masterKeyHex
      );
    }).toThrow();
  });
});
