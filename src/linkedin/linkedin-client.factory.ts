import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';
import type { ILinkedInClient } from './types.js';
import { RealLinkedInClient, type LinkedInClientLogger } from './client.js';
import { MockLinkedInClient } from './mock-client.js';

export interface CustomOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

@Injectable()
export class LinkedInClientFactory implements OnModuleInit {
  private readonly clientLogger: LinkedInClientLogger;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLoggerService
  ) {
    this.clientLogger = {
      info: (obj, msg) => this.logger.log(obj, msg ?? 'LinkedInClient'),
      warn: (obj, msg) => this.logger.warn(obj, msg ?? 'LinkedInClient'),
      error: (obj, msg) => this.logger.error(obj, msg ?? 'LinkedInClient'),
    };
  }

  onModuleInit(): void {
    MockLinkedInClient.setSimulateTransientFailure(this.config.simulateTransientFailure);
  }

  isMockMode(): boolean {
    return this.config.useMockLinkedin;
  }

  createClient(customCredentials?: CustomOAuthCredentials): ILinkedInClient {
    if (this.config.useMockLinkedin) {
      return new MockLinkedInClient(this.clientLogger);
    }

    return new RealLinkedInClient(
      {
        clientId: customCredentials?.clientId ?? this.config.linkedinClientId,
        clientSecret: customCredentials?.clientSecret ?? this.config.linkedinClientSecret,
        redirectUri: this.config.linkedinRedirectUri,
        apiVersion: this.config.linkedinApiVersion,
      },
      this.clientLogger
    );
  }
}
