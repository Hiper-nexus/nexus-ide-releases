import {
  PANE_ROUTE_EFFORTS,
  paneRouteEffortLabel,
  paneRouteSummary,
  type PaneRouteEffort,
  type PaneRouteProposal,
} from '../../shared/pane-route';

/**
 * Passo de confirmação do "+ Pane": mostra o que o motor propôs e deixa o
 * operador mudar o ESFORÇO antes do pane nascer.
 *
 * Existe porque o pane aberto na mão nascia sempre no padrão do provider: o
 * esforço era decidido em 70% das rotas de missão e nunca chegava aqui. O
 * passo também diz QUEM decidiu — sem isso o revezamento por fair-share e
 * diversidade lê como sorteio.
 *
 * Só aparece quando o operador digitou um pedido. Sem pedido não há o que
 * classificar, e o "+ Pane" segue exatamente como sempre foi.
 */

export type PaneRouteConfirmState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly proposal: PaneRouteProposal }
  /** Sem chave, superfície desligada ou erro: o passo some, não trava nada. */
  | { readonly kind: 'none' };

type Props = {
  state: PaneRouteConfirmState;
  /** CLI que o operador escolheu na lista — ela manda, o motor não a troca. */
  adapterLabel: string;
  /** `undefined` = a CLI decide (sem `--effort`). */
  effort: PaneRouteEffort | undefined;
  onEffortChange: (effort: PaneRouteEffort | undefined) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

const EFFORT_CHOICES: readonly (PaneRouteEffort | undefined)[] = [
  undefined,
  ...PANE_ROUTE_EFFORTS,
];

export function PaneRouteConfirm({
  state,
  adapterLabel,
  effort,
  onEffortChange,
  onConfirm,
  onCancel,
}: Props) {
  const proposal = state.kind === 'ready' ? state.proposal : null;

  return (
    <section
      className="pane-route-confirm"
      role="group"
      aria-label={`Confirmar abertura em ${adapterLabel}`}
    >
      <header className="pane-route-confirm__head">
        <span className="pane-route-confirm__cli">{adapterLabel}</span>
        {state.kind === 'loading' ? (
          <span className="pane-route-confirm__note" role="status">
            Lendo o pedido…
          </span>
        ) : proposal ? (
          <span className="pane-route-confirm__note">{paneRouteSummary(proposal)}</span>
        ) : (
          <span className="pane-route-confirm__note">Sem proposta — a CLI decide</span>
        )}
      </header>

      <div className="pane-route-confirm__row">
        <span id="pane-route-effort-label" className="pane-route-confirm__label">
          Esforço
        </span>
        <div
          className="pane-route-confirm__efforts"
          role="radiogroup"
          aria-labelledby="pane-route-effort-label"
        >
          {EFFORT_CHOICES.map((choice) => {
            const selected = choice === effort;
            return (
              <button
                key={choice ?? 'cli'}
                type="button"
                role="radio"
                aria-checked={selected}
                className={
                  selected
                    ? 'pane-route-confirm__effort pane-route-confirm__effort--on'
                    : 'pane-route-confirm__effort'
                }
                onClick={() => onEffortChange(choice)}
              >
                {paneRouteEffortLabel(choice)}
              </button>
            );
          })}
        </div>
      </div>

      {proposal?.skill ? (
        <p className="pane-route-confirm__skill">
          Skill sugerida: <strong>{proposal.skill}</strong>
        </p>
      ) : null}

      <footer className="pane-route-confirm__actions">
        <button type="button" className="pane-route-confirm__cancel" onClick={onCancel}>
          Voltar
        </button>
        <button type="button" className="pane-route-confirm__go" onClick={onConfirm}>
          Abrir
        </button>
      </footer>
    </section>
  );
}

/**
 * Esforço inicial do passo: o proposto, quando houver. `undefined` mantém o
 * comportamento de sempre (a CLI decide) — nunca inventa um nível.
 */
export function initialEffort(state: PaneRouteConfirmState): PaneRouteEffort | undefined {
  return state.kind === 'ready' ? state.proposal.effort : undefined;
}
