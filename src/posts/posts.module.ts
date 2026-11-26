import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LinkedInModule } from '../linkedin/linkedin.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { PostsController } from './posts.controller.js';
import { PostsProcessor } from './posts.processor.js';
import { PostsService } from './posts.service.js';

@Module({
  imports: [QueueModule, LinkedInModule, AuthModule],
  controllers: [PostsController],
  providers: [PostsService, PostsProcessor],
  exports: [PostsService],
})
export class PostsModule {}
