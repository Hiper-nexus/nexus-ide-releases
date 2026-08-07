/**
 * Identidade de missão: charset travado ANTES de virar path, e atribuição
 * provada em main em vez de aceita do chamador.
 *
 * Dois defeitos distintos cobertos aqui:
 *
 * P2-10 — mission id vira nome de arquivo. APFS/HFS+ são case-insensitive por
 * padrão, então `mission-Auth` e `mission-auth` são O MESMO arquivo: duas linhas
 * do SQLite viram uma projeção só, conteúdo não-determinístico, e o guard de
 * idempotência (comparar bytes em disco) nunca converge → reescrita perpétua.
 * ':' no Windows abre Alternate Data Stream; '/' e '..' saem do diretório.
 *
 * P1-4 — o `source` da projeção decide a QUE missão a nota pertence. Enquanto
 * qualquer texto contendo `mission:` promovia a nota a kind=mission, o chamador
 * escolhia sozinho em que missão sua nota aparecia.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MISSION_PROJECTION_SOURCE_PREFIX,
  assertProjectableMissionId,
  authorizedMissionId,
  isMissionScopedSource,
  isProjectableMissionId,
  missionIdFromProjectionSource,
  missionProjectionBasename,
  missionProjectionSource,
} from './mission-id';

/** Formato real de `makeId('mission')` — base36 de Date.now + contador. */
const REAL_IDS = ['mission-lz4k2p-3', 'mission-m1x9qq-1f', 'mission-a-b-c-9'];

const FORGED_IDS = [
  '', // vazio: `${''}.md` = ".md", arquivo oculto que colide com todo id vazio
  'Mission-A', // maiúscula: colide com 'mission-a' em volume case-insensitive
  'mission-Auth', // idem — o par exato do defeito relatado
  'a:b', // ADS no Windows
  '../x', // traversal
  'a/b', // separador POSIX
  'a\\b', // separador Windows
  '.', // o próprio diretório
  '..', // o diretório pai
  '-lead', // hífen inicial: parece flag para ferramenta de linha de comando
  'a b', // espaço
  'a\u0000b', // NUL trunca o path em chamadas de sistema
  'a\nb', // quebra de linha envenena o frontmatter YAML
  'café', // não-ASCII: normalização NFC/NFD colide no APFS
  `${'a'.repeat(65)}`, // acima do teto de 64
];

describe('mission id — charset travado antes de virar path', () => {
  it('aceita os ids que o gerador de missão realmente produz', () => {
    for (const id of REAL_IDS) {
      expect(isProjectableMissionId(id)).toBe(true);
      expect(assertProjectableMissionId(id)).toBe(id);
    }
  });

  it('rejeita todo id que não é seguro como nome de arquivo', () => {
    for (const id of FORGED_IDS) {
      expect(isProjectableMissionId(id)).toBe(false);
      expect(() => assertProjectableMissionId(id)).toThrow(
        /mission_id_unsafe/,
      );
    }
  });

  it('rejeita valor que não é string, sem coagir para path', () => {
    for (const value of [undefined, null, 42, {}, ['a'], Symbol('a')]) {
      expect(isProjectableMissionId(value)).toBe(false);
      expect(() => assertProjectableMissionId(value)).toThrow(
        /mission_id_unsafe/,
      );
    }
  });

  it('nunca deixa um id aceito escapar do próprio nome de arquivo', () => {
    for (const id of REAL_IDS) {
      const basename = missionProjectionBasename(id);
      expect(basename).toBe(`${id}.md`);
      expect(path.basename(basename)).toBe(basename);
      expect(path.join('/root', basename)).toBe(`/root/${basename}`);
    }
  });

  it('não constrói nome de arquivo a partir de id inválido', () => {
    for (const id of FORGED_IDS) {
      expect(() => missionProjectionBasename(id)).toThrow(/mission_id_unsafe/);
    }
  });
});

describe('mission id — colisão em filesystem case-insensitive', () => {
  it('rejeita a variante de caixa que o volume dobraria no mesmo arquivo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-case-'));
    try {
      fs.writeFileSync(path.join(dir, 'mission-auth.md'), 'lower');
      // APFS/HFS+ (default macOS) dobram: o arquivo em caixa alta JÁ existe.
      const volumeFoldsCase = fs.existsSync(
        path.join(dir, 'mission-Auth.md'),
      );

      // O guard é o charset, e não pode depender de em que volume rodamos.
      expect(isProjectableMissionId('mission-auth')).toBe(true);
      expect(isProjectableMissionId('mission-Auth')).toBe(false);

      if (volumeFoldsCase) {
        // Prova que o perigo é real aqui: sem o charset, a segunda projeção
        // sobrescreveria a primeira e o guard de idempotência nunca casaria.
        expect(
          fs.readFileSync(path.join(dir, 'mission-Auth.md'), 'utf8'),
        ).toBe('lower');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mantém o mapa id → arquivo injetivo sob case-folding', () => {
    const accepted = [...REAL_IDS, 'mission-auth', 'mission-a', 'm0'];
    const folded = accepted.map((id) =>
      missionProjectionBasename(id).toLowerCase(),
    );
    expect(new Set(folded).size).toBe(accepted.length);
    // Corolário: para todo id aceito, dobrar a caixa é a identidade.
    for (const id of accepted) {
      expect(id.toLowerCase()).toBe(id);
    }
  });
});

describe('source canônico de projeção de missão', () => {
  it('faz round-trip do id pelo source canônico', () => {
    for (const id of REAL_IDS) {
      const source = missionProjectionSource(id);
      expect(source).toBe(`${MISSION_PROJECTION_SOURCE_PREFIX}${id}`);
      expect(missionIdFromProjectionSource(source)).toBe(id);
    }
  });

  it('não emite source a partir de id inválido', () => {
    for (const id of FORGED_IDS) {
      expect(() => missionProjectionSource(id)).toThrow(/mission_id_unsafe/);
    }
  });

  it('não reconhece source forjado como atribuição de missão', () => {
    const forgedSources = [
      'mission:m1', // a forma exata que o teste substring aceitava
      'operator:agent:mission:m1',
      'trusted:accepted-handoff:mission:m1',
      'note about mission:m1',
      'operator:mission:', // id vazio
      'operator:mission:../../etc/passwd',
      'operator:mission:a/b',
      'operator:mission:Mission-A',
      'operator:mission:a:b',
      'operator:mission:m1 extra',
      'xoperator:mission:m1',
      'OPERATOR:MISSION:m1',
      'operator:mission:m1\n',
      null,
      undefined,
      '',
    ];
    for (const source of forgedSources) {
      expect(missionIdFromProjectionSource(source)).toBeUndefined();
    }
  });
});

describe('provenance agent-authored — missão sim, mission id não', () => {
  const authority = 'a'.repeat(64);

  it('reconhece a nota de missão escrita por agente como escopo de missão', () => {
    // `agent-authored:<mission|pane>:<sha256>` é derivado em main da autoridade
    // física do pane (tools-memory.defaultSource) — o worker não escolhe.
    expect(isMissionScopedSource(`agent-authored:mission:${authority}`)).toBe(
      true,
    );
  });

  it('NÃO trata o hash de autoridade como mission id', () => {
    // O segmento depois de `mission:` aqui é um sha256 opaco de sessão, não uma
    // missão. O parser antigo (`/(?:^|:)mission:(.+)$/`) publicava esse hash no
    // campo missionId do frontmatter — identidade que nunca existiu.
    expect(
      missionIdFromProjectionSource(`agent-authored:mission:${authority}`),
    ).toBeUndefined();
  });

  it('não confunde pane com missão nem aceita hash malformado', () => {
    for (const source of [
      `agent-authored:pane:${authority}`,
      'agent-authored:mission:notahash',
      `agent-authored:mission:${'a'.repeat(63)}`,
      `agent-authored:mission:${'A'.repeat(64)}`,
      `agent-authored:mission:${authority}extra`,
      `xagent-authored:mission:${authority}`,
    ]) {
      expect(isMissionScopedSource(source)).toBe(false);
      expect(missionIdFromProjectionSource(source)).toBeUndefined();
    }
  });

  it('o source canônico do operador continua sendo escopo de missão COM id', () => {
    expect(isMissionScopedSource('operator:mission:mission-lz4k2p-3')).toBe(
      true,
    );
    expect(
      missionIdFromProjectionSource('operator:mission:mission-lz4k2p-3'),
    ).toBe('mission-lz4k2p-3');
  });

  it('source forjado não é escopo de missão', () => {
    for (const source of [
      'mission:m1',
      'operator:agent:mission:m1',
      'operator:mission:../x',
      'trusted:accepted-handoff',
      null,
      undefined,
    ]) {
      expect(isMissionScopedSource(source)).toBe(false);
    }
  });
});

describe('autoridade de atribuição — o chamador não escolhe a missão', () => {
  const found = () => true;
  const notFound = () => false;

  it('devolve undefined quando nada foi reivindicado', () => {
    const lookup = vi.fn(found);
    expect(authorizedMissionId(undefined, lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('devolve o id quando o escopo autorizado prova que a missão existe', () => {
    const lookup = vi.fn(found);
    expect(authorizedMissionId('mission-lz4k2p-3', lookup)).toBe(
      'mission-lz4k2p-3',
    );
    expect(lookup).toHaveBeenCalledWith('mission-lz4k2p-3');
  });

  it('recusa id que o escopo autorizado não conhece', () => {
    expect(() => authorizedMissionId('mission-lz4k2p-3', notFound)).toThrow(
      /mission_id_unauthorized/,
    );
  });

  it('recusa charset inválido SEM consultar o store', () => {
    // O lookup pode tocar disco/SQLite com o id; texto não validado não pode
    // chegar até lá.
    const lookup = vi.fn(found);
    expect(() => authorizedMissionId('../x', lookup)).toThrow(
      /mission_id_unsafe/,
    );
    expect(() => authorizedMissionId('mission-Auth', lookup)).toThrow(
      /mission_id_unsafe/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('não deixa erro do store virar atribuição aceita', () => {
    expect(() =>
      authorizedMissionId('mission-lz4k2p-3', () => {
        throw new Error('store offline');
      }),
    ).toThrow();
  });
});
