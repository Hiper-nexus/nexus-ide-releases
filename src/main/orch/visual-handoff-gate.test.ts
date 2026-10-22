import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { ProcessGitRunner } from '../runtime/git-command';
import * as candidateSnapshots from '../context/candidate-working-tree-snapshot';
import {
  __resetVisualHandoffBouncesForTests, checkVisualHandoff, recordVisualHandoffEvidence, visualCandidateBindingsSettled,
  visualHandoffSendBack, visualTaskRequirement, visualTaskAtSpawn, visualEvidenceVerified, VISUAL_CAPTURE_STALE_REASON,
  observeVisualCandidate,
} from './visual-handoff-gate';

let dir: string;
let manager: ProjectRuntimeManager;
const scope = testProjectScope();
const context = () => ({ scope, executionScope: scope, sessionId: 'worker-session', missionId: 'mission',
  workerIncarnationId: 'incarnation', visualTask: { since: 1000, id: 'assignment-a' } });
// The candidate the fake checkout shows right now; a test "edits" it by reassigning.
let candidate: string;
const observeCandidate = vi.fn(async () => ({ base: 'b'.repeat(40), fingerprint: candidate }));
const deps = { servedFromCandidate: () => true, observeCandidate };
beforeEach(() => {
  candidate = 'a'.repeat(64);
  observeCandidate.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-handoff-'));
  manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: 'test' });
  manager.open(scope).db.prepare("INSERT INTO missions (id,title,status,created_at,updated_at) VALUES ('mission','UI','running',1,1)").run();
});
afterEach(async () => {
  await visualCandidateBindingsSettled();
  manager.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

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
  expect(await checkVisualHandoff({ ...context(), visualTask }, { manager, observeCandidate })).toMatchObject({ required: true, verified: false });
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
// Revisão 22/10: o pedido de bug de UI chega RELATADO, sem verbo de reparo e
// com um único substantivo de UI ("o modal … não fecha"). O quórum do
// isUiWorkText e a regra de verbo da autoridade de design o perdiam, e o
// worker que corrigia a tela nunca era cobrado pela captura.
it.each([
  'O modal de login não fecha no mobile',
  'Erro de hidratação na página de preços',
  'O menu dropdown não abre no Safari',
  'O botão de enviar some no celular',
  'Texto cortado no cabeçalho do dashboard',
  'O formulário de cadastro não envia no iPhone',
  'The checkout modal does not close on mobile',
  'hydration mismatch no checkout',
])('review 22/10: a reported UI defect requires a capture: %s', assignment => {
  expect(visualTaskRequirement(assignment, 1000)).toEqual({ since: 1000, id: expect.any(String) });
});
it.each([
  'Corrigir o erro 500 na API de login',
  'O token de login não expira no backend',
  'corrigir o bug da tela de erro que trava o backend',
  'Melhorar a performance do dashboard',
  'O cron de backup não roda no servidor',
  'Calcular a hidratação diária recomendada do usuário',
  'Documente por que o modal de login não fecha no mobile',
  'O endpoint de usuários não responde no staging',
])('review 22/10: backend or document text near UI words requires no capture: %s', assignment => {
  expect(visualTaskRequirement(assignment, 1000)).toBeUndefined();
});
it('preserves an already classified nonvisual task instead of reclassifying appended instructions', () => {
  const initialPrompt = 'Crie a tela de login com layout responsivo.';
  expect(visualTaskAtSpawn({ role: 'worker', visualTask: undefined, initialPrompt })).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', initialPrompt })).toEqual({ since: expect.any(Number), id: expect.any(String) });
  expect(visualTaskAtSpawn({ role: 'orchestrator', initialPrompt })).toBeUndefined();
});
// Revisão 22/10: o leitor de uma tarefa de UI (mapeamento, revisão) entrega
// achados, não tela renderizada; cobrá-lo rebaixava todo leitor a partial.
// F-1318: isolatedWriter vence o rótulo readOnly — esse pane escreve.
it('review 22/10: a read-only lane is never charged, but a writer labeled readOnly is (F-1318)', () => {
  const initialPrompt = 'Crie a tela de login com layout responsivo.';
  const visualTask = { since: 1, id: 'explicit-assignment' };
  expect(visualTaskAtSpawn({ role: 'worker', readOnly: true, initialPrompt })).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', readOnly: true, visualTask, initialPrompt })).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', executionMode: 'read_only', visualTask, initialPrompt })).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', readOnly: true, isolatedWriter: true, initialPrompt }))
    .toEqual({ since: expect.any(Number), id: expect.any(String) });
  expect(visualTaskAtSpawn({ role: 'worker', readOnly: true, executionMode: 'isolated_worktree', visualTask, initialPrompt }))
    .toBe(visualTask);
  expect(visualTaskAtSpawn({ role: 'worker', readOnly: false, visualTask, initialPrompt })).toBe(visualTask);
});
it('a declared screenshot path or convincing summary cannot satisfy missing Main evidence', async () => {
  expect(await checkVisualHandoff(context(), { manager, observeCandidate })).toMatchObject({ required: true, verified: false });
  expect(await checkVisualHandoff({ ...context(), visualTask: undefined }, { manager, observeCandidate })).toEqual({ required: false, verified: true });
});
it('requires the exact worker generation, execution root, assignment time and current image bytes', async () => {
  const store = createScopedBrowserArtifactStore(manager, scope);
  const image = store.recordScreenshot({ paneId: 'browser-pane', missionId: 'mission', png: Buffer.from('fixture-png'),
    width: 1, height: 1, url: 'http://localhost:3000', title: 'UI', capturedAt: 1100 });
  expect(recordVisualHandoffEvidence(context(), image.id, manager, deps)).toBe(true);
  expect(await checkVisualHandoff(context(), { manager, observeCandidate })).toMatchObject({ verified: true, artifactId: image.id });
  expect(await checkVisualHandoff({ ...context(), workerIncarnationId: 'other' }, { manager, observeCandidate })).toMatchObject({ verified: false });
  expect(await checkVisualHandoff({ ...context(), executionScope: { ...scope, rootRealPath: '/other' } }, { manager, observeCandidate })).toMatchObject({ verified: false });
  expect(await checkVisualHandoff({ ...context(), visualTask: { since: 1200, id: 'assignment-b' } }, { manager, observeCandidate })).toMatchObject({ verified: false });
  fs.writeFileSync(image.path, 'tampered');
  expect(await checkVisualHandoff(context(), { manager, observeCandidate })).toMatchObject({ verified: false });
});

it('requires evidence from a sealed visual task even without a spawn hint', async () => {
  expect(await checkVisualHandoff({ ...context(), visualTask: undefined }, { manager, observeCandidate,
    task: { plannedTitle: 'Corrija o bug da tela de login', plannedDetail: 'Layout responsivo com formulário.', task: { createdAt: 1000 } },
  })).toMatchObject({ required: true, verified: false });
});

it('does not let another worker or mission claim an existing capture', async () => {
  const store = createScopedBrowserArtifactStore(manager, scope);
  const image = store.recordScreenshot({ paneId: 'browser-pane', missionId: 'mission', png: Buffer.from('fixture'),
    width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 1100 });
  expect(recordVisualHandoffEvidence(context(), image.id, manager, deps)).toBe(true);
  expect(recordVisualHandoffEvidence({ ...context(), sessionId: 'other' }, image.id, manager, deps)).toBe(false);
  expect(recordVisualHandoffEvidence({ ...context(), missionId: 'other' }, image.id, manager, deps)).toBe(false);
  expect(await checkVisualHandoff({ ...context(), sessionId: 'other' }, { manager, observeCandidate })).toMatchObject({ verified: false });
});

// Revisão 22/10: a captura prova o build DESTE worker no candidato que ela
// mostrou. Página pública não é evidência; edição depois da captura (rodada de
// rework incluída) pede captura nova; commitar a mesma árvore não.
describe('review 22/10: a capture is bound to the preview and to the candidate', () => {
  const shot = (url = 'http://127.0.0.1:4567/') => createScopedBrowserArtifactStore(manager, scope).recordScreenshot({
    paneId: 'browser-pane', missionId: 'mission', png: Buffer.from(`fixture ${Math.random()}`), width: 1, height: 1,
    url, title: 'UI', capturedAt: 1100 });

  it('does not turn an incomplete snapshot fingerprint into a candidate observation', async () => {
    const snapshot = vi.spyOn(candidateSnapshots, 'captureWorkingTreeCandidate').mockResolvedValue({
      source: 'filesystem', headSha: null, fingerprint: 'f'.repeat(64), contentFingerprint: 'a'.repeat(64),
      changedPaths: [], deletedPaths: [], untrackedPaths: [], diff: '', complete: false,
      incompleteReasons: ['candidate file limit reached'],
    });
    try {
      expect(await observeVisualCandidate(scope)).toBeNull();
    } finally {
      snapshot.mockRestore();
    }
  });

  it.each(['null', 'error'])('refuses evidence when both candidate observations are unavailable (%s)', async mode => {
    const unavailable = async () => {
      if (mode === 'error') throw new Error('checkout cannot be read');
      return null;
    };
    const image = shot();
    expect(recordVisualHandoffEvidence(context(), image.id, manager,
      { ...deps, observeCandidate: unavailable })).toBe(true);
    expect(await checkVisualHandoff(context(), { manager, observeCandidate: unavailable }))
      .toEqual({ required: true, verified: false, reason: VISUAL_CAPTURE_STALE_REASON });
  });

  it('a page that is not served from this checkout is not evidence', async () => {
    const served = vi.fn(() => false);
    const image = shot('https://example.com/');
    expect(recordVisualHandoffEvidence(context(), image.id, manager, { ...deps, servedFromCandidate: served })).toBe(false);
    expect(served).toHaveBeenCalledWith('https://example.com/', scope);
    expect(await checkVisualHandoff(context(), { manager, observeCandidate })).toMatchObject({ verified: false });
  });

  it('an edit after the capture needs a fresh capture of the current build', async () => {
    const first = shot();
    expect(recordVisualHandoffEvidence(context(), first.id, manager, deps)).toBe(true);
    expect(await checkVisualHandoff(context(), { manager, observeCandidate })).toMatchObject({ verified: true, artifactId: first.id });
    candidate = 'c'.repeat(64); // rework: the worker changed the code
    expect(await checkVisualHandoff(context(), { manager, observeCandidate }))
      .toEqual({ required: true, verified: false, reason: VISUAL_CAPTURE_STALE_REASON });
    const second = shot();
    expect(recordVisualHandoffEvidence(context(), second.id, manager, deps)).toBe(true);
    expect(await checkVisualHandoff(context(), { manager, observeCandidate })).toMatchObject({ verified: true, artifactId: second.id });
    // The candidate is measured against the HEAD recorded at capture time.
    expect(observeCandidate).toHaveBeenLastCalledWith(scope, 'b'.repeat(40));
  });

  // Revisão 22/10: o artifact só levava {artifactId, sha256} e ninguém além do
  // worker via a imagem. O juiz recebe o caminho da imagem verificada e a
  // instrução de abri-la antes de aceitar.
  it('the verified verdict tells the judge where the verified image is and to look at it', async () => {
    const image = shot('http://127.0.0.1:4567/precos');
    expect(recordVisualHandoffEvidence(context(), image.id, manager, deps)).toBe(true);
    const verdict = await checkVisualHandoff(context(), { manager, observeCandidate });
    expect(verdict).toMatchObject({ required: true, verified: true, artifactId: image.id, sha256: image.sha256,
      path: image.path, url: 'http://127.0.0.1:4567/precos', width: 1, height: 1, capturedAt: 1100 });
    expect(verdict.required && verdict.verified && verdict.reviewHint).toContain(image.path);
    expect(verdict.required && verdict.verified && verdict.reviewHint).toMatch(/antes de aceitar/);
  });

  it('the check waits for a capture-time observation still running', async () => {
    let release!: () => void;
    const slow = vi.fn(() => new Promise<{ base: string; fingerprint: string }>((resolve) => {
      release = () => resolve({ base: 'b'.repeat(40), fingerprint: candidate });
    }));
    const image = shot();
    expect(recordVisualHandoffEvidence(context(), image.id, manager, { ...deps, observeCandidate: slow })).toBe(true);
    const verdict = checkVisualHandoff(context(), { manager, observeCandidate });
    await Promise.resolve();
    release();
    expect(await verdict).toMatchObject({ verified: true, artifactId: image.id });
  });

  it('a row recorded before the binding existed does not prove the candidate', async () => {
    const image = shot();
    manager.open(scope).db.prepare(`INSERT INTO visual_handoff_evidence
      (artifact_id, mission_id, session_id, worker_incarnation_id, execution_root, captured_at, assignment_id)
      VALUES (?, 'mission', 'worker-session', 'incarnation', ?, 1100, 'assignment-a')`).run(image.id, scope.rootRealPath);
    expect(await checkVisualHandoff(context(), { manager, observeCandidate }))
      .toEqual({ required: true, verified: false, reason: VISUAL_CAPTURE_STALE_REASON });
  });

  it('with a real checkout: committing the captured tree keeps the capture, a later edit does not', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visual-candidate-')));
    try {
      const git = new ProcessGitRunner();
      const run = (...args: string[]) => git.run(root, args).stdout.trim();
      fs.writeFileSync(path.join(root, 'page.html'), '<h1>v1</h1>\n');
      run('init', '-q');
      run('config', 'user.name', 'Nexus Test');
      run('config', 'user.email', 'test@example.invalid');
      run('add', '--', 'page.html');
      run('commit', '-qm', 'Base');
      const ctx = { ...context(), executionScope: { ...scope, rootRealPath: root } };
      fs.writeFileSync(path.join(root, 'page.html'), '<h1>v2</h1>\n');
      fs.writeFileSync(path.join(root, 'modal.css'), '.modal { display: none; }\n');
      const image = shot();
      expect(recordVisualHandoffEvidence(ctx, image.id, manager, { servedFromCandidate: () => true })).toBe(true);
      await visualCandidateBindingsSettled();
      run('add', '-A', '--', '.');
      run('commit', '-qm', 'Fix modal');
      expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ verified: true, artifactId: image.id });
      fs.writeFileSync(path.join(root, 'modal.css'), '.modal { display: block; }\n');
      expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ verified: false, reason: VISUAL_CAPTURE_STALE_REASON });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('review 22/10: one send-back before a visual delivery becomes partial', () => {
  const pending = { required: true, verified: false, reason: 'falta a captura' } as const;
  const verified = { required: true, verified: true, artifactId: 'browser-x', sha256: 'f'.repeat(64) } as const;
  beforeEach(() => __resetVisualHandoffBouncesForTests());

  it('sends back once per assignment with the capture recipe, then lets the partial through', () => {
    const message = visualHandoffSendBack(context(), pending);
    expect(message).toContain('devolução 1/1');
    expect(message).toContain('falta a captura');
    expect(message).toMatch(/nexus_preview_start[\s\S]*nexus_browser_open[\s\S]*nexus_browser_responsive/);
    expect(visualHandoffSendBack(context(), pending)).toBeNull();
    // A transport replay of the partial is not bounced again.
    expect(visualHandoffSendBack(context(), pending)).toBeNull();
    // Another assignment of the same worker gets its own send-back.
    expect(visualHandoffSendBack({ ...context(), visualTask: { since: 2000, id: 'assignment-b' } }, pending)).not.toBeNull();
  });

  it('a verified capture resets it, and nothing is sent back without a return channel or a requirement', () => {
    expect(visualHandoffSendBack(context(), pending)).not.toBeNull();
    expect(visualHandoffSendBack(context(), verified)).toBeNull();
    expect(visualHandoffSendBack(context(), pending)).not.toBeNull();
    expect(visualHandoffSendBack({ ...context(), sessionId: 'pty' }, pending, { returnable: false })).toBeNull();
    expect(visualHandoffSendBack(context(), { required: false, verified: true })).toBeNull();
    expect(visualHandoffSendBack(context(), undefined)).toBeNull();
  });
});

it.each([2000, 500])('refuses an earlier task capture after reassignment at clock %s', async since => {
  const ctx = { ...context(), visualTask: visualTaskRequirement('Crie a tela de login com layout responsivo.', 1000)! };
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('old assignment'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 2000 });
  expect(recordVisualHandoffEvidence(ctx, image.id, manager, deps)).toBe(true);
  ctx.visualTask = visualTaskRequirement('Crie a tela de login com layout responsivo.', since)!;
  expect(await checkVisualHandoff(ctx, { manager, observeCandidate })).toMatchObject({ required: true, verified: false });
});

it('keeps same-assignment evidence valid if the wall clock moves backward during capture', async () => {
  const ctx = context();
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('same assignment'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 500 });
  expect(recordVisualHandoffEvidence(ctx, image.id, manager, deps)).toBe(true);
  expect(await checkVisualHandoff(ctx, { manager, observeCandidate })).toMatchObject({ required: true, verified: true });
});

it('revokes an in-flight check if the assignment changes and propagates authority cancellation', async () => {
  const ctx = context();
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('fixture'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 1100 });
  recordVisualHandoffEvidence(ctx, image.id, manager, deps);
  const realOpen = fs.promises.open.bind(fs.promises);
  const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    ctx.visualTask = { since: 1200, id: 'assignment-b' };
    return realOpen(...args);
  });
  try { expect(await checkVisualHandoff(ctx, { manager, observeCandidate })).toMatchObject({ verified: false }); }
  finally { open.mockRestore(); }
  await expect(checkVisualHandoff(context(), { manager, observeCandidate, assertCurrent: () => { throw new Error('stale authority'); } }))
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

it('F-1417 (revisão Grok): título da regra citado SEM o fechamento não apaga o pedido visual depois dele', () => {
  expect(visualTaskRequirement(
    'O brief cita:\nRegra de design do projeto (sempre que o trabalho envolver UI):\nCrie a tela de login com o botão Entrar.',
  )).toBeDefined();
});

it('F-1417 (revisão Grok): título citado e rodapé real depois de linha em branco — o pedido entre eles fica', () => {
  expect(visualTaskRequirement(
    'Regra de design do projeto (sempre que o trabalho envolver UI):\nCrie a tela de login com o botão Entrar.' +
      F1417_DESIGN_FOOTER,
  )).toBeDefined();
});

// F-1635: a captura verificada conta como evidência de verificação na revisão
// Jev. O risco é o inverso: `{ required: false, verified: true }` é o retorno
// de uma tarefa NÃO visual (nada a exigir) e, lido como "captura observada",
// daria evidência visual a todo handoff de código — desligando o sinal de
// "sem evidência de verificação" justamente onde ele importa.
describe('visualEvidenceVerified', () => {
  it('só a captura que o Main verificou é evidência', () => {
    expect(visualEvidenceVerified({ required: true, verified: true, artifactId: 'a1', sha256: 'f'.repeat(64) })).toBe(true);
  });

  it('tarefa não visual (required:false, verified:true) NÃO é evidência visual', () => {
    expect(visualEvidenceVerified({ required: false, verified: true })).toBe(false);
  });

  it('tarefa visual sem captura não é evidência', () => {
    expect(visualEvidenceVerified({ required: true, verified: false, reason: 'falta captura' })).toBe(false);
  });

  it('veredito ausente não é evidência', () => {
    expect(visualEvidenceVerified(undefined)).toBe(false);
  });
});
