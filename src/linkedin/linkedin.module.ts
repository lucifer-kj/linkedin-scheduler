import { Module } from '@nestjs/common';
import { LinkedInClientFactory } from './linkedin-client.factory.js';

@Module({
  providers: [LinkedInClientFactory],
  exports: [LinkedInClientFactory],
})
export class LinkedInModule {}
