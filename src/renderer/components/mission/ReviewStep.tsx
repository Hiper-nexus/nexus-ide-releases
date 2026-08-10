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
  backLabel?: string;
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
  backLabel = 'Voltar para equipe',
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
        <p className="mission-setup__step-kicker">Etapa 3 · Revisar</p>
        <h1 id="mission-review-title" ref={headingRef} tabIndex={-1}>
          Revisar e iniciar
        </h1>
        <p>
          Confira o resumo abaixo. Iniciar usa exatamente este conteúdo — dá
          para ajustar tudo depois.
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
          data-nexus-real-mission-wizard-launch="prepare"
          className="mission-setup__button mission-setup__button--secondary"
          onClick={onRetryPrepare}
        >
          Preparar nova revisão
        </button>
      )}

      {review && (
        <div className="mission-review" aria-label="Revisão atual da missão">
          <section className="mission-setup__continuous-section mission-review__brief">
            <h2>Entrega solicitada</h2>
            <h3 className="mission-review__brief-title">{review.title}</h3>
            <p className="mission-review__objective">{review.objective}</p>
          </section>

          <dl className="mission-review__briefing">
            <div className="mission-review__brief-row">
              <dt>Pasta</dt>
              <dd><code>{review.workspaceLabel}</code></dd>
            </div>
            <div className="mission-review__brief-row">
              <dt>Equipe</dt>
              <dd>
                {review.roster.length}{' '}
                {review.roster.length === 1 ? 'papel' : 'papéis'} ·{' '}
                {review.roster
                  .filter((agent) => agent.category === 'orchestrator')
                  .length}{' '}
                coordenação · {workerCount}{' '}
                {workerCount === 1 ? 'execução' : 'execuções'}
              </dd>
            </div>
            <div className="mission-review__brief-row">
              <dt>Modo</dt>
              <dd>
                {lanePresentation.label} — {lanePresentation.guidance}
              </dd>
            </div>
            <div className="mission-review__brief-row">
              <dt>Paralelo</dt>
              <dd>
                até {parallelism} {parallelism === 1 ? 'frente' : 'frentes'} ao
                mesmo tempo
              </dd>
            </div>
            <div className="mission-review__brief-row">
              <dt>Contexto</dt>
              <dd>
                {review.contextPaths.length > 0 ? (
                  <span className="mission-review__chips">
                    {review.contextPaths.map((path) => (
                      <code key={path}>{path}</code>
                    ))}
                  </span>
                ) : (
                  'Nenhum arquivo específico'
                )}
              </dd>
            </div>
            {review.acceptanceCriteria &&
              review.acceptanceCriteria.length > 0 && (
                <div className="mission-review__brief-row">
                  <dt>Pronto quando</dt>
                  <dd>
                    <ul className="mission-review__plain-list">
                      {review.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            {review.permissions.length > 0 && (
              <div className="mission-review__brief-row">
                <dt>Permissões</dt>
                <dd>
                  <ul className="mission-review__plain-list">
                    {review.permissions.map((permission) => (
                      <li key={permission.id}>
                        {permission.label}
                        {permission.detail ? ` — ${permission.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {review.warnings.length > 0 && (
              <div className="mission-review__brief-row mission-review__brief-row--warn">
                <dt>Atenção</dt>
                <dd>
                  <ul className="mission-review__warnings">
                    {review.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {review.attachments && review.attachments.length > 0 && (
              <div className="mission-review__brief-row">
                <dt>Anexos</dt>
                <dd>
                  <ul className="mission-review__detail-list">
                    {review.attachments.map((attachment) => (
                      <li key={`${attachment.path}:${attachment.sha256}`}>
                        <strong>
                          {attachment.path.split(/[\\/]/u).at(-1) ??
                            attachment.path}
                        </strong>
                        <span>
                          Caminho revisado: <code>{attachment.path}</code>
                        </span>
                        <span>
                          SHA-256: <code>{attachment.sha256}</code>
                        </span>
                        <span>Tamanho: {attachment.size} bytes</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>

          <section className="mission-setup__continuous-section">
            <h2>Equipe</h2>
            <ul className="mission-review__team-list">
              {review.roster.map((agent) => (
                <li key={agent.id} className="mission-review__role-card">
                  <div className="mission-review__role-heading">
                    <span
                      className="mission-review__role-avatar"
                      aria-hidden="true"
                      data-category={agent.category}
                    >
                      {agent.category === 'orchestrator'
                        ? '♛'
                        : agent.category === 'reviewer'
                          ? '◎'
                          : agent.category === 'scout'
                            ? '⌕'
                            : agent.category === 'architect'
                              ? '⬡'
                              : '⚒'}
                    </span>
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
                    <span className="mission-review__role-tool">
                      {agent.cli}
                      {agent.model ? ` · ${agent.model}` : ''}
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
          {backLabel}
        </button>
        <button
          type="button"
          data-nexus-real-mission-wizard-launch="start"
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
