import crypto from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Production AES-256-GCM Authenticated Encryption
 * Ensures confidentiality (encryption) and tamper-proof integrity (auth tag).
 */
export class TokenEncryption {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // 96-bit IV recommended for GCM

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * @param plaintext Sensitive token to encrypt
   * @param masterKeyHex 64-character hex string (32 bytes)
   */
  static encrypt(plaintext: string, masterKeyHex: string): EncryptedPayload {
    if (!masterKeyHex || masterKeyHex.length !== 64) {
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
   * Throws an error if the ciphertext or authentication tag has been tampered with.
   */
  static decrypt(
    ciphertext: string,
    ivHex: string,
    authTagHex: string,
    masterKeyHex: string
  ): string {
    if (!masterKeyHex || masterKeyHex.length !== 64) {
      throw new Error('Master key must be exactly 64 hex characters (32 bytes).');
    }

    const key = Buffer.from(masterKeyHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
