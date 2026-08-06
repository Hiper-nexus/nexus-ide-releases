/**
 * Adaptador REAL da reversibilidade destrutiva: lixeira do SO e refs do git.
 *
 * Separado de `destructive-reversibility-io.ts` de propósito — a decisão e a
 * mecânica são testadas com IO falso, e este arquivo é a única superfície que
 * toca disco. Ele não tem lógica: se alguma condição aparecer aqui, ela está no
 * lugar errado.
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { shell } from 'electron';
import type { ReversibilityIo } from './destructive-reversibility-io';

const execFileAsync = promisify(execFile);

/** Teto de tempo: git travado não pode pendurar o dispatch inteiro. */
const GIT_TIMEOUT_MS = 10_000;

export function createSystemReversibilityIo(): ReversibilityIo {
  return {
    async trash(absolutePath: string): Promise<void> {
      // `shell.trashItem` rejeita quando o SO recusa — e essa rejeição PRECISA
      // subir: o chamador só deixa o `rm` rodar depois que a lixeira confirmou.
      // Engolir aqui apagaria o arquivo de vez. Caminho AUSENTE não chega aqui:
      // o chamador filtra por `exists` antes, porque trashItem também rejeita
      // nesse caso (medido em Electron real) e limpeza idempotente é comum.
      await shell.trashItem(absolutePath);
    },

    async exists(absolutePath: string): Promise<boolean> {
      try {
        await fsp.access(absolutePath);
        return true;
      } catch {
        return false;
      }
    },

    async revParse(cwd: string, revision: string): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--verify', '--quiet', revision],
          { cwd, timeout: GIT_TIMEOUT_MS },
        );
        const sha = stdout.trim();
        return sha.length > 0 ? sha : null;
      } catch {
        // Revisão inexistente (branch sem upstream, repo recém-criado) sai por
        // exit code. É ausência de coisa a perder, não falha — o chamador
        // degrada para registro.
        return null;
      }
    },

    async updateRef(cwd: string, ref: string, sha: string): Promise<void> {
      await execFileAsync('git', ['update-ref', ref, sha], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
    },

    resolvePath(cwd: string, target: string): string {
      return isAbsolute(target) ? target : resolve(cwd, target);
    },
  };
}
