import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UnrecoverableError, type Job } from 'bullmq';
import { PostsService, type PublishPostJobData } from '../../src/posts/posts.service.js';
import { PostsProcessor, computeLinkedInBackoffMs } from '../../src/posts/posts.processor.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { HealthController } from '../../src/health/health.controller.js';
import { RealLinkedInClient, parseRetryAfterMs } from '../../src/linkedin/client.js';
import { LinkedInApiError } from '../../src/linkedin/types.js';
import { TokenEncryption } from '../../src/common/crypto/token-encryption.js';
import { LinkedInClientFactory } from '../../src/linkedin/linkedin-client.factory.js';
import { MockLinkedInClient } from '../../src/linkedin/mock-client.js';

const MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createMockConfig(useMock = true) {
  return {
    encryptionMasterKey: MASTER_KEY,
    useMockLinkedin: useMock,
    linkedinClientId: 'env_client_id',
    linkedinClientSecret: 'env_client_secret',
    linkedinRedirectUri: 'http://localhost:3000/api/auth/linkedin/callback',
    linkedinApiVersion: '202501',
  } as any;
}

function createMockLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

describe('Milestone 2: PostsService, PostsProcessor, AuthService, HealthController & LinkedIn API', () => {
  beforeEach(() => {
    MockLinkedInClient.reset();
    vi.restoreAllMocks();
  });

  describe('PostsService', () => {
    it('rejects schedule when account is missing or token is expired', async () => {
      const prisma = {
        linkedinAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      } as any;
      const queue = { add: vi.fn(), getJob: vi.fn(), remove: vi.fn() } as any;
      const service = new PostsService(prisma, createMockLogger(), queue);

      await expect(
        service.schedulePost('u1', { content: 'Hello', scheduledFor: new Date().toISOString() })
      ).rejects.toThrow(BadRequestException);

      prisma.linkedinAccount.findUnique.mockResolvedValue({
        id: 'acc1',
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        service.schedulePost('u1', { content: 'Hello', scheduledFor: new Date().toISOString() })
      ).rejects.toThrow(UnauthorizedException);
    });

    it('enforces SHA-256 idempotencyKey deduplication (409 Conflict on P2002)', async () => {
      const existing = { id: 'p-existing', content: 'Hello' };
      const prisma = {
        linkedinAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'acc1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        },
        post: {
          create: vi
            .fn()
            .mockRejectedValue(
              new Prisma.PrismaClientKnownRequestError('Unique', {
                code: 'P2002',
                clientVersion: '5.22.0',
              })
            ),
          findUnique: vi.fn().mockResolvedValue(existing),
        },
      } as any;
      const queue = { add: vi.fn() } as any;
      const service = new PostsService(prisma, createMockLogger(), queue);

      await expect(
        service.schedulePost('u1', {
          content: 'Hello',
          scheduledFor: '2026-12-01T10:00:00.000Z',
        })
      ).rejects.toThrow(ConflictException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('cancels only tenant-owned scheduled posts and removes BullMQ job', async () => {
      const prisma = {
        post: {
          findFirst: vi.fn().mockResolvedValue(null),
          delete: vi.fn(),
        },
      } as any;
      const queue = { remove: vi.fn().mockResolvedValue(1) } as any;
      const service = new PostsService(prisma, createMockLogger(), queue);

      await expect(service.cancelPost('u2', 'p1')).rejects.toThrow(NotFoundException);

      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        userId: 'u1',
        status: 'published',
        bullmqJobId: 'post-p1',
      });
      await expect(service.cancelPost('u1', 'p1')).rejects.toThrow(BadRequestException);

      prisma.post.findFirst.mockResolvedValue({
        id: 'p1',
        userId: 'u1',
        status: 'scheduled',
        bullmqJobId: 'post-p1',
      });
      const res = await service.cancelPost('u1', 'p1');
      expect(res).toEqual({ message: 'Post canceled successfully' });
      expect(queue.remove).toHaveBeenCalledWith('post-p1');
      expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });

    it('recovers overdue scheduled posts missing from BullMQ', async () => {
      const prisma = {
        post: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'p-overdue', bullmqJobId: null, maxRetries: 5 },
            { id: 'p-active', bullmqJobId: 'post-p-active', maxRetries: 5 },
          ]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      } as any;
      const queue = {
        getJob: vi.fn().mockImplementation(async (jobId: string) => {
          if (jobId === 'post-p-active') {
            return { getState: async () => 'active' };
          }
          return null;
        }),
        add: vi.fn().mockResolvedValue({ id: 'post-p-overdue' }),
      } as any;

      const service = new PostsService(prisma, createMockLogger(), queue);
      const count = await service.recoverOverduePosts();

      expect(count).toBe(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'publish-post',
        { postId: 'p-overdue' },
        expect.objectContaining({ jobId: 'post-p-overdue', delay: 0 })
      );
    });
  });

  describe('PostsProcessor (Atomic CAS, Retries & UnrecoverableError)', () => {
    it('skips execution when atomic CAS updateMany returns count 0', async () => {
      const prisma = {
        post: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn(),
        },
      } as any;
      const processor = new PostsProcessor(
        prisma,
        createMockConfig(true),
        createMockLogger(),
        new LinkedInClientFactory(createMockConfig(true), createMockLogger()),
        { resolveCustomCredentials: vi.fn() } as any
      );

      await processor.process({ id: 'j1', data: { postId: 'p1' }, attemptsMade: 0 } as Job<PublishPostJobData>);
      expect(prisma.post.findUnique).not.toHaveBeenCalled();
    });

    it('retries transient 503 errors with backoff and publishes on attempt 2', async () => {
      MockLinkedInClient.setSimulateTransientFailure(true);
      const enc = TokenEncryption.encrypt('secret-token', MASTER_KEY);

      const postRow = {
        id: 'p1',
        userId: 'u1',
        content: 'Retry test post',
        idempotencyKey: 'idem-1',
        maxRetries: 5,
        linkedinAccount: {
          linkedinPersonUrn: 'urn:li:person:mock-1',
          encryptedAccessToken: enc.ciphertext,
          tokenIv: enc.iv,
          tokenAuthTag: enc.authTag,
          expiresAt: new Date(Date.now() + 60_000),
        },
      };

      const prisma = {
        post: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue(postRow),
          update: vi.fn().mockResolvedValue(postRow),
        },
      } as any;

      const processor = new PostsProcessor(
        prisma,
        createMockConfig(true),
        createMockLogger(),
        new LinkedInClientFactory(createMockConfig(true), createMockLogger()),
        { resolveCustomCredentials: vi.fn().mockResolvedValue(undefined) } as any
      );

      // Attempt 0 -> throws 503, resets status to scheduled
      await expect(
        processor.process({ id: 'j1', data: { postId: 'p1' }, attemptsMade: 0 } as Job<PublishPostJobData>)
      ).rejects.toThrow(LinkedInApiError);

      expect(prisma.post.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: expect.objectContaining({ status: 'scheduled', retryCount: 1 }),
        })
      );

      // Attempt 1 -> publishes cleanly
      await processor.process({ id: 'j1', data: { postId: 'p1' }, attemptsMade: 1 } as Job<PublishPostJobData>);

      expect(prisma.post.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: expect.objectContaining({
            status: 'published',
            externalPostUrn: expect.stringContaining('urn:li:share:mock-'),
          }),
        })
      );
    });

    it('throws UnrecoverableError and marks failed on terminal 401/expired token', async () => {
      const enc = TokenEncryption.encrypt('secret-token', MASTER_KEY);
      const prisma = {
        post: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            id: 'p-expired',
            userId: 'u1',
            content: 'Expired',
            idempotencyKey: 'idem-2',
            maxRetries: 5,
            linkedinAccount: {
              linkedinPersonUrn: 'urn:li:person:1',
              encryptedAccessToken: enc.ciphertext,
              tokenIv: enc.iv,
              tokenAuthTag: enc.authTag,
              expiresAt: new Date(Date.now() - 1000),
            },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
      } as any;

      const processor = new PostsProcessor(
        prisma,
        createMockConfig(true),
        createMockLogger(),
        new LinkedInClientFactory(createMockConfig(true), createMockLogger()),
        { resolveCustomCredentials: vi.fn() } as any
      );

      await expect(
        processor.process({
          id: 'j2',
          data: { postId: 'p-expired' },
          attemptsMade: 0,
        } as Job<PublishPostJobData>)
      ).rejects.toThrow(UnrecoverableError);

      expect(prisma.post.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'p-expired' },
          data: expect.objectContaining({ status: 'failed' }),
        })
      );
    });

    it('honors Retry-After header ms in computeLinkedInBackoffMs', () => {
      const err = new LinkedInApiError('Rate limited', 429, 12_000);
      expect(computeLinkedInBackoffMs(1, err)).toBe(12_000);
      const backoff2 = computeLinkedInBackoffMs(2);
      expect(backoff2).toBeGreaterThanOrEqual(4000);
      expect(backoff2).toBeLessThan(4500);
    });
  });

  describe('AuthService OAuth CSRF & Error Handling', () => {
    it('handles ?error= provider callback and rejects invalid/reused state', async () => {
      const prisma = {
        oAuthState: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as any;
      const auth = new AuthService(
        prisma,
        createMockConfig(true),
        createMockLogger(),
        new LinkedInClientFactory(createMockConfig(true), createMockLogger())
      );

      const errRedirect = await auth.handleCallback('u1', {
        error: 'user_cancelled_login',
        error_description: 'User cancelled',
      });
      expect(errRedirect).toBe('/?auth=error&message=User%20cancelled');

      const badStateRedirect = await auth.handleCallback('u1', {
        code: 'abc',
        state: 'invalid-state',
      });
      expect(badStateRedirect).toContain('/?auth=error&message=Invalid%20or%20expired%20OAuth%20state');
    });
  });

  describe('RealLinkedInClient /rest/posts & Retry-After', () => {
    it('parses Retry-After integer seconds and HTTP-date', () => {
      expect(parseRetryAfterMs('7')).toBe(7000);
      const now = Date.parse('2026-11-26T10:00:00.000Z');
      expect(parseRetryAfterMs('Thu, 26 Nov 2026 10:00:15 GMT', now)).toBe(15_000);
    });

    it('calls /rest/posts with LinkedIn-Version and reads x-restli-id header', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', {
          status: 201,
          headers: { 'x-restli-id': 'urn:li:share:987654321' },
        })
      );

      const client = new RealLinkedInClient({ apiVersion: '202501' });
      const res = await client.publishPost(
        'tok',
        'urn:li:person:abc',
        'Hello LinkedIn',
        'idem-key'
      );

      expect(res.postUrn).toBe('urn:li:share:987654321');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.linkedin.com/rest/posts',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'LinkedIn-Version': '202501',
            'X-Restli-Protocol-Version': '2.0.0',
          }),
        })
      );
    });
  });

  describe('HealthController', () => {
    it('returns ok with recoveredPosts or 503 when Redis is down', async () => {
      const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) } as any;
      const postsService = { recoverOverduePosts: vi.fn().mockResolvedValue(2) } as any;
      const redis = { ping: vi.fn().mockResolvedValue('PONG') } as any;

      const controller = new HealthController(
        prisma,
        createMockConfig(true),
        postsService,
        redis
      );

      const ok = await controller.getHealth();
      expect(ok).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok', recoveredPosts: 2 });

      redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(controller.getHealth()).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
