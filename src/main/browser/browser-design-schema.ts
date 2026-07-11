import { z } from 'zod';

/**
 * Validation for design-mode events pushed by the browser preload
 * (VISUAL-EDIT-001). The preload runs in the pane's isolated world but the
 * payload still crosses a process boundary — treat it as untrusted and cap
 * every field, mirroring browser-automation-schema.ts.
 */

const ELEMENT_REF = /^e[1-9]\d{0,7}$/;

const finiteCoord = z.number().finite().min(-10_000_000).max(10_000_000);

export const browserDesignRectSchema = z
  .object({
    x: finiteCoord,
    y: finiteCoord,
    width: z.number().finite().min(0).max(10_000_000),
    height: z.number().finite().min(0).max(10_000_000),
  })
  .strict();

const boundedRecord = (
  maxEntries: number,
  maxKeyChars: number,
  maxValueChars: number,
) =>
  z
    .record(z.string().max(maxKeyChars), z.string().max(maxValueChars))
    .refine((record) => Object.keys(record).length <= maxEntries, {
      message: `record exceeds ${maxEntries} entries`,
    });

export const browserDesignSourceHintSchema = z
  .object({
    file: z.string().min(1).max(1_024),
    line: z.number().int().min(0).max(10_000_000).optional(),
    column: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

export const browserDesignFrameworkHintsSchema = z
  .object({
    framework: z.enum(['react', 'vue', 'svelte', 'angular', 'unknown']),
    componentName: z.string().min(1).max(128).optional(),
    ownerChain: z.array(z.string().max(128)).max(10),
    propKeys: z.array(z.string().max(64)).max(32).optional(),
    source: browserDesignSourceHintSchema.optional(),
  })
  .strict();

export const browserDesignAncestorSchema = z
  .object({
    tag: z.string().min(1).max(32),
    id: z.string().max(256).optional(),
    classes: z.array(z.string().max(128)).max(8),
    role: z.string().max(64).optional(),
  })
  .strict();

export const browserDesignElementContextSchema = z
  .object({
    ref: z.string().regex(ELEMENT_REF),
    tag: z.string().min(1).max(32),
    id: z.string().max(256).optional(),
    classes: z.array(z.string().max(128)).max(32),
    selector: z.string().max(1_024),
    rect: browserDesignRectSchema,
    text: z.string().max(512),
    outerHtml: z.string().max(4_096),
    attributes: boundedRecord(24, 64, 256),
    computedStyles: boundedRecord(64, 64, 512),
    url: z.string().max(4_096),
    ancestors: z.array(browserDesignAncestorSchema).max(8).optional(),
    siblingLabels: z.array(z.string().max(160)).max(8).optional(),
    frameworkHints: browserDesignFrameworkHintsSchema.optional(),
    additive: z.boolean().optional(),
  })
  .strict();

export const browserDesignModeStateSchema = z
  .object({
    active: z.boolean(),
    reason: z.enum(['enable', 'disable', 'navigation']),
  })
  .strict();

export const browserDesignModeResultSchema = z
  .object({ active: z.boolean() })
  .strict();

export const browserStylePreviewResultSchema = z
  .object({
    applied: z.literal(true),
    selector: z.string().min(1).max(1_024),
    properties: z.number().int().min(1).max(64),
  })
  .strict();

export const browserStylePreviewClearResultSchema = z
  .object({ cleared: z.number().int().min(0).max(1_024) })
  .strict();

export const browserDesignReorderIntentSchema = z
  .object({
    nexusId: z.string().min(1).max(64),
    parentNexusId: z.string().min(1).max(64),
    fromIndex: z.number().int().min(0).max(10_000),
    toIndex: z.number().int().min(0).max(10_000),
  })
  .strict();

export const browserDesignEventSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        eventId: z.string().uuid(),
        generation: z.string().uuid(),
        type: z.literal('selection'),
        at: z.number().int().min(0),
        selection: browserDesignElementContextSchema,
      })
      .strict(),
    z
      .object({
        eventId: z.string().uuid(),
        generation: z.string().uuid(),
        type: z.literal('mode'),
        at: z.number().int().min(0),
        mode: browserDesignModeStateSchema,
      })
      .strict(),
    z
      .object({
        eventId: z.string().uuid(),
        generation: z.string().uuid(),
        type: z.literal('reorder'),
        at: z.number().int().min(0),
        reorder: browserDesignReorderIntentSchema,
      })
      .strict(),
  ]);
