import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenEncryption } from '../common/crypto/token-encryption.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';
import {
  LinkedInClientFactory,
  type CustomOAuthCredentials,
} from '../linkedin/linkedin-client.factory.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const saveCredentialsSchema = z.object({
  clientId: z.string().trim().min(1, 'Client ID is required'),
  clientSecret: z.string().trim().min(1, 'Client Secret is required'),
});

export type SaveCredentialsDto = z.infer<typeof saveCredentialsSchema>;

export interface OAuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export interface AccountStatusResponse {
  connected: boolean;
  isExpired: boolean;
  hasCustomCredentials: boolean;
  mode: 'mock' | 'live';
  account: {
    id: string;
    linkedinName: string;
    linkedinPersonUrn: string;
    expiresAt: string;
    createdAt: string;
  } | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLoggerService,
    private readonly clientFactory: LinkedInClientFactory
  ) {}

  async getAuthorizationUrl(userId: string): Promise<{ url: string }> {
    const customCreds = await this.resolveCustomCredentials(userId);
    const state = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    await this.prisma.oAuthState.create({
      data: {
        state,
        userId,
        expiresAt,
      },
    });

    const client = this.clientFactory.createClient(customCreds);
    return { url: client.getAuthorizationUrl(state) };
  }

  async handleCallback(userId: string, query: OAuthCallbackQuery): Promise<string> {
    if (query.error) {
      const errorMessage =
        (query.error_description || query.error).trim() ||
        'LinkedIn authorization failed or was cancelled';
      this.logger.warn(
        { userId, error: query.error },
        'LinkedIn OAuth callback returned provider error'
      );
      return `/?auth=error&message=${encodeURIComponent(errorMessage)}`;
    }

    if (!query.state || !query.code) {
      return `/?auth=error&message=${encodeURIComponent('Missing OAuth code or state parameter')}`;
    }

    const now = new Date();
    const consumed = await this.prisma.oAuthState.deleteMany({
      where: {
        state: query.state,
        userId,
        expiresAt: { gt: now },
      },
    });

    if (consumed.count !== 1) {
      this.logger.warn(
        { userId },
        'Rejected LinkedIn OAuth callback due to invalid, expired, or mismatched state'
      );
      return `/?auth=error&message=${encodeURIComponent('Invalid or expired OAuth state')}`;
    }

    try {
      const customCreds = await this.resolveCustomCredentials(userId);
      const client = this.clientFactory.createClient(customCreds);
      const tokenResponse = await client.exchangeCodeForToken(query.code);

      const encryptedToken = TokenEncryption.encrypt(
        tokenResponse.accessToken,
        this.config.encryptionMasterKey
      );
      const expiresAt = new Date(Date.now() + Math.max(0, tokenResponse.expiresIn) * 1000);

      await this.prisma.linkedinAccount.upsert({
        where: { userId },
        create: {
          userId,
          linkedinPersonUrn: tokenResponse.personUrn,
          linkedinName: tokenResponse.name,
          encryptedAccessToken: encryptedToken.ciphertext,
          tokenIv: encryptedToken.iv,
          tokenAuthTag: encryptedToken.authTag,
          expiresAt,
        },
        update: {
          linkedinPersonUrn: tokenResponse.personUrn,
          linkedinName: tokenResponse.name,
          encryptedAccessToken: encryptedToken.ciphertext,
          tokenIv: encryptedToken.iv,
          tokenAuthTag: encryptedToken.authTag,
          expiresAt,
        },
      });

      this.logger.log(
        { userId, personUrn: tokenResponse.personUrn },
        'LinkedIn account connected successfully'
      );
      return '/?auth=success';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OAuth token exchange failed';
      this.logger.error({ userId, err: error }, 'LinkedIn OAuth callback token exchange failed');
      return `/?auth=error&message=${encodeURIComponent(message)}`;
    }
  }

  async getAccountStatus(userId: string): Promise<AccountStatusResponse> {
    const [account, credential] = await Promise.all([
      this.prisma.linkedinAccount.findUnique({
        where: { userId },
        select: {
          id: true,
          linkedinPersonUrn: true,
          linkedinName: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
      this.prisma.oAuthCredential.findUnique({
        where: { userId },
        select: { id: true },
      }),
    ]);

    const isExpired = account ? account.expiresAt.getTime() <= Date.now() : false;

    return {
      connected: Boolean(account),
      isExpired,
      hasCustomCredentials: Boolean(credential),
      mode: this.config.useMockLinkedin ? 'mock' : 'live',
      account: account
        ? {
            id: account.id,
            linkedinName: account.linkedinName,
            linkedinPersonUrn: account.linkedinPersonUrn,
            expiresAt: account.expiresAt.toISOString(),
            createdAt: account.createdAt.toISOString(),
          }
        : null,
    };
  }

  async saveCredentials(
    userId: string,
    dto: SaveCredentialsDto
  ): Promise<{ ok: true; hasCustomCredentials: true }> {
    const encryptedClientId = TokenEncryption.encrypt(
      dto.clientId,
      this.config.encryptionMasterKey
    );
    const encryptedClientSecret = TokenEncryption.encrypt(
      dto.clientSecret,
      this.config.encryptionMasterKey
    );

    await this.prisma.oAuthCredential.upsert({
      where: { userId },
      create: {
        userId,
        encryptedClientId: encryptedClientId.ciphertext,
        clientIdIv: encryptedClientId.iv,
        clientIdAuthTag: encryptedClientId.authTag,
        encryptedClientSecret: encryptedClientSecret.ciphertext,
        clientSecretIv: encryptedClientSecret.iv,
        clientSecretAuthTag: encryptedClientSecret.authTag,
      },
      update: {
        encryptedClientId: encryptedClientId.ciphertext,
        clientIdIv: encryptedClientId.iv,
        clientIdAuthTag: encryptedClientId.authTag,
        encryptedClientSecret: encryptedClientSecret.ciphertext,
        clientSecretIv: encryptedClientSecret.iv,
        clientSecretAuthTag: encryptedClientSecret.authTag,
      },
    });

    return { ok: true, hasCustomCredentials: true };
  }

  async deleteCredentials(userId: string): Promise<{ ok: true; hasCustomCredentials: false }> {
    await this.prisma.oAuthCredential.deleteMany({
      where: { userId },
    });
    return { ok: true, hasCustomCredentials: false };
  }

  async disconnectAccount(userId: string): Promise<{ ok: true; connected: false }> {
    await this.prisma.linkedinAccount.deleteMany({
      where: { userId },
    });
    return { ok: true, connected: false };
  }

  async resolveCustomCredentials(userId: string): Promise<CustomOAuthCredentials | undefined> {
    const cred = await this.prisma.oAuthCredential.findUnique({
      where: { userId },
    });
    if (!cred) {
      return undefined;
    }

    const clientId = TokenEncryption.decrypt(
      cred.encryptedClientId,
      cred.clientIdIv,
      cred.clientIdAuthTag,
      this.config.encryptionMasterKey
    );
    const clientSecret = TokenEncryption.decrypt(
      cred.encryptedClientSecret,
      cred.clientSecretIv,
      cred.clientSecretAuthTag,
      this.config.encryptionMasterKey
    );

    return { clientId, clientSecret };
  }
}
