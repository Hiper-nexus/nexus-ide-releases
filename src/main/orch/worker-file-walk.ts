import fs from 'node:fs/promises';
import path from 'node:path';

/** Incremental, capped metadata acquisition; no recursive synchronous FS. */
export async function listChangedMtimeFiles(
  cwd: string,
  sinceMs: number,
  options: {
    readonly maxFiles: number;
    readonly maxDepth: number;
    readonly maxEntries: number;
    readonly skipDirectories: ReadonlySet<string>;
    readonly inclusive?: boolean;
  },
): Promise<string[]> {
  if (!cwd.trim() || !Number.isFinite(sinceMs)) return [];
  let root: string;
  try { root = await fs.realpath(cwd); } catch { return []; }
  const found: string[] = [];
  const stack = [{ absolute: root, relative: '', depth: 0 }];
  let entriesSeen = 0;
  while (stack.length && entriesSeen < options.maxEntries && found.length < options.maxFiles) {
    const directory = stack.pop()!;
    let handle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      const stat = await fs.lstat(directory.absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const canonical = await fs.realpath(directory.absolute);
      if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) continue;
      handle = await fs.opendir(directory.absolute, { bufferSize: 32 });
    } catch { continue; }
    try {
      while (entriesSeen < options.maxEntries && found.length < options.maxFiles) {
        const entry = await handle.read();
        if (!entry) break;
        entriesSeen++;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory.absolute, entry.name);
        const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!options.skipDirectories.has(entry.name) && directory.depth < options.maxDepth) {
            stack.push({ absolute, relative, depth: directory.depth + 1 });
          }
        } else if (entry.isFile()) {
          try {
            const stat = await fs.lstat(absolute);
            if (stat.isFile() && (options.inclusive ? stat.mtimeMs >= sinceMs : stat.mtimeMs > sinceMs)) found.push(relative);
          } catch { /* A removed/replaced entry contributes no evidence. */ }
        }
        // Ignored directories also consume the budget; a wide ignored tree
        // cannot evade the entry cap or run an unbroken Main loop.
        if (entriesSeen % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally { await handle.close(); }
  }
  return found;
}
