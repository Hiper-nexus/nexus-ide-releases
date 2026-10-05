import { isPathInsideOrEqual } from './worktree-removal-safety';

/**
 * Varredura de PTY do teardown de worktree.
 *
 * O `#releaseDeadOwnerWorktrees` libera o REGISTRO do worktree quando a task ou
 * a missão dona morreu — e o próprio log declara que "no Git path or ref was
 * removed". O que ninguém fazia era olhar para os processos: um PTY com `cwd`
 * dentro daquele worktree continua vivo escrevendo num diretório que o sistema
 * já considera liberado. Daí nasce o worktree órfão que trava missões futuras.
 *
 * Ideia portada do Orca (MIT, `src/main/runtime/worktree-teardown.ts`): antes de
 * dar um worktree por encerrado, mate todo PTY que se PROVE pertencer a ele.
 * A prova aqui é de caminho — `cwd` contido na raiz do worktree — usando a mesma
 * função de contenção já testada do worktree-removal-safety.
 */

export interface LiveSessionLocation {
  readonly sessionId: string;
  /** `cwd` de spawn da sessão; nulo quando a sessão já morreu entre a listagem
   *  e a leitura. */
  readonly cwd: string | null;
}

/**
 * Sessões que provadamente moram dentro do worktree.
 *
 * Fail-CLOSED ao contrário do usual: na dúvida NÃO mata. Um `cwd` ausente ou um
 * caminho de worktree vazio devolve nenhuma sessão, porque matar o PTY errado
 * derruba trabalho real do operador — o custo de deixar um processo sobrando é
 * um aviso, o de matar o processo errado é perder trabalho.
 */
export function sessionsInsideWorktree(input: {
  readonly worktreePath: string;
  readonly sessions: readonly LiveSessionLocation[];
}): readonly string[] {
  const root = input.worktreePath.trim();
  if (!root) return Object.freeze([]);
  const matched: string[] = [];
  for (const session of input.sessions) {
    const cwd = session.cwd?.trim();
    if (!cwd) continue;
    if (!isPathInsideOrEqual(root, cwd)) continue;
    matched.push(session.sessionId);
  }
  return Object.freeze(matched);
}

export interface WorktreePtySweepPorts {
  readonly listSessions: () => readonly LiveSessionLocation[];
  readonly terminate: (sessionId: string) => Promise<unknown>;
}

/**
 * Injeção em vez de import direto: `pty-manager` já importa de `runtime/`
 * (process-sandbox, linked-worktree-git-paths), então importá-lo de volta aqui
 * fecharia um ciclo ESM — a classe de bug em que um símbolo chega `undefined`
 * no import sem ninguém perceber. Mesmo padrão do
 * `configureProviderFailureWaiver`: o bootstrap de produção liga as pontas.
 */
let configuredPorts: WorktreePtySweepPorts | null = null;

export function configureWorktreePtySweep(
  ports: WorktreePtySweepPorts | null,
): void {
  configuredPorts = ports;
}

/**
 * Encerra os PTYs que provadamente moram no worktree liberado.
 *
 * Best-effort e NUNCA lança: isto roda dentro da liberação de worktree, que por
 * sua vez roda no caminho de dispatch. Uma limpeza oportunista não pode
 * derrubar o despacho de uma missão — por isso todo erro vira aviso.
 *
 * Fire-and-forget de propósito: o encerramento é assíncrono e com prova física,
 * enquanto a liberação do registro é síncrona. Esperar aqui seria bloquear o
 * scheduler por um processo que já perdeu o dono.
 */
export function sweepPtysInsideWorktree(worktreePath: string): readonly string[] {
  const ports = configuredPorts;
  if (!ports) return Object.freeze([]);
  let doomed: readonly string[] = Object.freeze([]);
  try {
    doomed = sessionsInsideWorktree({
      worktreePath,
      sessions: ports.listSessions(),
    });
  } catch (error) {
    console.warn('[worktree-runtime] varredura de PTY do worktree pulada', error);
    return Object.freeze([]);
  }
  if (doomed.length === 0) return doomed;
  console.warn(
    `[worktree-runtime] encerrando ${doomed.length} PTY(s) que continuavam ` +
      `dentro do worktree liberado ${worktreePath}`,
  );
  for (const sessionId of doomed) {
    try {
      void Promise.resolve(ports.terminate(sessionId)).catch((error: unknown) => {
        console.warn(
          `[worktree-runtime] PTY ${sessionId} não confirmou encerramento:`,
          error,
        );
      });
    } catch (error) {
      console.warn(
        `[worktree-runtime] PTY ${sessionId} recusou o encerramento:`,
        error,
      );
    }
  }
  return doomed;
}

/**
 * F-908: há sessão viva com `cwd` dentro do worktree? Prova de "fora de uso"
 * da coleta de worktrees paradas. Fail-closed no sentido inverso da varredura
 * acima: sem portas ligadas ou com erro na listagem, conta como EM USO, porque
 * aqui o custo do engano é apagar o diretório de um processo vivo.
 */
export function worktreeHasLiveSession(worktreePath: string): boolean {
  const ports = configuredPorts;
  if (!ports) return true;
  try {
    return sessionsInsideWorktree({ worktreePath, sessions: ports.listSessions() }).length > 0;
  } catch {
    return true;
  }
}
