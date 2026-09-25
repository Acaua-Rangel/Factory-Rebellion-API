import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// 1–12 characters: A–Z, 0–9 and underscore; trimmed and stored in uppercase (ASM-001).
export const CreateSessionSchema = z.object({
  nickname: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{1,12}$/, 'invalid nickname'),
});

export class CreateSessionDTO extends createZodDto(CreateSessionSchema) {}
