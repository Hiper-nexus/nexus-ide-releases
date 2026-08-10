import { beforeEach, describe, expect, it } from 'vitest';
import type { Mission, SquadAgent } from '../../shared/orch-types';
import { agentPrompt } from './mission-fast-lane';
import {
  MissionMarkerObserver,
  isPromptEcho,
  scanMissionMarker,
  trimLineDecoration,
} from './mission-completion-marker';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    ...overrides,
  } as Mission;
}

function agent(overrides: Partial<SquadAgent> = {}): SquadAgent {
  return {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'agy',
    ...overrides,
  } as SquadAgent;
}

/** O prompt REAL que a Via Rápida entrega — a fonte da armadilha. */
const DELIVERED = agentPrompt(
  agent(),
  mission(),
  ['Coordenar e revisar', 'Implementar motor'],
  false,
);

/** Quebra o texto em linhas de `width` colunas, como uma TUI estreita faria. */
function hardWrap(text: string, width: number): string {
  return text
    .split('\n')
    .flatMap((line) => {
      const chunks: string[] = [];
      for (let at = 0; at < line.length; at += width) {
        chunks.push(line.slice(at, at + width));
      }
      return chunks.length > 0 ? chunks : [''];
    })
    .join('\n');
}

describe('marcador de conclusão — a armadilha do eco do prompt', () => {
  it('o prompt entregue contém as palavras dos marcadores (a armadilha existe)', () => {
    expect(DELIVERED).toContain('PRONTO:');
    expect(DELIVERED).toContain('BLOQUEADO:');
  });

  it('eco do prompt REAL sozinho NÃO produz marcador nenhum', () => {
    expect(scanMissionMarker(DELIVERED, [DELIVERED])).toBeNull();
  });

  it('eco quebrado por largura de TUI, com marcador abrindo linha, continua sendo eco', () => {
    for (const width of [24, 32, 41, 48, 55, 60, 72, 80]) {
      const echoed = hardWrap(DELIVERED, width);
      // Prova que o teste é real: alguma dessas larguras coloca o marcador no
      // começo de uma linha, que é exatamente o que a âncora sozinha não filtra.
      expect(scanMissionMarker(echoed, [DELIVERED])).toBeNull();
    }
    const anchored = [24, 32, 41, 48, 55, 60, 72, 80].some((width) =>
      hardWrap(DELIVERED, width)
        .split('\n')
        .some((line) => trimLineDecoration(line).startsWith('PRONTO:')),
    );
    expect(anchored).toBe(true);
  });

  it('eco emoldurado e com reticências de repaint continua sendo eco', () => {
    const repaint = [
      '│ Quando terminar, escreva uma linha final "PRONTO: <resumo    │',
      '│ PRONTO: <resumo curto>"…                                     │',
      '│ BLOQUEADO: <motivo>" em uma linha.                           │',
    ].join('\n');
    expect(scanMissionMarker(repaint, [DELIVERED])).toBeNull();
  });

  it('resposta genuína DEPOIS do eco é detectada com o texto do agente', () => {
    const screen = [
      DELIVERED,
      '',
      'Li brief.txt e gravei resumo.txt.',
      'PRONTO: Primeira frase do brief.txt gravada com sucesso no arquivo resumo.txt.',
      '',
    ].join('\n');
    expect(scanMissionMarker(screen, [DELIVERED])).toEqual({
      kind: 'done',
      text: 'Primeira frase do brief.txt gravada com sucesso no arquivo resumo.txt.',
    });
  });

  it('BLOQUEADO genuíno vira veredito bloqueado com o motivo do agente', () => {
    const screen = [
      DELIVERED,
      'BLOQUEADO: brief.txt não existe no diretório da missão.',
      '',
    ].join('\n');
    expect(scanMissionMarker(screen, [DELIVERED])).toEqual({
      kind: 'blocked',
      text: 'brief.txt não existe no diretório da missão.',
    });
  });

  it('sessão não armada (nenhum prompt entregue) nunca aceita marcador', () => {
    expect(
      scanMissionMarker('PRONTO: achei isso no scrollback antigo.', []),
    ).toBeNull();
  });

  it('marcador no meio da linha não conta — só o que ABRE a linha', () => {
    const screen = 'o usuário pediu que eu escrevesse PRONTO: alguma coisa aqui.';
    expect(scanMissionMarker(screen, [DELIVERED])).toBeNull();
  });

  it('marcador sem resumo é recusado (indistinguível de eco cortado)', () => {
    expect(scanMissionMarker('PRONTO:\n', [DELIVERED])).toBeNull();
    expect(scanMissionMarker('PRONTO: ok\n', [DELIVERED])).toBeNull();
    expect(scanMissionMarker('PRONTO: feito\n', [DELIVERED])).toEqual({
      kind: 'done',
      text: 'feito',
    });
  });

  it('isPromptEcho reconhece trecho literal, prefixo cortado e continuação', () => {
    expect(isPromptEcho('PRONTO: <resumo curto>".', [DELIVERED])).toBe(true);
    expect(isPromptEcho('PRONTO: <resumo cur', [DELIVERED])).toBe(true);
    expect(isPromptEcho('PRONTO: <resumo curto>"… (truncado)', [DELIVERED])).toBe(
      true,
    );
    expect(isPromptEcho('PRONTO: resumo.txt gravado.', [DELIVERED])).toBe(false);
  });
});

describe('marcador de conclusão — moldura e chunks do PTY', () => {
  it('linha emoldurada por TUI é detectada', () => {
    const screen = '│ PRONTO: resumo.txt gravado com a primeira frase. │\n';
    expect(scanMissionMarker(screen, [DELIVERED])).toEqual({
      kind: 'done',
      text: 'resumo.txt gravado com a primeira frase.',
    });
  });

  it('goteira de bloco (▌) e marcação de markdown não escondem o marcador', () => {
    for (const decorated of [
      '▌ PRONTO: resumo.txt gravado.\n',
      '┃ PRONTO: resumo.txt gravado.\n',
      '  > **PRONTO:** resumo.txt gravado.\n',
    ]) {
      expect(scanMissionMarker(decorated, [DELIVERED])).toMatchObject({
        kind: 'done',
      });
    }
  });

  it('marcador partido entre chunks do PTY é remontado pelo observador', () => {
    const observer = new MissionMarkerObserver();
    observer.registerPrompt('s1', DELIVERED);
    expect(observer.observe('s1', 'trabalhando...\nPRON')).toBeNull();
    expect(observer.observe('s1', 'TO: resumo.txt gra')).toBeNull();
    const sighting = observer.observe('s1', 'vado.\n$ ');
    expect(sighting).toMatchObject({
      kind: 'done',
      text: 'resumo.txt gravado.',
    });
  });
});

describe('marcador de conclusão — ciclo de vida do observador', () => {
  let observer: MissionMarkerObserver;

  beforeEach(() => {
    observer = new MissionMarkerObserver();
  });

  it('não observa sessão sem prompt registrado e para depois do veredito', () => {
    expect(observer.isWatching('s1')).toBe(false);
    expect(observer.observe('s1', 'PRONTO: qualquer coisa.')).toBeNull();

    observer.registerPrompt('s1', DELIVERED);
    expect(observer.isWatching('s1')).toBe(true);
    expect(observer.observe('s1', 'PRONTO: resumo.txt gravado.\n')).not.toBeNull();
    expect(observer.isWatching('s1')).toBe(false);
  });

  it('primeiro veredito trava: PRONTO depois de BLOQUEADO não sobrescreve', () => {
    observer.registerPrompt('s1', DELIVERED);
    observer.observe('s1', 'BLOQUEADO: sem permissão de escrita.\n');
    observer.observe('s1', 'PRONTO: consegui depois de tudo.\n');
    expect(observer.markerOf('s1')).toMatchObject({
      kind: 'blocked',
      text: 'sem permissão de escrita.',
    });
  });

  it('recarga do prompt (nudge) registra o texto e o eco novo continua mudo', () => {
    observer.registerPrompt('s1', DELIVERED);
    const resumePrompt = agentPrompt(
      agent(),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      true,
    );
    observer.registerPrompt('s1', resumePrompt);
    observer.observe('s1', hardWrap(resumePrompt, 41));
    expect(observer.markerOf('s1')).toBeNull();
  });

  it('seal preserva o veredito de uma sessão que morreu logo após falar', () => {
    observer.registerPrompt('s1', DELIVERED);
    observer.observe('s1', 'PRONTO: resumo.txt gravado.\n');
    observer.seal('s1');
    expect(observer.markerOf('s1')).toMatchObject({ kind: 'done' });
    expect(observer.isWatching('s1')).toBe(false);
    // Selada: saída póstuma não pode mais mexer no veredito.
    expect(observer.observe('s1', 'BLOQUEADO: tarde demais.\n')).toBeNull();
    expect(observer.markerOf('s1')).toMatchObject({ kind: 'done' });
  });

  it('linha ainda chegando não vira veredito cortado, mas o seal a completa', () => {
    observer.registerPrompt('s1', DELIVERED);
    // Sem `\n` a linha ainda está sendo escrita: gravar agora daria o resumo
    // truncado "resumo.txt gra" como palavra final do agente.
    expect(observer.observe('s1', 'PRONTO: resumo.txt gra')).toBeNull();
    expect(observer.markerOf('s1')).toBeNull();
    // A sessão morre sem nunca emitir o `\n`: agora a linha está completa.
    expect(observer.seal('s1')).toMatchObject({
      kind: 'done',
      text: 'resumo.txt gra',
    });
  });

  it('drop e clear esquecem a sessão por inteiro', () => {
    observer.registerPrompt('s1', DELIVERED);
    observer.observe('s1', 'PRONTO: resumo.txt gravado.\n');
    observer.drop('s1');
    expect(observer.markerOf('s1')).toBeNull();

    observer.registerPrompt('s2', DELIVERED);
    observer.clear();
    expect(observer.isWatching('s2')).toBe(false);
  });
});
