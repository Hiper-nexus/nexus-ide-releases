import { z } from "zod";

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
  "computer-use",
]);
export const realMissionE2ERunPayloadSchema = z
  .object({
    workspacePath: z.string().min(1).max(4_096),
    rendererFailureToken: sha256Schema,
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
