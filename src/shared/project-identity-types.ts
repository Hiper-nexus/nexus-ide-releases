/**
 * Portable project identity v2 — Zod schemas + quarantine helpers.
 * Extracted from types.ts for the Akita ~800-line module budget.
 */
import { z } from 'zod';

export const PROJECT_IDENTITY_VERSION = 1 as const;
export const PROJECT_MANIFEST_VERSION = 2 as const;

const originHashSchema = z.string().regex(/^origin-sha256-[a-f0-9]{64}$/);
const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const gitRepositoryLineageSchema = z
  .object({
    vcs: z.literal('git'),
    originHashes: z.array(originHashSchema).max(16),
    rootCommits: z.array(gitObjectIdSchema).max(64),
    anchorCommits: z.array(gitObjectIdSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.originHashes.length === 0 && value.anchorCommits.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'repository lineage requires an origin hash or anchor commit',
      });
    }
    for (const [field, values] of [
      ['originHashes', value.originHashes],
      ['rootCommits', value.rootCommits],
      ['anchorCommits', value.anchorCommits],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must not contain duplicates`,
        });
      }
    }
  });

export const projectManifestSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_MANIFEST_VERSION),
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
    repository: gitRepositoryLineageSchema,
  })
  .strict();

export const legacyProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_IDENTITY_VERSION),
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const projectManifestFileSchema = z.union([
  projectManifestSchema,
  legacyProjectManifestSchema,
]);

export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type LegacyProjectManifest = z.infer<typeof legacyProjectManifestSchema>;
export type GitRepositoryLineage = z.infer<typeof gitRepositoryLineageSchema>;
export type ProjectIdentitySource = 'manifest' | 'provisional';

export type ProjectIdentityQuarantineCode =
  | 'legacy-manifest-unverified'
  | 'repository-lineage-mismatch'
  | 'repository-lineage-unverifiable'
  | 'unsafe-git-administration'
  | 'checkout-registry-required'
  | 'checkout-token-mismatch'
  | 'duplicate-checkout-token';

export class ProjectIdentityQuarantineError extends Error {
  readonly code: ProjectIdentityQuarantineCode;
  readonly remediation: string;

  constructor(
    code: ProjectIdentityQuarantineCode,
    message: string,
    remediation: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectIdentityQuarantineError';
    this.code = code;
    this.remediation = remediation;
  }
}

export function quarantineProjectIdentity(
  code: ProjectIdentityQuarantineCode,
  message: string,
  remediation: string,
  cause?: unknown,
): never {
  throw new ProjectIdentityQuarantineError(code, message, remediation, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export const projectExecutionScopeSchema = z.object({
  version: z.literal(PROJECT_IDENTITY_VERSION),
  installationId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  checkoutId: z.string().min(1).max(128),
  rootRealPath: z.string().min(1).max(4096),
  identitySource: z.enum(['manifest', 'provisional']),
}).strict();

/**
 * Immutable authority attached to a session when it is created. Paths are
 * always resolved from this scope; the workspace currently visible in the UI
 * is intentionally absent from the authorization decision.
 */
export type ProjectExecutionScope = Readonly<
  z.infer<typeof projectExecutionScopeSchema>
>;
