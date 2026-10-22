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
    invalid: z.boolean().optional(),
    expanded: z.boolean().optional(),
    selected: z.boolean().optional(),
  })
  .strict();

export const browserViewportSchema = z
  .object({
    scrollY: z.number().finite().min(-100_000).max(100_000_000),
    scrollHeight: z.number().finite().min(0).max(100_000_000),
    innerHeight: z.number().finite().min(0).max(100_000),
    pagesBelow: z.number().finite().min(0).max(100_000),
  })
  .strict();

export const browserPageAlertSchema = z
  .object({
    ref: z.string().regex(/^e[1-9]\d{0,7}$/).optional(),
    role: z.string().min(1).max(64),
    text: z.string().min(1).max(200),
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
    viewport: browserViewportSchema,
    alerts: z.array(browserPageAlertSchema).max(10),
  })
  .strict();

export const browserFindMatchSchema = browserElementDescriptorSchema
  .extend({ score: z.number().finite().min(0).max(1) })
  .strict();

export const browserFindResultSchema = z
  .object({
    matches: z.array(browserFindMatchSchema).max(25),
    total: z.number().int().min(0).max(100_000),
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
    atBottom: z.boolean(),
    viewport: browserViewportSchema,
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

export const browserExtractCandidatesSchema = z
  .object({
    jsonLd: z.array(z.unknown()).max(3),
    pairs: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            value: z.string().min(1).max(300),
            ref: z.string().regex(/^e[1-9]\d{0,7}$/).optional(),
          })
          .strict(),
      )
      .max(60),
    tokens: z
      .array(
        z
          .object({
            kind: z.enum(['number', 'date', 'email', 'money', 'percent']),
            text: z.string().min(1).max(60),
            context: z.string().max(80),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

const layoutPx = z.number().finite().min(-1_000_000).max(1_000_000);

export const browserLayoutAuditSchema = z
  .object({
    layoutWidth: z.number().finite().min(0).max(100_000),
    scrollWidth: z.number().finite().min(0).max(1_000_000),
    horizontalOverflow: z.boolean(),
    overflowing: z
      .array(
        browserElementDescriptorSchema.extend({
          left: layoutPx,
          right: layoutPx,
          overflowPx: z.number().finite().min(0).max(1_000_000),
        }),
      )
      .max(20),
    clipped: z
      .array(
        browserElementDescriptorSchema.extend({
          hiddenX: z.number().finite().min(0).max(1_000_000),
          hiddenY: z.number().finite().min(0).max(1_000_000),
        }),
      )
      .max(20),
    truncated: z.boolean(),
  })
  .strict();

/** `input_prepare`: a point + delivery token, or why native input cannot be used. */
export const browserInputPrepareSchema = z.union([
  z
    .object({
      token: z.string().regex(/^i[1-9]\d{0,9}$/),
      x: z.number().finite().min(0).max(100_000),
      y: z.number().finite().min(0).max(100_000),
      element: browserElementDescriptorSchema,
    })
    .strict(),
  z.object({ token: z.string().regex(/^i[1-9]\d{0,9}$/) }).strict(),
  z
    .object({
      token: z.null(),
      reason: z.enum(['no-geometry', 'offscreen', 'occluded', 'no-target']),
    })
    .strict(),
]);

export const browserInputConfirmSchema = z.object({ delivered: z.boolean() }).strict();

export const browserSelectResultSchema = z
  .object({
    selected: z.literal(true),
    ref: z.string().regex(/^e[1-9]\d{0,7}$/),
    option: z
      .object({ label: z.string().max(120), index: z.number().int().min(0).max(100_000) })
      .strict(),
  })
  .strict();

/** `element_rect`: element box in top-level viewport CSS px after scrolling it into view. */
export const browserElementRectSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().finite().min(0).max(100_000),
    height: z.number().finite().min(0).max(100_000),
  })
  .strict();
