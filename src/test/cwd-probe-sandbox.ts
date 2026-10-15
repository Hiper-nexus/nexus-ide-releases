import { spawnSync } from 'node:child_process';

/**
 * Portão de regressão sob Seatbelt: a sonda real de cwd (`listProcessCwds`,
 * F-908) começa pelo `/bin/ps`, que é setuid, e o Seatbelt do portão recusa
 * executar binário setuid (`spawn EPERM`, mesma recusa do F-715). A sonda
 * falha fechada (`null`, sem prova) e todo teste que exige uma PROVA real de
 * "fora de uso" falhava por ambiente — o portão lia como regressão.
 *
 * A decisão olha o SO cru, nunca a sonda sob teste: pula só quando o `ps`
 * recusa o spawn com EPERM enquanto um binário comum executa. `ps` que roda,
 * ou que falha de outro jeito, não pula: uma sonda quebrada fora do sandbox
 * continua falhando o teste.
 */
export function cwdProbeSandboxEvidence(input: {
  readonly platform: NodeJS.Platform;
  readonly psSpawnError: unknown;
  readonly plainExecOk: boolean;
}): string | undefined {
  if (input.platform !== 'darwin' || !input.plainExecOk) return undefined;
  return (input.psSpawnError as { code?: unknown } | undefined)?.code === 'EPERM'
    ? '/bin/ps (setuid) recusado com spawn EPERM enquanto /usr/bin/true executa'
    : undefined;
}

let cached: { readonly reason: string | undefined } | undefined;

/** Motivo para pular (texto do reporter), ou `undefined` quando a sonda real pode provar. */
function cwdProbeSandboxSkipReason(): string | undefined {
  if (!cached) {
    const darwin = process.platform === 'darwin';
    const ps = darwin ? spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'pid='], { stdio: 'ignore', timeout: 5_000 }) : undefined;
    const plain = darwin ? spawnSync('/usr/bin/true', [], { stdio: 'ignore', timeout: 5_000 }) : undefined;
    const evidence = cwdProbeSandboxEvidence({
      platform: process.platform,
      psSpawnError: ps?.error,
      plainExecOk: plain?.status === 0 && !plain.error,
    });
    cached = {
      reason: evidence
        ? `AMBIENTE-SANDBOX (sonda de cwd, F-908): ${evidence}; a sonda real (ps + lsof) não prova nada aqui ` +
          'e falha fechada. Rode fora do sandbox do portão.'
        : undefined,
    };
  }
  return cached.reason;
}

/** Pula o teste corrente quando ele depende de uma PROVA da sonda real de cwd. */
export function skipIfCwdProbeDeniedBySandbox(context: { readonly skip: (note?: string) => never }): void {
  const reason = cwdProbeSandboxSkipReason();
  if (reason) context.skip(reason);
}
