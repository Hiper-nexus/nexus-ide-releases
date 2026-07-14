/**
 * Contextual-panel tab bodies for product wave: Search, Skills, Memory, Editor.
 * Uses window.nexus.product / searchMixer IPC. Fail-soft when API missing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

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
        setError('Search API unavailable');
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
        placeholder="Search files, missions, skills…"
        aria-label="Search"
      />
      {busy && <p className="product-pane__meta">Searching…</p>}
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
        <p className="product-pane__meta">No skills found in catalog paths.</p>
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
          placeholder="Note title"
          aria-label="Memory title"
        />
        <textarea
          className="product-pane__textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Body (supports [[wikilinks]])"
          rows={3}
          aria-label="Memory body"
        />
        <button type="button" className="product-pane__btn" onClick={() => void remember()}>
          Remember
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
        setStatus('Binary file — not editable');
        return;
      }
      if (doc.tooLarge) {
        setStatus('File too large for editor model');
        return;
      }
      setPath(doc.path ?? null);
      setContent(doc.content ?? '');
      setContentHash(doc.contentHash ?? null);
      setDirty(false);
      setStatus(`Opened ${doc.path ?? relPath}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'open failed');
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
      setStatus('Saved');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'save failed');
    }
  };

  return (
    <div className="product-pane" data-testid="product-editor">
      <div className="product-pane__form product-pane__form--row">
        <input
          className="product-pane__input"
          value={relPath}
          onChange={(e) => setRelPath(e.target.value)}
          placeholder="relative/path.ts"
          aria-label="Relative path"
        />
        <button type="button" className="product-pane__btn" onClick={() => void open()}>
          Open
        </button>
        <button
          type="button"
          className="product-pane__btn"
          disabled={!path || !dirty}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {status && <p className="product-pane__meta">{status}</p>}
      <textarea
        className="product-pane__textarea product-pane__textarea--editor"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        aria-label="Editor content"
      />
    </div>
  );
}

export function McpHubPanelBody() {
  const [summary, setSummary] = useState<string>('Loading…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const api = productApi();
        if (!api) {
          setSummary('MCP Hub API unavailable');
          return;
        }
        const loaded = (await api.mcpHubLoad()) as {
          config?: { servers?: unknown[] };
          matrix?: unknown[];
        };
        const n = loaded.config?.servers?.length ?? 0;
        const tools = Array.isArray(loaded.matrix) ? loaded.matrix.length : 0;
        setSummary(`${n} server(s) · ${tools} tool matrix row(s)`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'mcp hub load failed');
      }
    })();
  }, []);

  return (
    <div className="product-pane" data-testid="product-mcp">
      {error && <p className="product-pane__error">{error}</p>}
      <p className="product-pane__meta">{summary}</p>
      <p className="product-pane__snip">
        Config lives at <code>.nexus/mcp-hub.json</code>. Secrets are masked in UI.
      </p>
    </div>
  );
}
