import { writeFile } from 'node:fs/promises';
import { normalizeReleases } from '../src/downloads/releases.js';

const response = await fetch('https://api.github.com/repos/Hiper-nexus/nexus-ide-releases/releases?per_page=100', {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NexusIDE-public-site' },
});
if (!response.ok) throw new Error(`Public releases request failed: ${response.status}`);
const catalog = normalizeReleases(await response.json());
if (!catalog.macos.length || !catalog.windows.length) throw new Error('Public catalog has no compatible installer for one of the supported systems.');
const snapshot = { checkedAt: new Date().toISOString(), catalog };
await writeFile(new URL('../src/downloads/snapshot.js', import.meta.url), `// Public GitHub releases only. Refresh with npm run releases:update.\nexport default ${JSON.stringify(snapshot, null, 2)};\n`);
console.log(`Public catalog updated: macOS ${catalog.macos[0].version}; Windows ${catalog.windows[0].version}.`);
