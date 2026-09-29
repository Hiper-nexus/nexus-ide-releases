// F-688: o Codex do npm (>= 0.157) roda TODA ferramenta no Windows por
// `codex-code-mode-host.exe`, que mora dentro do próprio pacote. Com o Node
// portátil do WinGet o prefixo global do npm é a pasta do Node
// (`%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_…\node-v22…`),
// e com um nome de usuário comprido esse caminho passa do MAX_PATH: o Windows
// recusa o processo (`os error 3`) e o pane conversa, mas nenhuma ferramenta
// roda. O prefixo curto `%USERPROFILE%\.local\bin` cabe com folga.

import fs from 'node:fs';
import path from 'node:path';

/** MAX_PATH (260) conta o NUL final: sobram 259 caracteres para o caminho. */
export const WINDOWS_MAX_PATH_CHARS = 259;

export function codexWindowsHostPath(prefix: string, arch: string = process.arch): string {
  const [pkg, triple] = arch === 'arm64'
    ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc']
    : ['codex-win32-x64', 'x86_64-pc-windows-msvc'];
  return path.win32.join(
    prefix,
    'node_modules', '@openai', 'codex',
    'node_modules', '@openai', pkg,
    'vendor', triple, 'bin', 'codex-code-mode-host.exe',
  );
}

export function codexWindowsPrefixFits(prefix: string, arch?: string): boolean {
  return codexWindowsHostPath(prefix, arch).length <= WINDOWS_MAX_PATH_CHARS;
}

export function codexWindowsShortPrefix(home: string): string {
  return path.win32.join(home, '.local', 'bin');
}

export class CodexWindowsPathTooLongError extends Error {
  constructor(readonly prefix: string, readonly hostPathLength: number) {
    super(
      `Codex: a instalação em ${prefix} fica num caminho longo demais para o Windows ` +
        `(${hostPathLength} caracteres; o limite é ${WINDOWS_MAX_PATH_CHARS}) e nenhuma ` +
        'ferramenta dele roda. Use "Atualizar CLI" no Nexus, que reinstala num prefixo ' +
        'curto, ou rode: npm i -g --prefix "%USERPROFILE%\\.local\\bin" @openai/codex',
    );
    this.name = 'CodexWindowsPathTooLongError';
  }
}

/**
 * O atalho `codex.cmd` que o pane deve abrir. Mantém o resolvido quando ele
 * não é um atalho npm com o host de ferramentas, ou quando o host cabe no
 * MAX_PATH. Senão troca pela instalação curta verificada; sem ela, recusa com
 * a correção em vez de abrir um pane que falha em toda ferramenta.
 */
export function windowsCodexShimWithinMaxPath(
  binPath: string,
  options: {
    readonly home: string;
    readonly arch?: string;
    readonly exists?: (candidate: string) => boolean;
  },
): string {
  if (!/\.cmd$/iu.test(binPath)) return binPath;
  const exists = options.exists ?? fs.existsSync;
  const prefix = path.win32.dirname(binPath);
  const hostPath = codexWindowsHostPath(prefix, options.arch);
  if (hostPath.length <= WINDOWS_MAX_PATH_CHARS || !exists(hostPath)) return binPath;

  const shortPrefix = codexWindowsShortPrefix(options.home);
  const shortShim = path.win32.join(shortPrefix, 'codex.cmd');
  if (
    shortShim.toLowerCase() !== binPath.toLowerCase() &&
    codexWindowsPrefixFits(shortPrefix, options.arch) &&
    exists(shortShim) &&
    exists(codexWindowsHostPath(shortPrefix, options.arch))
  ) {
    return shortShim;
  }
  throw new CodexWindowsPathTooLongError(prefix, hostPath.length);
}
