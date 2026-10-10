import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MissionReview } from '../../../shared/mission-engine-contract';
import type { MissionLane } from '../../../shared/mission-intent';
import { missionLanePresentation } from './mission-lane-presentation';

export const REVIEW_BRIEF_EXCERPT_CHARS = 140;

export function collapseReviewText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function reviewBriefBody(title: string, objective: string): string {
  const titleText = collapseReviewText(title);
  const objectiveText = collapseReviewText(objective);
  if (!titleText) return objectiveText;
  if (!objectiveText) return titleText;
  if (objectiveText === titleText || objectiveText.startsWith(titleText)) {
    return objectiveText;
  }
  if (titleText.startsWith(objectiveText)) return titleText;
  return objectiveText;
}

export function excerptReviewText(
  value: string,
  max = REVIEW_BRIEF_EXCERPT_CHARS,
): string {
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const broken = slice.replace(/\s+\S*$/u, '').trim();
  return `${broken || slice}…`;
}

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

/**
 * F-1157 (doutrina do dono, 10/10/2026): todo agente da missão alcança toda
 * ferramenta e habilidade. As listas do roster continuam no selo como
 * registro, mas não restringem — a aprovação não pode prometer limite que
 * não existe. Só o modo Hardened, quando o operador o escolhe, confina a
 * leitura de quem revisa.
 */
const OPEN_TOOLS_COPY = 'Todas as ferramentas do Nexus e da CLI.';
const OPEN_SKILLS_COPY = 'Todas as habilidades instaladas.';

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

function GlanceCard({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="mission-review__glance-card">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
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
  const [briefOpen, setBriefOpen] = useState(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    setBriefOpen(false);
  }, [review?.reviewSha256]);

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
  const pendingCopy =
    prepareStatus === 'loading' || startStatus === 'loading'
      ? 'Montando o resumo da missão — objetivo, equipe, contexto e permissões.'
      : prepareStatus === 'error'
        ? 'A revisão não está visível. O rascunho foi preservado; prepare de novo para ver o resumo e iniciar.'
        : 'A revisão ainda não está visível. Volte para a equipe ou aguarde o resumo aparecer.';

  const briefBody = review
    ? reviewBriefBody(review.title, review.objective)
    : '';
  const briefNeedsToggle = briefBody.length > REVIEW_BRIEF_EXCERPT_CHARS;
  const briefShown =
    briefOpen || !briefNeedsToggle ? briefBody : excerptReviewText(briefBody);
  const coordinatorCount =
    review?.roster.filter((agent) => agent.category === 'orchestrator').length ??
    0;

  return (
    <section
      className="mission-setup__step mission-setup__step--review"
      aria-labelledby="mission-review-title"
    >
      <div className="mission-setup__step-scroll">
        <header className="mission-setup__step-header">
        <p className="mission-setup__step-kicker">Etapa 3 · Revisar</p>
        <h1 id="mission-review-title" ref={headingRef} tabIndex={-1}>
          Revisar e iniciar
        </h1>
        <p>Resumo da missão. Iniciar usa exatamente isto — dá para ajustar depois.</p>
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

      {!review && (
        <div
          className="mission-review mission-review--pending"
          role="region"
          aria-label="Estado da revisão"
        >
          <p>{pendingCopy}</p>
          {prepareStatus === 'error' && (
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onRetryPrepare}
            >
              Preparar nova revisão
            </button>
          )}
        </div>
      )}

      {review && (
        <div className="mission-review" aria-label="Revisão atual da missão">
          <dl className="mission-review__glance">
            <GlanceCard label="Entrega">{review.title}</GlanceCard>
            <GlanceCard label="Equipe">
              {review.roster.length}{' '}
              {review.roster.length === 1 ? 'papel' : 'papéis'} ·{' '}
              {coordinatorCount} coordenação · {workerCount}{' '}
              {workerCount === 1 ? 'execução' : 'execuções'}
            </GlanceCard>
            <GlanceCard label="Modo">{lanePresentation.label}</GlanceCard>
            <GlanceCard label="Pasta">
              <code>{review.workspaceLabel}</code>
            </GlanceCard>
          </dl>

          <section className="mission-setup__continuous-section mission-review__brief">
            <h2>Entrega solicitada</h2>
            <div
              className={
                briefOpen
                  ? 'mission-review__brief-body mission-review__brief-body--open'
                  : 'mission-review__brief-body'
              }
            >
              <p className="mission-review__objective">{briefShown}</p>
            </div>
            {briefNeedsToggle && (
              <button
                type="button"
                className="mission-review__brief-toggle"
                onClick={() => setBriefOpen((open) => !open)}
              >
                {briefOpen ? 'Fechar' : 'Ler tudo'}
              </button>
            )}
          </section>

          <section className="mission-setup__continuous-section">
            <h2>Equipe</h2>
            <p className="mission-review__team-meta">
              até {parallelism} {parallelism === 1 ? 'frente' : 'frentes'} ao
              mesmo tempo
            </p>
            <ul className="mission-review__team-chips">
              {review.roster.map((agent) => (
                <li key={agent.id}>
                  <strong>{agent.agentName}</strong>
                  <span>
                    {agent.cli}
                    {agent.model ? ` · ${agent.model}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <details className="mission-review__team-details">
              <summary>Ver equipe</summary>
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
                    <AuthorityRow label="Ferramentas">
                      {OPEN_TOOLS_COPY}
                    </AuthorityRow>
                    <AuthorityRow label="Habilidades">
                      {OPEN_SKILLS_COPY}
                    </AuthorityRow>
                  </dl>
                </li>
              ))}
              </ul>
            </details>
          </section>

          {review.contextPaths.length > 0 && (
            <p className="mission-review__context-line">
              Contexto:{' '}
              <span className="mission-review__chips">
                {review.contextPaths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </span>
            </p>
          )}

          {review.warnings.length > 0 && (
            <div className="mission-review__brief-row mission-review__brief-row--warn">
              <p className="mission-review__warn-label">Atenção</p>
              <ul className="mission-review__warnings">
                {review.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <details className="mission-setup__disclosure mission-setup__continuous-section">
              <summary>Mais detalhes</summary>
              <p className="mission-review__mode-guidance">
                {lanePresentation.guidance}
              </p>
              <dl className="mission-review__briefing">
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
            </details>

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
                  <dt>{agent.agentName}: concessões registradas no selo (não restringem o acesso)</dt>
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
      </div>

      <div className="mission-setup__step-dock">
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
      </div>
    </section>
  );
}
