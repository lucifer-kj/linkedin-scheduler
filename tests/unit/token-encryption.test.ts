import { describe, it, expect } from 'vitest';
import { TokenEncryption } from '../../src/common/crypto/token-encryption.js';

describe('TokenEncryption (AES-256-GCM)', () => {
  const masterKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const wrongKeyHex = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const sampleToken = 'AQVn8_LinkedInSecretAccessToken_xyz123456789';

  it('encrypts and decrypts ASCII, UTF-8, and empty strings back to original plaintext', () => {
    for (const plaintext of [sampleToken, 'Hello 🚀 LinkedIn — café', '']) {
      const encrypted = TokenEncryption.encrypt(plaintext, masterKeyHex);
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);

      const decrypted = TokenEncryption.decrypt(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        masterKeyHex
      );
      expect(decrypted).toBe(plaintext);
    }
  });

  it('generates distinct IVs and ciphertexts for identical plaintexts (IND-CPA)', () => {
    const enc1 = TokenEncryption.encrypt(sampleToken, masterKeyHex);
    const enc2 = TokenEncryption.encrypt(sampleToken, masterKeyHex);

    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('fails decryption when ciphertext or authTag is tampered with or wrong key is used', () => {
    const encrypted = TokenEncryption.encrypt(sampleToken, masterKeyHex);
    const tamperedCiphertext =
      encrypted.ciphertext.slice(0, -2) + (encrypted.ciphertext.endsWith('aa') ? 'bb' : 'aa');
    const tamperedTag =
      encrypted.authTag.slice(0, -2) + (encrypted.authTag.endsWith('00') ? '11' : '00');

    expect(() =>
      TokenEncryption.decrypt(tamperedCiphertext, encrypted.iv, encrypted.authTag, masterKeyHex)
    ).toThrow(/decrypt/i);

    expect(() =>
      TokenEncryption.decrypt(encrypted.ciphertext, encrypted.iv, tamperedTag, masterKeyHex)
    ).toThrow(/decrypt/i);

    expect(() =>
      TokenEncryption.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.authTag, wrongKeyHex)
    ).toThrow(/decrypt/i);
  });

  it('rejects non-hex or wrong-length master key, IV, authTag, and ciphertext', () => {
    const nonHexKey = 'z'.repeat(64);
    const shortKey = '0123456789abcdef';

    expect(() => TokenEncryption.encrypt(sampleToken, nonHexKey)).toThrow(/64 hex/);
    expect(() => TokenEncryption.encrypt(sampleToken, shortKey)).toThrow(/64 hex/);

    const encrypted = TokenEncryption.encrypt(sampleToken, masterKeyHex);

    expect(() =>
      TokenEncryption.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.authTag, nonHexKey)
    ).toThrow(/64 hex/);

    expect(() =>
      TokenEncryption.decrypt(encrypted.ciphertext, '0011', encrypted.authTag, masterKeyHex)
    ).toThrow(/IV must be exactly 24 hex/);

    expect(() =>
      TokenEncryption.decrypt(encrypted.ciphertext, encrypted.iv, '0011', masterKeyHex)
    ).toThrow(/Auth tag must be exactly 32 hex/);

    expect(() =>
      TokenEncryption.decrypt('abc', encrypted.iv, encrypted.authTag, masterKeyHex)
    ).toThrow(/even-length hex/);
  });
});
