import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';

const sampleSchema = z.object({
  content: z.string().trim().min(1, 'Content is required').max(3000),
  scheduledFor: z.string().datetime(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(sampleSchema);
  const metadata = { type: 'body' as const };

  it('parses and transforms valid input', () => {
    const result = pipe.transform(
      {
        content: '  Hello LinkedIn!  ',
        scheduledFor: '2026-12-01T10:00:00.000Z',
      },
      metadata
    );

    expect(result).toEqual({
      content: 'Hello LinkedIn!',
      scheduledFor: '2026-12-01T10:00:00.000Z',
    });
  });

  it('throws structured BadRequestException on invalid input', () => {
    let caught: unknown;
    try {
      pipe.transform({ content: '   ', scheduledFor: 'not-a-date' }, metadata);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const response = (caught as BadRequestException).getResponse() as {
      statusCode: number;
      message: string;
      errors: Array<{ path: string; message: string; code: string }>;
      fieldErrors: Record<string, string[]>;
    };

    expect(response.statusCode).toBe(400);
    expect(response.message).toBe('Validation failed');
    expect(response.errors.length).toBeGreaterThanOrEqual(2);
    expect(response.fieldErrors.content).toBeDefined();
    expect(response.fieldErrors.scheduledFor).toBeDefined();
  });
});
