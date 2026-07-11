/**
 * Attach file paths / dropped blobs to the focused CLI agent pane (Sprint A1).
 */
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from './split-tree';
import { writeToPane } from '../terminal/terminal-host';

function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function focusedAgentPaneId(): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const panes = listPanes(root);
  if (focusedPaneId) {
    const p = panes.find((x) => x.id === focusedPaneId);
    if (p?.kind === 'cli-agent') return p.id;
  }
  const agent = panes.find((p) => p.kind === 'cli-agent');
  return agent?.id ?? null;
}

/** Inject path(s) into the focused agent as if typed into the prompt. */
export function injectPathsToAgent(paths: string[], paneId?: string): boolean {
  const target = paneId ?? focusedAgentPaneId();
  if (!target || paths.length === 0) return false;
  const line =
    '\n[Anexos Nexus]\n' +
    paths.map((p) => `- ${shellQuote(p)}`).join('\n') +
    '\n';
  return writeToPane(target, line);
}

export async function attachFilesToAgent(
  files: FileList | File[],
  paneId?: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const list = Array.from(files);
  if (list.length === 0) return { ok: false, count: 0, error: 'no files' };
  const target = paneId ?? focusedAgentPaneId();
  if (!target) return { ok: false, count: 0, error: 'no agent pane focused' };

  const paths: string[] = [];
  for (const file of list) {
    const real = window.nexus.files.pathForFile(file);
    if (real) {
      paths.push(real);
      continue;
    }
    try {
      const base64 = bufferToBase64(await file.arrayBuffer());
      const res = await window.nexus.files.saveDropped(file.name || 'drop', base64);
      if (res.ok && res.path) paths.push(res.path);
    } catch {
      // skip bad file
    }
  }
  if (paths.length === 0) return { ok: false, count: 0, error: 'could not resolve paths' };
  const ok = injectPathsToAgent(paths, target);
  return { ok, count: paths.length, error: ok ? undefined : 'write failed' };
}

/** Format diff annotations as a prompt block for the agent. */
export function annotationsToAgentPrompt(
  annotations: Array<{ path: string; line: number; body: string }>,
): string {
  if (annotations.length === 0) return '';
  const lines = annotations.map(
    (a, i) => `${i + 1}. ${a.path}:${a.line} — ${a.body.trim()}`,
  );
  return (
    '\n[Revisão Nexus — anotações no diff]\n' +
    'Por favor endereça estes comentários no código:\n' +
    lines.join('\n') +
    '\n'
  );
}

export function sendAnnotationsToAgent(
  annotations: Array<{ path: string; line: number; body: string }>,
  paneId?: string,
): boolean {
  const text = annotationsToAgentPrompt(annotations);
  if (!text) return false;
  const target = paneId ?? focusedAgentPaneId();
  if (!target) return false;
  return writeToPane(target, text);
}
