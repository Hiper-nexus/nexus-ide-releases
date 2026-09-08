import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDeliveryArtifactsForDone,
  evaluateDeliveryArtifactsForDone,
  extractObjectivePaths,
} from './mission-delivery-artifact-gate';

describe('delivery artifact gate', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-'));
    dirs.push(dir);
    return dir;
  }

  it('extrai saas-waitlist/ do objetivo', () => {
    expect(
      extractObjectivePaths('mini SaaS lista de espera em saas-waitlist/'),
    ).toContain('saas-waitlist');
  });

  it('recusa done sem arquivos no disco (waitlist vazio)', () => {
    const root = tmpRoot();
    const result = evaluateDeliveryArtifactsForDone({
      lane: 'standard',
      goal: 'mini SaaS em saas-waitlist/',
      rootRealPath: root,
      handoffs: [],
    });
    expect(result.ok).toBe(false);
    expect(() =>
      assertDeliveryArtifactsForDone({
        lane: 'standard',
        goal: 'mini SaaS em saas-waitlist/',
        rootRealPath: root,
        handoffs: [],
      }),
    ).toThrow(/não pode ficar Concluída/);
  });

  it('aceita quando a pasta do objetivo tem conteúdo', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'saas-waitlist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'saas-waitlist', 'server.js'), 'ok\n');
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'standard',
        goal: 'mini SaaS em saas-waitlist/',
        rootRealPath: root,
        handoffs: [],
      }),
    ).toEqual({ ok: true });
  });

  it('aceita handoff success quando o artefato listado existe', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'hello.txt'), 'entrega\n');
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'standard',
        goal: 'ship something',
        rootRealPath: root,
        handoffs: [
          {
            status: 'success',
            artifacts: { files: ['hello.txt'] },
            summary: 'ok',
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    { summary: 'Pronto' },
    { summary: 'Pronto', artifacts: { files: ['loja/index.html'] } },
    { artifacts: [{ kind: 'review-findings', verdict: 'correct' }] },
    { artifacts: ['loja/index.html'] },
  ])('não conclui uma criação com prosa ou artefatos inexistentes: %j', (handoff) => {
    expect(evaluateDeliveryArtifactsForDone({
      lane: 'standard', goal: 'Crie uma loja em loja/', rootRealPath: tmpRoot(),
      handoffs: [{ status: 'success', ...handoff }],
    }).ok).toBe(false);
  });

  it('aceita arquivos do resultado colhidos pelo motor sem exigir metadados do agente', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'index.html'), '<main>Minha loja</main>');
    expect(evaluateDeliveryArtifactsForDone({
      lane: 'standard', goal: 'Crie uma loja', rootRealPath: root,
      artifactRefs: ['index.html'], handoffs: [],
    })).toEqual({ ok: true });
  });

  it.each(['Faz um app de barbearia', 'Quero um sistema de agendamento'])(
    'não interpreta um pedido leigo de software como conversa: %s', (goal) => {
      expect(evaluateDeliveryArtifactsForDone({
        goal, rootRealPath: tmpRoot(), handoffs: [{ status: 'success', summary: 'Pronto' }],
      }).ok).toBe(false);
    },
  );

  it('aceita formato legado de lista de arquivos dentro do array de artefatos', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'index.html'), '<main>Loja</main>');
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Crie uma loja', rootRealPath: root,
      handoffs: [{ status: 'success', artifacts: [{ files: ['index.html'] }] }],
    })).toEqual({ ok: true });
  });

  it('preserva operação remota concluída pelo Main sem exigir handoff de worker', () => {
    expect(evaluateDeliveryArtifactsForDone({
      lane: 'ops', goal: 'Reinicie o serviço remoto', rootRealPath: tmpRoot(),
      handoffs: [], resultSummary: 'Serviço reiniciado e respondendo ao health check.',
    })).toEqual({ ok: true });
  });

  it('preserva uma exclusão física observada pelo Main, sem pedir arquivo substituto', () => {
    const root = tmpRoot();
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Apague README.md', rootRealPath: root, handoffs: [],
      deletedArtifactRefs: ['README.md'],
    })).toEqual({ ok: true });
    fs.writeFileSync(path.join(root, 'README.md'), 'recriado');
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Apague README.md', rootRealPath: root, handoffs: [],
      deletedArtifactRefs: ['README.md'],
    }).ok).toBe(false);
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Apague o documento antigo', rootRealPath: root, handoffs: [],
      deletedArtifactRefs: ['README.md'],
    }).ok).toBe(false);
  });

  it('não usa declaração de exclusão nem caminho externo como prova de criação', () => {
    const root = tmpRoot();
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Crie README.md', rootRealPath: root,
      handoffs: [{ status: 'success', summary: 'Apagado', artifacts: [{ path: 'README.md', deleted: true }] }],
    }).ok).toBe(false);
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Apague o documento antigo', rootRealPath: root, handoffs: [],
      deletedArtifactRefs: ['../fora/README.md'],
    }).ok).toBe(false);
  });

  it('não considera exclusão comprovada através de um pai symlink que não resolve', () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'link'), 'dir');
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Remova link/old.sql', rootRealPath: root,
      handoffs: [{ status: 'success', summary: 'Apagado.' }],
    }).ok).toBe(false);
  });

  it.each(['Apague README.md', 'Remova o arquivo src/obsolete.ts do projeto', 'Please delete old.js', 'Remova schema.sql', 'Remova relatório.txt'])(
    'confere uma exclusão idempotente sem exigir Git ou arquivo substituto: %s', (goal) => {
      const root = tmpRoot();
      expect(evaluateDeliveryArtifactsForDone({
        goal, rootRealPath: root, handoffs: [{ status: 'success', summary: 'Concluído.' }],
      })).toEqual({ ok: true });
    },
  );

  it('preserva exclusão em lote sem truncar silenciosamente aos oito primeiros alvos', () => {
    const files = Array.from({ length: 12 }, (_, index) => `old-${index}.sql`);
    expect(evaluateDeliveryArtifactsForDone({
      goal: `Remova ${files.join(', ')}`, rootRealPath: tmpRoot(),
      handoffs: [{ status: 'success', summary: 'Arquivos removidos.' }],
    })).toEqual({ ok: true });
  });

  it('não transforma pedido misto de exclusão e criação em apenas exclusão', () => {
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Remova old.js e crie um app novo', rootRealPath: tmpRoot(),
      handoffs: [{ status: 'success', summary: 'Pronto' }],
    }).ok).toBe(false);
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Remova old.ts e crie um site com login em app/', rootRealPath: tmpRoot(),
      handoffs: [{ status: 'success', summary: 'Pronto' }],
      deletedArtifactRefs: ['old.ts'],
    }).ok).toBe(false);
  });

  it.each([
    ['standard', 'Quanto é 1+1?'],
    ['standard', 'Analise o projeto sem alterar nada'],
    ['standard', 'peça a todos os agentes que expliquem seu papel, sem editar arquivos'],
    ['ops', 'Reinicie o serviço remoto'],
  ])('preserva entrega textual em %s: %s', (lane, goal) => {
    expect(evaluateDeliveryArtifactsForDone({
      lane, goal, rootRealPath: tmpRoot(),
      handoffs: [{ status: 'success', summary: 'Resposta concluída conforme o pedido.' }],
    })).toEqual({ ok: true });
  });

  it('não usa subpastas vazias como prova de entrega', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'loja', 'src'), { recursive: true });
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Crie a loja em loja/', rootRealPath: root, handoffs: [],
    }).ok).toBe(false);
  });

  it('reconhece uma entrega dentro de subpastas sem depender de Git', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'loja', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'loja', 'src', 'index.html'), '<main>Loja</main>');
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Crie a loja em loja/', rootRealPath: root, handoffs: [],
    })).toEqual({ ok: true });
  });

  it('não usa dependências ou metadados Git como produto', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'loja', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'loja', 'node_modules', 'fake.js'), 'module.exports = {}');
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Crie a loja em loja/', rootRealPath: root, handoffs: [],
    }).ok).toBe(false);
  });

  it('recusa symlink que aponta para arquivo de fora do projeto', () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    fs.writeFileSync(path.join(outside, 'index.html'), '<main>Outro projeto</main>');
    fs.symlinkSync(outside, path.join(root, 'loja'), 'dir');
    expect(evaluateDeliveryArtifactsForDone({
      goal: 'Crie a loja em loja/', rootRealPath: root, handoffs: [],
    }).ok).toBe(false);
  });

  it('aceita caminho absoluto contido no projeto, mas não um vizinho', () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    fs.writeFileSync(path.join(root, 'index.html'), 'loja');
    fs.writeFileSync(path.join(outside, 'index.html'), 'outra loja');
    for (const [file, ok] of [[path.join(root, 'index.html'), true], [path.join(outside, 'index.html'), false]] as const) {
      expect(evaluateDeliveryArtifactsForDone({
        goal: 'Crie uma loja', rootRealPath: root,
        handoffs: [{ status: 'success', artifacts: [{ path: file }] }],
      }).ok).toBe(ok);
    }
  });

  it('plan exige plan.md no disco', () => {
    const root = tmpRoot();
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'plan',
        goal: 'planeje',
        rootRealPath: root,
        handoffs: [],
      }).ok,
    ).toBe(false);
    fs.writeFileSync(path.join(root, 'plan.md'), '# plano\n');
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'plan',
        goal: 'planeje',
        rootRealPath: root,
        handoffs: [],
      }),
    ).toEqual({ ok: true });
  });
});
