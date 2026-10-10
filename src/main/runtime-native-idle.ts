import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { claudeProjectSlug } from './usage/claude-transcript';

/** Private acceptance only: a dictated UUID is not a persisted native turn. */
export async function hasPrivateNativeIdleHistory(input: {
  userData: string; checkoutId: string; cwd: string; conversationId: string; marker: string;
}): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.checkoutId) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.conversationId) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.marker) ||
      !path.isAbsolute(input.userData) || !path.isAbsolute(input.cwd)) return false;
  const segments = ['provider-state', 'claude', input.checkoutId, 'claude', 'projects', claudeProjectSlug(input.cwd)];
  let dir = input.userData;
  const ancestors: Array<{ dir: string; dev: number; ino: number }> = [];
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    for (const segment of ['', ...segments]) {
      if (segment) dir = path.join(dir, segment);
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) return false;
      ancestors.push({ dir, dev: stat.dev, ino: stat.ino });
    }
    const file = path.join(dir, `${input.conversationId}.jsonl`);
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 2 * 1024 * 1024 ||
        typeof process.getuid === 'function' && before.uid !== process.getuid()) return false;
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    const after = await handle.stat(), named = await fs.lstat(file);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1 ||
        named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size || named.mtimeMs !== before.mtimeMs) return false;
    if (await fs.realpath(file) !== file) return false;
    for (const ancestor of ancestors) {
      const stat = await fs.lstat(ancestor.dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ancestor.dev || stat.ino !== ancestor.ino || await fs.realpath(ancestor.dir) !== ancestor.dir) return false;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    if (!text.endsWith('\n')) return false;
    const lines = text.slice(0, -1).split('\n'); if (lines.length > 4096) return false;
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    const nodes = new Map<string, { type: string; parent: string | null; identity: string; userContent?: string; idleRequest: boolean; idleResponse: boolean }>();
    for (const line of lines) {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
      if (row.isSidechain !== undefined && typeof row.isSidechain !== 'boolean') return false;
      if (row.isSidechain === true) continue;
      const message = row.type === 'user' || row.type === 'assistant';
      if (row.uuid === undefined && !message) continue;
      if (typeof row.uuid !== 'string' || !uuid.test(row.uuid) || typeof row.type !== 'string' || row.isSidechain !== false ||
          row.parentUuid !== null && (typeof row.parentUuid !== 'string' || !uuid.test(row.parentUuid)) ||
          row.sessionId !== input.conversationId || row.cwd !== input.cwd || message && row.message?.role !== row.type) return false;
      const content = row.message?.content;
      const texts = typeof content === 'string' ? [content] : Array.isArray(content)
        ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text) : [];
      const identity = JSON.stringify([row.type, row.parentUuid, row.sessionId, row.cwd, row.isSidechain, row.message?.role]);
      const userContent = row.type === 'user' ? JSON.stringify(content) : undefined;
      const existing = nodes.get(row.uuid);
      if (existing && (existing.identity !== identity || existing.userContent !== userContent)) return false;
      nodes.set(row.uuid, { type: row.type, parent: row.parentUuid, identity, userContent,
        idleRequest: row.type === 'user' && texts.some(value => value.includes(`RT_GATE IDLE ${input.marker}`)),
        idleResponse: existing?.idleResponse === true || row.type === 'assistant' && texts.includes(`RT_DONE_IDLE_${input.marker}`) });
    }
    // Native transcript writers can append an assistant before its user.
    // Only the complete, bound parent chain proves their actual turn order.
    for (const [id, response] of nodes) {
      if (!response.idleResponse) continue;
      const ancestors = new Set<string>(); let current: string | null = id, nearestUser: typeof response | undefined;
      while (current !== null) {
        const node = nodes.get(current);
        if (!node || ancestors.has(current)) return false;
        ancestors.add(current);
        if (node.type === 'user' && !nearestUser) nearestUser = node;
        current = node.parent;
      }
      if (nearestUser?.idleRequest && [...nodes].every(([key, node]) => node.type !== 'user' || ancestors.has(key))) return true;
    }
    return false;
  } catch { return false; }
  finally { await handle?.close(); }
}
