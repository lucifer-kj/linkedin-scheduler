import { Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [QueueModule, PostsModule],
  controllers: [HealthController],
})
export class HealthModule {}
