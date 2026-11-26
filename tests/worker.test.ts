import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '../src/database/client.js';
import { PostExecutionWorker } from '../src/queue/worker.js';
import { TokenEncryption } from '../src/crypto/encryption.js';
import { config } from '../src/config/index.js';
import { MockLinkedInClient } from '../src/linkedin/mock-client.js';

describe('PostExecutionWorker & Duplicate Protection Engine', () => {
  let testUser: any;
  let testAccount: any;

  beforeEach(async () => {
    // Reset test data
    await prisma.post.deleteMany();
    await prisma.linkedinAccount.deleteMany();
    await prisma.user.deleteMany();

    testUser = await prisma.user.create({
      data: { email: `test-${Date.now()}@example.com` },
    });

    const encrypted = TokenEncryption.encrypt('test-access-token-12345', config.ENCRYPTION_MASTER_KEY);

    testAccount = await prisma.linkedinAccount.create({
      data: {
        userId: testUser.id,
        linkedinPersonUrn: 'urn:li:person:test-eval-123',
        linkedinName: 'Test Evaluator',
        encryptedAccessToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    MockLinkedInClient.simulateTransientFailure = false;
  });

  it('should successfully publish a scheduled post and update status to "published"', async () => {
    const post = await prisma.post.create({
      data: {
        userId: testUser.id,
        linkedinAccountId: testAccount.id,
        content: 'Testing automatic worker publication!',
        scheduledFor: new Date(Date.now() - 1000), // due immediately
        status: 'scheduled',
        idempotencyKey: `idemp-${Date.now()}`,
      },
    });

    await PostExecutionWorker.processPost(post.id);

    const updated = await prisma.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe('published');
    expect(updated?.externalPostUrn).toContain('urn:li:share:');
    expect(updated?.publishedAt).toBeDefined();
    expect(updated?.retryCount).toBe(0);
  });

  it('should prevent duplicate posts if status is already "published" or "processing"', async () => {
    const post = await prisma.post.create({
      data: {
        userId: testUser.id,
        linkedinAccountId: testAccount.id,
        content: 'Already published content',
        scheduledFor: new Date(),
        status: 'published',
        externalPostUrn: 'urn:li:share:existing-123',
        idempotencyKey: `idemp-dup-${Date.now()}`,
      },
    });

    // Attempt to process again
    await PostExecutionWorker.processPost(post.id);

    const unchanged = await prisma.post.findUnique({ where: { id: post.id } });
    expect(unchanged?.status).toBe('published');
    expect(unchanged?.externalPostUrn).toBe('urn:li:share:existing-123');
  });

  it('should automatically retry with exponential backoff on simulated transient 503 error', async () => {
    MockLinkedInClient.simulateTransientFailure = true;

    const post = await prisma.post.create({
      data: {
        userId: testUser.id,
        linkedinAccountId: testAccount.id,
        content: 'Testing 503 transient failure backoff',
        scheduledFor: new Date(Date.now() - 1000),
        status: 'scheduled',
        idempotencyKey: `idemp-transient-${Date.now()}`,
      },
    });

    // 1st attempt: triggers transient error (503)
    await PostExecutionWorker.processPost(post.id);

    const afterFirstAttempt = await prisma.post.findUnique({ where: { id: post.id } });
    expect(afterFirstAttempt?.status).toBe('scheduled'); // reset to scheduled for next retry
    expect(afterFirstAttempt?.retryCount).toBe(1);
    expect(afterFirstAttempt?.lastError).toContain('503 Service Unavailable');
    // Ensure next scheduled time is pushed forward (exponential backoff)
    expect(afterFirstAttempt!.scheduledFor.getTime()).toBeGreaterThan(Date.now());

    // 2nd attempt: simulated transient failure resolves and succeeds
    await PostExecutionWorker.processPost(post.id);

    const afterSecondAttempt = await prisma.post.findUnique({ where: { id: post.id } });
    expect(afterSecondAttempt?.status).toBe('published');
    expect(afterSecondAttempt?.externalPostUrn).toBeDefined();
  });
});
