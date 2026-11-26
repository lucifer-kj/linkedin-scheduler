import crypto from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const HEX_24_REGEX = /^[0-9a-fA-F]{24}$/;
const HEX_32_REGEX = /^[0-9a-fA-F]{32}$/;
const HEX_EVEN_REGEX = /^(?:[0-9a-fA-F]{2})*$/;

/**
 * Production AES-256-GCM Authenticated Encryption
 * Ensures confidentiality (encryption) and tamper-proof integrity (auth tag).
 */
export class TokenEncryption {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // 96-bit IV recommended for GCM
  private static readonly AUTH_TAG_LENGTH = 16; // 128-bit auth tag

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * @param plaintext Sensitive token or credential to encrypt
   * @param masterKeyHex 64-character hex string (32 bytes)
   */
  static encrypt(plaintext: string, masterKeyHex: string): EncryptedPayload {
    if (!masterKeyHex || !HEX_64_REGEX.test(masterKeyHex)) {
      throw new Error('Master key must be exactly 64 hex characters (32 bytes).');
    }

    const key = Buffer.from(masterKeyHex, 'hex');
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
      ciphertext,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypts an AES-256-GCM ciphertext payload and validates the authentication tag.
   * Throws an error if the key, IV, authTag, or ciphertext is invalid or tampered with.
   */
  static decrypt(
    ciphertext: string,
    ivHex: string,
    authTagHex: string,
    masterKeyHex: string
  ): string {
    if (!masterKeyHex || !HEX_64_REGEX.test(masterKeyHex)) {
      throw new Error('Master key must be exactly 64 hex characters (32 bytes).');
    }
    if (!ivHex || !HEX_24_REGEX.test(ivHex)) {
      throw new Error('IV must be exactly 24 hex characters (12 bytes).');
    }
    if (!authTagHex || !HEX_32_REGEX.test(authTagHex)) {
      throw new Error('Auth tag must be exactly 32 hex characters (16 bytes).');
    }
    if (typeof ciphertext !== 'string' || !HEX_EVEN_REGEX.test(ciphertext)) {
      throw new Error('Ciphertext must be a valid even-length hex string.');
    }

    try {
      const key = Buffer.from(masterKeyHex, 'hex');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv, {
        authTagLength: this.AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch {
      throw new Error('Failed to decrypt token payload: invalid key or tampered ciphertext/authTag.');
    }
  }
}
