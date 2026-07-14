import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { resolveSubdirUnderRoot } from '../security/scoped-workspace-fs';
import { redactCommandLine } from '../terminal/command-redaction';

/**
 * Local-first Markdown memory under `.nexus-memory/` (clean-room).
 * Readable on disk; optional SQLite index later via project runtime.
 */

export const DEFAULT_MEMORY_DIR = '.nexus-memory';

export const memoryNoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(256),
    kind: z.enum(['decision', 'mission', 'agent', 'note']).default('note'),
    body: z.string().max(64_000),
    wikilinks: z.array(z.string().max(256)).max(128).default([]),
    missionId: z.string().max(128).optional(),
    path: z.string().max(4096),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MemoryNote = z.infer<typeof memoryNoteSchema>;

const WIKILINK_RE = /\[\[([^\]]{1,256})\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.add(m[1].trim());
  }
  return [...out];
}

/**
 * Resolve memory directory under projectRoot via shared scoped-fs adapter.
 */
export function resolveMemoryRoot(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): string {
  try {
    return resolveSubdirUnderRoot(projectRoot, dirname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      msg.includes('subdirectory')
        ? 'memory root must be a subdirectory of project'
        : msg.includes('escape') || msg.includes('relative')
          ? msg.replace(/^directory/, 'memory dirname')
          : `memory root escaped project: ${msg}`,
    );
  }
}

export function rememberMarkdown(
  projectRoot: string,
  input: {
    title: string;
    body: string;
    kind?: MemoryNote['kind'];
    missionId?: string;
  },
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.nexusMemory)) {
    throw new Error('feature.memory.nexusMemory is disabled');
  }
  const root = resolveMemoryRoot(projectRoot, dirname);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'note';
  const id = `${slug}-${Date.now().toString(36)}`;
  const filePath = path.join(root, `${id}.md`);
  // Redact secret-like tokens but never denylist entire memory notes.
  const scrubbed = redactCommandLine(input.body, {
    denylist: [],
    maxLength: 64_000,
  }).command;
  const body = scrubbed.slice(0, 64_000);
  const wikilinks = extractWikilinks(body);
  const md = `---\nid: ${id}\nkind: ${input.kind ?? 'note'}\nmissionId: ${input.missionId ?? ''}\n---\n\n# ${input.title}\n\n${body}\n`;
  fs.writeFileSync(filePath, md, { mode: 0o600 });
  return memoryNoteSchema.parse({
    id,
    title: input.title,
    kind: input.kind ?? 'note',
    body,
    wikilinks,
    missionId: input.missionId,
    path: filePath,
    updatedAt: Date.now(),
  });
}

const MEMORY_KINDS = new Set(['decision', 'mission', 'agent', 'note']);

function parseFrontmatter(raw: string): {
  kind: MemoryNote['kind'];
  missionId?: string;
  idFromFm?: string;
} {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) return { kind: 'note' };
  const block = fm[1];
  const kindRaw = /^kind:\s*(\S+)/m.exec(block)?.[1]?.trim();
  const kind =
    kindRaw && MEMORY_KINDS.has(kindRaw)
      ? (kindRaw as MemoryNote['kind'])
      : 'note';
  const missionId = /^missionId:\s*(.+)$/m.exec(block)?.[1]?.trim() || undefined;
  const idFromFm = /^id:\s*(\S+)/m.exec(block)?.[1]?.trim();
  return {
    kind,
    missionId: missionId || undefined,
    idFromFm,
  };
}

export function listMemoryNotes(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const root = resolveMemoryRoot(projectRoot, dirname);
  if (!fs.existsSync(root)) return [];
  const notes: MemoryNote[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(root, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(raw);
      const title =
        /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? name.replace(/\.md$/, '');
      const id = fm.idFromFm ?? name.replace(/\.md$/, '');
      const body = raw.replace(/^---[\s\S]*?---\s*/, '');
      notes.push(
        memoryNoteSchema.parse({
          id,
          title,
          kind: fm.kind,
          body: body.slice(0, 64_000),
          wikilinks: extractWikilinks(body),
          missionId: fm.missionId,
          path: filePath,
          updatedAt: Math.floor(fs.statSync(filePath).mtimeMs),
        }),
      );
    } catch {
      // skip corrupt
    }
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function searchMemory(
  projectRoot: string,
  query: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return listMemoryNotes(projectRoot, dirname).filter((n) => {
    const hay = `${n.title}\n${n.body}\n${n.wikilinks.join('\n')}`.toLowerCase();
    return hay.includes(q);
  });
}

export function backlinks(
  projectRoot: string,
  title: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const t = title.toLowerCase();
  return listMemoryNotes(projectRoot, dirname).filter((n) =>
    n.wikilinks.some((w) => w.toLowerCase() === t),
  );
}

export function wikilinkCompletions(
  projectRoot: string,
  prefix: string,
  dirname = DEFAULT_MEMORY_DIR,
): string[] {
  const p = prefix.toLowerCase();
  return listMemoryNotes(projectRoot, dirname)
    .map((n) => n.title)
    .filter((t) => t.toLowerCase().startsWith(p))
    .slice(0, 20);
}
