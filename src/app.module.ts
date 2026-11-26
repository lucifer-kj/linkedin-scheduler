import { join } from 'node:path';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AppConfigModule } from './config/config.module.js';
import { LoggerModule } from './common/logger/logger.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { LinkedInModule } from './linkedin/linkedin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { PostsModule } from './posts/posts.module.js';
import { HealthModule } from './health/health.module.js';
import { TenantSessionMiddleware } from './common/tenant/tenant-session.middleware.js';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'dist', 'public'),
      exclude: ['/api/{*path}'],
    }),
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    QueueModule,
    LinkedInModule,
    AuthModule,
    PostsModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantSessionMiddleware).forRoutes('*');
  }
}
