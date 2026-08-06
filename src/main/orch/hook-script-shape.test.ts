import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT } from './hooks-gen';

/**
 * D5 — a forma do hook, e por que ela NÃO pode ser unificada entre eventos.
 *
 * Medido no motor do Overclock (handoff-deliver.mjs:400-430, handoff-stop.mjs:
 * 497-520): o processo que a CLI espera NÃO faz I/O de rede — grava o payload,
 * relança a si mesmo `detached` e sai `exit 0` em milissegundos. E é FAIL-OPEN
 * no `stop`, por escolha explícita documentada no próprio arquivo deles:
 * "eco a mais é ruído; resultado perdido é o bug que este mecanismo conserta".
 *
 * É por isso que eles podem instalar o hook em todo pane sem risco, e é
 * exatamente o que faltava ao nosso: o nosso era síncrono e fail-closed, e essa
 * é a razão DOCUMENTADA (auditoria 0fe423aa) de nunca o termos instalado no
 * caminho padrão — gate fora do ar trancaria o worker.
 *
 * A DISTINÇÃO É INEGOCIÁVEL e este teste existe para impedir que uma futura
 * refatoração "unifique os eventos por consistência":
 *   · `stop`    = obrigação de RELATO      → desacoplado, fail-OPEN
 *   · `pretool` = gate de AUTORIZAÇÃO      → síncrono,    fail-CLOSED
 * Um gate de autorização fail-open não é gate: é convite.
 */
describe('forma do hook por evento', () => {
  it('pretool continua SÍNCRONO e FAIL-CLOSED', () => {
    // Gate inalcançável tem de bloquear a tool call. É o comportamento correto.
    expect(HOOK_SCRIPT).toContain('gate unreachable');
    expect(HOOK_SCRIPT).toMatch(/pretool[\s\S]*exit\(2\)|exit\(2\)[\s\S]*pretool/);
  });

  it('stop NÃO bloqueia quando o gate está fora do ar (fail-open)', () => {
    // O worker precisa conseguir encerrar mesmo com o gate indisponível.
    expect(HOOK_SCRIPT).toMatch(/stop[\s\S]*fail-open|fail-open[\s\S]*stop/i);
  });

  it('stop é DESACOPLADO: o pai sai sem esperar rede', () => {
    expect(HOOK_SCRIPT).toContain('detached');
    expect(HOOK_SCRIPT).toContain('unref');
  });

  it('o script diz POR QUE as formas divergem, para ninguém unificá-las', () => {
    expect(HOOK_SCRIPT).toMatch(/autoriza|authorization/i);
    expect(HOOK_SCRIPT).toMatch(/relato|report/i);
  });
});
