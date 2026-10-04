import { cachedCliBinaryVersion, getEffectivePath, probeCliBinaryVersion } from '../path-resolver';
interface VersionPorts { cached(file: string): string | null | undefined; probe(file: string, effectivePath: string): Promise<string | null> }
const production: VersionPorts = { cached: file => cachedCliBinaryVersion(file, 'opencode'), probe: (file, effectivePath) => probeCliBinaryVersion(file, effectivePath, 'opencode') };
export function isOpenCodeOwnedServerProved(file: string): boolean { return cachedCliBinaryVersion(file, 'opencode')?.startsWith('2.') === true; }
/** OpenCode2's shared service cannot inherit this pane's environment/sandbox.
 * Version proof is bound to the selected installation and never synchronously
 * executes a CLI. Legacy1 keeps its existing argv. */
export async function prepareOpenCodeSessionArgs(file: string, args: readonly string[], effectivePath = getEffectivePath(), ports: VersionPorts = production): Promise<string[]> {
  let version = ports.cached(file);
  if (version === undefined) { await ports.probe(file, effectivePath); version = ports.cached(file); }
  const major = version && /^(\d+)\./.exec(version)?.[1];
  if (major === '1') return [...args];
  if (major !== '2') throw new Error('opencode_session_version_unproved');
  if (args.some(arg => arg === '--server' || arg.startsWith('--server='))) throw new Error('opencode_external_service_not_pane_owned');
  return args.includes('--standalone') ? [...args] : [...args, '--standalone'];
}
