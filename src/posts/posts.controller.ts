import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentTenant } from '../common/tenant/current-tenant.decorator.js';
import type { TenantContext } from '../common/tenant/tenant-session.middleware.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { MockLinkedInClient } from '../linkedin/mock-client.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';
import {
  PostsService,
} from './posts.service.js';
import {
  schedulePostSchema,
  toggleSimulationSchema,
  type SchedulePostDto,
  type ToggleSimulationDto,
} from './posts.dto.js';

@Controller()
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly logger: PinoLoggerService
  ) {}

  @Post('posts/schedule')
  async schedulePost(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(schedulePostSchema)) body: SchedulePostDto
  ) {
    const post = await this.postsService.schedulePost(tenant.userId, body);
    return {
      message: 'Post scheduled successfully',
      post,
    };
  }

  @Get('posts')
  async listPosts(@CurrentTenant() tenant: TenantContext) {
    const posts = await this.postsService.listPosts(tenant.userId);
    return { posts };
  }

  @Post('posts/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelPost(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string
  ): Promise<{ message: string }> {
    return this.postsService.cancelPost(tenant.userId, id);
  }

  @Post('test/toggle-simulate-failure')
  @HttpCode(HttpStatus.OK)
  toggleSimulateFailure(
    @Body(new ZodValidationPipe(toggleSimulationSchema)) body?: ToggleSimulationDto
  ) {
    const nextState =
      typeof body?.enabled === 'boolean'
        ? MockLinkedInClient.setSimulateTransientFailure(body.enabled)
        : MockLinkedInClient.toggleSimulateTransientFailure();

    this.logger.log(
      { simulateTransientFailure: nextState },
      'Toggled MockLinkedInClient transient 503 failure simulation'
    );

    return {
      simulateTransientFailure: nextState,
      message: nextState
        ? 'Transient 503 failure simulation ENABLED. Next post will fail on attempt 1 and auto-retry!'
        : 'Transient failure simulation DISABLED. Posts will publish normally.',
    };
  }
}
