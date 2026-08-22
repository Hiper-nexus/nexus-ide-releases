/**
 * E2E real no dev (CDP): prova o router de intenção via IPC de verdade e
 * roda UMA missão de UI pequena para inspecionar roster/skills/handoffs.
 *
 * Pré-requisito: dev rodando com NEXUS_REMOTE_DEBUG=9222.
 * Não faz parte do app empacotado.
 */
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9222';
const WORKSPACE = process.env.NEXUS_E2E_WORKSPACE ?? '/tmp/nexus-e2e-ui';
const OBJECTIVE =
  process.env.NEXUS_E2E_GOAL ??
  'crie uma landing page simples em index.html para a marca E2E seguindo o DESIGN.md do projeto';

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const targets = await res.json();
const page = targets.find(
  (t) => t.type === 'page' && t.url.includes('localhost') && !t.url.includes('pet.html'),
);
if (!page) throw new Error('renderer não encontrado');

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}, timeoutMs = 90_000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject, timer } = pending.get(msg.id);
  clearTimeout(timer);
  pending.delete(msg.id);
  msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
});
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

const evaluate = async (expression, timeoutMs = 120_000) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result?.value;
};

// --- Fase 1: router via IPC real ------------------------------------------
console.log('[fase1] router via IPC do renderer…');
const routerProof = await evaluate(`(async () => {
  const out = {};
  out.triviaRoute = await window.nexus.mission.routeIntent('quanto é 1+1?');
  out.triviaAnswer = await window.nexus.mission.answerDirect('quanto é 1+1?');
  out.workRoute = await window.nexus.mission.routeIntent(${JSON.stringify(OBJECTIVE)});
  return JSON.stringify(out);
})()`);
console.log('[fase1]', routerProof);

// --- Fase 2: missão de UI real --------------------------------------------
console.log('[fase2] abrindo workspace e preparando missão de UI…');
const started = await evaluate(`(async () => {
  try {
    await window.nexus.workspace.open(${JSON.stringify(WORKSPACE)});
    await new Promise((r) => setTimeout(r, 2000));
    // Mesmo shape do Caminho Expresso: allowedSkills [] explícito — o main
    // tem que conceder as skills do motor (política papel × objetivo × lane).
    const mk = (id, name, cat, tools) => ({
      id, agentName: name, category: cat, cli: 'claude',
      allowedTools: tools, allowedSkills: [],
    });
    const roster = [
      mk('coordenar-e-revisar', 'Coordenar e revisar', 'orchestrator', null),
      mk('implementar-interface', 'Implementar interface', 'executor', ['Read', 'Edit', 'Write', 'Bash']),
      mk('verificar-o-resultado', 'Verificar o resultado', 'reviewer', ['Read', 'Bash']),
    ];
    const review = await window.nexus.mission.prepare({
      objective: ${JSON.stringify(OBJECTIVE)},
      contextPaths: [],
      roster,
      advanced: { lane: 'standard' },
    });
    const started = await window.nexus.mission.start({
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });
    return JSON.stringify({
      missionId: review.missionId,
      reviewRoster: (review.roster ?? []).map((a) => ({
        id: a.id, skills: a.allowedSkills ?? null,
      })),
      state: started.state ?? started.status ?? started.lifecycle ?? null,
    });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`);
console.log('[fase2]', started);
const info = JSON.parse(started);
if (info.error) throw new Error(`missão não iniciou: ${info.error}`);

// --- Fase 3: observa bootstrap por 90s ------------------------------------
console.log('[fase3] acompanhando bootstrap (90s)…');
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const snap = await evaluate(`(async () => {
    try {
      const s = await window.nexus.mission.snapshot(${JSON.stringify(info.missionId)});
      return JSON.stringify({
        state: s.state ?? s.status ?? null,
        intentState: s.intentState ?? null,
        panes: (s.panes ?? s.agents ?? []).length,
      });
    } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
  })()`);
  console.log('[fase3]', snap);
}
console.log('[fase3] fim da janela de observação — missão segue rodando no dev.');
ws.close();
process.exit(0);
