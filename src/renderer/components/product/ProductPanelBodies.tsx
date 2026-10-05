/**
 * Contextual-panel tab bodies for product wave: Search, Skills, Memory, Editor.
 * Uses window.nexus.product / searchMixer IPC. Fail-soft when API missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { McpAcrossToolsReport } from '../../../shared/mcp-across-tools';
import type { FileNode } from '../../../shared/files-types';
import { McpAcrossToolsMatrix } from '../McpAcrossToolsMatrix';
import { MarketplaceSection } from '../settings/MarketplaceSection';
import { PixelIcon } from '../PixelIcon';
import { ActionCard, EmptyState } from '../ActionCard';
import {
  exportToolsFromPlan,
  McpAcrossSyncControls,
  type McpExportToolId,
  type McpSyncPlan,
} from '../McpAcrossSyncControls';
import {
  PANE_SKILL_DRAG_TYPE,
  buildSkillInvocationPrompt,
  serializeSkillDragPayload,
} from '../../lib/pane-interactions';
import { useToastStore } from '../../state/toast-store';
import { useFilesStore } from '../../state/files-store';
import { useContextualPanelNavStore } from '../../state/contextual-panel-nav-store';
import { readableMemoryBody } from './memory-note-readable';

type Hit = {
  id: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  path?: string;
  source?: string;
};

function productApi() {
  return window.nexus?.product;
}

function memoryApi() {
  return window.nexus?.memory;
}

const MEMORY_KIND_LABELS: Record<string, string> = {
  note: 'nota',
  decision: 'decisão',
  mission: 'missão',
  agent: 'agente',
};

export function SearchPanelBody() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // IPC responses resolve out of order; only the latest request may render.
  const requestSeq = useRef(0);

  const run = useCallback(async (text: string) => {
    const requestId = ++requestSeq.current;
    if (!text.trim()) {
      setHits([]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const api = window.nexus?.searchMixer ?? productApi();
      if (!api) {
        setError('API de busca indisponível');
        return;
      }
      const result =
        'search' in api
          ? await (api as { search: (q: unknown) => Promise<{ hits?: Hit[]; error?: string }> }).search({
              text,
              limit: 40,
              projectRoot: undefined,
            })
          : await (api as { searchQuery: (q: { text: string; limit?: number }) => Promise<{ hits?: Hit[]; error?: string }> }).searchQuery({
              text,
              limit: 40,
            });
      if (requestId !== requestSeq.current) return;
      if (result.error) setError(result.error);
      setHits((result.hits as Hit[]) ?? []);
    } catch (err) {
      if (requestId !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : 'search failed');
    } finally {
      if (requestId === requestSeq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void run(query), 120);
    return () => clearTimeout(t);
  }, [query, run]);

  return (
    <div className="product-pane" data-testid="product-search">
      <input
        className="product-pane__input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar arquivos, missões, skills…"
        aria-label="Busca"
      />
      {busy && <p className="product-pane__meta">Buscando…</p>}
      {error && <p className="product-pane__error">{error}</p>}
      {!query.trim() && hits.length === 0 && !busy && (
        <div className="product-empty-card">
          <PixelIcon name="search" size={24} />
          <p className="product-pane__meta">
            Busque rapidamente por arquivos do workspace, histórico de missões e catálogo de skills.
          </p>
        </div>
      )}
      {query.trim() && !busy && hits.length === 0 && !error && (
        <p className="product-pane__meta">Nenhum resultado encontrado para &ldquo;{query}&rdquo;.</p>
      )}
      <ul className="product-pane__list">
        {hits.map((h) => (
          <li key={h.id} className="product-pane__item">
            <strong>{h.title}</strong>
            {h.subtitle && <span className="product-pane__sub">{h.subtitle}</span>}
            {h.snippet && <p className="product-pane__snip">{h.snippet}</p>}
            {h.path && <code className="product-pane__path">{h.path}</code>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SkillsPanelBody() {
  const [skills, setSkills] = useState<
    Array<{ id: string; name: string; description: string; category?: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useToastStore((state) => state.push);

  useEffect(() => {
    void (async () => {
      try {
        const api = productApi();
        if (!api) return;
        const list = (await api.skillsList()) as Array<{
          id: string;
          name: string;
          description: string;
          category?: string;
        }>;
        setSkills(list ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'skills load failed');
      }
    })();
  }, []);

  return (
    <div className="product-pane" data-testid="product-skills">
      {error && <p className="product-pane__error">{error}</p>}
      {!error && skills.length === 0 && (
        <div className="product-empty-card">
          <PixelIcon name="sparkle" size={24} />
          <p className="product-pane__meta">
            Nenhuma skill nos caminhos do catálogo local. Acesse o Market para instalar novas skills.
          </p>
          <button
            type="button"
            className="product-pane__btn"
            onClick={() => {
              useContextualPanelNavStore.getState().openTab('marketplace');
            }}
          >
            Abrir Marketplace
          </button>
        </div>
      )}
      {skills.length > 0 && (
        <p className="product-pane__meta product-pane__drag-hint">
          Arraste para um agente. O roster e as permissões da missão continuam
          valendo.
        </p>
      )}
      <ul className="product-pane__list">
        {skills.map((s) => (
          <li key={s.id} className="product-pane__item product-skill">
            <button
              type="button"
              className="product-skill__chip"
              draggable
              data-testid="skill-drag-chip"
              aria-label={`Arrastar skill ${s.name} para um agente`}
              title="Arraste para um pane de agente ou clique para copiar a instrução"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData(
                  PANE_SKILL_DRAG_TYPE,
                  serializeSkillDragPayload({ id: s.id, name: s.name }),
                );
              }}
              onClick={() => {
                const instruction = buildSkillInvocationPrompt(s.name);
                void navigator.clipboard.writeText(instruction).then(
                  () =>
                    pushToast(
                      'success',
                      'Instrução copiada',
                      `Cole em um agente para solicitar ${s.name}.`,
                    ),
                  () =>
                    pushToast(
                      'warn',
                      'Clipboard indisponível',
                      'Arraste a skill diretamente para um pane de agente.',
                    ),
                );
              }}
            >
              <strong>{s.name}</strong>
              <span aria-hidden="true">arrastar</span>
            </button>
            {s.category && <span className="product-pane__sub">{s.category}</span>}
            <p className="product-pane__snip">{s.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MarketplacePanelBody() {
  return (
    <div className="product-pane product-pane--marketplace" data-testid="product-marketplace">
      <MarketplaceSection />
    </div>
  );
}

type ProductMemoryNote = {
  id: string;
  title: string;
  body: string;
  kind?: string;
  /** Provenance canônica do SQLite (ex.: trusted:operator-preference). */
  source?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** F-800/F-808: quarantine (fora do brief até promover), promoted, reverify. */
  flags?: readonly string[];
  /** Detalhe de "a reverificar": qual arquivo citado sumiu do checkout. */
  reverify?: string | null;
};

/** Rótulo pt-BR das marcas de uma nota (F-800/F-808). */
export function memoryFlagLabel(flag: string, reverify?: string | null): string | null {
  if (flag === 'quarantine') return 'em quarentena: origem ainda não aprovada; fora dos briefs até você promover';
  if (flag === 'promoted') return 'promovida por você: entra nos briefs deste projeto';
  if (flag === 'reverify') return `a reverificar: ${reverify ?? 'um arquivo citado sumiu do checkout'}`;
  return null;
}

const TRUSTED_MEMORY_SOURCE_LABELS: Readonly<Record<string, string>> = {
  'trusted:operator-decision': 'decisão do operador',
  'trusted:accepted-handoff': 'handoff aceito',
  'trusted:resolved-problem': 'problema resolvido',
  'trusted:architecture-rule': 'regra de arquitetura',
  'trusted:approved-merge': 'merge aprovado',
  'trusted:session-digest': 'resumo de sessão',
  'trusted:operator-preference': 'preferência do operador',
};

/** Rótulo curto da origem para a linha de meta da nota. */
function memorySourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source === 'operator:note' || source === 'operator:agent:manual') {
    return 'manual';
  }
  if (source.startsWith('agent-authored:')) return 'agente';
  // F-798: auto-memória nativa de uma CLI importada (não verificada).
  if (source === 'imported:claude-auto-memory') return 'importada do Claude';
  if (source.startsWith('imported:')) return 'importada';
  return TRUSTED_MEMORY_SOURCE_LABELS[source] ?? source;
}

type ProductMemoryFailure = {
  operation: 'load' | 'remember' | 'forget';
  message: string;
};

const DAY_MS = 86_400_000;
/** Acima disso a tela Memória entra em alerta (F-769). */
export const MEMORY_STALE_DAYS_THRESHOLD = 3;

/**
 * Dias desde a memória mais recente do workspace; null quando nenhuma nota
 * traz data. Contador visível do "a memória parou de andar" — antes disto a
 * escrita falhava em silêncio por semanas sem sinal na UI (F-769).
 */
export function memoryStalenessDays(
  notes: ReadonlyArray<Pick<ProductMemoryNote, 'createdAt' | 'updatedAt'>>,
  now = Date.now(),
): number | null {
  let latest = 0;
  for (const note of notes) {
    const stamp = note.updatedAt ?? note.createdAt ?? 0;
    if (stamp > latest) latest = stamp;
  }
  if (latest <= 0) return null;
  return Math.max(0, Math.floor((now - latest) / DAY_MS));
}

/**
 * Handoffs entregues desde a memória mais recente, contados pelo Main
 * (`memory:stats` → `activity`), independente da retenção ter rodado (Mem12).
 * Nota de handoff no banco nunca substitui essa contagem: ela só existe
 * quando a retenção funcionou. Indisponível ou malformado → null (sem alerta).
 */
async function loadDeliveredHandoffsSinceLatestMemory(): Promise<number | null> {
  try {
    const result = await memoryApi()?.stats();
    if (!result?.enabled) return null;
    const delivered = result.activity?.deliveredHandoffsSinceLatestMemory;
    return typeof delivered === 'number' && Number.isSafeInteger(delivered) && delivered >= 0
      ? delivered
      : null;
  } catch {
    return null;
  }
}

/** Linha "última memória há N dias" da tela Memória. */
export function memoryStalenessLabel(days: number): string {
  if (days === 0) return 'Última memória hoje';
  return `Última memória há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

export interface MemoryPanelBodyProps {
  showOnboarding?: boolean;
  presentation?: 'compact' | 'full';
}

export function MemoryPanelBody({
  showOnboarding = false,
  presentation = 'compact',
}: MemoryPanelBodyProps = {}) {
  const [notes, setNotes] = useState<ProductMemoryNote[]>([]);
  const [deliveredSinceLatest, setDeliveredSinceLatest] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [memoryType, setMemoryType] = useState<'note' | 'architecture-rule' | 'operator-preference'>('note');
  const [preferenceScope, setPreferenceScope] = useState<'workspace' | 'global'>('workspace');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ProductMemoryFailure | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const savingRef = useRef(false);
  const forgettingRef = useRef(false);
  const reloadGenerationRef = useRef(0);
  const mountedRef = useRef(false);

  const reload = useCallback(
    async (
      failureMessage = 'Não foi possível acessar a memória local. Tente novamente em instantes.',
    ): Promise<boolean> => {
      if (!mountedRef.current) return false;
      const generation = ++reloadGenerationRef.current;
      setLoading(true);
      setFailure(null);
      try {
        const api = productApi();
        if (!api) throw new Error('product memory API unavailable');
        const [list, delivered] = await Promise.all([
          api.memoryList() as Promise<ProductMemoryNote[]>,
          loadDeliveredHandoffsSinceLatestMemory(),
        ]);
        if (
          !mountedRef.current ||
          generation !== reloadGenerationRef.current
        ) {
          return false;
        }
        setNotes(list ?? []);
        setDeliveredSinceLatest(delivered);
        return true;
      } catch {
        if (
          !mountedRef.current ||
          generation !== reloadGenerationRef.current
        ) {
          return false;
        }
        setFailure({ operation: 'load', message: failureMessage });
        return false;
      } finally {
        if (
          mountedRef.current &&
          generation === reloadGenerationRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
      reloadGenerationRef.current += 1;
    };
  }, [reload]);

  const remember = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || savingRef.current) return;

    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    setImportStatus(null);
    try {
      const api = productApi();
      if (!api) throw new Error('product memory API unavailable');
      if (memoryType === 'note') await api.memoryRemember({
        title: trimmedTitle,
        body,
        kind: 'note',
      });
      else {
        const result = await memoryApi()?.attest({ type: memoryType, title: trimmedTitle,
          summary: body || trimmedTitle, scope: memoryType === 'operator-preference' ? preferenceScope : 'workspace' });
        if (!result?.enabled) throw new Error('memory attestation unavailable');
        if (result.scope === 'global' && mountedRef.current) {
          setImportStatus('Preferência salva para todos os seus projetos.');
        }
      }
      if (!mountedRef.current) return;
      setTitle('');
      setBody('');
      await reload(
        'A memória foi guardada, mas não foi possível atualizar a lista. Tente recarregar.',
      );
    } catch {
      if (mountedRef.current) {
        setFailure({
          operation: 'remember',
          message:
            'Não foi possível guardar esta memória. Revise os campos e tente novamente.',
        });
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const importNative = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setFailure(null); setImportStatus(null);
    try {
      const result = await memoryApi()?.importNative();
      if (!result?.enabled) throw new Error('native import unavailable');
      if (!mountedRef.current || result.cancelled) return;
      await reload();
      if (!mountedRef.current) return;
      setImportStatus(`${result.imported} importadas, ${result.deduped} já existentes, ${result.skipped} ignoradas. Revise as notas em quarentena antes de promover.`);
    } catch {
      if (mountedRef.current) setFailure({ operation: 'remember', message: 'Não foi possível importar as memórias. Selecione até 32 arquivos de texto de até 8 KB cada.' });
    } finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
  };

  const forget = async (id: string) => {
    if (!id || forgettingRef.current) return;

    forgettingRef.current = true;
    setForgettingId(id);
    setFailure(null);
    try {
      const api = memoryApi();
      if (!api) throw new Error('workspace memory API unavailable');
      const result = await api.forget(id);
      if (!result.enabled) {
        throw new Error('workspace memory is disabled');
      }
      if (!result.forgotten) {
        throw new Error('memory was not forgotten');
      }
      if (!mountedRef.current) return;
      await reload(
        'A memória foi apagada, mas não foi possível atualizar a lista. Tente recarregar.',
      );
    } catch {
      if (mountedRef.current) {
        setFailure({
          operation: 'forget',
          message:
            'Não foi possível apagar esta memória. Tente novamente em instantes.',
        });
      }
    } finally {
      forgettingRef.current = false;
      if (mountedRef.current) setForgettingId(null);
    }
  };

  // F-808: promover uma nota em quarentena é decisão do operador, aqui.
  const promote = async (id: string) => {
    if (!id || forgettingRef.current) return;
    forgettingRef.current = true;
    setForgettingId(id);
    setFailure(null);
    try {
      const api = memoryApi();
      if (!api) throw new Error('workspace memory API unavailable');
      const result = await api.promote(id);
      if (!result.enabled || !result.promoted) {
        throw new Error('memory was not promoted');
      }
      if (!mountedRef.current) return;
      await reload(
        'A memória foi promovida, mas não foi possível atualizar a lista. Tente recarregar.',
      );
    } catch {
      if (mountedRef.current) {
        setFailure({
          operation: 'forget',
          message:
            'Não foi possível promover esta memória. Tente novamente em instantes.',
        });
      }
    } finally {
      forgettingRef.current = false;
      if (mountedRef.current) setForgettingId(null);
    }
  };

  const collection = (
    <>
      {showOnboarding && !loading && !failure && notes.length === 0 ? (
        <EmptyState
          icon="file"
          title="Nenhuma memória ainda"
          body="Registre uma decisão, uma regra do projeto ou um aprendizado. As notas salvas aparecem aqui."
          className="memory-workspace__empty"
          action={
            <ActionCard
              icon="plus"
              title="Escrever primeira memória"
              subtitle="Título + texto, depois Salvar."
              variant="primary"
              onClick={() => titleInputRef.current?.focus()}
            />
          }
        />
      ) : null}
      {loading ? (
        <p className="product-pane__loading" role="status">
          Carregando memórias…
        </p>
      ) : notes.length > 0 ? (
        <ul className="product-pane__list" aria-label="Memórias salvas">
          {notes.map((note) => {
            const readable = readableMemoryBody(note.body, note.title);
            const forgetting = forgettingId === note.id;
            return (
              <li key={note.id} className="product-pane__item">
                <div className="product-pane__item-head">
                  <strong>{note.title}</strong>
                  <button
                    type="button"
                    className="product-pane__forget"
                    disabled={forgettingId !== null}
                    aria-label={`Apagar memória ${note.title}`}
                    onClick={() => void forget(note.id)}
                  >
                    {forgetting ? 'Apagando…' : 'Apagar'}
                  </button>
                </div>
                {note.kind ? (
                  <span className="product-pane__sub">
                    {MEMORY_KIND_LABELS[note.kind] ?? note.kind}
                  </span>
                ) : null}
                {(note.flags ?? []).map((flag) => {
                  const label = memoryFlagLabel(flag, note.reverify);
                  if (!label) return null;
                  return (
                    <p
                      key={flag}
                      className="product-pane__meta memory-workspace__flag"
                      data-flag={flag}
                    >
                      {label}
                      {flag === 'quarantine' ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="product-pane__retry"
                            disabled={forgettingId !== null}
                            aria-label={`Promover memória ${note.title}`}
                            onClick={() => void promote(note.id)}
                          >
                            Promover
                          </button>
                        </>
                      ) : null}
                    </p>
                  );
                })}
                {note.source !== undefined ||
                note.updatedAt !== undefined ? (
                  <p className="product-pane__meta">
                    {[
                      memorySourceLabel(note.source),
                      note.updatedAt
                        ? new Date(note.updatedAt).toLocaleDateString('pt-BR')
                        : null,
                    ]
                      .filter((part) => part !== null)
                      .join(' · ')}
                  </p>
                ) : null}
                <p
                  className={
                    presentation === 'full'
                      ? 'product-pane__snip product-pane__body'
                      : 'product-pane__snip'
                  }
                >
                  {presentation === 'full'
                    ? readable.body
                    : readable.body.slice(0, 200)}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );

  return (
    <div className="product-pane" data-testid="product-memory">
      {failure ? (
        <div className="product-pane__error" role="alert">
          <p>{failure.message}</p>
          {failure.operation === 'load' ? (
            <button
              type="button"
              className="product-pane__retry"
              disabled={loading}
              onClick={() => void reload()}
            >
              Tentar novamente
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="product-pane__form" aria-busy={saving || undefined}>
        {presentation === 'full' ? <h2>Nova memória</h2> : null}
        <label className="product-pane__field">
          <span>Tipo de memória</span>
          <select className="product-pane__input" aria-label="Tipo de memória" value={memoryType}
            disabled={saving} onChange={(event) => setMemoryType(event.target.value as typeof memoryType)}>
            <option value="note">Nota</option>
            <option value="architecture-rule">Regra aprovada por mim</option>
            <option value="operator-preference">Minha preferência</option>
          </select>
        </label>
        {memoryType === 'operator-preference' ? <label className="product-pane__field">
          <span>Onde a preferência vale</span>
          <select className="product-pane__input" aria-label="Escopo da preferência" value={preferenceScope}
            disabled={saving} onChange={(event) => setPreferenceScope(event.target.value as typeof preferenceScope)}>
            <option value="workspace">Neste projeto</option><option value="global">Em todos os meus projetos</option>
          </select>
        </label> : null}
        <label className="product-pane__field">
          <span>Título da nota</span>
          <input
            ref={titleInputRef}
            className="product-pane__input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Ex.: Usar um único banco de domínio"
            aria-label="Título da memória"
          />
        </label>
        <label className="product-pane__field">
          <span>O que deve ser lembrado</span>
          <textarea
            className="product-pane__textarea"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Decisão, contexto ou aprendizado para a próxima sessão"
            rows={5}
            aria-label="Corpo da memória"
          />
        </label>
        <button
          type="button"
          className="product-pane__btn"
          disabled={saving || title.trim().length === 0}
          onClick={() => void remember()}
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
        <p className="product-pane__hint">
          {memoryType === 'operator-preference' && preferenceScope === 'global'
            ? 'Salva nos dados do app para todos os seus projetos.'
            : 'Salva nos dados do app para este projeto, não no repositório.'}
        </p>
        <button type="button" className="product-pane__retry" disabled={saving}
          onClick={() => void importNative()}>Importar memórias nativas</button>
        <p className="product-pane__hint">Selecione arquivos .md ou .txt, até 8 KB cada. A importação fica em quarentena e preserva os arquivos originais.</p>
        {importStatus ? <p className="product-pane__hint" role="status">{importStatus}</p> : null}
      </div>

      {presentation === 'full' ? (
        <section className="product-pane__entries" aria-label="Caderno salvo">
          <header className="product-pane__entries-heading">
            <h2>Memórias salvas</h2>
            {!loading && !failure ? <span>{notes.length}</span> : null}
          </header>
          {!loading && !failure
            ? (() => {
                const stalenessDays = memoryStalenessDays(notes);
                if (stalenessDays === null) return null;
                // Mem12: idade sozinha não alarma — só com handoffs entregues
                // depois da última memória, na contagem do Main.
                const stale =
                  stalenessDays > MEMORY_STALE_DAYS_THRESHOLD &&
                  (deliveredSinceLatest ?? 0) > 0;
                return (
                  <p
                    className="product-pane__meta memory-workspace__staleness"
                    data-stale={stale ? 'true' : undefined}
                    role="status"
                  >
                    {memoryStalenessLabel(stalenessDays)}
                    {stale
                      ? ' — há mais de 3 dias com handoffs no período: o projeto pode estar esquecendo o que aprendeu'
                      : ''}
                  </p>
                );
              })()
            : null}
          {collection}
        </section>
      ) : collection}
    </div>
  );
}

interface EditorTreeNodeProps {
  readonly node: FileNode;
  readonly depth: number;
  readonly onSelectFile: (relPath: string) => void;
}

function EditorTreeNode({
  node,
  depth,
  onSelectFile,
}: EditorTreeNodeProps) {
  const expanded = useFilesStore((state) =>
    state.expanded.has(node.relPath),
  );
  const children = useFilesStore((state) => state.children[node.relPath]);
  const loadError = useFilesStore(
    (state) => state.loadErrors[node.relPath],
  );
  const loading = useFilesStore((state) =>
    state.loadingDirs.has(node.relPath),
  );
  const openPath = useFilesStore((state) => state.openFile?.relPath);
  const toggleDir = useFilesStore((state) => state.toggleDir);
  const loadDir = useFilesStore((state) => state.loadDir);
  const isDirectory = node.kind === 'dir';
  const active = !isDirectory && openPath === node.relPath;

  return (
    <li className="product-editor__tree-item">
      <button
        type="button"
        className={`product-editor__tree-node${active ? ' is-active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={isDirectory ? expanded : undefined}
        aria-current={active ? 'page' : undefined}
        title={node.relPath}
        onClick={() => {
          if (isDirectory) {
            void toggleDir(node.relPath);
          } else {
            onSelectFile(node.relPath);
          }
        }}
      >
        <PixelIcon
          name={
            isDirectory
              ? expanded
                ? 'chevron-down'
                : 'chevron'
              : 'file'
          }
          size={10}
        />
        <span>{node.name}</span>
      </button>
      {isDirectory && expanded ? (
        children === undefined && loadError ? (
          <div
            className="product-editor__tree-load-error"
            style={{ paddingLeft: 22 + depth * 14 }}
          >
            <span className="product-editor__tree-error" role="alert">
              {loadError}
            </span>
            <button
              type="button"
              className="product-editor__retry"
              aria-label={`Tentar carregar ${node.name} novamente`}
              onClick={() => void loadDir(node.relPath)}
            >
              Tentar novamente
            </button>
          </div>
        ) : children === undefined && loading ? (
          <span
            className="product-editor__tree-note"
            style={{ paddingLeft: 22 + depth * 14 }}
            role="status"
          >
            Carregando…
          </span>
        ) : children === undefined ? null : children.length === 0 ? (
          <span
            className="product-editor__tree-note"
            style={{ paddingLeft: 22 + depth * 14 }}
          >
            Pasta vazia
          </span>
        ) : (
          <ul className="product-editor__tree-list">
            {children.map((child) => (
              <EditorTreeNode
                key={child.relPath}
                node={child}
                depth={depth + 1}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

export function EditorPanelBody() {
  const root = useFilesStore((state) => state.children['']);
  const rootError = useFilesStore((state) => state.loadErrors['']);
  const rootLoading = useFilesStore((state) => state.loadingDirs.has(''));
  const file = useFilesStore((state) => state.openFile);
  const saving = useFilesStore((state) => state.saving);
  const loadDir = useFilesStore((state) => state.loadDir);
  const selectFile = useFilesStore((state) => state.selectFile);
  const edit = useFilesStore((state) => state.edit);
  const saveFile = useFilesStore((state) => state.save);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const escArmedRef = useRef(false);
  const content = file?.content ?? '';
  const lineCount = useMemo(() => content.split('\n').length, [content]);
  const readFailed = Boolean(file?.error && !file.dirty);
  const editable = Boolean(
    file &&
      !file.loading &&
      !file.tooLarge &&
      !file.binary &&
      !readFailed,
  );

  useEffect(() => {
    if (root === undefined && !rootError && !rootLoading) void loadDir('');
  }, [loadDir, root, rootError, rootLoading]);

  useEffect(() => {
    setCursor({ line: 1, col: 1 });
    escArmedRef.current = false;
  }, [file?.loading, file?.relPath]);

  const handleSelectFile = useCallback(
    (relPath: string) => {
      setSaveStatus(null);
      void selectFile(relPath);
    },
    [selectFile],
  );

  const updateCursor = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
    setCursor({
      line: beforeCursor.split('\n').length,
      col: textarea.selectionStart - beforeCursor.lastIndexOf('\n'),
    });
  };

  const syncGutter = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const save = async () => {
    setSaveStatus(null);
    if (await saveFile()) setSaveStatus('Salvo');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 's'
    ) {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape') {
      escArmedRef.current = true;
      return;
    }
    if (event.key !== 'Tab') {
      escArmedRef.current = false;
      return;
    }
    if (escArmedRef.current) {
      escArmedRef.current = false;
      return;
    }
    event.preventDefault();
    const textarea = event.currentTarget;
    const { selectionStart, selectionEnd, value } = textarea;
    const next =
      value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
    setSaveStatus(null);
    edit(next);
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = selectionStart + 2;
      updateCursor();
    });
  };

  return (
    <div
      className="product-pane product-editor"
      data-testid="product-editor"
    >
      <nav
        className="product-editor__tree"
        aria-label="Arquivos do workspace"
        aria-busy={rootLoading || undefined}
      >
        <div className="product-editor__tree-heading">
          <span>Workspace</span>
          {root ? <span>{root.length}</span> : null}
        </div>
        {rootError ? (
          <div className="product-editor__load-error">
            <p className="product-editor__error" role="alert">
              {rootError}
            </p>
            <button
              type="button"
              className="product-editor__retry"
              aria-label="Tentar carregar arquivos novamente"
              onClick={() => void loadDir('')}
            >
              Tentar novamente
            </button>
          </div>
        ) : root === undefined ? (
          <p className="product-editor__tree-state" role="status">
            Carregando arquivos…
          </p>
        ) : root.length === 0 ? (
          <p className="product-editor__tree-state">
            Este workspace não contém arquivos.
          </p>
        ) : (
          <ul className="product-editor__tree-list">
            {root.map((node) => (
              <EditorTreeNode
                key={node.relPath}
                node={node}
                depth={0}
                onSelectFile={handleSelectFile}
              />
            ))}
          </ul>
        )}
      </nav>

      <section
        className="product-editor__workspace"
        aria-label="Editor de arquivo"
        aria-busy={saving || file?.loading || undefined}
      >
        {!file ? (
          <div className="product-editor__empty">
            <PixelIcon name="file" size={20} />
            <strong>Editor de workspace</strong>
            <span>Selecione um arquivo para ver ou editar.</span>
          </div>
        ) : (
          <>
            <div className="product-editor__toolbar">
              <span className="product-editor__path" title={file.relPath}>
                {file.relPath}
                {file.dirty ? ' •' : ''}
              </span>
              <button
                type="button"
                className="product-pane__btn product-editor__save"
                disabled={!file.dirty || saving || !editable}
                onClick={() => void save()}
              >
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>

            {file.error ? (
              <p className="product-editor__error" role="alert">
                {file.error}
              </p>
            ) : null}

            {file.loading ? (
              <div className="product-editor__notice" role="status">
                Abrindo arquivo…
              </div>
            ) : readFailed ? null : file.tooLarge ? (
              <div className="product-editor__notice">
                Arquivo grande demais para edição inline.
              </div>
            ) : file.binary ? (
              <div className="product-editor__notice">
                Arquivo binário não pode ser editado como texto.
              </div>
            ) : (
              <>
                <div className="editor-code">
                  <div
                    className="editor-code__gutter"
                    ref={gutterRef}
                    aria-hidden="true"
                  >
                    {Array.from({ length: lineCount }, (_, index) => (
                      <span key={index} className="editor-code__line-no">
                        {index + 1}
                      </span>
                    ))}
                  </div>
                  <textarea
                    ref={textareaRef}
                    className="product-pane__textarea product-pane__textarea--editor editor-code__textarea"
                    value={content}
                    onChange={(event) => {
                      setSaveStatus(null);
                      edit(event.target.value);
                      updateCursor();
                    }}
                    onKeyDown={handleKeyDown}
                    onScroll={syncGutter}
                    onSelect={updateCursor}
                    onClick={updateCursor}
                    spellCheck={false}
                    wrap="off"
                    aria-label={`Conteúdo de ${file.relPath}`}
                  />
                </div>
                <div className="editor-code__status">
                  <span>
                    Ln {cursor.line}, Col {cursor.col}
                  </span>
                  <span>{lineCount} linhas</span>
                  <span>{content.length} chars</span>
                  {file.dirty ? (
                    <span className="editor-code__dirty">não salvo</span>
                  ) : null}
                </div>
              </>
            )}

            {saveStatus ? (
              <p
                className="product-editor__feedback"
                role="status"
                aria-live="polite"
              >
                {saveStatus}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

export function McpHubPanelBody() {
  const [across, setAcross] = useState<McpAcrossToolsReport | null>(null);
  const [plan, setPlan] = useState<McpSyncPlan | null>(null);
  const [exportTools, setExportTools] = useState<McpExportToolId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reloadGen = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++reloadGen.current;
    setBusy(true);
    setError(null);
    try {
      const api = productApi();
      if (!api?.mcpHubObserve) {
        if (gen !== reloadGen.current) return;
        setError('API de observe indisponível — reinicie o app');
        return;
      }
      const report = (await api.mcpHubObserve()) as McpAcrossToolsReport;
      if (gen !== reloadGen.current) return;
      setAcross(report);
      try {
        if (api.mcpHubSyncPlan) {
          const next = (await api.mcpHubSyncPlan()) as McpSyncPlan;
          if (gen !== reloadGen.current) return;
          setPlan(next);
          setExportTools(exportToolsFromPlan(next));
        }
      } catch {
        if (gen !== reloadGen.current) return;
        setPlan(null);
      }
    } catch (err) {
      if (gen !== reloadGen.current) return;
      setAcross(null);
      setError(err instanceof Error ? err.message : 'falha ao observar MCP');
    } finally {
      if (gen === reloadGen.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ritualTone =
    across == null
      ? ('idle' as const)
      : across.driftCount === 0
        ? ('ok' as const)
        : ('drift' as const);

  return (
    <div className="product-pane mcp-ritual" data-testid="product-mcp">
      <McpAcrossSyncControls
        tone={ritualTone}
        plan={plan}
        exportTools={exportTools}
        onExportToolsChange={setExportTools}
        busy={busy}
        onObserve={reload}
        onSynced={reload}
        status={
          <>
            <span className="mcp-ritual__banner-kicker">
              <span className="mcp-ritual__banner-label">Across Tools</span>
              {across ? (
                across.driftCount > 0 ? (
                  <span className="mcp-ritual__pill mcp-ritual__pill--drift">
                    {across.driftCount} drift
                  </span>
                ) : (
                  <span className="mcp-ritual__pill mcp-ritual__pill--ok">
                    alinhado
                  </span>
                )
              ) : null}
            </span>
            <span className="mcp-ritual__banner-line">
              {across?.bannerLine ??
                plan?.summary ??
                'Observe + Sync fill-gaps'}
            </span>
          </>
        }
      />
      {error && <p className="product-pane__error">{error}</p>}
      {across ? <McpAcrossToolsMatrix report={across} hideBanner /> : null}
      <p className="product-pane__snip">
        Hub: <code>.nexus/mcp-hub.json</code>. Fill-gaps never deletes ·
        Simular antes de Sync.
      </p>
    </div>
  );
}
