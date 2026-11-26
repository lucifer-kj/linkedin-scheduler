import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../database/client.js';
import { TokenEncryption } from '../crypto/encryption.js';
import { linkedInClient } from '../linkedin/index.js';
import { MockLinkedInClient } from '../linkedin/mock-client.js';
import { SchedulerService } from '../queue/scheduler.js';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

export const apiRouter = Router();

// Default evaluation user (single tenant sandbox for technical evaluation)
const DEFAULT_USER_EMAIL = 'evaluator@liberatingsolution.com';

async function getOrCreateDefaultUser() {
  return await prisma.user.upsert({
    where: { email: DEFAULT_USER_EMAIL },
    update: {},
    create: { email: DEFAULT_USER_EMAIL },
  });
}

/**
 * Health check endpoint
 */
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    mode: config.USE_MOCK_LINKEDIN ? 'mock' : 'live',
    simulateTransientFailure: MockLinkedInClient.simulateTransientFailure,
    timestamp: new Date().toISOString(),
  });
});

/**
 * 1. LinkedIn OAuth: Get Authorization URL
 */
apiRouter.get('/auth/linkedin/url', (_req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = linkedInClient.getAuthorizationUrl(state);
  res.json({ url });
});

/**
 * 1. LinkedIn OAuth: Callback & Token Exchange
 * Implements AES-256-GCM authenticated encryption for access token storage.
 */
apiRouter.get('/auth/linkedin/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send('Missing authorization code');
    return;
  }

  try {
    const user = await getOrCreateDefaultUser();
    const tokenData = await linkedInClient.exchangeCodeForToken(code);

    // Encrypt access token at rest using AES-256-GCM
    const encrypted = TokenEncryption.encrypt(tokenData.accessToken, config.ENCRYPTION_MASTER_KEY);
    const expiresAt = new Date(Date.now() + tokenData.expiresIn * 1000);

    await prisma.linkedinAccount.upsert({
      where: { userId: user.id },
      update: {
        linkedinPersonUrn: tokenData.personUrn,
        linkedinName: tokenData.name,
        encryptedAccessToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        expiresAt: expiresAt,
        updatedAt: new Date(),
      },
      create: {
        userId: user.id,
        linkedinPersonUrn: tokenData.personUrn,
        linkedinName: tokenData.name,
        encryptedAccessToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        expiresAt: expiresAt,
      },
    });

    logger.info({ userId: user.id, personUrn: tokenData.personUrn }, '[AUTH] LinkedIn account linked and token encrypted.');
    res.redirect('/?auth=success');
  } catch (err: any) {
    logger.error({ error: err.message }, '[AUTH] OAuth callback error');
    res.redirect(`/?auth=error&message=${encodeURIComponent(err.message)}`);
  }
});

/**
 * Get connected LinkedIn account status
 */
apiRouter.get('/account', async (_req: Request, res: Response) => {
  const user = await getOrCreateDefaultUser();
  const account = await prisma.linkedinAccount.findUnique({
    where: { userId: user.id },
    select: {
      id: true,
      linkedinName: true,
      linkedinPersonUrn: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  res.json({
    connected: !!account,
    account: account || null,
  });
});

/**
 * 2. Schedule a LinkedIn Post
 * Validates content, ensures idempotency, stores with status 'scheduled', enqueues in scheduler.
 */
const scheduleSchema = z.object({
  content: z.string().trim().min(1, 'Post content cannot be empty').max(3000, 'Post content exceeds 3000 characters'),
  scheduledFor: z.string().refine((val) => !isNaN(Date.parse(val)), 'Invalid datetime format'),
});

apiRouter.post('/posts/schedule', async (req: Request, res: Response) => {
  const parseResult = scheduleSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.format() });
    return;
  }

  const { content, scheduledFor } = parseResult.data;
  const user = await getOrCreateDefaultUser();

  const account = await prisma.linkedinAccount.findUnique({
    where: { userId: user.id },
  });

  if (!account) {
    res.status(400).json({ error: 'Please connect your LinkedIn account first.' });
    return;
  }

  const scheduledDate = new Date(scheduledFor);

  // Layer 1 Duplicate-Post Protection: Deterministic idempotency key
  // Hash content + scheduledFor timestamp + userId
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${user.id}:${content}:${scheduledDate.toISOString()}`)
    .digest('hex');

  const existingPost = await prisma.post.findUnique({
    where: { idempotencyKey },
  });

  if (existingPost) {
    res.status(409).json({
      error: 'Duplicate post detected. A post with identical content and scheduled time already exists.',
      post: existingPost,
    });
    return;
  }

  const post = await prisma.post.create({
    data: {
      userId: user.id,
      linkedinAccountId: account.id,
      content,
      scheduledFor: scheduledDate,
      status: 'scheduled',
      idempotencyKey,
      retryCount: 0,
      maxRetries: 5,
    },
  });

  logger.info({ postId: post.id, scheduledFor: post.scheduledFor }, '[API] Post scheduled in database');

  // Enqueue job with scheduler
  await SchedulerService.schedulePost(post.id, post.scheduledFor);

  res.status(201).json({
    message: 'Post scheduled successfully',
    post,
  });
});

/**
 * List all scheduled and historic posts
 */
apiRouter.get('/posts', async (_req: Request, res: Response) => {
  const user = await getOrCreateDefaultUser();
  const posts = await prisma.post.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ posts });
});

/**
 * Cancel a scheduled post
 */
apiRouter.post('/posts/:id/cancel', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const user = await getOrCreateDefaultUser();

  const post = await prisma.post.findFirst({
    where: { id: id, userId: user.id },
  });

  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }

  if (post.status !== 'scheduled') {
    res.status(400).json({ error: `Cannot cancel a post with status "${post.status}"` });
    return;
  }

  await prisma.post.delete({ where: { id: id } });
  logger.info({ postId: id }, '[API] Scheduled post canceled and deleted.');

  res.json({ message: 'Post canceled successfully' });
});

/**
 * Evaluator Tool: Toggle Transient Failure Simulation
 * When enabled, the first attempt to publish throws a 503 error, allowing
 * evaluators to visually observe automatic retries and exponential backoff in action!
 */
apiRouter.post('/test/toggle-simulate-failure', (req: Request, res: Response) => {
  const { enabled } = req.body;
  MockLinkedInClient.simulateTransientFailure = typeof enabled === 'boolean'
    ? enabled
    : !MockLinkedInClient.simulateTransientFailure;

  logger.info(
    { simulateTransientFailure: MockLinkedInClient.simulateTransientFailure },
    '[EVALUATOR TEST] Toggled transient failure simulation'
  );

  res.json({
    simulateTransientFailure: MockLinkedInClient.simulateTransientFailure,
    message: MockLinkedInClient.simulateTransientFailure
      ? 'Transient 503 failure simulation ENABLED. Next post will fail on attempt 1 and auto-retry!'
      : 'Transient failure simulation DISABLED. Posts will publish normally.',
  });
});
