import { describe, expect, it } from 'vitest';
import { buildIntentDispatchKickoffPrompt } from './mission-dispatch-kickoff';
import type { Squad } from './orch-types';

/**
 * Trilha completa do prompt de bootstrap até os bytes que o CLI lê (bug F,
 * 05/08 — o operador recebeu "PREVC Guided n√£o aplica").
 *
 * Saltos auditados:
 *  1. Template pt-BR    → mission-dispatch-kickoff.ts (fonte UTF-8)
 *  2. Composição        → buildIntentDispatchKickoffPrompt (só concat de string)
 *  3. Renderer → main   → MissionWizard.tsx goalPrompt via IPC (structured clone)
 *  4. Sanitização       → pty-prompt-safety.ts assertSafePtyPrompt (identidade)
 *  5. Escrita no PTY    → tool-util.ts injectPastedPrompt → pty-manager.ts
 *                         orchWriteSession → proc.write(string) (node-pty: UTF-8)
 *  6. Decodificação     → locale do filho (pty-manager baseChildEnv →
 *                         ensureUtf8Locale) — O ÚNICO salto que já perdeu bytes
 *
 * Este teste prende os saltos 1-2 (fonte/composição não podem ser salvas em
 * charset legado) e nomeia o salto 6 no nível de byte: a mesma sequência UTF-8
 * lida por um decodificador single-byte é exatamente o mojibake do voo real.
 */
const squad = {
  id: 'squad-a',
  name: 'Execução + QA',
  orchestratorInstructions: 'Coordene execução e QA.',
  agents: [
    {
      id: 'agent-orch',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
      model: 'claude-fable-5',
      tools: [],
    },
    {
      id: 'agent-exec',
      agentName: 'Executor principal',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6',
      tools: [],
    },
  ],
} as unknown as Squad;

/** Marcas clássicas de UTF-8 relido como single-byte (latin1/MacRoman). */
const MOJIBAKE = /Ã[-¿]|â€|Â[ -¿]|√[£©¢∫]/u;

function fastPathPrompt(): string {
  return buildIntentDispatchKickoffPrompt({
    squad,
    missionId: 'mission-fast',
    goal: 'Continuar codando nosso sistema completo — story 2',
    acceptanceCriteria: ['Implementação entregue e validada'],
    risk: 'normal',
    maxWorkers: 6,
    standardTopology: 'delivery',
    guidedPrevcRequired: false,
  });
}

describe('kickoff pt-BR sobrevive a trilha inteira até o CLI', () => {
  it('detecta mojibake quando o texto é lido como single-byte', () => {
    // O detector precisa ser real: a amostra do voo real tem que acender.
    const corrupted = Buffer.from('PREVC Guided não aplica', 'utf8').toString(
      'latin1',
    );
    expect(MOJIBAKE.test(corrupted)).toBe(true);
    expect(MOJIBAKE.test('PREVC Guided não aplica')).toBe(false);
  });

  it('compõe acentuação pt-BR limpa — fonte e composição sem charset legado', () => {
    const prompt = fastPathPrompt();

    expect(MOJIBAKE.test(prompt)).toBe(false);
    expect(prompt).toContain('não');
    expect(prompt).toContain('missão');
    expect(prompt).toContain('—');
    expect(prompt).toContain('Implementação');
  });

  it('vira bytes UTF-8 e volta idêntico (o que node-pty escreve no filho)', () => {
    const prompt = fastPathPrompt();
    const bytes = Buffer.from(prompt, 'utf8');

    expect(bytes.toString('utf8')).toBe(prompt);
    // Multibyte de verdade: se algum salto tivesse achatado para ASCII, o
    // prompt teria o mesmo tamanho em bytes e caracteres.
    expect(bytes.byteLength).toBeGreaterThan(prompt.length);
    // E o defeito do voo real é exatamente ler ESSES bytes com um decodificador
    // single-byte — o que só o locale do filho decide (ensureUtf8Locale).
    expect(MOJIBAKE.test(bytes.toString('latin1'))).toBe(true);
  });

  it('mantém a acentuação depois do envelope de bracketed paste', () => {
    const prompt = fastPathPrompt();
    const pasted = `\x1b[200~${prompt}\x1b[201~`;

    expect(Buffer.from(pasted, 'utf8').toString('utf8')).toBe(pasted);
    expect(pasted).toContain('não');
    expect(MOJIBAKE.test(pasted)).toBe(false);
  });
});
