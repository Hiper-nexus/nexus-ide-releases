import { useEffect, useRef, type ReactNode } from 'react';
import type { MissionReview } from '../../../shared/mission-engine-contract';
import type { MissionLane } from '../../../shared/mission-intent';
import { missionLanePresentation } from './mission-lane-presentation';

export type MissionPrepareStatus = 'idle' | 'loading' | 'ready' | 'error';
export type MissionStartStatus = 'idle' | 'loading' | 'error';

interface ReviewStepProps {
  review: MissionReview | null;
  lane: MissionLane;
  prepareStatus: MissionPrepareStatus;
  startStatus: MissionStartStatus;
  error: string | null;
  onBack(): void;
  onRetryPrepare(): void;
  onStart(): void;
}

const BEGINNER_TOOL_LABELS: Readonly<Partial<Record<string, string>>> = {
  Bash: 'Executar comandos',
  Read: 'Ler arquivos',
  Edit: 'Editar arquivos',
};

function allowedToolsCopy(
  values: readonly string[] | null | undefined,
): string {
  if (values === null || values === undefined) {
    return 'Sem lista restrita; este papel pode usar qualquer ferramenta disponível.';
  }
  if (values.length === 0) {
    return 'Nenhuma ferramenta autorizada para este papel.';
  }

  const labels: string[] = [];
  let additionalToolCount = 0;
  for (const tool of values) {
    const beginnerLabel = BEGINNER_TOOL_LABELS[tool];
    if (beginnerLabel) {
      labels.push(beginnerLabel);
    } else {
      additionalToolCount += 1;
    }
  }
  if (additionalToolCount > 0) {
    labels.push(
      additionalToolCount === 1
        ? '1 ferramenta técnica adicional'
        : `${additionalToolCount} ferramentas técnicas adicionais`,
    );
  }
  return `${labels.join(', ')}.`;
}

function allowedSkillsCopy(
  values: readonly string[] | null | undefined,
): string {
  if (values === null || values === undefined) {
    return 'Sem lista restrita; este papel pode usar qualquer habilidade disponível.';
  }
  if (values.length === 0) {
    return 'Nenhuma habilidade autorizada para este papel.';
  }
  return `${values.join(', ')}.`;
}

function AuthorityRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className="mission-setup__sr-only" aria-hidden="true">
          :{' '}
        </span>
        {children}
      </dd>
    </div>
  );
}

function CanonicalGrantValue({
  values,
}: {
  readonly values: readonly string[] | null | undefined;
}) {
  if (values === undefined) return <code>undefined</code>;
  return <code>{JSON.stringify(values)}</code>;
}

export function ReviewStep({
  review,
  lane,
  prepareStatus,
  startStatus,
  error,
  onBack,
  onRetryPrepare,
  onStart,
}: ReviewStepProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const statusText =
    startStatus === 'loading'
      ? 'Iniciando a missão com esta revisão…'
      : prepareStatus === 'loading'
        ? 'Preparando a revisão segura…'
        : prepareStatus === 'ready' && review
          ? 'Revisão pronta. Confira antes de iniciar.'
          : prepareStatus === 'error'
            ? 'A revisão precisa ser preparada novamente. O rascunho foi preservado.'
            : 'Aguardando a revisão.';
  const startDisabled =
    !review || prepareStatus !== 'ready' || startStatus === 'loading';
  const disabledReason =
    startStatus === 'loading'
      ? 'A missão já está sendo iniciada.'
      : !review || prepareStatus !== 'ready'
        ? 'A revisão precisa estar visível e atual antes de iniciar.'
        : null;
  const workerCount =
    review?.roster.filter((agent) => agent.category !== 'orchestrator').length ??
    0;
  const parallelism = Math.max(1, workerCount);
  const lanePresentation = missionLanePresentation(lane);

  return (
    <section className="mission-setup__step" aria-labelledby="mission-review-title">
      <header className="mission-setup__step-header">
        <p className="mission-setup__step-kicker">Revisar</p>
        <h1 id="mission-review-title" ref={headingRef} tabIndex={-1}>
          Confira antes de iniciar
        </h1>
        <p>
          Esta é a revisão produzida pelo processo principal. Iniciar usa
          exatamente o conteúdo mostrado aqui.
        </p>
      </header>

      <p
        id="mission-review-status"
        className="mission-setup__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
      </p>

      {error && (
        <div
          ref={errorRef}
          className="mission-setup__error-summary"
          role="alert"
          tabIndex={-1}
        >
          <strong>Não foi possível concluir esta etapa.</strong>
          <span>{error}</span>
          <span>
            Seu rascunho continua disponível. Use a ação oferecida para
            continuar.
          </span>
        </div>
      )}

      {prepareStatus === 'error' && !review && (
        <button
          type="button"
          className="mission-setup__button mission-setup__button--secondary"
          onClick={onRetryPrepare}
        >
          Preparar nova revisão
        </button>
      )}

      {review && (
        <div className="mission-review" aria-label="Revisão atual da missão">
          <section className="mission-setup__continuous-section">
            <h2>Entrega solicitada</h2>
            <h3>{review.title}</h3>
            <p className="mission-review__objective">{review.objective}</p>
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Projeto</h2>
            <p>{review.workspaceLabel}</p>
          </section>
          <section className="mission-setup__continuous-section mission-review__lane-summary">
            <h2>Tipo de trabalho</h2>
            <h3>{lanePresentation.label}</h3>
            <p>{lanePresentation.guidance}</p>
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Arquivos e referências</h2>
            {review.contextPaths.length > 0 ? (
              <ul className="mission-review__plain-list">
                {review.contextPaths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nenhum arquivo específico foi incluído.</p>
            )}
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Equipe</h2>
            <ul className="mission-review__team-list">
              {review.roster.map((agent) => (
                <li key={agent.id} className="mission-review__role-card">
                  <div className="mission-review__role-heading">
                    <strong>{agent.agentName}</strong>
                    <span>
                      {agent.category === 'orchestrator'
                        ? 'Coordena e revisa'
                        : agent.category === 'reviewer'
                          ? 'Verifica o resultado'
                          : agent.category === 'executor'
                            ? 'Implementa a entrega'
                            : 'Apoia a entrega'}
                    </span>
                  </div>
                  <dl className="mission-review__authority-list">
                    <AuthorityRow label="Instruções">
                      {agent.instructions?.trim()
                        ? agent.instructions
                        : 'Nenhuma instrução adicional foi fornecida.'}
                    </AuthorityRow>
                    <AuthorityRow label="Ferramentas permitidas">
                      {allowedToolsCopy(agent.allowedTools)}
                    </AuthorityRow>
                    <AuthorityRow label="Habilidades permitidas">
                      {allowedSkillsCopy(agent.allowedSkills)}
                    </AuthorityRow>
                  </dl>
                </li>
              ))}
            </ul>
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Permissões</h2>
            {review.permissions.length > 0 ? (
              <ul className="mission-review__detail-list">
                {review.permissions.map((permission) => (
                  <li key={permission.id}>
                    <strong>{permission.label}</strong>
                    {permission.detail && <span>{permission.detail}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nenhuma permissão adicional foi solicitada.</p>
            )}
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Riscos e avisos</h2>
            {review.warnings.length > 0 ? (
              <ul className="mission-review__warnings">
                {review.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p>Nenhum risco específico foi apontado.</p>
            )}
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Trabalho em paralelo</h2>
            <p>
              A equipe pode avançar em até {parallelism}{' '}
              {parallelism === 1 ? 'frente' : 'frentes'} ao mesmo tempo. Esta
              estimativa considera apenas os papéis da equipe.
            </p>
          </section>

          <details className="mission-setup__disclosure mission-setup__continuous-section">
            <summary>Avançado</summary>
            <dl className="mission-review__technical-list">
              <div>
                <dt>Tipo de trabalho (identificador exato)</dt>
                <dd><code>{lane}</code></dd>
              </div>
              <div>
                <dt>Identificador da missão</dt>
                <dd><code>{review.missionId}</code></dd>
              </div>
              <div>
                <dt>Identificador exato da revisão</dt>
                <dd><code>{review.reviewSha256}</code></dd>
              </div>
              <div>
                <dt>Revisão criada em</dt>
                <dd>{new Date(review.createdAt).toLocaleString('pt-BR')}</dd>
              </div>
              {review.roster.map((agent) => (
                <div key={agent.id}>
                  <dt>{agent.agentName}: autoridade exata</dt>
                  <dd className="mission-review__canonical-authority">
                    <span>
                      Papel: <code>{agent.id}</code>
                    </span>
                    <span>
                      Ferramentas:{' '}
                      <CanonicalGrantValue values={agent.allowedTools} />
                    </span>
                    <span>
                      Habilidades:{' '}
                      <CanonicalGrantValue values={agent.allowedSkills} />
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <ul className="mission-review__technical-team">
              {review.roster.map((agent) => (
                <li key={agent.id}>
                  <strong>{agent.agentName}</strong>
                  <span>
                    {agent.cli}
                    {agent.model ? ` · ${agent.model}` : ''}
                    {agent.effort ? ` · esforço ${agent.effort}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <footer className="mission-setup__step-actions">
        <button
          type="button"
          className="mission-setup__button mission-setup__button--secondary"
          onClick={onBack}
          disabled={startStatus === 'loading'}
          aria-describedby={
            startStatus === 'loading' ? 'mission-review-status' : undefined
          }
        >
          Voltar para equipe
        </button>
        <button
          type="button"
          className="mission-setup__button mission-setup__button--primary mission-setup__button--start"
          onClick={onStart}
          disabled={startDisabled}
          aria-describedby={
            disabledReason ? 'mission-start-disabled-reason' : undefined
          }
        >
          {startStatus === 'loading' ? 'Iniciando missão…' : 'Iniciar missão'}
        </button>
      </footer>
      <p
        id="mission-start-disabled-reason"
        className="mission-setup__hint mission-setup__disabled-reason"
      >
        {disabledReason}
      </p>
    </section>
  );
}
