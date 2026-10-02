import { z } from 'zod';

const domNodeSchema = z.object({
  children: z.array(z.unknown()).optional(), shadowRoots: z.array(z.unknown()).optional(),
  shadowRootType: z.enum(['open', 'closed', 'user-agent']).optional(),
});
const MAX_DOM_NODES = 50_000;
const MAX_DOM_DEPTH = 256;
const INSPECTION_TIMEOUT_MS = 5_000;
interface DomInspector {
  isAttached(): boolean; attach(version?: string): void; detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
function assertOpenTrees(root: unknown): void {
  const pending = [{ raw: root, depth: 0 }]; let visited = 0;
  while (pending.length) {
    const { raw, depth } = pending.pop()!;
    if (++visited > MAX_DOM_NODES) throw new Error('visual DOM limit reached');
    if (depth > MAX_DOM_DEPTH) throw new Error('visual DOM depth limit reached');
    if (raw && typeof raw === 'object') {
      for (const value of [(raw as { children?: unknown }).children, (raw as { shadowRoots?: unknown }).shadowRoots]) {
        if (Array.isArray(value) && value.length > MAX_DOM_NODES - visited) throw new Error('visual DOM limit reached');
      }
    }
    const node = domNodeSchema.parse(raw);
    if (node.shadowRootType === 'closed') throw new Error('closed components cannot be safely redacted');
    if (node.shadowRootType === 'user-agent') continue;
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) pending.push({ raw: child, depth: depth + 1 });
  }
}

/** CDP sees closed roots hidden from the isolated preload. Never borrow an existing inspector. */
export async function assertInspectableBrowserDom(inspector: DomInspector): Promise<void> {
  if (inspector.isAttached()) throw new Error('visual inspector is already in use');
  inspector.attach('1.3');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const document = await Promise.race([inspector.sendCommand('DOM.getDocument', { depth: -1, pierce: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('visual inspection unavailable')), INSPECTION_TIMEOUT_MS); })]);
    assertOpenTrees(z.object({ root: z.unknown() }).parse(document).root);
  } finally { clearTimeout(timer); inspector.detach(); }
}
