import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isContainedInWorkspace,
  scanHtmlCandidates,
  objectiveWantsBrowserOpen,
  openMissionDeliverable,
  pickFromArtifactRefs,
  pickOpenableDeliverable,
  resetMissionDeliverableOpenState,
  type DeliverableCandidate,
} from './mission-deliverable-open';

const ROOT = '/projects/landing';

function candidate(
  absolutePath: string,
  modifiedAtMs: number,
): DeliverableCandidate {
  return { absolutePath, modifiedAtMs };
}

describe('objectiveWantsBrowserOpen', () => {
  it('reconhece o pedido explícito do operador', () => {
    for (const objective of [
      'crie uma landing e abra no navegador',
      'faça a página e abre no browser',
      'monte o site e mostre no Chrome',
      'quero um preview no navegador',
    ]) {
      expect(objectiveWantsBrowserOpen(objective)).toBe(true);
    }
  });

  it('NÃO abre janela quando o operador não pediu', () => {
    // Abrir sem pedido é mais intrusivo do que não abrir.
    for (const objective of [
      'crie uma landing page para minha empresa',
      'corrija o bug do login',
      'gere um relatório em HTML',
      'abra o arquivo de configuração e ajuste a porta',
      '',
    ]) {
      expect(objectiveWantsBrowserOpen(objective)).toBe(false);
    }
  });
});

describe('isContainedInWorkspace', () => {
  it('aceita apenas caminho realmente dentro da pasta', () => {
    expect(isContainedInWorkspace(ROOT, `${ROOT}/index.html`)).toBe(true);
    expect(isContainedInWorkspace(ROOT, `${ROOT}/dist/app/index.html`)).toBe(
      true,
    );
  });

  it('recusa escapes — inclusive o vizinho com o mesmo prefixo', () => {
    // Comparação por prefixo de string aceitaria "/projects/landing-evil".
    expect(isContainedInWorkspace(ROOT, '/projects/landing-evil/x.html')).toBe(
      false,
    );
    expect(isContainedInWorkspace(ROOT, `${ROOT}/../fora/x.html`)).toBe(false);
    expect(isContainedInWorkspace(ROOT, '/etc/passwd')).toBe(false);
    expect(isContainedInWorkspace(ROOT, ROOT)).toBe(false);
    expect(isContainedInWorkspace('relativo', `${ROOT}/x.html`)).toBe(false);
  });
});

describe('pickOpenableDeliverable', () => {
  it('escolhe o HTML mais recente produzido pela missão', () => {
    const picked = pickOpenableDeliverable(
      ROOT,
      [
        candidate(`${ROOT}/velho.html`, 50),
        candidate(`${ROOT}/entrega.html`, 300),
        candidate(`${ROOT}/parcial.html`, 200),
      ],
      100,
    );
    expect(picked).toBe(`${ROOT}/entrega.html`);
  });

  it('ignora arquivo anterior ao início da missão', () => {
    expect(
      pickOpenableDeliverable(ROOT, [candidate(`${ROOT}/antigo.html`, 50)], 100),
    ).toBeNull();
  });

  it('index.html ganha do irmão com a mesma modificação', () => {
    const picked = pickOpenableDeliverable(
      ROOT,
      [
        candidate(`${ROOT}/sobre.html`, 300),
        candidate(`${ROOT}/index.html`, 300),
      ],
      100,
    );
    expect(picked).toBe(`${ROOT}/index.html`);
  });

  it('ignora node_modules, .git e caches de build do próprio Nexus', () => {
    expect(
      pickOpenableDeliverable(
        ROOT,
        [
          candidate(`${ROOT}/node_modules/pkg/demo.html`, 900),
          candidate(`${ROOT}/.git/x.html`, 900),
          candidate(`${ROOT}/.nexus/y.html`, 900),
          candidate(`${ROOT}/index.html`, 300),
        ],
        100,
      ),
    ).toBe(`${ROOT}/index.html`);
  });

  it('recusa arquivo fora do workspace mesmo se for o mais recente', () => {
    expect(
      pickOpenableDeliverable(
        ROOT,
        [candidate('/tmp/evil.html', 9_000)],
        100,
      ),
    ).toBeNull();
  });

  it('só abre html/htm', () => {
    expect(
      pickOpenableDeliverable(
        ROOT,
        [
          candidate(`${ROOT}/entrega.pdf`, 900),
          candidate(`${ROOT}/script.sh`, 900),
        ],
        100,
      ),
    ).toBeNull();
  });
});

describe('openMissionDeliverable', () => {
  beforeEach(() => resetMissionDeliverableOpenState());

  const deps = (candidates: DeliverableCandidate[]) => {
    const openPath = vi.fn();
    return {
      openPath,
      deps: {
        listHtmlCandidates: () => candidates,
        openPath,
      },
    };
  };

  it('abre a entrega quando o operador pediu navegador', () => {
    const { openPath, deps: d } = deps([candidate(`${ROOT}/index.html`, 300)]);
    const opened = openMissionDeliverable(d, {
      missionId: 'm1',
      objective: 'crie a landing e abra no navegador',
      workspaceRoot: ROOT,
      missionStartedAtMs: 100,
    });
    expect(opened).toBe(`${ROOT}/index.html`);
    expect(openPath).toHaveBeenCalledWith(`${ROOT}/index.html`);
  });

  it('abre UMA vez por missão — done reemitido não repete a janela', () => {
    const { openPath, deps: d } = deps([candidate(`${ROOT}/index.html`, 300)]);
    const input = {
      missionId: 'm1',
      objective: 'abra no navegador',
      workspaceRoot: ROOT,
      missionStartedAtMs: 100,
    };
    openMissionDeliverable(d, input);
    openMissionDeliverable(d, input);
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it('não abre nada quando o objetivo não pediu', () => {
    const { openPath, deps: d } = deps([candidate(`${ROOT}/index.html`, 300)]);
    expect(
      openMissionDeliverable(d, {
        missionId: 'm2',
        objective: 'crie uma landing page',
        workspaceRoot: ROOT,
        missionStartedAtMs: 100,
      }),
    ).toBeNull();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('varredura que explode não derruba o done', () => {
    const openPath = vi.fn();
    expect(
      openMissionDeliverable(
        {
          listHtmlCandidates: () => {
            throw new Error('EACCES');
          },
          openPath,
        },
        {
          missionId: 'm3',
          objective: 'abra no navegador',
          workspaceRoot: ROOT,
          missionStartedAtMs: 100,
        },
      ),
    ).toBeNull();
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe('scanHtmlCandidates', () => {
  type Entry = { name: string; dir?: boolean };
  const tree: Record<string, Entry[]> = {
    [ROOT]: [
      { name: 'index.html' },
      { name: 'node_modules', dir: true },
      { name: 'src', dir: true },
      { name: 'leia.md' },
    ],
    [`${ROOT}/node_modules`]: [{ name: 'evil.html' }],
    [`${ROOT}/src`]: [{ name: 'sobre.html' }],
  };
  const fsImpl = {
    readdirSync: (p: string) =>
      (tree[p] ?? []).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.dir === true,
        isFile: () => entry.dir !== true,
      })),
    statSync: () => ({ mtimeMs: 500 }),
  };

  it('acha os HTML do projeto e pula node_modules', () => {
    const found = scanHtmlCandidates(ROOT, fsImpl).map((c) => c.absolutePath);
    expect(found).toEqual([`${ROOT}/index.html`, `${ROOT}/src/sobre.html`]);
  });

  it('respeita o teto de profundidade', () => {
    const found = scanHtmlCandidates(ROOT, fsImpl, { maxDepth: 0 });
    expect(found.map((c) => c.absolutePath)).toEqual([`${ROOT}/index.html`]);
  });

  it('readdir que explode degrada para vazio, nunca lança', () => {
    expect(() =>
      scanHtmlCandidates(ROOT, {
        readdirSync: () => {
          throw new Error('EACCES');
        },
        statSync: () => ({ mtimeMs: 1 }),
      }),
    ).not.toThrow();
  });
});

describe('pickFromArtifactRefs — a missão declara o que entregou', () => {
  it('usa o index.html declarado, resolvido contra a pasta do projeto', () => {
    // Formato real observado no app rodando (mission.result.artifactRefs).
    expect(
      pickFromArtifactRefs(ROOT, [
        'docs/plan.md',
        'index.html',
        'docs/superpowers/plans/2026-08-22-secao.md',
      ]),
    ).toBe(`${ROOT}/index.html`);
  });

  it('sem index.html, pega o HTML de caminho mais curto', () => {
    expect(
      pickFromArtifactRefs(ROOT, ['site/paginas/sobre.html', 'site/home.html']),
    ).toBe(`${ROOT}/site/home.html`);
  });

  it('recusa artefato que escapa da pasta do projeto', () => {
    expect(pickFromArtifactRefs(ROOT, ['../fora/evil.html'])).toBeNull();
    expect(pickFromArtifactRefs(ROOT, ['/etc/evil.html'])).toBeNull();
  });

  it('sem HTML entre os artefatos devolve null e deixa a varredura decidir', () => {
    expect(pickFromArtifactRefs(ROOT, ['docs/plan.md', 'server.js'])).toBeNull();
  });
});

describe('openMissionDeliverable — artefatos declarados vencem a varredura', () => {
  beforeEach(() => resetMissionDeliverableOpenState());

  it('abre o artefato declarado sem varrer o disco', () => {
    const openPath = vi.fn();
    const listHtmlCandidates = vi.fn(() => []);
    const opened = openMissionDeliverable(
      { listHtmlCandidates, openPath },
      {
        missionId: 'm-decl',
        objective: 'crie a landing e abra no navegador',
        workspaceRoot: ROOT,
        missionStartedAtMs: 100,
        artifactRefs: ['index.html', 'docs/plan.md'],
      },
    );
    expect(opened).toBe(`${ROOT}/index.html`);
    expect(listHtmlCandidates).not.toHaveBeenCalled();
  });

  it('cai na varredura quando a missão não declarou HTML', () => {
    const openPath = vi.fn();
    const opened = openMissionDeliverable(
      {
        listHtmlCandidates: () => [
          { absolutePath: `${ROOT}/achado.html`, modifiedAtMs: 300 },
        ],
        openPath,
      },
      {
        missionId: 'm-scan',
        objective: 'abra no navegador',
        workspaceRoot: ROOT,
        missionStartedAtMs: 100,
        artifactRefs: ['docs/plan.md'],
      },
    );
    expect(opened).toBe(`${ROOT}/achado.html`);
  });
});
