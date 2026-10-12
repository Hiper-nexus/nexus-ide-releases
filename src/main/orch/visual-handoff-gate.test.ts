import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { checkVisualHandoff, recordVisualHandoffEvidence, visualTaskRequirement, visualTaskAtSpawn } from './visual-handoff-gate';

let dir: string;
let manager: ProjectRuntimeManager;
const scope = testProjectScope();
const context = () => ({ scope, executionScope: scope, sessionId: 'worker-session', missionId: 'mission',
  workerIncarnationId: 'incarnation', visualTask: { since: 1000, id: 'assignment-a' } });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-handoff-'));
  manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: 'test' });
  manager.open(scope).db.prepare("INSERT INTO missions (id,title,status,created_at,updated_at) VALUES ('mission','UI','running',1,1)").run();
});
afterEach(() => { manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });

it('F-1271: o bloco <business-model> montado na frente não torna visual uma tarefa de backend', () => {
  const block = '<business-model fonte="modelo e referências locais · jev">\nInvariantes da tarefa:\n' +
    '- [projeto#27] O PAINEL é superfície Nexus escura SEMPRE (.darkAqua no root e no popover; #111013 ' +
    'cabeçalho/rodapé). No tema claro o painel… (AGENTS.md:586)\n</business-model>';
  const task = 'Corrigir bug no nexus_file_search: glob com **/ no meio não casa zero diretórios';
  expect(visualTaskRequirement(`${block}\n\n${task}`, 1000)).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', initialPrompt: `${block}\n\n${task}` })).toBeUndefined();
  // A tarefa visual continua visual com o mesmo bloco na frente; citar a tag no meio não é montagem.
  expect(visualTaskRequirement(`${block}\n\nCorrija o bug no layout da tela de login.`, 1000)).toBeDefined();
  expect(visualTaskRequirement(`Corrija o bug no layout da tela de login citando ${block}`, 1000)).toBeDefined();
});

it('F-1311: palavra de UI em lista de exemplos ou nome de ferramenta não torna a tarefa visual', () => {
  // s240: o prompt da sonda citava "UI/design" dentro de uma lista de
  // tarefas de exemplo e o pane nasceu com visualTask; o spawn de
  // ferramentas citava "browser"/"design system" como nomes de ferramenta.
  expect(visualTaskRequirement(
    'Sonda: avaliar se o Nexus sugere a especialidade certa para tarefas como UI/design, front-end e jogos.',
    1000,
  )).toBeUndefined();
  expect(visualTaskRequirement(
    'Sonda: medir as ferramentas de código (browser, design system, terminal, git) e registrar a cobertura.',
    1000,
  )).toBeUndefined();
  expect(visualTaskRequirement(
    'Avalie o roteamento de skills: para cada tarefa de exemplo ("crie uma landing page", "redesenhe o dashboard"), registre a skill esperada.',
    1000,
  )).toBeUndefined();
  expect(visualTaskRequirement(
    'Inventário: liste as skills instaladas, incluindo `impeccable` e `design system`.',
    1000,
  )).toBeUndefined();
  // O pedido visual continua visual — só enumeração/contexto foi removido.
  expect(visualTaskRequirement('Crie a tela de login com layout responsivo.', 1000)).toBeDefined();
  expect(visualTaskRequirement('Corrija o bug no layout responsivo da tela de login.', 1000)).toBeDefined();
  expect(visualTaskRequirement('Redesenhe o dashboard com hierarquia visual e modo escuro.', 1000)).toBeDefined();
});

it('F-1311 (revisão Fable): "como"/"liste" só cortam a enumeração, não o resto da sentença', () => {
  // O introdutor removia de "como"/"liste" até o fim da sentença e levava
  // junto o pedido visual que vinha depois.
  expect(visualTaskRequirement(
    'Mostre como a tela de login renderiza no mobile e corrija o layout quebrado',
    1000,
  )).toBeDefined();
  expect(visualTaskRequirement(
    'liste os botões quebrados na tela de checkout e corrija o alinhamento',
    1000,
  )).toBeDefined();
  // Uma lista curta de exemplos depois de "como" continua sendo contexto.
  expect(visualTaskRequirement(
    'Sonda: avaliar o roteamento para tarefas como UI, front-end e jogos.',
    1000,
  )).toBeUndefined();
});

it('F-1362: tarefa de UI embrulhada em XML continua exigindo a captura', async () => {
  const wrapped = '<task>\nCrie a tela de login com layout responsivo.\n</task>';
  const visualTask = visualTaskRequirement(wrapped, 1000);
  expect(visualTask).toEqual({ since: 1000, id: expect.any(String) });
  expect(visualTaskRequirement('<instructions>Crie a tela de login com layout responsivo.</instructions>', 1000)).toBeDefined();
  expect(await checkVisualHandoff({ ...context(), visualTask }, { manager })).toMatchObject({ required: true, verified: false });
  // O contexto montado pelo Nexus continua fora da classificação.
  const memory = '<workspace-memory phase="execution">\n- O PAINEL usa layout, cabeçalho e tema escuro.\n</workspace-memory>';
  expect(visualTaskRequirement(`${memory}\n\nCorrigir bug na API de estoque.`, 1000)).toBeUndefined();
  expect(visualTaskRequirement(`${memory}\n\n${wrapped}`, 1000)).toBeDefined();
});

it('derives a visual requirement from the assigned task, not from a completion claim', () => {
  expect(visualTaskRequirement('Crie a tela de login com layout responsivo.', 1000)).toEqual({ since: 1000, id: expect.any(String) });
  expect(visualTaskRequirement('Documente os endpoints da API de login.', 1000)).toBeUndefined();
  expect(visualTaskRequirement('Corrija o bug na paginação da API de estoque.', 1000)).toBeUndefined();
});
it.each(['Corrija o bug no layout responsivo da tela de login.', 'Corrija o botão que não funciona na interface do dashboard.'])
  ('requires a capture for a UI bug: %s', assignment => expect(visualTaskRequirement(assignment, 1000)).toEqual({ since: 1000, id: expect.any(String) }));
it('preserves an already classified nonvisual task instead of reclassifying appended instructions', () => {
  const initialPrompt = 'Crie a tela de login com layout responsivo.';
  expect(visualTaskAtSpawn({ role: 'worker', visualTask: undefined, initialPrompt })).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', initialPrompt })).toEqual({ since: expect.any(Number), id: expect.any(String) });
  expect(visualTaskAtSpawn({ role: 'orchestrator', initialPrompt })).toBeUndefined();
});
it('a declared screenshot path or convincing summary cannot satisfy missing Main evidence', async () => {
  expect(await checkVisualHandoff(context(), { manager })).toMatchObject({ required: true, verified: false });
  expect(await checkVisualHandoff({ ...context(), visualTask: undefined }, { manager })).toEqual({ required: false, verified: true });
});
it('requires the exact worker generation, execution root, assignment time and current image bytes', async () => {
  const store = createScopedBrowserArtifactStore(manager, scope);
  const image = store.recordScreenshot({ paneId: 'browser-pane', missionId: 'mission', png: Buffer.from('fixture-png'),
    width: 1, height: 1, url: 'http://localhost:3000', title: 'UI', capturedAt: 1100 });
  expect(recordVisualHandoffEvidence(context(), image.id, manager)).toBe(true);
  expect(await checkVisualHandoff(context(), { manager })).toMatchObject({ verified: true, artifactId: image.id });
  expect(await checkVisualHandoff({ ...context(), workerIncarnationId: 'other' }, { manager })).toMatchObject({ verified: false });
  expect(await checkVisualHandoff({ ...context(), executionScope: { ...scope, rootRealPath: '/other' } }, { manager })).toMatchObject({ verified: false });
  expect(await checkVisualHandoff({ ...context(), visualTask: { since: 1200, id: 'assignment-b' } }, { manager })).toMatchObject({ verified: false });
  fs.writeFileSync(image.path, 'tampered');
  expect(await checkVisualHandoff(context(), { manager })).toMatchObject({ verified: false });
});

it('requires evidence from a sealed visual task even without a spawn hint', async () => {
  expect(await checkVisualHandoff({ ...context(), visualTask: undefined }, { manager,
    task: { plannedTitle: 'Corrija o bug da tela de login', plannedDetail: 'Layout responsivo com formulário.', task: { createdAt: 1000 } },
  })).toMatchObject({ required: true, verified: false });
});

it('does not let another worker or mission claim an existing capture', async () => {
  const store = createScopedBrowserArtifactStore(manager, scope);
  const image = store.recordScreenshot({ paneId: 'browser-pane', missionId: 'mission', png: Buffer.from('fixture'),
    width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 1100 });
  expect(recordVisualHandoffEvidence(context(), image.id, manager)).toBe(true);
  expect(recordVisualHandoffEvidence({ ...context(), sessionId: 'other' }, image.id, manager)).toBe(false);
  expect(recordVisualHandoffEvidence({ ...context(), missionId: 'other' }, image.id, manager)).toBe(false);
  expect(await checkVisualHandoff({ ...context(), sessionId: 'other' }, { manager })).toMatchObject({ verified: false });
});

it.each([2000, 500])('refuses an earlier task capture after reassignment at clock %s', async since => {
  const ctx = { ...context(), visualTask: visualTaskRequirement('Crie a tela de login com layout responsivo.', 1000)! };
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('old assignment'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 2000 });
  expect(recordVisualHandoffEvidence(ctx, image.id, manager)).toBe(true);
  ctx.visualTask = visualTaskRequirement('Crie a tela de login com layout responsivo.', since)!;
  expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ required: true, verified: false });
});

it('keeps same-assignment evidence valid if the wall clock moves backward during capture', async () => {
  const ctx = context();
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('same assignment'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 500 });
  expect(recordVisualHandoffEvidence(ctx, image.id, manager)).toBe(true);
  expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ required: true, verified: true });
});

it('revokes an in-flight check if the assignment changes and propagates authority cancellation', async () => {
  const ctx = context();
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('fixture'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 1100 });
  recordVisualHandoffEvidence(ctx, image.id, manager);
  const realOpen = fs.promises.open.bind(fs.promises);
  const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    ctx.visualTask = { since: 1200, id: 'assignment-b' };
    return realOpen(...args);
  });
  try { expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ verified: false }); }
  finally { open.mockRestore(); }
  await expect(checkVisualHandoff(context(), { manager, assertCurrent: () => { throw new Error('stale authority'); } }))
    .rejects.toThrow('stale authority');
});

it('selects bounded proof candidates through the worker index', () => {
  const plan = manager.open(scope).db.prepare(`EXPLAIN QUERY PLAN SELECT artifact_id FROM visual_handoff_evidence
    WHERE session_id = ? AND mission_id IS ? AND worker_incarnation_id IS ? AND execution_root = ? AND assignment_id = ?
    ORDER BY captured_at DESC LIMIT 4`).all('worker-session', 'mission', 'incarnation', scope.rootRealPath, 'assignment-a');
  expect(JSON.stringify(plan)).toContain('idx_visual_handoff_assignment');
  expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
});

// F-1417: revisão de segurança só leitura (sem UI) foi rebaixada para partial
// com "[verificação visual pendente]". A decisão olha a TASK, nunca o rodapé
// de design que o Nexus injeta no prompt.
const F1417_TASK =
  'Revisão de segurança, só leitura, do auto-update de CLI (F-1397 × F-1395 com C5/C6/C7) e do F-1411 Kimi bracketed paste';
// Texto real de `ruleText` (workspace-design-rule.ts), com e sem DESIGN.md.
const F1417_RULE_TAIL =
  '\nReutilize tokens e componentes existentes. Na entrega, identifique a referência usada e como ' +
  'verificou a interface renderizada; se não conseguiu ler ou verificar, declare a limitação. ' +
  'Não apresente uma proposta de design ainda não aplicada como regra vigente.';
const F1417_DESIGN_FOOTER =
  '\n\nRegra de design do projeto (sempre que o trabalho envolver UI):\n' +
  'Leia DESIGN.md antes de editar a interface. Este é o contrato visual do projeto; referências externas são complementares.' +
  F1417_RULE_TAIL;
const F1417_NO_CONTRACT_FOOTER =
  '\n\nRegra de design do projeto (sempre que o trabalho envolver UI):\n' +
  'O projeto não tem contrato visual aplicado (DESIGN.md ou .context/docs/design-system.md). Consulte AGENTS.md e siga primeiro os tokens e componentes que o código já usa.\n' +
  'Se precisar de direção visual, consulte as referências com nexus_design_system_local_list e informe a escolhida.' +
  F1417_RULE_TAIL;

it('F-1417: revisão de segurança só leitura sem UI na task não exige captura visual', () => {
  expect(visualTaskRequirement(F1417_TASK)).toBeUndefined();
});

it('F-1417: o rodapé de design injetado pelo Nexus não torna a task visual', () => {
  expect(visualTaskRequirement(`${F1417_TASK}${F1417_DESIGN_FOOTER}`)).toBeUndefined();
  expect(visualTaskRequirement(`${F1417_TASK}${F1417_NO_CONTRACT_FOOTER}`)).toBeUndefined();
});

it('F-1417: pedido visual direto com o rodapé continua exigindo captura', () => {
  expect(visualTaskRequirement(`Crie a tela de login com o formulário e o botão de entrar${F1417_DESIGN_FOOTER}`)).toBeDefined();
});

it('F-1417: pedido visual direto continua exigindo captura', () => {
  expect(visualTaskRequirement('Crie a tela de login com o formulário e o botão de entrar')).toBeDefined();
});
