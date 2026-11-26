import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentTenant } from '../common/tenant/current-tenant.decorator.js';
import type { TenantContext } from '../common/tenant/tenant-session.middleware.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AuthService,
  saveCredentialsSchema,
  type AccountStatusResponse,
  type OAuthCallbackQuery,
  type SaveCredentialsDto,
} from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('auth/linkedin/url')
  getLinkedInAuthUrl(@CurrentTenant() tenant: TenantContext): Promise<{ url: string }> {
    return this.authService.getAuthorizationUrl(tenant.userId);
  }

  @Get('auth/linkedin/callback')
  async handleLinkedInCallback(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: OAuthCallbackQuery,
    @Res() res: Response
  ): Promise<void> {
    const redirectUrl = await this.authService.handleCallback(tenant.userId, query);
    res.redirect(HttpStatus.FOUND, redirectUrl);
  }

  @Get('account')
  getAccount(@CurrentTenant() tenant: TenantContext): Promise<AccountStatusResponse> {
    return this.authService.getAccountStatus(tenant.userId);
  }

  @Post('account/credentials')
  @HttpCode(HttpStatus.OK)
  saveCredentials(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(saveCredentialsSchema)) body: SaveCredentialsDto
  ): Promise<{ ok: true; hasCustomCredentials: true }> {
    return this.authService.saveCredentials(tenant.userId, body);
  }

  @Delete('account/credentials')
  @HttpCode(HttpStatus.OK)
  deleteCredentials(
    @CurrentTenant() tenant: TenantContext
  ): Promise<{ ok: true; hasCustomCredentials: false }> {
    return this.authService.deleteCredentials(tenant.userId);
  }

  @Post('account/disconnect')
  @HttpCode(HttpStatus.OK)
  disconnectAccount(
    @CurrentTenant() tenant: TenantContext
  ): Promise<{ ok: true; connected: false }> {
    return this.authService.disconnectAccount(tenant.userId);
  }
}
