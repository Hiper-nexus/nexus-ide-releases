import { useEffect, useId, useRef, useState } from "react";
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
 * Pack may require a Landing/SaaS/Fix template when the plan has &lt;2
 * stories/tasks (`### Task N:` Superpowers ou `Story N.M` BMAD legado).
 */
export function OrchestrationModeDialog() {
  const pending = useOrchestrationModeStore((s) => s.pending);
  const decide = useOrchestrationModeStore((s) => s.decide);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [templateId, setTemplateId] = useState<WavePackTemplateId | "">("");
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!pending) {
      setTemplateId("");
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
      return;
    }

    if (
      restoreFocusRef.current === null &&
      document.activeElement instanceof HTMLElement &&
      !dialogRef.current?.contains(document.activeElement)
    ) {
      restoreFocusRef.current = document.activeElement;
    }

    setTemplateId(pending.templateRequiredForPack ? "landing" : "");
    primaryRef.current?.focus();
  }, [pending]);

  useEffect(
    () => () => {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    },
    [],
  );

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
              ? `${pending.storyCount} tasks em panes paralelos`
              : "Template declara o fan-out (Landing / SaaS / Fix)",
          primary: true,
        },
        {
          mode: "guided",
          label: "Guiado",
          hint: "Uma task por vez, cerca PREVC quando sensível",
          primary: false,
        },
      ]
    : [
        {
          mode: "guided",
          label: "Guiado",
          hint: "Uma task por vez, cerca PREVC quando sensível",
          primary: true,
        },
        {
          mode: "pack",
          label: "Wave Pack",
          hint:
            pending.storyCount >= 2
              ? `${pending.storyCount} tasks em panes paralelos`
              : "Template declara o fan-out (Landing / SaaS / Fix)",
          primary: false,
        },
      ];

  return (
    <div
      ref={dialogRef}
      className="confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          decide(null);
          return;
        }
        if (event.key !== "Tab") return;

        event.preventDefault();
        event.stopPropagation();
        const focusables = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (element) => element.getAttribute("aria-hidden") !== "true",
        );
        if (focusables.length === 0) {
          event.currentTarget.focus();
          return;
        }
        const currentIndex = focusables.indexOf(
          document.activeElement as HTMLElement,
        );
        const nextIndex = event.shiftKey
          ? currentIndex <= 0
            ? focusables.length - 1
            : currentIndex - 1
          : (currentIndex + 1) % focusables.length;
        focusables[nextIndex]?.focus();
      }}
    >
      <div className="confirm__overlay" onClick={() => decide(null)} />
      <div className="confirm__panel confirm__panel--orch-mode">
        <h3 id={titleId} className="confirm__title">
          {pending.title}
        </h3>
        <p id={descriptionId} className="confirm__body">
          {pending.body}
        </p>
        <div className="confirm__orch-choices" role="group" aria-label="Modo de execução">
          {choices.map((choice) => (
            <button
              key={choice.mode}
              ref={choice.primary ? primaryRef : undefined}
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
        <label className="confirm__orch-template">
          Template Pack (opcional se o plano já tem ≥2 tasks)
          <select
            className="confirm__orch-template-select"
            value={templateId}
            onChange={(e) =>
              setTemplateId((e.target.value || "") as WavePackTemplateId | "")
            }
            aria-required={pending.templateRequiredForPack}
          >
            {!pending.templateRequiredForPack ? (
              <option value="">Usar tasks do plano</option>
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
