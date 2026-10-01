import { z } from 'zod';

interface DomNode { children?: DomNode[]; shadowRoots?: DomNode[]; shadowRootType?: 'open' | 'closed' | 'user-agent' }
const domNodeSchema: z.ZodType<DomNode> = z.lazy(() => z.object({
  children: z.array(domNodeSchema).optional(), shadowRoots: z.array(domNodeSchema).optional(),
  shadowRootType: z.enum(['open', 'closed', 'user-agent']).optional(),
}));
const MAX_DOM_NODES = 50_000;
const INSPECTION_TIMEOUT_MS = 5_000;
interface DomInspector {
  isAttached(): boolean; attach(version?: string): void; detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
function assertOpenTrees(root: DomNode): void {
  const pending = [root]; let visited = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > MAX_DOM_NODES) throw new Error('visual DOM limit reached');
    if (node.shadowRootType === 'closed') throw new Error('closed components cannot be safely redacted');
    if (node.shadowRootType === 'user-agent') continue;
    pending.push(...node.children ?? [], ...node.shadowRoots ?? []);
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
    assertOpenTrees(z.object({ root: domNodeSchema }).parse(document).root);
  } finally { clearTimeout(timer); inspector.detach(); }
}
