import crypto from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';
import {
  LINKEDIN_BACKOFF_TYPE,
  LINKEDIN_POSTS_QUEUE,
  PUBLISH_POST_JOB,
} from '../queue/queue.constants.js';
import type { SchedulePostDto } from './posts.dto.js';

export interface PublishPostJobData {
  postId: string;
}

@Injectable()
export class PostsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLoggerService,
    @InjectQueue(LINKEDIN_POSTS_QUEUE)
    private readonly postsQueue: Queue<PublishPostJobData>
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const recovered = await this.recoverOverduePosts();
      if (recovered > 0) {
        this.logger.log(
          { recovered },
          'Startup overdue-post recovery enqueued missed scheduled posts'
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Startup overdue-post recovery skipped or failed'
      );
    }
  }

  async schedulePost(userId: string, dto: SchedulePostDto) {
    const account = await this.prisma.linkedinAccount.findUnique({
      where: { userId },
    });

    if (!account) {
      throw new BadRequestException('Please connect your LinkedIn account first.');
    }

    if (account.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(
        'Your LinkedIn access token has expired. Please reconnect your LinkedIn account.'
      );
    }

    const scheduledDate = new Date(dto.scheduledFor);
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${userId}:${dto.content}:${scheduledDate.toISOString()}`)
      .digest('hex');

    let post;
    try {
      post = await this.prisma.post.create({
        data: {
          userId,
          linkedinAccountId: account.id,
          content: dto.content,
          scheduledFor: scheduledDate,
          status: 'scheduled',
          idempotencyKey,
          retryCount: 0,
          maxRetries: 5,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existingPost = await this.prisma.post.findUnique({
          where: { idempotencyKey },
        });
        throw new ConflictException({
          error:
            'Duplicate post detected. A post with identical content and scheduled time already exists.',
          post: existingPost,
        });
      }
      throw error;
    }

    const jobId = this.buildJobId(post.id);
    const delayMs = Math.max(0, scheduledDate.getTime() - Date.now());

    await this.enqueuePublishJob(post.id, delayMs, post.maxRetries);

    const updatedPost = await this.prisma.post.update({
      where: { id: post.id },
      data: { bullmqJobId: jobId },
    });

    this.logger.log(
      { userId, postId: post.id, jobId, delayMs, scheduledFor: scheduledDate.toISOString() },
      'Scheduled LinkedIn post in database and BullMQ'
    );

    return updatedPost;
  }

  async listPosts(userId: string) {
    return this.prisma.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancelPost(userId: string, postId: string): Promise<{ message: string }> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    if (post.status !== 'scheduled') {
      throw new BadRequestException(`Cannot cancel a post with status "${post.status}"`);
    }

    const jobId = post.bullmqJobId ?? this.buildJobId(post.id);
    try {
      await this.postsQueue.remove(jobId);
    } catch (error) {
      this.logger.warn(
        { postId, jobId, err: error },
        'Failed to remove BullMQ job during cancellation (may already be removed)'
      );
    }

    await this.prisma.post.delete({ where: { id: post.id } });
    this.logger.log({ userId, postId, jobId }, 'Scheduled post canceled and removed');

    return { message: 'Post canceled successfully' };
  }

  /**
   * Recovery sweep for overdue `scheduled` posts (e.g. after Render free-tier sleep or Redis restart).
   * Enqueues any overdue `scheduled` post whose BullMQ job is missing or not active/delayed.
   */
  async recoverOverduePosts(): Promise<number> {
    const now = new Date();
    const overduePosts = await this.prisma.post.findMany({
      where: {
        status: 'scheduled',
        scheduledFor: { lte: now },
      },
      select: { id: true, bullmqJobId: true, maxRetries: true },
      take: 25,
    });

    let recovered = 0;
    for (const post of overduePosts) {
      const jobId = post.bullmqJobId ?? this.buildJobId(post.id);
      const existingJob = await this.postsQueue.getJob(jobId);

      if (existingJob) {
        const state = await existingJob.getState();
        if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized') {
          continue;
        }
        await existingJob.remove().catch(() => {});
      }

      await this.enqueuePublishJob(post.id, 0, post.maxRetries);
      if (!post.bullmqJobId) {
        await this.prisma.post.updateMany({
          where: { id: post.id, bullmqJobId: null },
          data: { bullmqJobId: jobId },
        });
      }
      recovered += 1;
    }

    return recovered;
  }

  private buildJobId(postId: string): string {
    return `post-${postId}`;
  }

  private async enqueuePublishJob(
    postId: string,
    delayMs: number,
    maxRetries: number
  ): Promise<void> {
    await this.postsQueue.add(
      PUBLISH_POST_JOB,
      { postId },
      {
        jobId: this.buildJobId(postId),
        delay: delayMs,
        attempts: maxRetries,
        backoff: {
          type: LINKEDIN_BACKOFF_TYPE,
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
  }
}
