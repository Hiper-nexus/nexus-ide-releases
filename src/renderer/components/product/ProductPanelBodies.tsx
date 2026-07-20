/**
 * Contextual-panel tab bodies for product wave: Search, Skills, Memory, Editor.
 * Uses window.nexus.product / searchMixer IPC. Fail-soft when API missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { McpAcrossToolsReport } from '../../../shared/mcp-across-tools';
import { McpAcrossToolsMatrix } from '../McpAcrossToolsMatrix';
import { MarketplaceSection } from '../settings/MarketplaceSection';
import {
  exportToolsFromPlan,
  McpAcrossSyncControls,
  type McpExportToolId,
  type McpSyncPlan,
} from '../McpAcrossSyncControls';

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
        <p className="product-pane__meta">Nenhuma skill nos caminhos do catálogo.</p>
      )}
      <ul className="product-pane__list">
        {skills.map((s) => (
          <li key={s.id} className="product-pane__item">
            <strong>{s.name}</strong>
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

export function MemoryPanelBody() {
  const [notes, setNotes] = useState<
    Array<{ id: string; title: string; body: string; kind?: string }>
  >([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const api = productApi();
      if (!api) return;
      const list = (await api.memoryList()) as Array<{
        id: string;
        title: string;
        body: string;
        kind?: string;
      }>;
      setNotes(list ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'memory load failed');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remember = async () => {
    if (!title.trim()) return;
    try {
      const api = productApi();
      if (!api) return;
      await api.memoryRemember({ title: title.trim(), body, kind: 'note' });
      setTitle('');
      setBody('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'remember failed');
    }
  };

  return (
    <div className="product-pane" data-testid="product-memory">
      {error && <p className="product-pane__error">{error}</p>}
      <div className="product-pane__form">
        <input
          className="product-pane__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Título da nota"
          aria-label="Título da memória"
        />
        <textarea
          className="product-pane__textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Corpo (suporta [[wikilinks]])"
          rows={3}
          aria-label="Corpo da memória"
        />
        <button type="button" className="product-pane__btn" onClick={() => void remember()}>
          Lembrar
        </button>
      </div>
      <ul className="product-pane__list">
        {notes.map((n) => (
          <li key={n.id} className="product-pane__item">
            <strong>{n.title}</strong>
            {n.kind && <span className="product-pane__sub">{n.kind}</span>}
            <p className="product-pane__snip">{n.body.slice(0, 200)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EditorPanelBody() {
  const [relPath, setRelPath] = useState('');
  const [content, setContent] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [contentHash, setContentHash] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  /**
   * WCAG 2.1.2 (no keyboard trap): Tab normally indents, which would trap
   * focus. Escape arms a one-shot so the following Tab moves focus out —
   * the WAI-ARIA recommended escape hatch for editors.
   */
  const escArmedRef = useRef(false);

  const lineCount = useMemo(() => content.split('\n').length, [content]);

  const updateCursor = () => {
    const el = textareaRef.current;
    if (!el) return;
    const upTo = el.value.slice(0, el.selectionStart);
    const line = upTo.split('\n').length;
    const col = el.selectionStart - upTo.lastIndexOf('\n');
    setCursor({ line, col });
  };

  const syncGutter = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      escArmedRef.current = true;
      return;
    }
    if (e.key !== 'Tab') {
      escArmedRef.current = false;
      return;
    }
    if (escArmedRef.current) {
      escArmedRef.current = false;
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart, selectionEnd, value } = el;
    const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
    setContent(next);
    setDirty(true);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = selectionStart + 2;
      updateCursor();
    });
  };

  const open = async () => {
    if (!relPath.trim()) return;
    try {
      const api = productApi();
      if (!api) return;
      const doc = (await api.editorOpen(relPath.trim())) as {
        path?: string;
        content?: string;
        binary?: boolean;
        tooLarge?: boolean;
        contentHash?: string;
      };
      if (doc.binary) {
        setStatus('Arquivo binário — não editável');
        return;
      }
      if (doc.tooLarge) {
        setStatus('Arquivo grande demais para o editor');
        return;
      }
      setPath(doc.path ?? null);
      setContent(doc.content ?? '');
      setContentHash(doc.contentHash ?? null);
      setDirty(false);
      setCursor({ line: 1, col: 1 });
      setStatus(`Aberto ${doc.path ?? relPath}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'falha ao abrir');
    }
  };

  const save = async () => {
    if (!path || !contentHash) return;
    try {
      const api = productApi();
      if (!api) return;
      const saved = (await api.editorApply({
        path,
        content,
        write: true,
        expectedContentHash: contentHash,
      })) as { contentHash?: string };
      setContentHash(saved.contentHash ?? contentHash);
      setDirty(false);
      setStatus('Salvo');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'falha ao salvar');
    }
  };

  return (
    <div className="product-pane" data-testid="product-editor">
      <div className="product-pane__form product-pane__form--row">
        <input
          className="product-pane__input"
          value={relPath}
          onChange={(e) => setRelPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void open()}
          placeholder="caminho/relativo.ts"
          aria-label="Caminho relativo"
        />
        <button type="button" className="product-pane__btn" onClick={() => void open()}>
          Abrir
        </button>
        <button
          type="button"
          className="product-pane__btn"
          disabled={!path || !dirty}
          onClick={() => void save()}
        >
          Salvar
        </button>
      </div>
      {status && <p className="product-pane__meta">{status}</p>}
      <div className="editor-code">
        <div className="editor-code__gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i} className="editor-code__line-no">
              {i + 1}
            </span>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="product-pane__textarea product-pane__textarea--editor editor-code__textarea"
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
            updateCursor();
          }}
          onKeyDown={handleKeyDown}
          onScroll={syncGutter}
          onSelect={updateCursor}
          onClick={updateCursor}
          spellCheck={false}
          wrap="off"
          aria-label="Conteúdo do editor"
        />
      </div>
      <div className="editor-code__status" aria-live="polite">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{lineCount} linhas</span>
        <span>{content.length} chars</span>
        {dirty && <span className="editor-code__dirty">não salvo</span>}
      </div>
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
