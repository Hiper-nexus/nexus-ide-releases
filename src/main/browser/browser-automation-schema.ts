import { z } from 'zod';

export const browserElementDescriptorSchema = z
  .object({
    ref: z.string().regex(/^e[1-9]\d{0,7}$/),
    tag: z.string().min(1).max(32),
    role: z.string().min(1).max(64),
    name: z.string().max(320),
    href: z.string().max(4096).optional(),
    inputType: z.string().max(32).optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    editable: z.boolean().optional(),
  })
  .strict();

export const browserPageReadResultSchema = z
  .object({
    url: z.string().max(4096),
    title: z.string().max(512),
    readyState: z.string().max(32),
    language: z.string().max(32).optional(),
    description: z.string().max(1000).optional(),
    bodyText: z.string().max(20_000),
    headings: z
      .array(
        z
          .object({
            level: z.number().int().min(1).max(6),
            text: z.string().max(320),
          })
          .strict(),
      )
      .max(40),
    elements: z.array(browserElementDescriptorSchema).max(200),
    truncated: z.boolean(),
  })
  .strict();

export const browserAutomationEnvelopeSchema = z
  .object({
    requestId: z.string().uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(512).optional(),
  })
  .strict();

export const browserClickResultSchema = z
  .object({ clicked: z.literal(true), element: browserElementDescriptorSchema })
  .strict();

export const browserFillResultSchema = z
  .object({
    filled: z.literal(true),
    ref: z.string().regex(/^e[1-9]\d{0,7}$/),
    length: z.number().int().min(0).max(8_192),
  })
  .strict();

export const browserWaitResultSchema = z
  .object({
    matched: z.literal(true),
    condition: z.enum(['load', 'text', 'ref']),
    elapsedMs: z.number().int().min(0).max(60_000),
  })
  .strict();

export const browserScrollResultSchema = z
  .object({
    scrolled: z.literal(true),
    scrollX: z.number().finite().min(-100_000).max(100_000),
    scrollY: z.number().finite().min(-100_000).max(100_000),
    target: z.enum(['page', 'element']),
  })
  .strict();

export const browserPressResultSchema = z
  .object({
    pressed: z.literal(true),
    key: z.string().min(1).max(32),
    ref: z.string().regex(/^e[1-9]\d{0,7}$/).optional(),
  })
  .strict();

export const browserHoverResultSchema = z
  .object({ hovered: z.literal(true), element: browserElementDescriptorSchema })
  .strict();
