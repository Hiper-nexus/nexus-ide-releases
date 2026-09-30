import fs from 'node:fs';
import path from 'node:path';

/**
 * F-706: no Windows o Muse Code instala `muse.cmd` → `.muse-launcher.ps1`
 * (PowerShell) → `muse-bin-<versão>.exe`. Um `.cmd` não pode levar o brief no
 * argv (F-668/F-670: o cmd.exe corta na quebra de linha), então o brief ia
 * para a colagem depois do boot — e no Muse ela nunca pegava: workers de
 * missão ficaram horas com o composer vazio, sem nenhum handoff. O binário
 * aceita o prompt posicional (`muse [OPTIONS] [PROMPT]`), então o Nexus faz
 * o que o launcher faz na hora de rodar: resolve o binário ativo por
 * `.muse-version` e repassa `MUSE_RELEASE_INFO` quando a versão confere. A
 * checagem de atualização do launcher fica para quando o operador usa o
 * `muse` fora do Nexus.
 */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/u;

export interface MuseLauncherSpawn {
  readonly file: string;
  readonly argsPrefix: string[];
  readonly env: Record<string, string>;
}

export function windowsMuseLauncherSpawn(launcherPath: string): MuseLauncherSpawn | null {
  if (path.basename(launcherPath).toLowerCase() !== 'muse.cmd') return null;
  const dir = path.dirname(launcherPath);
  try {
    // Dono do atalho: o launcher oficial ao lado dele, não um .cmd qualquer.
    if (!fs.readFileSync(launcherPath, 'utf8').includes('.muse-launcher.ps1')) return null;
    if (!fs.statSync(path.join(dir, '.muse-launcher.ps1')).isFile()) return null;
    const version = fs.readFileSync(path.join(dir, '.muse-version'), 'utf8').trim();
    if (!VERSION_PATTERN.test(version)) return null;
    const binary = path.join(dir, `muse-bin-${version}.exe`);
    if (!fs.statSync(binary).isFile()) return null;
    return { file: binary, argsPrefix: [], env: releaseInfoEnv(dir, version) };
  } catch {
    return null;
  }
}

function releaseInfoEnv(dir: string, version: string): Record<string, string> {
  try {
    const content = fs.readFileSync(path.join(dir, '.muse-release-info.json'), 'utf8');
    const parsed = JSON.parse(content) as { version?: unknown };
    return parsed.version === version ? { MUSE_RELEASE_INFO: content } : {};
  } catch {
    return {};
  }
}
