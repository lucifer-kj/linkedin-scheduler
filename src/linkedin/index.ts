import { config } from '../config/index.js';
import { ILinkedInClient } from './types.js';
import { RealLinkedInClient } from './client.js';
import { MockLinkedInClient } from './mock-client.js';

export const linkedInClient: ILinkedInClient = config.USE_MOCK_LINKEDIN
  ? new MockLinkedInClient()
  : new RealLinkedInClient();
