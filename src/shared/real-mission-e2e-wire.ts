import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

const REAL_MISSION_E2E_RENDERER_FAILURE_PREFIX = "renderer-failed:";

export const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const gitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const timestampSchema = z.number().int().nonnegative();

export const coverageTierSchema = z.enum([
  "guided-delivery-core",
  "full-flow",
]);
export const planOriginSchema = z.enum([
  "production-guided-planner",
  "agent-mcp",
]);
export const prevcOriginSchema = z.enum(["e2e-fixture", "production-runtime"]);
export const reviewOriginSchema = z.literal("production-physical-worker");
export const qaOriginSchema = z.literal("production-physical-worker");
export const launchSurfaceSchema = z.enum(["private-runner", "product-wizard"]);
export const wizardCoverageSchema = z.enum([
  "not-covered",
  "main-owned-product-sequence",
]);
export const productWizardStepSchema = z.enum([
  "mission-armed",
  "intent-submitted",
  "approval-returned",
]);
export const productWizardGestureCapabilitySchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);
export const realMissionRuntimeAttestationSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("hmac-sha256"),
    challengeSha256: sha256Schema,
    bindingSha256: sha256Schema,
    evidenceSha256: sha256Schema,
    macSha256: sha256Schema,
  })
  .strict();
export const realMissionE2EProductWizardStepPayloadSchema = z
  .object({
    missionId: idSchema,
    step: productWizardStepSchema,
    capability: productWizardGestureCapabilitySchema,
  })
  .strict();

const productWizardReceiptCoreSchema = z
  .object({
    origin: z.literal("main-owned-product-wizard-causal-chain"),
    missionId: idSchema,
    workspaceSha256: sha256Schema,
    sourceSquadRevisionHash: sha256Schema,
    squadRevisionHash: sha256Schema,
    submittedContractSha256: sha256Schema,
    approvedContractSha256: sha256Schema,
    armedAt: timestampSchema,
    intentSubmittedAt: timestampSchema,
    nativeDialogOpenedAt: timestampSchema,
    nativeDialogAcceptedAt: timestampSchema,
    approvalReturnedAt: timestampSchema,
  })
  .strict();

type ProductWizardReceiptCore = z.infer<
  typeof productWizardReceiptCoreSchema
>;

export function productWizardReceiptChainSha256(
  receipt: ProductWizardReceiptCore,
): string {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify({
          version: "nexus-product-wizard-causal-chain-v1",
          origin: receipt.origin,
          missionId: receipt.missionId,
          workspaceSha256: receipt.workspaceSha256,
          sourceSquadRevisionHash: receipt.sourceSquadRevisionHash,
          squadRevisionHash: receipt.squadRevisionHash,
          submittedContractSha256: receipt.submittedContractSha256,
          approvedContractSha256: receipt.approvedContractSha256,
          armedAt: receipt.armedAt,
          intentSubmittedAt: receipt.intentSubmittedAt,
          nativeDialogOpenedAt: receipt.nativeDialogOpenedAt,
          nativeDialogAcceptedAt: receipt.nativeDialogAcceptedAt,
          approvalReturnedAt: receipt.approvalReturnedAt,
        }),
      ),
    ),
  );
}

export const productWizardReceiptSchema = productWizardReceiptCoreSchema
  .extend({
    chainSha256: sha256Schema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.armedAt > receipt.intentSubmittedAt ||
      receipt.intentSubmittedAt > receipt.nativeDialogOpenedAt ||
      receipt.nativeDialogOpenedAt > receipt.nativeDialogAcceptedAt ||
      receipt.nativeDialogAcceptedAt > receipt.approvalReturnedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "product wizard causal timestamps are out of order",
      });
    }
    if (receipt.submittedContractSha256 === receipt.approvedContractSha256) {
      context.addIssue({
        code: "custom",
        path: ["approvedContractSha256"],
        message: "approved contract must differ from the submitted contract",
      });
    }
    if (receipt.chainSha256 !== productWizardReceiptChainSha256(receipt)) {
      context.addIssue({
        code: "custom",
        path: ["chainSha256"],
        message: "product wizard causal chain hash is invalid",
      });
    }
  });

export type RealMissionE2EProductWizardStep = z.infer<
  typeof productWizardStepSchema
>;
export type RealMissionE2EProductWizardReceipt = z.infer<
  typeof productWizardReceiptSchema
>;
export type RealMissionRuntimeAttestation = z.infer<
  typeof realMissionRuntimeAttestationSchema
>;
export const realMissionE2ERunPayloadSchema = z
  .object({
    workspacePath: z.string().min(1).max(4_096),
    rendererFailureToken: sha256Schema,
    // Variante de orquestrador selada pelo main; ausente = codex (default).
    orchestratorCli: z.enum(["codex", "claude"]).default("codex"),
  })
  .strict();

export const realMissionE2EPrepareFixturePayloadSchema = z
  .object({
    rendererFailureToken: sha256Schema,
  })
  .strict();

export const realMissionE2EObservePayloadSchema = z
  .object({
    missionId: idSchema,
  })
  .strict();

export function realMissionE2ERendererFailureSignal(token: string): string {
  return `${REAL_MISSION_E2E_RENDERER_FAILURE_PREFIX}${sha256Schema.parse(token)}`;
}

export function isRealMissionE2ERendererFailureSignal(
  value: string,
  expectedToken: string,
): boolean {
  const parsedToken = sha256Schema.safeParse(expectedToken);
  return (
    parsedToken.success &&
    value === `${REAL_MISSION_E2E_RENDERER_FAILURE_PREFIX}${parsedToken.data}`
  );
}
