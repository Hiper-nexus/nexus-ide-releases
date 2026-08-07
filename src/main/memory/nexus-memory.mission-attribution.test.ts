/**
 * P1-4 — atribuição de missão na projeção legível.
 *
 * `kind='mission'` é exatamente o filtro do provider de busca de missões
 * (search-mixer-bootstrap: `listMemoryNotes(...).filter(n => n.kind === 'mission')`).
 * Enquanto a promoção saía de um teste de substring `/(?:^|:)mission:/` sobre um
 * `source` que o chamador escolhe, qualquer nota entrava na busca de qualquer
 * missão. E `projectionMissionId` devolvia o resto da string inteiro — inclusive
 * traversal — para um campo que a projeção de missão usa como identidade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_DIR,
  listMemoryNotes,
  writeCanonicalMemoryProjection,
} from './nexus-memory';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-attr-'));
  dirs.push(root);
  return root;
}

function project(root: string, id: string, source: string | null) {
  return writeCanonicalMemoryProjection(root, {
    id,
    content: `# Nota ${id}\n\ncorpo`,
    kind: 'fact',
    scope: 'workspace',
    importance: 4,
    source,
    createdAt: 1,
    updatedAt: 2,
  });
}

describe('projeção: kind=mission exige autoridade real', () => {
  it('promove a missão pelo source canônico e faz round-trip do id', () => {
    const root = tempRoot();

    const note = project(root, 'mem-real', 'operator:mission:mission-lz4k2p-3');

    expect(note.kind).toBe('mission');
    expect(note.missionId).toBe('mission-lz4k2p-3');

    const listed = listMemoryNotes(root).find((n) => n.id === 'mem-real');
    expect(listed?.kind).toBe('mission');
    expect(listed?.missionId).toBe('mission-lz4k2p-3');
  });

  it('mantém a nota de missão escrita por agente na busca, sem inventar id', () => {
    const root = tempRoot();
    // tools-memory deriva `agent-authored:mission:<sha256>` da autoridade
    // física do pane. É escopo de missão legítimo — mas o hash NÃO é um mission
    // id, e o parser antigo publicava ele como se fosse.
    const note = project(
      root,
      'mem-agente',
      `agent-authored:mission:${'a'.repeat(64)}`,
    );

    expect(note.kind).toBe('mission');
    expect(note.missionId).toBeUndefined();

    const listed = listMemoryNotes(root).filter((n) => n.kind === 'mission');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.missionId).toBeUndefined();
  });

  it('não promove source forjado que apenas CONTÉM "mission:"', () => {
    const root = tempRoot();
    const forged = [
      'mission:m1',
      'operator:agent:mission:m1',
      'trusted:accepted-handoff:mission:m1',
      'anotação sobre mission:m1',
      'operator:mission:',
    ];

    forged.forEach((source, index) => {
      const note = project(root, `mem-forged-${index}`, source);
      expect(note.kind).not.toBe('mission');
      expect(note.missionId).toBeUndefined();
    });

    // Este é o filtro literal do provider de busca de missões.
    expect(listMemoryNotes(root).filter((n) => n.kind === 'mission')).toEqual(
      [],
    );
  });

  it('não deixa traversal nem caixa alta virarem missionId', () => {
    const root = tempRoot();
    const unsafe = [
      'operator:mission:../../etc/passwd',
      'operator:mission:a/b',
      'operator:mission:Mission-Auth',
      'operator:mission:a:b',
    ];

    unsafe.forEach((source, index) => {
      const note = project(root, `mem-unsafe-${index}`, source);
      expect(note.missionId).toBeUndefined();
      expect(note.kind).not.toBe('mission');
    });

    // O frontmatter em disco também não pode carregar o id não-sanitizado.
    for (const note of listMemoryNotes(root)) {
      expect(note.missionId).toBeUndefined();
      const raw = fs.readFileSync(note.path, 'utf8');
      // O `source` guarda a reivindicação original de propósito (provenance
      // auditável, e inerte: nada deriva path dele). Quem vira identidade é o
      // missionId, e ele fica vazio.
      expect(raw).toContain('missionId: ""');
      expect(/^missionId:.*(etc\/passwd|Mission-Auth|a\/b)/m.test(raw)).toBe(
        false,
      );
    }
  });

  it('não deixa frontmatter plantado injetar mission id na leitura', () => {
    const root = tempRoot();
    // Um arquivo plantado que satisfaz id == nome do arquivo ainda declara o
    // resto do frontmatter livremente, e a leitura é o que alimenta o provider
    // de busca. O campo de identidade passa pelo mesmo charset da escrita.
    const planted = [
      { id: 'mem-planted-0', missionId: '"../../etc/passwd"' },
      { id: 'mem-planted-1', missionId: '"Mission-Auth"' },
      { id: 'mem-planted-2', missionId: '""' },
      { id: 'mem-planted-3', missionId: 'null' },
    ];
    const projectionDir = path.join(root, DEFAULT_MEMORY_DIR);
    fs.mkdirSync(projectionDir, { recursive: true });
    for (const file of planted) {
      fs.writeFileSync(
        path.join(projectionDir, `${file.id}.md`),
        [
          '---',
          `id: ${file.id}`,
          'canonical: sqlite-fts5',
          'generated: true',
          'kind: mission',
          `missionId: ${file.missionId}`,
          '---',
          '',
          '# Plantada',
          '',
        ].join('\n'),
      );
    }

    const notes = listMemoryNotes(root);
    expect(notes).toHaveLength(planted.length);
    for (const note of notes) {
      // Nenhum id inventado atravessa. `kind` continua sendo governado pela
      // autenticidade do arquivo (marcador canônico + id == nome) e pelo
      // reaper, não por este campo.
      expect(note.missionId).toBeUndefined();
    }
  });

  it('preserva kind=mission legítimo lido do frontmatter', () => {
    const root = tempRoot();
    project(root, 'mem-ok', 'operator:mission:mission-lz4k2p-3');

    const listed = listMemoryNotes(root).filter((n) => n.kind === 'mission');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.missionId).toBe('mission-lz4k2p-3');
  });

  it('mantém a promoção a agent/decision intocada', () => {
    const root = tempRoot();

    expect(project(root, 'mem-agent', 'operator:agent:manual').kind).toBe(
      'agent',
    );
    const decision = writeCanonicalMemoryProjection(root, {
      id: 'mem-decision',
      content: '# D\n\ncorpo',
      kind: 'decision',
      scope: 'workspace',
      importance: 5,
      source: 'operator:note',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(decision.kind).toBe('decision');
  });
});
