import { useEffect, useRef, useState } from 'react';
import { OverlayLayer } from '../../overlay/overlay-layer';

/**
 * Overlay "preparando missão" — do clique em iniciar até a missão estar
 * rodando ou falhar (DESIGN.md §2 camada de overlay, §4 motion, §11
 * continuidade). Console de boot em VT323: um toque de pixel por tela, a
 * pegada de dev pedida pelo operador. As mensagens refletem a fase REAL do
 * motor quando ela existe (revisão → start) e caem na rotação genérica quando
 * não existe. Nada de timer falso: quem abre e fecha é o estado do fluxo em
 * `MissionSetup`.
 */

export type MissionPrepPhase = 'prepare' | 'start' | null;

/** Rotação em ms — mesma cadência do pulso vivo da camada (§4). */
export const MISSION_PREP_MESSAGE_INTERVAL_MS = 2200;
/**
 * Atraso de entrada: um start que resolve rápido não pode piscar a tela
 * inteira (o operador já convive com flicker em outro ponto). Só acende
 * depois que a espera é real; erro não espera.
 */
export const MISSION_PREP_SHOW_DELAY_MS = 400;

export const MISSION_PREP_MESSAGES: Record<
  Exclude<MissionPrepPhase, null>,
  readonly string[]
> = {
  prepare: [
    'carimbando a revisão segura…',
    'empacotando o contexto…',
    'conferindo as permissões…',
    'lendo o rascunho com calma…',
  ],
  start: [
    'acordando o coordenador…',
    'criando a worktree…',
    'preparando o código…',
    'compilando ideias…',
    'alinhando os agentes…',
  ],
};

export const MISSION_PREP_GENERIC_MESSAGES: readonly string[] = [
  'preparando o código…',
  'compilando ideias…',
  'achando o ponto e vírgula perdido…',
  'alinhando os agentes…',
  'delegando com carinho…',
  'respirando fundo…',
];

interface MissionPrepOverlayProps {
  /** Verdadeiro enquanto o fluxo de criação está em voo (ou falhou em tela). */
  open: boolean;
  /** Fase real do motor, quando o fluxo conhece; `null` roda a lista genérica. */
  phase?: MissionPrepPhase;
  /** Mensagem humanizada; presente, o overlay para de girar e vira erro. */
  error?: string | null;
  /** Carregar em segundo plano (loading) / voltar ao formulário (erro). */
  onDismiss(): void;
  /** Erro: tentar a etapa de novo. */
  onRetry(): void;
}

export function MissionPrepOverlay({
  open,
  phase = null,
  error = null,
  onDismiss,
  onRetry,
}: MissionPrepOverlayProps) {
  const [shown, setShown] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Entrada atrasada no loading (anti-flicker); erro acende na hora.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    if (error) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), MISSION_PREP_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, error]);

  const messages = phase ? MISSION_PREP_MESSAGES[phase] : MISSION_PREP_GENERIC_MESSAGES;
  const message = messages[messageIndex % messages.length] ?? messages[0];

  // Troca de fase recomeça a rotação do começo (a primeira mensagem da fase
  // explica a etapa que acabou de entrar).
  useEffect(() => {
    setMessageIndex(0);
  }, [phase]);

  useEffect(() => {
    if (!open || error) return;
    const timer = setInterval(() => {
      setMessageIndex((index) => (index + 1) % messages.length);
    }, MISSION_PREP_MESSAGE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, error, messages]);

  const failed = Boolean(error);

  // O painel recebe o foco para o Esc funcionar e o leitor de tela ancorar.
  useEffect(() => {
    if (shown) panelRef.current?.focus();
  }, [shown, failed]);

  if (!open || !shown) return null;

  return (
    <OverlayLayer>
      <div className="mission-prep-overlay__backdrop overlay-scrim-enter">
        <div
          ref={panelRef}
          className="mission-prep-overlay overlay-enter"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mission-prep-overlay-title"
          aria-busy={!failed}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onDismiss();
            }
          }}
        >
          {failed ? (
            <>
              <h2 id="mission-prep-overlay-title" className="mission-prep-overlay__title">
                Não deu para iniciar a missão
              </h2>
              <p role="alert" className="mission-prep-overlay__error">
                {error}
              </p>
              <p className="mission-prep-overlay__hint">
                Seu pedido continua salvo — nada se perdeu.
              </p>
              <div className="mission-prep-overlay__actions">
                <button
                  type="button"
                  className="mission-setup__button mission-setup__button--primary"
                  onClick={onRetry}
                >
                  Tentar de novo
                </button>
                <button
                  type="button"
                  className="mission-setup__button"
                  onClick={onDismiss}
                >
                  Voltar
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="mission-prep-overlay-title" className="mission-prep-overlay__title">
                Preparando a missão
              </h2>
              <p className="mission-prep-overlay__console" aria-live="polite">
                <span className="mission-prep-overlay__prompt" aria-hidden="true">
                  &gt;{' '}
                </span>
                <span key={message} className="mission-prep-overlay__message">
                  {message}
                </span>
                <span className="mission-prep-overlay__cursor" aria-hidden="true">
                  ▮
                </span>
              </p>
              <div
                className="mission-prep-overlay__track"
                aria-hidden="true"
              >
                <div className="mission-prep-overlay__runner" />
              </div>
              <div className="mission-prep-overlay__actions">
                <button
                  type="button"
                  className="mission-setup__button"
                  onClick={onDismiss}
                >
                  Continuar em segundo plano
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </OverlayLayer>
  );
}
