import { describe, expect, it } from "vitest";
import {
  humanizeMissionErrorDetail,
  toUserFacingMissionError,
} from "./user-facing-mission-error";

describe("user-facing mission errors", () => {
  it("maps governed preflight codes to a concrete recovery instruction", () => {
    expect(
      humanizeMissionErrorDetail(
        "Error invoking remote method 'orch:missions.approveIntent': Error: " +
          "guided_plan_preflight_blocked: guided_plan_unborn_with_files",
      ),
    ).toBe(
      "Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.",
    );
  });

  it("never exposes unknown English provider diagnostics in the golden path", () => {
    const message = toUserFacingMissionError(
      new Error("provider temporarily unavailable"),
      "Não foi possível preparar a equipe. Tente novamente.",
    );

    expect(message).toBe(
      "Não foi possível preparar a equipe. Tente novamente.",
    );
    expect(message).not.toMatch(/provider|unavailable/i);
    expect(
      toUserFacingMissionError(
        "connection refused while opening /private/tmp/nexus/socket",
        "Não foi possível preparar a equipe. Tente novamente.",
      ),
    ).toBe("Não foi possível preparar a equipe. Tente novamente.");
  });

  it("preserves already actionable Portuguese copy", () => {
    expect(
      toUserFacingMissionError(
        "A pasta mudou durante a preparação. Revise o objetivo e tente novamente.",
      ),
    ).toBe(
      "A pasta mudou durante a preparação. Revise o objetivo e tente novamente.",
    );
  });
});
