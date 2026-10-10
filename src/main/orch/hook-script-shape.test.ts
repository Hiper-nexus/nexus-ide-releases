import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT } from './hooks-gen';

/**
 * F-1154 — a forma do hook depois da doutrina do dono (10/10/2026): agentes do
 * Nexus têm acesso a tudo e o Nexus fora do ar nunca bloqueia ferramenta.
 *
 * O hook antigo era um gate de autorização síncrono e fail-closed em toda
 * ferramenta, mais Stop/PostToolUse sem efeito no Main. O que sobra é só a
 * entrega do relato (F-795): com o Main inalcançável, o nexus_handoff_submit
 * vai para o spool assinado. Este teste impede que alguém reintroduza o gate
 * bloqueante "por segurança" sem pedido do dono.
 */
describe('forma do hook de entrega do handoff', () => {
  it('não autoriza nem bloqueia ferramenta: a única saída 2 é a do spool', () => {
    expect(HOOK_SCRIPT.match(/process\.exit\(2\)/g)).toHaveLength(1);
    expect(HOOK_SCRIPT).toMatch(/spooled[\s\S]*process\.exit\(2\)/);
    expect(HOOK_SCRIPT).not.toContain('gate unreachable');
    expect(HOOK_SCRIPT).not.toContain('blocking');
    expect(HOOK_SCRIPT).not.toContain('verdict');
  });

  it('só o nexus_handoff_submit degrada para o disco', () => {
    expect(HOOK_SCRIPT).toContain("nexus[1] !== 'nexus_handoff_submit'");
    expect(HOOK_SCRIPT).not.toContain('OFFLINE_NATIVE_READ_TOOLS');
  });

  it('não sobra caminho de Stop nem processo destacado', () => {
    expect(HOOK_SCRIPT).not.toContain('detached');
    expect(HOOK_SCRIPT).not.toContain("'node:child_process'");
  });

  it('o script diz por que não é gate, para ninguém religar a allowlist', () => {
    expect(HOOK_SCRIPT).toMatch(/NÃO é gate de autorização/);
    expect(HOOK_SCRIPT).toMatch(/nunca bloqueia/);
  });
});
