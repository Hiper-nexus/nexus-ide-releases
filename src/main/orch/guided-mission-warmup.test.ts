import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import { assertRosterCompleteGuidedV2Receipt } from "./guided-mission-plan-authority";
import { ensureGuidedMissionPlan } from "./guided-mission-planner";
import {
  harness,
  sealedGuidedV2Receipt,
  squad,
} from "./guided-mission-planner-test-harness";
import { GUIDED_TASK_DOMAINS } from "./guided-task-kind";
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
  type TaskScheduleMeta,
} from "./mission-scheduler-meta";

const FLAG = FEATURE_FLAG_IDS.missionWarmupAdvisories;

function warmupMeta(detail: string): TaskScheduleMeta | null {
  const meta = decodeTaskScheduleDetail(detail).meta;
  if (!meta) return null;
  return meta.ownership.domains.includes(GUIDED_TASK_DOMAINS.warmup)
    ? meta
    : null;
}

describe("warm-up read-only de reviewer/QA (feature.mission.warmupAdvisories)", () => {
  beforeAll(() => {
    getFeatureFlagRegistry().setOverride(FLAG, true);
  });

  afterAll(() => {
    getFeatureFlagRegistry().clearOverride(FLAG);
  });

  it("sela um warm-up raiz read-only por reviewer/QA na onda 1", () => {
    const h = harness();

    const result = ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps);

    expect(result).toMatchObject({ applicable: true, sealed: true });
    const input = h.createPlanAtomically.mock.calls[0]![0] as {
      rows: Array<{
        title: string;
        detail: string;
        agentRef: string;
        agentCategory: string;
      }>;
    };
    // O squad do harness tem dois reviewers: um vira quality gate, o outro
    // revisor independente — ambos aquecem na onda 1.
    const warmups = input.rows.filter((row) => warmupMeta(row.detail));
    expect(warmups).toHaveLength(2);
    for (const row of warmups) {
      const meta = warmupMeta(row.detail)!;
      expect(meta.executionMode).toBe("read_only");
      expect(meta.dependsOn).toEqual([]);
      expect(meta.ownership.files).toEqual([]);
      expect(meta.agentCategory).toBe("reviewer");
      expect(row.title).toMatch(/^Aquecer /);
      expect(decodeTaskScheduleDetail(row.detail).body).toContain(
        "não edite arquivos",
      );
    }
    expect(new Set(warmups.map((row) => row.agentRef))).toEqual(
      new Set(["qa", "reviewer"]),
    );
  });

  it("o receipt v2 com warm-ups é aceito pela autoridade de roster", () => {
    const planned = sealedGuidedV2Receipt() as Array<{
      task: { detail: string };
    }>;
    expect(planned.filter((entry) => warmupMeta(entry.task.detail)).length)
      .toBeGreaterThan(0);
    expect(() =>
      assertRosterCompleteGuidedV2Receipt(planned as never, squad),
    ).not.toThrow();
  });

  it("rejeita warm-up com dependência (deixa de ser raiz auxiliar)", () => {
    const planned = sealedGuidedV2Receipt() as Array<{
      task: { detail: string };
      plannedDetail: string;
    }>;
    const warmup = planned.find((entry) => warmupMeta(entry.task.detail))!;
    const { body, meta } = decodeTaskScheduleDetail(warmup.task.detail);
    if (!meta) throw new Error("warm-up sem meta selada");
    const tamperedDetail = encodeTaskScheduleDetail(body, {
      ...meta,
      dependsOn: ["guided-execution"],
    });
    const tampered = planned.map((entry) =>
      entry === warmup
        ? {
            ...entry,
            plannedDetail: tamperedDetail,
            task: { ...entry.task, detail: tamperedDetail },
          }
        : entry,
    );
    expect(() =>
      assertRosterCompleteGuidedV2Receipt(tampered as never, squad),
    ).toThrow(/warm-up/i);
  });

  it("kill-switch desligado volta ao grafo exato de antes", () => {
    getFeatureFlagRegistry().setOverride(FLAG, false);
    try {
      const h = harness();
      const result = ensureGuidedMissionPlan(
        h.suite,
        "mission-guided",
        h.deps,
      );
      expect(result).toMatchObject({ applicable: true, sealed: true });
      const input = h.createPlanAtomically.mock.calls[0]![0] as {
        rows: Array<{ detail: string }>;
      };
      expect(input.rows.filter((row) => warmupMeta(row.detail))).toHaveLength(
        0,
      );
      // Receipts selados sem warm-up continuam válidos (compatibilidade).
      expect(() =>
        assertRosterCompleteGuidedV2Receipt(
          sealedGuidedV2Receipt() as never,
          squad,
        ),
      ).not.toThrow();
    } finally {
      getFeatureFlagRegistry().setOverride(FLAG, true);
    }
  });
});
