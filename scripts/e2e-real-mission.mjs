import path from "node:path";
import { pathToFileURL } from "node:url";

import { REAL_MISSION_CTA } from "./e2e-real-mission-contract.mjs";
import { parseRealMissionArgs } from "./e2e-real-mission-launcher.mjs";

export {
  REAL_MISSION_CTA,
  REAL_MISSION_EVIDENCE_FILE,
  REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_EXPECTED_CONTENT,
  REAL_MISSION_FLAG,
  REAL_MISSION_PRODUCT_WIZARD_FLAG,
  REAL_MISSION_TIMEOUT_MS,
  REAL_MISSION_ADVISOR_SKIP_ENV,
  REAL_MISSION_ORCHESTRATOR_ENV,
  mergeRealMissionAdvisorSkipEnv,
} from "./e2e-real-mission-contract.mjs";
export {
  assertAdvisorBinaries,
  assertCodexReady,
  parseRealMissionArgs,
  realMissionArgs,
  realMissionEnvironment,
  resolveTrustedCodexBinary,
  stageAdvisorAuthentication,
  stageClaudeNativeIdentity,
  stageCodexAuthentication,
} from "./e2e-real-mission-launcher.mjs";
export {
  assertRealMissionPassEvidence,
  assertRealMissionReleaseEvidence,
  safeRealMissionFailureReceipt,
  safeRealMissionFailureSummary,
} from "./e2e-real-mission-evidence.mjs";
export {
  assertVerifiedRealMissionRuntimeProof,
  runPackagedRealMission,
  runPackagedRealMissionProductWizard,
  waitForChild,
} from "./e2e-real-mission-runtime.mjs";

async function main() {
  parseRealMissionArgs(process.argv.slice(2));
  throw new Error(
    "direct E2E invocation is disabled: use npm run release:candidate so the " +
      "verified ZIP, commit, signature and evidence stay bound",
  );
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectRun) {
  main().catch((error) => {
    const message =
      error instanceof Error && error.message.startsWith("[real-mission]")
        ? error.message
        : `[real-mission] FAIL code=harness-error status=unknown panes=0 ` +
          `dispatches=0 handoffs=0 CTA: ${REAL_MISSION_CTA}`;
    console.error(message);
    process.exitCode = 1;
  });
}
