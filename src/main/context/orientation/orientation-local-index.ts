/**
 * Local "semantic-ish" index over the Project Orientation Map.
 *
 * Not a vector embedding store: inverted token index + TF-style ranking over
 * hubs, paths, manifests, and docs. Builds asynchronously, is cancelable,
 * and must never be a precondition for arming a squad (intent-first).
 */

export interface OrientationIndexDocument {
  readonly id: string;
  readonly title: string;
  readonly path?: string;
  readonly kind: 'hub' | 'path' | 'manifest' | 'doc' | 'dir';
  readonly text: string;
}

export interface OrientationIndexHit {
  readonly id: string;
  readonly title: string;
  readonly path?: string;
  readonly kind: OrientationIndexDocument['kind'];
  readonly score: number;
  readonly snippet?: string;
}

export interface OrientationIndexSnapshot {
  readonly mapHash: string;
  readonly documentCount: number;
  readonly ready: boolean;
  readonly builtAt: number;
  readonly cancelled: boolean;
}

type Inverted = Map<string, Map<string, number>>;

function tokenize(text: string): string[] {
  // Split path separators, punctuation, and camelCase/PascalCase boundaries.
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[./\\_+-]+/g, ' ');
  return expanded
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 64);
}

export function documentsFromOrientationMap(map: {
  readonly mapHash: string;
  readonly symbols: {
    readonly hubs: readonly {
      readonly name: string;
      readonly samplePaths: readonly string[];
    }[];
  };
  readonly inventory: {
    readonly entrypoints: readonly string[];
    readonly manifests: readonly string[];
    readonly topDirs: readonly { readonly path: string }[];
  };
  readonly docs: { readonly rootDocs: readonly string[] };
}): OrientationIndexDocument[] {
  const docs: OrientationIndexDocument[] = [];
  for (const hub of map.symbols.hubs) {
    docs.push({
      id: `hub:${hub.name}`,
      title: hub.name,
      kind: 'hub',
      path: hub.samplePaths[0],
      text: [hub.name, ...hub.samplePaths].join(' '),
    });
  }
  for (const path of map.inventory.entrypoints) {
    docs.push({
      id: `entry:${path}`,
      title: path,
      kind: 'path',
      path,
      text: path,
    });
  }
  for (const path of map.inventory.manifests) {
    docs.push({
      id: `manifest:${path}`,
      title: path,
      kind: 'manifest',
      path,
      text: path,
    });
  }
  for (const path of map.docs.rootDocs) {
    docs.push({
      id: `doc:${path}`,
      title: path,
      kind: 'doc',
      path,
      text: path,
    });
  }
  for (const dir of map.inventory.topDirs) {
    docs.push({
      id: `dir:${dir.path}`,
      title: dir.path,
      kind: 'dir',
      path: dir.path,
      text: dir.path,
    });
  }
  return docs;
}

export class OrientationLocalIndex {
  #mapHash = '';
  #docs = new Map<string, OrientationIndexDocument>();
  #inverted: Inverted = new Map();
  #ready = false;
  #builtAt = 0;
  #cancelled = false;
  #buildGeneration = 0;

  get snapshot(): OrientationIndexSnapshot {
    return {
      mapHash: this.#mapHash,
      documentCount: this.#docs.size,
      ready: this.#ready,
      builtAt: this.#builtAt,
      cancelled: this.#cancelled,
    };
  }

  /** Cancel in-flight build; search returns empty until a new build finishes. */
  cancel(): void {
    this.#buildGeneration += 1;
    this.#cancelled = true;
    this.#ready = false;
  }

  /**
   * Rebuild index. Yields between chunks so the event loop can cancel.
   * Safe to call repeatedly; stale generations are dropped.
   */
  async build(
    map: Parameters<typeof documentsFromOrientationMap>[0],
    options: { readonly chunkSize?: number; readonly signal?: AbortSignal } = {},
  ): Promise<OrientationIndexSnapshot> {
    const generation = ++this.#buildGeneration;
    this.#cancelled = false;
    this.#ready = false;
    const chunkSize = options.chunkSize ?? 64;
    const documents = documentsFromOrientationMap(map);
    const docs = new Map<string, OrientationIndexDocument>();
    const inverted: Inverted = new Map();

    for (let i = 0; i < documents.length; i += chunkSize) {
      if (options.signal?.aborted || generation !== this.#buildGeneration) {
        this.#cancelled = true;
        this.#ready = false;
        return this.snapshot;
      }
      const slice = documents.slice(i, i + chunkSize);
      for (const doc of slice) {
        docs.set(doc.id, doc);
        const tf = new Map<string, number>();
        for (const token of tokenize(doc.text)) {
          tf.set(token, (tf.get(token) ?? 0) + 1);
        }
        for (const [token, count] of tf) {
          let posting = inverted.get(token);
          if (!posting) {
            posting = new Map();
            inverted.set(token, posting);
          }
          posting.set(doc.id, count);
        }
      }
      // Cooperative yield
      await Promise.resolve();
    }

    if (generation !== this.#buildGeneration) {
      this.#cancelled = true;
      return this.snapshot;
    }

    this.#docs = docs;
    this.#inverted = inverted;
    this.#mapHash = map.mapHash;
    this.#builtAt = Date.now();
    this.#ready = true;
    this.#cancelled = false;
    return this.snapshot;
  }

  /**
   * Ranked search. Returns [] when not ready (never throws — callers must
   * fall back to substring query). Limit capped at 64.
   */
  search(query: string, limit = 16): OrientationIndexHit[] {
    if (!this.#ready || this.#cancelled) return [];
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scores = new Map<string, number>();
    const docCount = Math.max(1, this.#docs.size);

    for (const token of tokens) {
      const posting = this.#inverted.get(token);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + docCount / (1 + df));
      for (const [docId, tf] of posting) {
        const term = (1 + Math.log(tf)) * idf;
        scores.set(docId, (scores.get(docId) ?? 0) + term);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.min(64, Math.max(1, limit)))
      .map(([id, score]) => {
        const doc = this.#docs.get(id)!;
        const maxScore = scores.values().next().value ?? score;
        return {
          id: doc.id,
          title: doc.title,
          path: doc.path,
          kind: doc.kind,
          score: maxScore > 0 ? Math.min(1, score / maxScore) : 0,
          snippet: doc.text.slice(0, 160),
        };
      });
  }
}

/** Process-wide index per mapHash (main process). */
const indexes = new Map<string, OrientationLocalIndex>();

export function getOrientationLocalIndex(mapHash: string): OrientationLocalIndex {
  let index = indexes.get(mapHash);
  if (!index) {
    index = new OrientationLocalIndex();
    indexes.set(mapHash, index);
  }
  return index;
}

export function resetOrientationLocalIndexes(): void {
  indexes.clear();
}
