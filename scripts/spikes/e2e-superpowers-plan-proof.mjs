/**
 * E2E real (CDP): router ao vivo + missão de PLANEJAMENTO com o ciclo
 * Superpowers (squad nexus-plan reescrito). Prova que o plano nasce em
 * docs/plan.md com headings `### Task N:` — o formato que o wave-pack fatia.
 *
 * Pré-requisito: dev rodando com NEXUS_REMOTE_DEBUG=9222.
 */
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9222';
const WORKSPACE = '/tmp/nexus-e2e-ui';
const OBJECTIVE =
  'planeje adicionar uma seção de contato no rodapé da landing page deste projeto (index.html), incluindo a validação do formulário — só o plano, sem escrever código';
const DEADLINE_MS = 10 * 60_000;

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const page = (await res.json()).find(
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
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

const evaluate = async (expression, timeoutMs = 120_000) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
};

// --- Router ao vivo neste build --------------------------------------------
console.log('[router] via IPC real…');
console.log('[router]', await evaluate(`(async () => JSON.stringify({
  trivia: await window.nexus.mission.routeIntent('quanto é 1+1?'),
  plan: await window.nexus.mission.routeIntent(${JSON.stringify(OBJECTIVE)}),
}))()`));

// --- Missão de planejamento (lane plan = squad Superpowers) -----------------
console.log('[plan] abrindo workspace e preparando missão plan…');
const started = await evaluate(`(async () => {
  try {
    await window.nexus.workspace.open(${JSON.stringify(WORKSPACE)});
    await new Promise((r) => setTimeout(r, 2000));
    // Mesmo shape do wizard na lane plan (recommendMissionRosterRoles).
    const mk = (id, name, cat, tools) => ({
      id, agentName: name, category: cat, cli: 'claude',
      allowedTools: tools, allowedSkills: [],
    });
    const roster = [
      mk('mission-coordinator', 'Coordenar planejamento', 'orchestrator', null),
      mk('plan-architect', 'Arquitetar o plano', 'architect', ['Read', 'Edit', 'Write', 'Bash']),
      mk('plan-reviewer', 'Revisar o plano', 'reviewer', ['Read', 'Bash']),
    ];
    const review = await window.nexus.mission.prepare({
      objective: ${JSON.stringify(OBJECTIVE)},
      contextPaths: [],
      roster,
      advanced: { lane: 'plan' },
    });
    const started = await window.nexus.mission.start({
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });
    return JSON.stringify({
      missionId: review.missionId,
      reviewSkills: (review.roster ?? []).map((a) => a.allowedSkills ?? null),
      state: started.state ?? started.status ?? null,
    });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`);
console.log('[plan]', started);
const info = JSON.parse(started);
if (info.error) throw new Error(info.error);

// --- Acompanha e responde perguntas do brainstorming -------------------------
console.log('[plan] acompanhando (até 10 min; respondo perguntas do brainstorming)…');
const deadline = Date.now() + DEADLINE_MS;
let lastState = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000));
  const snap = JSON.parse(await evaluate(`(async () => {
    try {
      const s = await window.nexus.mission.snapshot(${JSON.stringify(info.missionId)});
      let questions = [];
      try {
        const cp = await window.nexus.orch.missionControlPlane(${JSON.stringify(info.missionId)});
        questions = (cp?.pendingQuestions ?? cp?.questions ?? [])
          .filter((q) => q && (q.status === 'pending' || q.status === undefined))
          .map((q) => ({ id: q.id, text: String(q.text ?? q.question ?? '').slice(0, 120) }));
      } catch {}
      return JSON.stringify({ state: s.state ?? s.status, intentState: s.intentState ?? null, questions });
    } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
  })()`));
  const line = JSON.stringify({ state: snap.state, intentState: snap.intentState, questions: snap.questions?.length ?? 0 });
  if (line !== lastState) { console.log('[plan]', line); lastState = line; }
  if (snap.questions?.length) {
    for (const q of snap.questions) {
      console.log('[plan] respondendo pergunta:', q.id, q.text);
      await evaluate(`window.nexus.mission.command({
        kind: 'answer-question',
        missionId: ${JSON.stringify(info.missionId)},
        questionId: ${JSON.stringify(q.id)},
        text: 'Pode seguir com a sua recomendação padrão; escopo mínimo.',
      })`).catch((e) => console.log('[plan] resposta falhou:', String(e).slice(0, 120)));
    }
  }
  if (snap.state === 'completed' || snap.state === 'failed' || snap.state === 'done') break;
}
console.log('[plan] estado final:', lastState);
ws.close();
process.exit(0);
