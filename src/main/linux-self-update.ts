/**
 * Auto-update do Linux para a instalação PORTÁTIL (o ZIP do `install.sh`, o caminho do Arch e do
 * Omarchy): o app baixa a versão nova, confere assinatura e SHA-256, extrai ao lado da instalação e,
 * ao reiniciar, troca a pasta e reabre. DEB e RPM pertencem ao gerenciador de pacotes (precisam de
 * root) e continuam no canal manual.
 *
 * Confiança: o `SHA256SUMS-linux-x64.txt` de cada versão é assinado com Ed25519
 * (linux-update-signing.ts). Os endereços de download são montados AQUI a partir da etiqueta e dos
 * nomes esperados, em repositórios conhecidos, nunca copiados do JSON da API. Só versão MAIOR que a
 * atual entra (sem downgrade). A pasta antiga fica ao lado como `.old` até a nova provar que sobe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cmpSemver } from './update-source';
import { trustedSha256For, type UpdateSigningKey } from './linux-update-signing';
import { extractLinuxZip } from './linux-zip-extract';
import { removeTree } from './util/remove-tree';

export const LINUX_SUMS_NAME = 'SHA256SUMS-linux-x64.txt';
export const LINUX_SIG_NAME = `${LINUX_SUMS_NAME}.sig`;
export const LINUX_ZIP_MAX_BYTES = 600 * 1024 * 1024;
const VERSION_RE = /^\d+\.\d+\.\d+$/u;
const TAG_RE = /^v\d+\.\d+\.\d+$/u;
const REPO_RE = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/u;
/** Estas pastas são do gerenciador de pacotes: o app não troca nada nelas. */
const SYSTEM_PREFIXES = ['/usr/', '/opt/', '/bin/', '/sbin/', '/lib/', '/snap/', '/nix/store/'] as const;

export type LinuxInstall =
  | { readonly kind: 'portable'; readonly installDir: string; readonly parentDir: string }
  | { readonly kind: 'system'; readonly reason: string };

export interface DetectDeps {
  readonly realpath?: (target: string) => string;
  readonly canWrite?: (target: string) => boolean;
  readonly exists?: (target: string) => boolean;
}

const defaultCanWrite = (target: string): boolean => {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Decide se esta instalação pode se trocar sozinha. Nunca lança. */
export function detectLinuxInstall(execPath: string, deps: DetectDeps = {}): LinuxInstall {
  try {
    const realpath = deps.realpath ?? fs.realpathSync;
    const canWrite = deps.canWrite ?? defaultCanWrite;
    const exists = deps.exists ?? fs.existsSync;
    const exe = realpath(execPath);
    if (!path.isAbsolute(exe) || path.basename(exe) !== 'nexus-ide') return { kind: 'system', reason: 'executável inesperado' };
    const installDir = path.dirname(exe);
    if (SYSTEM_PREFIXES.some((prefix) => `${installDir}/`.startsWith(prefix))) {
      return { kind: 'system', reason: 'instalado pelo gerenciador de pacotes' };
    }
    const parentDir = path.dirname(installDir);
    if (installDir === parentDir || !exists(path.join(installDir, 'resources', 'app.asar'))) {
      return { kind: 'system', reason: 'não parece o pacote portátil' };
    }
    if (!canWrite(installDir) || !canWrite(parentDir)) return { kind: 'system', reason: 'sem permissão de escrita' };
    return { kind: 'portable', installDir, parentDir };
  } catch {
    return { kind: 'system', reason: 'não consegui inspecionar a instalação' };
  }
}

export interface LinuxUpdateRelease {
  readonly version: string;
  readonly tag: string;
}

export interface StageDeps {
  /** Baixa um arquivo pequeno como texto; recusa mais que `maxBytes`. */
  readonly fetchText: (url: string, maxBytes: number) => Promise<string>;
  /** Baixa o ZIP para o disco, com progresso. */
  readonly download: (url: string, destination: string, onProgress?: (received: number, total?: number) => void) => Promise<void>;
  readonly onProgress?: (received: number, total?: number) => void;
  /** Só os testes trocam as chaves; em produção valem as embutidas no app. */
  readonly keys?: readonly UpdateSigningKey[];
  readonly log?: (event: string, detail?: unknown) => void;
}

const urlFor = (repo: string, tag: string, name: string): string =>
  `https://github.com/${repo}/releases/download/${tag}/${name}`;

/** O nome do ZIP e as três URLs do release, montados só com repositório conhecido e etiqueta válida. */
export function linuxUpdateUrls(repos: readonly string[], release: LinuxUpdateRelease): {
  zipName: string;
  candidates: Array<{ zip: string; sums: string; sig: string }>;
} | null {
  if (!VERSION_RE.test(release.version) || !TAG_RE.test(release.tag) || release.tag !== `v${release.version}`) return null;
  const zipName = `NexusIDE-linux-x64-${release.version}.zip`;
  const candidates = repos
    .filter((repo) => REPO_RE.test(repo))
    .map((repo) => ({
      zip: urlFor(repo, release.tag, zipName),
      sums: urlFor(repo, release.tag, LINUX_SUMS_NAME),
      sig: urlFor(repo, release.tag, LINUX_SIG_NAME),
    }));
  return candidates.length ? { zipName, candidates } : null;
}

export class UpdateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateRefused';
  }
}

async function sha256OfFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

export interface StagedUpdate {
  readonly version: string;
  readonly stagedDir: string;
  readonly keyId: string;
}

/**
 * Baixa, verifica e extrai a versão `release` ao lado da instalação (`<install>.new`). Só devolve se tudo
 * conferiu; em qualquer falha nada fica no disco. Sem `.sig` publicado para a versão = recusa (versões
 * antigas, anteriores à assinatura, não se atualizam sozinhas: o aviso manual continua valendo).
 */
export async function stageLinuxUpdate(input: {
  install: Extract<LinuxInstall, { kind: 'portable' }>;
  currentVersion: string;
  release: LinuxUpdateRelease;
  repos: readonly string[];
  deps: StageDeps;
}): Promise<StagedUpdate> {
  const { install, currentVersion, release, repos, deps } = input;
  const log = deps.log ?? (() => undefined);
  if (cmpSemver(release.version, currentVersion) <= 0) throw new UpdateRefused('a versão oferecida não é mais nova que a instalada');
  const plan = linuxUpdateUrls(repos, release);
  if (!plan) throw new UpdateRefused('versão ou etiqueta inválida');

  let trusted: { sha256: string; keyId: string } | null = null;
  let source: (typeof plan.candidates)[number] | null = null;
  let lastError: unknown = null;
  let refusal: UpdateRefused | null = null;
  for (const candidate of plan.candidates) {
    try {
      const [sums, signature] = await Promise.all([deps.fetchText(candidate.sums, 4096), deps.fetchText(candidate.sig, 256)]);
      const verified = trustedSha256For(sums, signature, plan.zipName, deps.keys);
      if (!verified) throw new UpdateRefused('assinatura das somas inválida ou ZIP fora da lista');
      trusted = verified;
      source = candidate;
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof UpdateRefused && !refusal) refusal = error;
      log('stage:source-failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!trusted || !source) {
    // Uma recusa de assinatura vale mais que um erro de rede de outra fonte: é o que o operador precisa ver.
    throw refusal ?? (lastError instanceof Error ? lastError : new UpdateRefused('não consegui as somas assinadas'));
  }

  const zipPath = path.join(install.parentDir, `.nexus-ide-update-${release.version}.zip`);
  const stagedDir = `${install.installDir}.new`;
  try {
    await removeTree(stagedDir, { force: true });
    await fs.promises.rm(zipPath, { force: true });
    await deps.download(source.zip, zipPath, deps.onProgress);
    const { sha256, size } = await sha256OfFile(zipPath);
    if (size > LINUX_ZIP_MAX_BYTES) throw new UpdateRefused('o ZIP baixado é grande demais');
    if (sha256 !== trusted.sha256) throw new UpdateRefused('o SHA-256 do ZIP não confere com as somas assinadas');
    await extractLinuxZip(zipPath, stagedDir);
    log('stage:ready', { version: release.version, keyId: trusted.keyId });
    return { version: release.version, stagedDir, keyId: trusted.keyId };
  } catch (error) {
    await removeTree(stagedDir, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.promises.rm(zipPath, { force: true }).catch(() => undefined);
  }
}

/** Constante: o que o app grava e roda ao reiniciar. Recebe só caminhos já validados, como argumentos. */
export const APPLY_SCRIPT = `#!/bin/sh
# NexusIDE: troca a pasta da instalação depois que o app fecha e reabre. Args: PID NOVO DESTINO
set -u
pid="$1"; new="$2"; dest="$3"; old="$dest.old"
case "$dest" in /*) ;; *) exit 64 ;; esac
[ "$new" = "$dest.new" ] || exit 64
[ -x "$new/nexus-ide" ] || exit 65
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 150 ] && exit 66
  sleep 0.2
done
rm -rf "$old"
mv "$dest" "$old" || exit 67
if ! mv "$new" "$dest"; then mv "$old" "$dest"; exit 68; fi
nohup "$dest/nexus-ide" >/dev/null 2>&1 &
`;

export interface ApplyDeps {
  readonly writeScript: (scriptPath: string, content: string) => void;
  readonly spawnDetached: (command: string, args: string[]) => void;
}

/** Grava o script (0700) e o dispara solto. O app precisa sair logo em seguida. */
export function launchApplyHelper(input: {
  scriptPath: string;
  pid: number;
  install: Extract<LinuxInstall, { kind: 'portable' }>;
  deps: ApplyDeps;
}): void {
  const { scriptPath, pid, install, deps } = input;
  if (!Number.isInteger(pid) || pid <= 1) throw new UpdateRefused('pid inválido');
  if (!path.isAbsolute(scriptPath) || !path.isAbsolute(install.installDir)) throw new UpdateRefused('caminho precisa ser absoluto');
  deps.writeScript(scriptPath, APPLY_SCRIPT);
  deps.spawnDetached('/bin/sh', [scriptPath, String(pid), `${install.installDir}.new`, install.installDir]);
}

/** A instalação antiga fica por perto até a nova provar que sobe; depois de `delayMs` de vida, some. */
export function scheduleOldInstallCleanup(
  install: Extract<LinuxInstall, { kind: 'portable' }>,
  delayMs = 90_000,
  remove: (target: string) => Promise<void> = (target) => removeTree(target, { force: true }),
): ReturnType<typeof setTimeout> | null {
  const old = `${install.installDir}.old`;
  if (!fs.existsSync(old)) return null;
  const timer = setTimeout(() => {
    void remove(old).catch(() => undefined);
  }, delayMs);
  timer.unref?.();
  return timer;
}
