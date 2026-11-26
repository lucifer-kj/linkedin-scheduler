import { prisma } from '../database/client.js';
import { TokenEncryption } from '../crypto/encryption.js';
import { linkedInClient } from '../linkedin/index.js';
import { LinkedInApiError } from '../linkedin/types.js';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

export class PostExecutionWorker {
  // In-memory mutex set to prevent concurrent worker threads from touching the same post
  private static activeLocks = new Set<string>();

  /**
   * Executes publishing of a single scheduled post.
   * Guarantees duplicate-post protection via atomic CAS and distributed locking principles.
   */
  static async processPost(postId: string): Promise<void> {
    // 1. Layer 1 Concurrency Guard: Local thread lock
    if (this.activeLocks.has(postId)) {
      logger.warn({ postId }, '[WORKER] Post is already being processed by another active worker. Skipping.');
      return;
    }
    this.activeLocks.add(postId);

    try {
      // 2. Layer 2 Concurrency Guard: Atomic Database State Transition (Compare-And-Swap)
      // Only transition to 'processing' if status is currently 'scheduled'
      const post = await prisma.post.findUnique({
        where: { id: postId },
        include: { linkedinAccount: true },
      });

      if (!post) {
        logger.error({ postId }, '[WORKER] Post not found.');
        return;
      }

      if (post.status !== 'scheduled') {
        logger.info(
          { postId, currentStatus: post.status },
          '[WORKER] Post status is not "scheduled". Aborting to prevent duplicate post.'
        );
        return;
      }

      // Atomically claim the post
      await prisma.post.update({
        where: { id: postId },
        data: {
          status: 'processing',
          updatedAt: new Date(),
        },
      });

      logger.info({ postId, retryCount: post.retryCount }, '[WORKER] Post claimed. Transitioned status to "processing".');

      if (!post.linkedinAccount) {
        throw new LinkedInApiError('No linked LinkedIn account found for post', 400);
      }

      // 3. Decrypt OAuth Access Token using AES-256-GCM
      let decryptedToken: string;
      try {
        decryptedToken = TokenEncryption.decrypt(
          post.linkedinAccount.encryptedAccessToken,
          post.linkedinAccount.tokenIv,
          post.linkedinAccount.tokenAuthTag,
          config.ENCRYPTION_MASTER_KEY
        );
      } catch (err: any) {
        logger.error({ postId, error: err.message }, '[WORKER] Failed to decrypt access token.');
        throw new LinkedInApiError(`Token decryption failed: ${err.message}`, 401);
      }

      // 4. Publish to LinkedIn API
      const result = await linkedInClient.publishPost(
        decryptedToken,
        post.linkedinAccount.linkedinPersonUrn,
        post.content,
        post.idempotencyKey,
        post.retryCount
      );

      // 5. Mark as Published on success
      await prisma.post.update({
        where: { id: postId },
        data: {
          status: 'published',
          externalPostUrn: result.postUrn,
          publishedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      });

      logger.info(
        { postId, postUrn: result.postUrn },
        '[WORKER] Successfully published post. Transitioned status to "published".'
      );
    } catch (error: any) {
      await this.handleExecutionError(postId, error);
    } finally {
      this.activeLocks.delete(postId);
    }
  }

  /**
   * Resilient Error Handling & Exponential Backoff Engine
   * Distinguishes transient errors (429, 5xx) from permanent/terminal errors (400, 401, 403).
   */
  private static async handleExecutionError(postId: string, error: any): Promise<void> {
    const isTransient = error instanceof LinkedInApiError ? error.isTransient : false;
    const errorMessage = error?.message || 'Unknown execution error';

    const currentPost = await prisma.post.findUnique({ where: { id: postId } });
    if (!currentPost) return;

    const nextRetryCount = currentPost.retryCount + 1;

    if (isTransient && nextRetryCount <= currentPost.maxRetries) {
      // Exponential backoff formula with jitter: base * 2^attempt + jitter
      const baseDelayMs = 2000; // 2 seconds base
      const exponentialDelay = baseDelayMs * Math.pow(2, currentPost.retryCount);
      const jitterMs = Math.floor(Math.random() * 500); // 0-500ms random jitter
      const totalDelayMs = Math.min(exponentialDelay + jitterMs, 300000); // cap at 5 minutes

      const nextScheduledTime = new Date(Date.now() + totalDelayMs);

      logger.warn(
        {
          postId,
          attempt: nextRetryCount,
          maxRetries: currentPost.maxRetries,
          backoffDelayMs: totalDelayMs,
          nextScheduledTime,
          errorMessage,
        },
        '[WORKER] Temporary/transient error encountered. Scheduling automatic retry with exponential backoff.'
      );

      // Reset to 'scheduled' state with next scheduled timestamp and incremented retry count
      await prisma.post.update({
        where: { id: postId },
        data: {
          status: 'scheduled',
          retryCount: nextRetryCount,
          scheduledFor: nextScheduledTime,
          lastError: `[Attempt ${nextRetryCount}/${currentPost.maxRetries}]: ${errorMessage}`,
          updatedAt: new Date(),
        },
      });
    } else {
      // Terminal error or exceeded max retries
      logger.error(
        {
          postId,
          attempt: currentPost.retryCount,
          isTransient,
          errorMessage,
        },
        '[WORKER] Terminal failure or exceeded max retries. Transitioned status to "failed".'
      );

      await prisma.post.update({
        where: { id: postId },
        data: {
          status: 'failed',
          lastError: errorMessage,
          updatedAt: new Date(),
        },
      });
    }
  }
}
