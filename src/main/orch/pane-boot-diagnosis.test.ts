import { describe, expect, it } from 'vitest';
import { diagnosePaneBoot } from './pane-boot-diagnosis';

/** Cauda real do pane-muym5dik-a (AGY 1.3.0, 07/10 18:22). */
const AGY_UNKNOWN_MODEL =
  'error: invalid model selection (--model "gemini-4-argon" --effort ""): model gemini-4-argon ' +
  'is not recognized as a known model or custom model in settings\nAvailable models:\n' +
  'Gemini 3.8 Flash (High)\nGemini 3.8 Flash (Medium)';

describe('F-958 — motivo legível do pane que não começou', () => {
  it('AGY que não reconhece o modelo: recusa de modelo com o id e o código de saída', () => {
    expect(diagnosePaneBoot(AGY_UNKNOWN_MODEL, 1)).toEqual({
      rejectedModel: 'gemini-4-argon',
      modelRejected: true,
      detail: 'a CLI instalada não reconhece o modelo "gemini-4-argon"; saiu com código 1',
    });
  });

  it('--effort recusado (F-773) é parâmetro, não modelo: não tira o modelo das rotas', () => {
    const effort =
      'E1003 printmode.go:304] Print mode: invalid model selection (--model "gemini-4-argon" ' +
      '--effort "high"): --effort is not supported for model "gemini-4-argon"';
    expect(diagnosePaneBoot(effort, 1)).toMatchObject({ modelRejected: false, rejectedModel: null });
  });

  it('recusa canônica de outra CLI (failover) também conta como modelo recusado', () => {
    const codex = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade.";
    expect(diagnosePaneBoot(codex, 1)).toMatchObject({ modelRejected: true, rejectedModel: null });
  });

  it('fila de pesados do Nexus vira frase fixa, sem a saída crua', () => {
    expect(diagnosePaneBoot('nexus-heavy: local admission request failed\n', 74)).toEqual({
      rejectedModel: null,
      modelRejected: false,
      detail: 'a fila de comandos pesados do Nexus (nexus-heavy) não liberou a vaga; saiu com código 74',
    });
  });

  it('sem nada reconhecido, só o código de saída (ou nada)', () => {
    expect(diagnosePaneBoot('segredo sk-live-123 qualquer coisa', 2).detail).toBe('saiu com código 2');
    expect(diagnosePaneBoot(null, 0).detail).toBeNull();
    expect(diagnosePaneBoot('', null).detail).toBeNull();
  });
});
