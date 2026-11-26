import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';
import { TokenEncryption } from '../common/crypto/token-encryption.js';
import { LinkedInClientFactory } from '../linkedin/linkedin-client.factory.js';
import { LinkedInApiError } from '../linkedin/types.js';
import { AuthService } from '../auth/auth.service.js';
import { LINKEDIN_BACKOFF_TYPE, LINKEDIN_POSTS_QUEUE } from '../queue/queue.constants.js';
import type { PublishPostJobData } from './posts.service.js';

export function computeLinkedInBackoffMs(
  attemptsMade: number,
  err?: Error,
  baseDelayMs: number = 2000,
  maxDelayMs: number = 300_000
): number {
  if (err instanceof LinkedInApiError && typeof err.retryAfterMs === 'number') {
    return Math.min(Math.max(0, err.retryAfterMs), maxDelayMs);
  }
  const exponent = Math.max(0, attemptsMade - 1);
  const exponential = baseDelayMs * Math.pow(2, exponent);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(exponential + jitter, maxDelayMs);
}

@Processor(LINKEDIN_POSTS_QUEUE, {
  settings: {
    backoffStrategy: (attemptsMade: number, type?: string, err?: Error) => {
      if (type === LINKEDIN_BACKOFF_TYPE) {
        return computeLinkedInBackoffMs(attemptsMade, err);
      }
      return 2000 * Math.pow(2, Math.max(0, attemptsMade - 1));
    },
  },
})
export class PostsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLoggerService,
    private readonly clientFactory: LinkedInClientFactory,
    private readonly authService: AuthService
  ) {
    super();
  }

  async process(job: Job<PublishPostJobData>): Promise<void> {
    const { postId } = job.data;
    const attemptNumber = job.attemptsMade + 1;

    // Atomic Compare-And-Swap (CAS) claim: only 1 worker can transition scheduled -> processing
    const claimed = await this.prisma.post.updateMany({
      where: {
        id: postId,
        status: 'scheduled',
      },
      data: {
        status: 'processing',
        updatedAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      this.logger.log(
        { postId, jobId: job.id, attemptNumber },
        'Post not in "scheduled" state; skipping duplicate execution'
      );
      return;
    }

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { linkedinAccount: true },
    });

    if (!post) {
      this.logger.warn({ postId }, 'Claimed post record disappeared before execution');
      return;
    }

    this.logger.log(
      { postId, userId: post.userId, attemptNumber, maxRetries: post.maxRetries },
      'Worker claimed post for publishing'
    );

    try {
      if (!post.linkedinAccount) {
        throw new LinkedInApiError('No linked LinkedIn account found for post', 400);
      }

      if (post.linkedinAccount.expiresAt.getTime() <= Date.now()) {
        throw new LinkedInApiError('LinkedIn access token has expired', 401);
      }

      let accessToken: string;
      try {
        accessToken = TokenEncryption.decrypt(
          post.linkedinAccount.encryptedAccessToken,
          post.linkedinAccount.tokenIv,
          post.linkedinAccount.tokenAuthTag,
          this.config.encryptionMasterKey
        );
      } catch (decryptErr) {
        const msg = decryptErr instanceof Error ? decryptErr.message : 'Decryption failed';
        throw new LinkedInApiError(`Token decryption failed: ${msg}`, 401);
      }

      const customCreds = await this.authService.resolveCustomCredentials(post.userId);
      const client = this.clientFactory.createClient(customCreds);

      const result = await client.publishPost(
        accessToken,
        post.linkedinAccount.linkedinPersonUrn,
        post.content,
        post.idempotencyKey,
        job.attemptsMade
      );

      await this.prisma.post.update({
        where: { id: post.id },
        data: {
          status: 'published',
          externalPostUrn: result.postUrn,
          publishedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        { postId: post.id, postUrn: result.postUrn, attemptNumber },
        'Post published successfully'
      );
    } catch (error) {
      await this.handleFailure(post.id, post.maxRetries, job.attemptsMade, error);
    }
  }

  private async handleFailure(
    postId: string,
    maxRetries: number,
    attemptsMade: number,
    error: unknown
  ): Promise<never> {
    const attemptCount = attemptsMade + 1;
    const errorMessage = error instanceof Error ? error.message : 'Unknown publishing error';
    const isTransient = error instanceof LinkedInApiError ? error.isTransient : false;

    if (!isTransient) {
      await this.prisma.post.update({
        where: { id: postId },
        data: {
          status: 'failed',
          retryCount: attemptCount,
          lastError: errorMessage,
          updatedAt: new Date(),
        },
      });

      this.logger.error(
        { postId, attemptCount, errorMessage },
        'Terminal LinkedIn error; marking post failed without retry'
      );
      throw new UnrecoverableError(errorMessage);
    }

    if (attemptCount >= maxRetries) {
      await this.prisma.post.update({
        where: { id: postId },
        data: {
          status: 'failed',
          retryCount: attemptCount,
          lastError: `Max retries (${maxRetries}) reached: ${errorMessage}`,
          updatedAt: new Date(),
        },
      });

      this.logger.error(
        { postId, attemptCount, maxRetries, errorMessage },
        'Exhausted max retries; marking post failed'
      );
      throw error instanceof Error ? error : new Error(errorMessage);
    }

    const nextDelayMs = computeLinkedInBackoffMs(attemptCount, error instanceof Error ? error : undefined);
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'scheduled',
        retryCount: attemptCount,
        scheduledFor: new Date(Date.now() + nextDelayMs),
        lastError: `[Attempt ${attemptCount}/${maxRetries}]: ${errorMessage}`,
        updatedAt: new Date(),
      },
    });

    this.logger.warn(
      { postId, attemptCount, maxRetries, nextDelayMs, errorMessage },
      'Transient LinkedIn error; BullMQ scheduling exponential backoff retry'
    );

    throw error instanceof Error ? error : new Error(errorMessage);
  }
}
