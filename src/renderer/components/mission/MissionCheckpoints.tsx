import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  MissionCheckpointEntryView,
  MissionCheckpointPlanView,
  MissionCheckpointScopeView,
} from '../../../shared/mission-checkpoints';

/**
 * F-1173 — pontos de restauração dos writers em "O que mudou".
 *
 * O Nexus grava um checkpoint oculto no fim de cada turno de writer, mas só
 * um agente via MCP conseguia ver e restaurar. Aqui a pessoa vê, por árvore
 * (branch e pasta da worktree), cada turno com data e arquivos, e restaura um
 * com confirmação em linha. O texto da confirmação diz o que
 * `restoreHiddenCheckpoint` faz de verdade: guarda o estado atual antes,
 * sobrescreve/cria só os arquivos do checkpoint, não apaga nada, não mexe em
 * branch/HEAD/índice e recusa se um agente estiver trabalhando na árvore.
 */

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: string }
  | { readonly kind: 'ready'; readonly scopes: readonly MissionCheckpointScopeView[] };

/** Plano mostrado + a impressão que a restauração exige (F-1173, TOCTOU). */
interface ShownPlan {
  readonly plan: MissionCheckpointPlanView;
  readonly fingerprint: string;
}

type ConfirmState =
  | { readonly kind: 'previewing'; readonly ref: string }
  | ({ readonly kind: 'ready'; readonly ref: string } & ShownPlan)
  | ({ readonly kind: 'restoring'; readonly ref: string } & ShownPlan)
  | { readonly kind: 'failed'; readonly ref: string; readonly error: string; readonly stale?: boolean };

type Outcome =
  | { readonly kind: 'restored'; readonly ref: string; readonly overwritten: number; readonly created: number }
  | { readonly kind: 'unchanged'; readonly ref: string };

const MAX_FILES_SHOWN = 8;

function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function checkpointTitle(entry: MissionCheckpointEntryView): string {
  if (entry.kind === 'backup') return 'Cópia de segurança (antes de uma restauração)';
  if (entry.kind === 'turn') return entry.writer ? `Fim do turno de ${entry.writer}` : 'Fim de um turno de writer';
  return `Checkpoint ${entry.ordinal}`;
}

function formatWhen(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 'data desconhecida';
  return new Date(createdAt).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function FileSummary({ entry }: { readonly entry: MissionCheckpointEntryView }) {
  const { files, total } = entry.changed;
  if (total === 0) {
    return <p className="mission-checkpoints__files-empty">Nenhum arquivo diferente da branch naquele momento.</p>;
  }
  const shown = files.slice(0, MAX_FILES_SHOWN);
  const hidden = total - shown.length;
  return (
    <details className="mission-checkpoints__files">
      <summary>{plural(total, 'arquivo', 'arquivos')}</summary>
      <ul>
        {shown.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      {hidden > 0 ? <p className="mission-checkpoints__more">e mais {hidden}</p> : null}
    </details>
  );
}

function RestoreConfirmation({
  scope,
  state,
  onConfirm,
  onCancel,
  onRepreview,
}: {
  readonly scope: MissionCheckpointScopeView;
  readonly state: ConfirmState;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onRepreview: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ready = state.kind === 'ready';
  // Foco no lado seguro: Enter repetido nunca cai em "Restaurar agora".
  useEffect(() => {
    if (ready) cancelRef.current?.focus();
  }, [ready]);
  const plan = state.kind === 'ready' || state.kind === 'restoring' ? state.plan : null;
  const where = scope.branch
    ? `na worktree ${folderName(scope.root)} (branch ${scope.branch})`
    : `na worktree ${folderName(scope.root)}`;

  return (
    <div className="mission-checkpoints__confirm" role="group" aria-labelledby={titleId}>
      <p id={titleId} className="mission-checkpoints__confirm-title">
        Restaurar este checkpoint?
      </p>
      {state.kind === 'previewing' ? (
        <p role="status">Conferindo o que muda…</p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="mission-checkpoints__error" role="alert">
          Não foi possível restaurar: {state.error}
        </p>
      ) : null}
      {plan ? (
        <p className="mission-checkpoints__plan">
          {plural(plan.overwrite.total, 'arquivo será sobrescrito', 'arquivos serão sobrescritos')} e{' '}
          {plural(plan.create.total, 'será criado', 'serão criados')} {where}.
          {plan.conflicts.total > 0
            ? ` ${plural(plan.conflicts.total, 'caminho bloqueado', 'caminhos bloqueados')} por pasta ou atalho não será escrito.`
            : ''}
        </p>
      ) : null}
      <ul className="mission-checkpoints__consequences">
        <li>
          Antes de escrever, o Nexus guarda o estado atual desta worktree como um checkpoint novo — para
          desfazer, restaure esse checkpoint.
        </li>
        <li>
          Os arquivos do checkpoint substituem as versões atuais no disco. Arquivos criados depois ficam
          como estão: nada é apagado. Branch, HEAD e índice do Git não mudam.
        </li>
        <li>
          Alterações não salvas no editor não estão no disco: não entram na cópia de segurança e o
          editor fica diferente do arquivo restaurado.
        </li>
        <li>Se algum agente estiver trabalhando nesta worktree, a restauração é recusada.</li>
        <li>
          Se a worktree ou o checkpoint mudarem depois desta prévia, a restauração é recusada sem
          escrever nada e pede uma prévia nova.
        </li>
      </ul>
      <div className="mission-checkpoints__confirm-actions">
        {state.kind === 'failed' && state.stale ? (
          <button type="button" className="mission-checkpoints__button" onClick={onRepreview}>
            Ver a prévia de novo
          </button>
        ) : (
          <button
            type="button"
            className="mission-checkpoints__button mission-checkpoints__button--danger"
            disabled={state.kind !== 'ready'}
            onClick={onConfirm}
          >
            {state.kind === 'restoring' ? 'Restaurando…' : 'Restaurar agora'}
          </button>
        )}
        <button
          ref={cancelRef}
          type="button"
          className="mission-checkpoints__button"
          disabled={state.kind === 'restoring'}
          onClick={onCancel}
        >
          {state.kind === 'failed' ? 'Fechar' : 'Cancelar'}
        </button>
      </div>
    </div>
  );
}

/**
 * `collapsible`: missão em curso, dentro da Atividade — uma linha com a
 * contagem que abre a lista, sem empurrar a timeline (F-1005: ela é a única
 * rolagem do painel). `refreshKey` muda quando um writer entrega: a lista é
 * relida em silêncio (sem "Carregando…" nem fechar a confirmação aberta).
 */
export function MissionCheckpoints({
  missionId,
  collapsible = false,
  refreshKey = 0,
}: {
  readonly missionId: string;
  readonly collapsible?: boolean;
  readonly refreshKey?: number;
}) {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const alive = useRef(true);
  const missionRef = useRef(missionId);
  missionRef.current = missionId;

  const load = useCallback(async (quiet = false) => {
    const forMission = missionId;
    if (!quiet) setList({ kind: 'loading' });
    try {
      const result = await window.nexus.orch.listMissionCheckpoints({ missionId: forMission });
      if (!alive.current || missionRef.current !== forMission) return;
      setList(result.ok ? { kind: 'ready', scopes: result.scopes } : { kind: 'error', error: result.error });
    } catch (error) {
      if (!alive.current || missionRef.current !== forMission) return;
      setList({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }, [missionId]);

  // Writer entregou de novo: relê sem apagar a lista nem a confirmação.
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    void load(true);
  }, [load, refreshKey]);

  useEffect(() => {
    alive.current = true;
    setConfirm(null);
    setOutcome(null);
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const askRestore = async (ref: string) => {
    setOutcome(null);
    setConfirm({ kind: 'previewing', ref });
    try {
      const preview = await window.nexus.orch.previewMissionCheckpoint({ missionId, ref });
      if (!alive.current) return;
      setConfirm((current) => {
        if (current?.ref !== ref) return current;
        return preview.ok
          ? { kind: 'ready', ref, plan: preview, fingerprint: preview.fingerprint }
          : { kind: 'failed', ref, error: preview.error };
      });
    } catch (error) {
      if (!alive.current) return;
      setConfirm({ kind: 'failed', ref, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const restore = async () => {
    if (confirm?.kind !== 'ready') return;
    const { ref, plan, fingerprint } = confirm;
    setConfirm({ kind: 'restoring', ref, plan, fingerprint });
    try {
      const result = await window.nexus.orch.restoreMissionCheckpoint({ missionId, ref, fingerprint });
      if (!alive.current) return;
      if (!result.ok) {
        setConfirm({ kind: 'failed', ref, error: result.error, stale: result.stale === true });
        return;
      }
      setConfirm(null);
      setOutcome(
        result.applied
          ? { kind: 'restored', ref, overwritten: result.overwrite.total, created: result.create.total }
          : { kind: 'unchanged', ref },
      );
      void load(true);
    } catch (error) {
      if (!alive.current) return;
      setConfirm({ kind: 'failed', ref, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const scopes = list.kind === 'ready' ? list.scopes : [];
  const total = scopes.reduce((sum, scope) => sum + scope.checkpoints.length, 0);

  const body = (
    <>
      {outcome ? (
        <p className="mission-checkpoints__outcome" role="status">
          {outcome.kind === 'restored'
            ? `Restaurado: ${plural(outcome.overwritten, 'arquivo sobrescrito', 'arquivos sobrescritos')} e ${plural(outcome.created, 'criado', 'criados')}. O estado anterior foi guardado como checkpoint novo.`
            : 'Nada a restaurar: a worktree já está igual a este checkpoint.'}
        </p>
      ) : null}
      {list.kind === 'loading' ? <p className="mission-checkpoints__hint">Carregando checkpoints…</p> : null}
      {list.kind === 'error' ? (
        <div className="mission-checkpoints__error" role="alert">
          <p>Não foi possível ler os checkpoints: {list.error}</p>
          <button type="button" className="mission-checkpoints__button" onClick={() => void load()}>
            Tentar de novo
          </button>
        </div>
      ) : null}
      {list.kind === 'ready' && total === 0 && scopes.every((scope) => !scope.unavailable) ? (
        <p className="mission-checkpoints__hint">
          Nenhum checkpoint gravado. O Nexus grava um no fim de cada turno de writer que trabalha numa
          worktree própria.
        </p>
      ) : null}
      {scopes.map((scope) => (
        <div key={scope.root} className="mission-checkpoints__scope">
          <p className="mission-checkpoints__scope-head" title={scope.root}>
            <span className="mission-checkpoints__branch">{scope.branch ?? 'sem branch'}</span>
            <span className="mission-checkpoints__folder">{folderName(scope.root)}</span>
          </p>
          {scope.unavailable ? (
            <p className="mission-checkpoints__hint">Indisponível agora: {scope.unavailable}</p>
          ) : null}
          <ul className="mission-checkpoints__list">
            {scope.checkpoints.map((entry) => {
              const open = confirm?.ref === entry.ref;
              return (
                <li key={entry.ref} className="mission-checkpoints__item">
                  <div className="mission-checkpoints__row">
                    <div className="mission-checkpoints__copy">
                      <strong>{checkpointTitle(entry)}</strong>
                      <span className="mission-checkpoints__when">{formatWhen(entry.createdAt)}</span>
                    </div>
                    <button
                      type="button"
                      className="mission-checkpoints__button"
                      aria-label={`Restaurar: ${checkpointTitle(entry)}, ${formatWhen(entry.createdAt)}`}
                      aria-expanded={open}
                      disabled={confirm?.kind === 'restoring'}
                      onClick={() => void askRestore(entry.ref)}
                    >
                      Restaurar…
                    </button>
                  </div>
                  <FileSummary entry={entry} />
                  {open && confirm ? (
                    <RestoreConfirmation
                      scope={scope}
                      state={confirm}
                      onConfirm={() => void restore()}
                      onCancel={() => setConfirm(null)}
                      onRepreview={() => void askRestore(entry.ref)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );

  if (collapsible) {
    return (
      <details
        className="mission-checkpoints mission-checkpoints--collapsible"
        aria-label="Pontos de restauração dos writers"
      >
        <summary className="mission-checkpoints__title">
          Pontos de restauração{list.kind === 'ready' ? ` (${total})` : ''}
        </summary>
        {body}
      </details>
    );
  }

  return (
    <section className="mission-checkpoints" aria-label="Pontos de restauração dos writers">
      <h4 className="mission-checkpoints__title">Pontos de restauração</h4>
      {body}
    </section>
  );
}
