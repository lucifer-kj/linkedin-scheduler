import { z } from 'zod';

export const schedulePostSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Post content cannot be empty')
    .max(3000, 'Post content exceeds 3000 characters'),
  scheduledFor: z
    .string()
    .refine((val) => !Number.isNaN(Date.parse(val)), 'Invalid datetime format'),
});

export type SchedulePostDto = z.infer<typeof schedulePostSchema>;

export const toggleSimulationSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .optional();

export type ToggleSimulationDto = z.infer<typeof toggleSimulationSchema>;
