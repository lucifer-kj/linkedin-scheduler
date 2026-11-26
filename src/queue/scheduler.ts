import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '../database/client.js';
import { PostExecutionWorker } from './worker.js';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

export class SchedulerService {
  private static pollingInterval: NodeJS.Timeout | null = null;
  private static bullQueue: Queue | null = null;
  private static bullWorker: Worker | null = null;
  private static redisConnected = false;

  /**
   * Initializes the scheduler engine.
   * Leverages BullMQ when Redis is available, alongside a reliable atomic polling engine.
   */
  static async init(): Promise<void> {
    // Attempt Redis connection for BullMQ
    try {
      const redisConnection = new IORedis.default(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        connectTimeout: 1000,
      });

      await redisConnection.connect();
      this.redisConnected = true;
      logger.info('[SCHEDULER] Redis connected. Initializing BullMQ delayed queue.');

      this.bullQueue = new Queue('linkedin-posts', { connection: redisConnection });
      this.bullWorker = new Worker(
        'linkedin-posts',
        async (job) => {
          logger.info({ jobId: job.id, postId: job.data.postId }, '[BULLMQ] Processing job.');
          await PostExecutionWorker.processPost(job.data.postId);
        },
        { connection: redisConnection }
      );
    } catch (err) {
      this.redisConnected = false;
      logger.info(
        '[SCHEDULER] Redis not detected locally. Operating in autonomous Atomic DB Polling mode.'
      );
    }

    // Start DB Scheduler heartbeat (runs every 1.5 seconds)
    this.startDbPolling();
  }

  /**
   * Schedules a post. If BullMQ is active, adds delayed job.
   */
  static async schedulePost(postId: string, scheduledFor: Date): Promise<void> {
    const delayMs = Math.max(0, scheduledFor.getTime() - Date.now());

    if (this.redisConnected && this.bullQueue) {
      await this.bullQueue.add(
        'publish-post',
        { postId },
        {
          delay: delayMs,
          jobId: `post-${postId}`, // BullMQ native idempotency
          removeOnComplete: true,
        }
      );
      logger.info({ postId, delayMs }, '[BULLMQ] Enqueued delayed job in Redis.');
    } else {
      logger.info(
        { postId, scheduledFor, delayMs },
        '[SCHEDULER] Post stored in DB. Scheduler polling engine will trigger it at scheduled time.'
      );
    }
  }

  /**
   * Core DB Poller: Scans for due posts and processes them atomically.
   */
  private static startDbPolling(): void {
    if (this.pollingInterval) return;

    this.pollingInterval = setInterval(async () => {
      try {
        const now = new Date();
        const duePosts = await prisma.post.findMany({
          where: {
            status: 'scheduled',
            scheduledFor: {
              lte: now,
            },
          },
          select: { id: true, scheduledFor: true },
          take: 10,
        });

        for (const post of duePosts) {
          // Fire worker in background (non-blocking)
          PostExecutionWorker.processPost(post.id).catch((err) => {
            logger.error({ postId: post.id, err }, '[SCHEDULER] Unhandled worker exception');
          });
        }
      } catch (error: any) {
        logger.error({ error: error.message }, '[SCHEDULER] Polling check encountered error');
      }
    }, 1500);
  }

  static stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.bullWorker) {
      this.bullWorker.close();
    }
    if (this.bullQueue) {
      this.bullQueue.close();
    }
  }
}
