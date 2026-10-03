import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { redactSecretText } from '../terminal/command-redaction';
import type { ProjectExecutionScope } from '../../shared/types';
import { getWorkspaceMemoryStore, MAX_MEMORY_CONTENT_BYTES, type RetainResult } from './workspace-memory';

/** Operator-selected file only. Does not search HOME, follow final symlinks or write native state. */
export async function importNativeMemoryFile(scope: ProjectExecutionScope, file: string,
  assertOperatorScope: () => void): Promise<RetainResult> {
  assertOperatorScope();
  if (!path.isAbsolute(file) || !/\.(md|txt)$/i.test(file)) throw new Error('native memory file type');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let content: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MEMORY_CONTENT_BYTES) throw new Error('native memory size');
    const buffer = Buffer.alloc(MAX_MEMORY_CONTENT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_MEMORY_CONTENT_BYTES) throw new Error('native memory size changed');
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (content.includes('\0') || !content.trim()) throw new Error('native memory text');
  } finally { await handle.close(); }
  assertOperatorScope();
  const hash = createHash('sha256').update(redactSecretText(content).text).digest('hex');
  const basename = path.basename(file).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 48);
  // Provenance is a separate canonical field: never truncate native knowledge to fit a header.
  return getWorkspaceMemoryStore(scope).retain({ content, kind: 'note', source: `imported:native:${basename}:${hash}` },
    { quarantine: 'operator-selected native import; unverified', vault: false });
}
