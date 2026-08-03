import { useEffect, useRef, useState } from "react";
import {
  useOrchestrationModeStore,
  type PromoteOrchestrationChoice,
} from "../state/orchestration-mode-store";
import {
  WAVE_PACK_TEMPLATES,
  type WavePackTemplateId,
} from "../../shared/wave-pack-templates";

/**
 * Pack vs Guiado before ▶ Executar plano. Escape = cancel (no promote).
 * Pack may require a Landing/SaaS/Fix template when the plan has &lt;2 BMAD stories.
 */
export function OrchestrationModeDialog() {
  const pending = useOrchestrationModeStore((s) => s.pending);
  const decide = useOrchestrationModeStore((s) => s.decide);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const secondaryRef = useRef<HTMLButtonElement>(null);
  const [templateId, setTemplateId] = useState<WavePackTemplateId | "">("");

  useEffect(() => {
    if (!pending) {
      setTemplateId("");
      return undefined;
    }
    setTemplateId(pending.templateRequiredForPack ? "landing" : "");
    const preferred =
      pending.recommended === "pack" ? primaryRef.current : secondaryRef.current;
    preferred?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        decide(null);
        return;
      }
      if (e.key !== "Tab") return;
      e.preventDefault();
      const focusables = [cancelRef.current, secondaryRef.current, primaryRef.current]
        .filter((el): el is HTMLButtonElement => Boolean(el));
      if (focusables.length === 0) return;
      const active = document.activeElement;
      const idx = focusables.findIndex((el) => el === active);
      const next = e.shiftKey
        ? focusables[(idx <= 0 ? focusables.length : idx) - 1]!
        : focusables[(idx + 1) % focusables.length]!;
      next.focus();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [pending, decide]);

  if (!pending) return null;

  const packFirst = pending.recommended === "pack";
  const pick = (mode: PromoteOrchestrationChoice) => {
    if (mode === "pack" && pending.templateRequiredForPack && !templateId) {
      return;
    }
    decide({
      mode,
      ...(mode === "pack" && templateId
        ? { wavePackTemplateId: templateId }
        : {}),
    });
  };
  const packBlocked =
    pending.templateRequiredForPack && templateId === "";

  const choices: Array<{
    mode: PromoteOrchestrationChoice;
    label: string;
    hint: string;
    primary: boolean;
  }> = packFirst
    ? [
        {
          mode: "pack",
          label: "Wave Pack",
          hint:
            pending.storyCount >= 2
              ? `${pending.storyCount} stories em panes paralelos`
              : "Template declara o fan-out (Landing / SaaS / Fix)",
          primary: true,
        },
        {
          mode: "guided",
          label: "Guiado",
          hint: "Uma story por vez, cerca PREVC quando sensível",
          primary: false,
        },
      ]
    : [
        {
          mode: "guided",
          label: "Guiado",
          hint: "Uma story por vez, cerca PREVC quando sensível",
          primary: true,
        },
        {
          mode: "pack",
          label: "Wave Pack",
          hint:
            pending.storyCount >= 2
              ? `${pending.storyCount} stories em panes paralelos`
              : "Template declara o fan-out (Landing / SaaS / Fix)",
          primary: false,
        },
      ];

  return (
    <div
      className="confirm"
      role="dialog"
      aria-modal="true"
      aria-label={pending.title}
    >
      <div className="confirm__overlay" onClick={() => decide(null)} />
      <div className="confirm__panel confirm__panel--orch-mode">
        <h3 className="confirm__title">{pending.title}</h3>
        <p className="confirm__body">{pending.body}</p>
        <div className="confirm__orch-choices" role="group" aria-label="Modo de execução">
          {choices.map((choice) => (
            <button
              key={choice.mode}
              ref={choice.primary ? primaryRef : secondaryRef}
              type="button"
              className={`confirm__orch-choice${
                choice.primary ? " confirm__orch-choice--recommended" : ""
              }`}
              disabled={choice.mode === "pack" && packBlocked}
              title={
                choice.mode === "pack" && packBlocked
                  ? "Escolha um template Pack antes de continuar"
                  : undefined
              }
              onClick={() => pick(choice.mode)}
            >
              <span className="confirm__orch-choice-label">
                {choice.label}
                {choice.primary ? (
                  <span className="confirm__orch-choice-badge">Recomendado</span>
                ) : null}
              </span>
              <span className="confirm__orch-choice-hint">{choice.hint}</span>
            </button>
          ))}
        </div>
        <label className="confirm__body" style={{ display: "block", marginTop: 12 }}>
          Template Pack (opcional se o plano já tem ≥2 stories)
          <select
            className="wizard__input"
            style={{ display: "block", width: "100%", marginTop: 6 }}
            value={templateId}
            onChange={(e) =>
              setTemplateId((e.target.value || "") as WavePackTemplateId | "")
            }
            aria-required={pending.templateRequiredForPack}
          >
            {!pending.templateRequiredForPack ? (
              <option value="">Usar stories do plano</option>
            ) : null}
            {WAVE_PACK_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label} — {template.hint}
              </option>
            ))}
          </select>
        </label>
        <div className="confirm__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm__btn"
            onClick={() => decide(null)}
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
