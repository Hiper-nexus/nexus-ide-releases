import { describe, expect, it } from 'vitest';
import {
  NEXUS_BROWSER_BRIEF_RULE,
  NEXUS_BROWSER_PAGE_TOOLS,
  NEXUS_BROWSER_UNAVAILABLE_HINT,
  NEXUS_BROWSER_WORKER_TOOLS,
  browserUnavailableError,
  defaultMissionWorkerTools,
  hasNexusBrowserAlternative,
} from './nexus-browser-policy';

describe('F-781: o navegador do Nexus está ao alcance do pane?', () => {
  it.each([
    {
      caso: 'worker de missão sem allowlist (livre)',
      subject: { role: 'worker' as const, missionId: 'm-1', allowedTools: null },
      expected: true,
    },
    {
      caso: 'orquestrador de missão',
      subject: { role: 'orchestrator' as const, missionId: 'm-1', allowedTools: null },
      expected: true,
    },
    {
      caso: 'worker com allowlist que dá abrir, navegar e ler',
      subject: {
        role: 'worker' as const,
        missionId: 'm-1',
        allowedTools: [...NEXUS_BROWSER_PAGE_TOOLS],
      },
      expected: true,
    },
    {
      caso: 'filho do operador (modo vibe) sem allowlist',
      subject: { role: 'user' as const, allowedTools: null, operatorChild: true },
      expected: true,
    },
    // F-1157: allowlist e somente-leitura não tiram mais o navegador.
    {
      caso: 'worker de missão com allowlist vazia (o padrão do spawn ad hoc)',
      subject: { role: 'worker' as const, missionId: 'm-1', allowedTools: [] },
      expected: true,
    },
    {
      caso: 'allowlist só com leitura',
      subject: {
        role: 'worker' as const,
        missionId: 'm-1',
        allowedTools: ['nexus_browser_read'],
      },
      expected: true,
    },
    {
      caso: 'pane que era somente leitura',
      subject: {
        role: 'worker' as const,
        missionId: 'm-1',
        allowedTools: null,
        readOnly: true,
      },
      expected: true,
    },
    {
      caso: 'worker sem missão (efeito recusado no dispatch)',
      subject: { role: 'worker' as const, allowedTools: null },
      expected: false,
    },
    {
      caso: 'mão do operador (pane "+", modo vibe)',
      subject: { role: 'user' as const, allowedTools: null },
      expected: false,
    },
    {
      caso: 'filho do operador com allowlist vazia',
      subject: { role: 'user' as const, allowedTools: [], operatorChild: true },
      expected: true,
    },
  ])('$caso → $expected', ({ subject, expected }) => {
    expect(hasNexusBrowserAlternative(subject)).toBe(expected);
  });
});

describe('F-781: textos da regra', () => {
  it('F-1157: a regra do brief recomenda o navegador (incluindo autopilot Jev e juiz visual Clef) e não proíbe WebFetch, fetch nativo nem curl', () => {
    for (const piece of [
      'nexus_browser_open',
      'nexus_browser_read',
      'nexus_browser_navigate',
      'nexus_browser_do',
      'nexus_browser_extract',
      'nexus_browser_judge_visual',
      'judge: true',
      'truncated: true',
    ]) {
      expect(NEXUS_BROWSER_BRIEF_RULE).toContain(piece);
    }
    expect(NEXUS_BROWSER_BRIEF_RULE).toContain('WebFetch, o fetch nativo da sua CLI e curl também estão liberados');
    expect(NEXUS_BROWSER_BRIEF_RULE).not.toMatch(/Não use|só para/u);
    expect(NEXUS_BROWSER_BRIEF_RULE).toContain('busca na web nativa continua valendo');
  });
});

describe('F-797: allowlist padrão do worker de missão', () => {
  it('worker gravável de missão recebe as tools de página; só leitura e extração', () => {
    const tools = defaultMissionWorkerTools({ missionWorker: true, readOnly: false });
    expect(tools).toEqual([...NEXUS_BROWSER_WORKER_TOOLS]);
    for (const page of NEXUS_BROWSER_PAGE_TOOLS) expect(tools).toContain(page);
    for (const action of [
      'nexus_browser_click', 'nexus_browser_fill', 'nexus_browser_press', 'nexus_browser_hover',
      'nexus_browser_scroll', 'nexus_browser_do', 'nexus_browser_responsive', 'nexus_computer_do',
      'nexus_terminal_run', 'nexus_file_write',
    ]) {
      expect(tools).not.toContain(action);
    }
    // Cada chamada devolve uma cópia: ninguém altera a lista compartilhada.
    expect(defaultMissionWorkerTools({ missionWorker: true, readOnly: false })).not.toBe(tools);
  });

  it('analista somente leitura e filho do operador em modo governado seguem com []', () => {
    expect(defaultMissionWorkerTools({ missionWorker: true, readOnly: true })).toEqual([]);
    expect(defaultMissionWorkerTools({ missionWorker: false, readOnly: false })).toEqual([]);
  });

  it('com a lista padrão o worker alcança o navegador e o brief liga sozinho, inclusive no analista somente leitura', () => {
    expect(
      hasNexusBrowserAlternative({
        role: 'worker',
        missionId: 'm-1',
        allowedTools: defaultMissionWorkerTools({ missionWorker: true, readOnly: false }),
      }),
    ).toBe(true);
    // F-1157: readOnly e allowlist vazia não tiram mais o navegador; só a
    // falta de missão tira (o dispatch recusa efeito de missão sem missão).
    expect(
      hasNexusBrowserAlternative({
        role: 'worker',
        missionId: 'm-1',
        readOnly: true,
        allowedTools: defaultMissionWorkerTools({ missionWorker: true, readOnly: true }),
      }),
    ).toBe(true);
  });

  it('o erro de aba indisponível mantém o motivo e aponta o caminho (curl + handoff)', () => {
    const message = browserUnavailableError('no renderer window available');
    expect(message.startsWith('no renderer window available — ')).toBe(true);
    expect(message).toContain(NEXUS_BROWSER_UNAVAILABLE_HINT);
    expect(NEXUS_BROWSER_UNAVAILABLE_HINT).toContain('curl -sL <url>');
    expect(NEXUS_BROWSER_UNAVAILABLE_HINT).toContain('registre no handoff');
  });
});
