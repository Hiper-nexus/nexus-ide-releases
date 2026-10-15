import { describe, expect, it } from "vitest";
import {
  humanizeMissionErrorDetail,
  toUserFacingMissionError,
  toUserFacingMissionRecovery,
} from "./user-facing-mission-error";

describe("user-facing mission errors", () => {
  it("F-1470: a recusa do vínculo do coordenador vira a ação que destrava, pelo rótulo", () => {
    const refused =
      "Orquestrador não reabriu: orchestrator physical spawn authority is missing or mismatched";
    const teamChanged =
      "O coordenador não voltou porque a equipe aprovada mudou. Revise a equipe e aprove a missão de novo.";
    const accountChanged =
      "O coordenador não voltou porque a conta aprovada para ele mudou. Revise a equipe e aprove a missão de novo.";
    const modelChanged =
      "O coordenador não voltou porque o modelo ou o esforço aprovado mudou. Revise a equipe e aprove a missão de novo.";
    const otherLive =
      "Já há outro coordenador rodando nesta missão. Feche os panes antigos do coordenador e use Retomar o coordenador.";
    const generic =
      "O coordenador não voltou. Use Retomar o coordenador; se repetir, use Reportar bug.";
    const cases: Array<[string, string]> = [
      [`${refused}: account[diferente]`, accountChanged],
      [`${refused}: account[ausente], cwd[diferente]`, accountChanged],
      [`${refused}: model[roster-model != approved-model]`, modelChanged],
      [`${refused}: effort[high != medium]`, modelChanged],
      [`${refused}: seal`, teamChanged],
      [`${refused}: adapter[claude != codex]`, teamChanged],
      [`${refused}: other-orchestrator[0f3a9c1d busy]`, otherLive],
      [`${refused}: account[diferente], other-orchestrator[0f3a9c1d busy]`, otherLive],
      [`${refused}: runtime, scope`, generic],
      // Build antigo: o prefixo sem rótulos.
      [refused, generic],
    ];
    for (const [raw, expected] of cases) {
      expect(toUserFacingMissionError(new Error(raw))).toBe(expected);
    }
  });

  it("maps governed preflight codes to a concrete recovery instruction", () => {
    expect(
      humanizeMissionErrorDetail(
        "Error invoking remote method 'orch:mission.start': Error: " +
          "guided_plan_preflight_blocked: guided_plan_unborn_with_files",
      ),
    ).toBe(
      "Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.",
    );
  });

  it("tells an unapproved mission to approve, not to audit an intact team", () => {
    // O contrato sem `squadRevisionHash` caía na cópia de squad alterado, que
    // manda revisar uma equipe que ninguém mexeu e esconde a ação que destrava.
    expect(
      humanizeMissionErrorDetail(
        "guided_plan_preflight_blocked: guided_plan_squad_unbound: a intenção " +
          "não foi aprovada com uma revisão de equipe",
      ),
    ).toBe("Esta missão ainda não foi aprovada. Revise a equipe e aprove para começar.");
    expect(
      humanizeMissionErrorDetail(
        "guided_plan_preflight_blocked: guided_plan_squad_stale: o squad mudou",
      ),
    ).toBe(
      "A equipe mudou depois da revisão. Revise o plano e aprove a missão novamente.",
    );
  });

  it("leads with recovery copy but discloses the raw reason when unmapped", () => {
    // Field trap (28/07): an unmapped pre-launch failure showed only "tente
    // novamente". There is no mission journal before launch, so the operator
    // retried a mission that could never start and had nothing to report.
    // The recovery sentence still leads; the raw reason follows it, labelled.
    const message = toUserFacingMissionError(
      new Error("provider temporarily unavailable"),
      "Não foi possível preparar a equipe. Tente novamente.",
    );

    expect(message).toMatch(
      /^Não foi possível preparar a equipe\. Tente novamente\./,
    );
    expect(message).toContain("Detalhe técnico:");
    expect(message).toContain("provider temporarily unavailable");

    const transport = toUserFacingMissionError(
      "connection refused while opening /private/tmp/nexus/socket",
      "Não foi possível preparar a equipe. Tente novamente.",
    );
    expect(transport).toMatch(
      /^Não foi possível preparar a equipe\. Tente novamente\. Detalhe técnico: /,
    );
  });

  it("does not treat authored EXATAMENTE as an errno token", () => {
    expect(
      humanizeMissionErrorDetail(
        "SaaS lista de espera com EXATAMENTE — o resultado final está pronto.",
      ),
    ).toBe(
      "SaaS lista de espera com EXATAMENTE — o resultado final está pronto.",
    );
    expect(
      humanizeMissionErrorDetail("spawn git ENOENT"),
    ).toMatch(/^Não foi possível concluir esta etapa/);
  });

  it("shows authored Portuguese copy that mentions a technical noun", () => {
    // Field trap (28/07): this message already told the operator what to do,
    // but "bootstrap" put it on the internal-diagnostic list and it was
    // replaced by a bare "tente novamente".
    expect(
      toUserFacingMissionError(
        new Error(
          "O bootstrap exige uma missão running com intenção aprovada. " +
            "CTA: Retomar missão.",
        ),
        "Não foi possível iniciar a missão. Tente novamente.",
      ),
    ).toBe(
      "O bootstrap exige uma missão running com intenção aprovada. CTA: Retomar missão.",
    );
  });

  it("still withholds English transport noise and machine residue", () => {
    const english = toUserFacingMissionError(
      new Error("connection refused"),
      "Não foi possível iniciar a missão. Tente novamente.",
    );
    expect(english).toMatch(/^Não foi possível iniciar a missão\./);

    // Portuguese wrapper around a snake_case code is still machine residue.
    const residue = toUserFacingMissionError(
      new Error("A missão falhou: mission_runtime_seal_absent"),
      "Não foi possível iniciar a missão. Tente novamente.",
    );
    expect(residue).toMatch(/^Não foi possível iniciar a missão\./);
  });

  it("F-1490: withholds a Windows absolute path even inside authored Portuguese", () => {
    const fallback = "Não foi possível preparar a revisão.";
    for (const raw of [
      "Não foi possível ler C:\\Users\\cliente\\AppData\\Roaming\\Nexus\\squads.json.",
      "Não foi possível ler \\\\servidor\\equipe\\squads.json.",
    ]) {
      const recovery = toUserFacingMissionRecovery(new Error(raw), fallback);
      expect(recovery).toBe(fallback);
      expect(recovery).not.toMatch(/Users|servidor/);
    }
  });

  it("keeps mapped recoveries free of technical noise", () => {
    const mapped = toUserFacingMissionError(
      new Error("invalid transition executing --submit_goal-->"),
      "Não foi possível iniciar a missão. Tente novamente.",
    );
    expect(mapped).not.toContain("Detalhe técnico:");
    expect(mapped).not.toMatch(/submit_goal|invalid transition/i);
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

  it("tells the truth when a mission state refuses a new goal", () => {
    // Field trap (28/07): the raw reason contains "invalid", so it fell into
    // the generic fallback and told the operator to "revise o texto" while the
    // real problem was the mission state. They retyped the same goal 3x.
    expect(
      toUserFacingMissionError(
        new Error("invalid transition executing --submit_goal-->"),
        "Não foi possível preparar o objetivo. Revise o texto e tente novamente.",
      ),
    ).toBe(
      "A missão já está em execução e não aceita um novo objetivo agora. Pare a missão para redirecioná-la.",
    );
  });

  it("maps guided context bootstrap attestation blockers to a concrete recovery", () => {
    expect(
      toUserFacingMissionError(
        new Error(
          "Error invoking remote method 'orch:mission.start': Error: " +
            "guided_plan_preflight_blocked: guided_prevc_context_bootstrap_blocked: " +
            "o contexto governado não ficou pronto; blockers=invalid-context-attestation, " +
            "missing-context-attestation; Context not ready.",
        ),
        "Não foi possível iniciar a missão. Tente novamente.",
      ),
    ).toMatch(/contexto do projeto precisa de revisão/i);
  });

  it("maps dirty evidence-surface git binding to a commit/cleanup instruction", () => {
    expect(
      toUserFacingMissionError(
        new Error(
          "guided_plan_preflight_blocked: workflow binding requires a clean " +
            "committed checkout of the evidence surface: " +
            ".context/nexus/attestations/att-bad.json",
        ),
        "Não foi possível iniciar a missão. Tente novamente.",
      ),
    ).toMatch(/arquivos não commitados em \.context/i);
  });

  it("maps mission-direct diagnostics to operator Portuguese recovery copy", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "mission direct requires the current kickoff receipt",
        "A coordenação ainda está recebendo o briefing da missão. " +
          "Envie de novo em alguns segundos.",
      ],
      [
        "mission direct requires a live orchestrator session",
        "O Maestro desta missão não está rodando. " +
          "Use Retomar no Quadro para religá-lo.",
      ],
      [
        "mission direct orchestrator session is not live",
        "O Maestro desta missão não está rodando. " +
          "Use Retomar no Quadro para religá-lo.",
      ],
      [
        "mission direct orchestrator authority is incomplete",
        "A missão não reconhece o terminal do Maestro. " +
          "Use «Religar a missão ao Maestro» no Quadro.",
      ],
      [
        "mission direct orchestrator authority mismatch: adapterId",
        "A missão não reconhece o terminal do Maestro. " +
          "Use «Religar a missão ao Maestro» no Quadro.",
      ],
      [
        "mission direct target requires sealed squad authority",
        "O agente escolhido não faz parte desta missão. Envie para @todos.",
      ],
      [
        "mission direct target squad authority is stale",
        "O agente escolhido não faz parte desta missão. Envie para @todos.",
      ],
      [
        "mission direct target agent is not in the sealed squad",
        "O agente escolhido não faz parte desta missão. Envie para @todos.",
      ],
      [
        "mission direct target is not an agent of this mission",
        "O agente escolhido não faz parte desta missão. Envie para @todos.",
      ],
      [
        "mission direct requires live current dispatch authority",
        "A missão está parada. Use Retomar no Quadro antes de orientar a equipe.",
      ],
      [
        "mission direct target is busy",
        "O Maestro está no meio de um turno. A orientação não foi enviada e " +
          "o texto continua no campo; tente quando ele terminar.",
      ],
    ];
    for (const [raw, expected] of cases) {
      expect(
        toUserFacingMissionError(
          new Error(`Error invoking remote method 'orch:mission.command': ${raw}`),
        ),
      ).toBe(expected);
    }
  });
});
