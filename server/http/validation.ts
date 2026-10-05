import { z } from 'zod';
export const memberSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const registrationSchema = memberSchema.extend({
  workspaceName: z.string().trim().min(1).max(80),
});
export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();
export const eventSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2000),
    kind: z.enum(['deployment', 'incident', 'announcement']),
  })
  .strict();
export const readSchema = z.object({ read: z.boolean() }).strict();
export const uuidSchema = z.string().uuid();
