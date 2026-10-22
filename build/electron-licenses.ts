import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const VERSION = '43.8.3';
const FILES = [
  { name: 'LICENSE', bytes: 1096, sha256: '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d' },
  { name: 'LICENSES.chromium.html', bytes: 19956022, sha256: '7ae82e97b8a60b9d97871e0e11a05285aea2d42bef665f93f6a4f415235839ed' },
] as const;

/** Preserve the Mac template's actual texts before ASAR/rename/signing.
 * Never resolve a fallback from the coordinator's node_modules. */
export async function preserveMacElectronLicenses(buildPath: string, electronVersion: string, platform: string, arch: string): Promise<void> {
  if (platform !== 'darwin') return;
  if (electronVersion !== VERSION || !['arm64', 'x64'].includes(arch)) throw new Error('Electron legal version/architecture is not qualified');
  const resources = path.dirname(buildPath);
  const contents = path.dirname(resources);
  if (path.basename(buildPath) !== 'app' || path.basename(resources) !== 'Resources' || path.basename(contents) !== 'Contents') {
    throw new Error('Electron legal staging layout is invalid');
  }
  const templateRoot = path.dirname(path.dirname(contents));
  const captured = [];
  for (const file of FILES) {
    const handle = await fs.open(path.join(templateRoot, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.bytes) throw new Error(`Electron legal source ${file.name} is incomplete`);
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Electron legal source ${file.name} differs from ${VERSION}`);
      captured.push({ file, bytes });
    } finally { await handle.close(); }
  }
  const destination = path.join(resources, 'electron-licenses');
  await fs.mkdir(destination, { recursive: true });
  if (!(await fs.lstat(destination)).isDirectory()) throw new Error('Electron legal destination is not a directory');
  const write = async (name: string, bytes: Buffer) => {
    const handle = await fs.open(path.join(destination, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Electron legal destination is not a file');
      await handle.writeFile(bytes);
    } finally { await handle.close(); }
  };
  for (const { file, bytes } of captured) await write(file.name, bytes);
  await write('manifest.json', Buffer.from(JSON.stringify({
    schema: 'nexus.electron-licenses/v1', electronVersion: VERSION, platform, arch,
    sourceUrl: `https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-${platform}-${arch}.zip`,
    source: 'packager-extracted-template', files: FILES,
  }, null, 2) + '\n'));
}
