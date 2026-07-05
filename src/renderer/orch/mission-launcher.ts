import type { AdapterInfo, PaneModel } from '../../shared/types';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useHomeStore } from '../state/home-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes, createPane } from '../lib/split-tree';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { getPaneSessionId, waitForSession } from '../terminal/terminal-host';

/**
 * Launch logic behind the wizard when a
 * mission starts:
 *  - LIVRE: open N solo panes (shell or agent CLI) in the workspace;
 *  - SQUAD: spawn the squad's orchestrator CLI and, once it finishes booting,
 *    inject its orchestratorInstructions + roster as the kickoff prompt
 *    (bracketed paste, then Enter) so it immediately starts delegating via
 *    the embedded MCP tools.
 */

/**
 * Mata as sessões dos agentes CLI vivos no grid antes de subir outra missão.
 * Sem isso, abrir uma 2ª missão deixava DOIS orquestradores Claude vivos ao
 * mesmo tempo — eles reescrevem o mesmo item de keychain e zeram o login de
 * todos. A missão anterior continua salva (mission-pane-store) e volta pela
 * trilha com --continue.
 */
export function killLiveAgents(): void {
  const { root } = useLayoutStore.getState();
  for (const pane of listPanes(root)) {
    if (pane.kind === 'cli-agent') {
      const sid = getPaneSessionId(pane.id);
      if (sid) window.nexus.pty.kill(sid);
    }
  }
}
const BOOT_IDLE_TIMEOUT_MS = 15_000;
const PASTE_SETTLE_MS = 250;

/**
 * Modo Livre: build a fresh grid of EXACTLY one pane per slot, each backed by
 * the chosen provider (or a plain shell). Replaces the current grid so "2
 * panes" reliably shows two — no fragile iterative splitting.
 */
export function launchLibrePanes(
  slots: string[],
  adapters: AdapterInfo[],
): void {
  const cwd = getActiveWorkspacePath() ?? undefined;
  const panes: PaneModel[] = slots.map((slot) => {
    if (slot === 'shell') return createPane('shell', cwd);
    const adapter = adapters.find((a) => a.id === slot);
    return createPane('cli-agent', cwd, slot, adapter?.models.default ?? '');
  });
  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes(panes);
}

/** Resolve on the CLI's first idle (booted, waiting for input) or timeout. */
function waitFirstIdle(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      resolve();
    };
    const unsub = window.nexus.pty.onStateChange(sessionId, (state) => {
      if (state === 'idle') finish();
    });
    setTimeout(finish, BOOT_IDLE_TIMEOUT_MS);
  });
}

function rosterBlock(agents: SquadAgent[]): string {
  return agents
    .filter((a) => a.category !== 'orchestrator')
    .map(
      (a) =>
        `- ${a.agentName} (${a.category}, cli=${a.cli}` +
        `${a.model ? `, model=${a.model}` : ''})`,
    )
    .join('\n');
}

function kickoffPrompt(squad: Squad): string {
  const parts: string[] = [];
  if (squad.orchestratorInstructions.trim()) {
    parts.push(squad.orchestratorInstructions.trim());
  }
  parts.push(
    `## Seu squad (${squad.name})\n${rosterBlock(squad.agents) || '(sem workers definidos)'}`,
  );
  parts.push(
    'Você é o orquestrador desta missão dentro do NexusIDE. Use as tools MCP ' +
      'do servidor "nexus" para orquestrar: nexus_mission_create para abrir a ' +
      'missão, nexus_pane_spawn {agentName} para spawnar cada worker (as ' +
      'allowlists do squad são aplicadas automaticamente), nexus_pane_write / ' +
      'nexus_pane_wait_idle / nexus_pane_read para coordenar, e ' +
      'nexus_handoff_list para coletar os resultados. Cada worker deve ' +
      'finalizar com nexus_handoff_submit. Comece perguntando ao usuário qual ' +
      'é a missão, caso ainda não tenha sido informada.',
  );
  parts.push(
    '## VELOCIDADE (time is money)\n' +
      'Spawne TODOS os workers necessários EM PARALELO no primeiro turno ' +
      '(várias chamadas de nexus_pane_spawn de uma vez) — nunca um por vez ' +
      'esperando o anterior. Não recite o plano nem peça confirmações: ' +
      'recebida a missão, EXECUTE. Respostas suas no chat: curtas.',
  );
  parts.push(
    '## REGRA INEGOCIÁVEL: você DELEGA, não executa\n' +
      'Você NÃO escreve código nem edita arquivos você mesmo. Recebida a ' +
      'missão, IMEDIATAMENTE: (1) nexus_mission_create; (2) quebre em tarefas; ' +
      '(3) para CADA tarefa, nexus_route_task e nexus_pane_spawn do worker ' +
      'correspondente do seu time; (4) coordene e cobre handoffs. Se uma tool ' +
      'falhar, mostre o erro EXATO no chat e tente uma vez de novo — nunca ' +
      'silencie a falha resolvendo a tarefa você mesmo. Fazer o trabalho no ' +
      'seu próprio pane é FALHA de orquestração.',
  );
  parts.push(
    '## Realidade de cada CLI (MCP e limites)\n' +
      'Só claude/glm/longcat têm as tools nexus_* (MCP). codex, gemini, ' +
      'grok, kimi e agy NÃO têm — nunca peça a eles para chamar nexus_*; ' +
      'dê a tarefa em texto puro e aguarde o bloco de handoff impresso no ' +
      'terminal (o contrato certo é anexado automaticamente ao prompt). ' +
      'RATE LIMIT: se um worker reportar limite de uso/rate limit, NÃO ' +
      'insista nem espere — chame nexus_route_task de novo com ' +
      '{exclude: ["<cli-limitada>"]}, respawne o worker na CLI indicada e ' +
      'siga. Use effort xhigh só no que é realmente crítico: xhigh queima a ' +
      'cota do provedor muito mais rápido.\n' +
      'LOGIN: o binário `claude` (assinatura) é SEU, exclusivo do ' +
      'orquestrador. NUNCA spawne worker no adapter claude — o route_task já ' +
      'devolve alternativas não-claude. Vários claude ao mesmo tempo corrompem ' +
      'a credencial compartilhada e derrubam o login de todos (glm/longcat são ' +
      'liberados: usam token próprio).',
  );
  parts.push(
    '## Engenharia de verdade (XP)\n' +
      'Você decide O QUÊ e POR QUÊ; os workers decidem o COMO. Handoff só ' +
      'é aceito VERDE: exija que o worker rode os checks do próprio projeto ' +
      '(testes/lint/typecheck/build) e recuse entrega vermelha ou sem teste ' +
      'para mudança não-trivial. Incrementos pequenos e reversíveis — a ' +
      'árvore fica production-ready após cada handoff. SPEC VIVA: se o ' +
      'workspace não tiver CLAUDE.md/AGENTS.md, inclua na primeira tarefa ' +
      'criar um starter (stack, comandos de build/test, convenções); toda ' +
      'pedra no caminho descoberta na missão deve ser documentada lá.',
  );
  parts.push(
    '## Design fora do padrão IA\n' +
      'Entrega com UI só finaliza após crítica do UX Designer. Rejeite o ' +
      '"look de IA": sparkles ✨/emoji como ícone, gradiente roxo, ' +
      'glassmorphism default, card grids idênticos, eyebrow uppercase em ' +
      'toda seção. Exija: design system do projeto, hierarquia tipográfica ' +
      'real, estados completos (hover/focus/empty/error) e, se a skill ' +
      'impeccable estiver disponível, `impeccable detect` rodado na entrega.',
  );
  parts.push(
    '## Roster é um MENU, não obrigação\n' +
      'Spawne SOMENTE os workers que a missão realmente pede: missão de um ' +
      'arquivo não precisa do squad inteiro; missão grande usa todos. QA e ' +
      'Security entram antes de finalizar sempre que houver entrega de ' +
      'código (QA) ou superfície sensível — auth, pagamentos, rede, dados ' +
      'de usuário (Security).',
  );
  parts.push(
    '## Código enxuto (ponytail)\n' +
      'Os workers operam em modo "lazy senior dev": mínimo código que ' +
      'funciona, reuso antes de escrever, zero abstração especulativa. Dê ' +
      'tarefas com escopo MÍNIMO e, ao revisar handoffs, REJEITE ' +
      'over-engineering — exija a versão mais curta que resolve.',
  );
  parts.push(
    '## Roteamento inteligente (economia de tokens)\n' +
      'Uma das suas missões é POUPAR tokens e acelerar o trabalho. Antes de ' +
      'CADA delegação, chame nexus_route_task {task} e use o adapterId/model/' +
      'effort retornados no nexus_pane_spawn: tarefa fácil vai para modelo ' +
      'barato e rápido (grok, haiku, gpt-5.4-mini), tarefa média para sonnet/' +
      'gpt-5.4, e só o que é realmente difícil/crítico (arquitetura, auth, ' +
      'pagamentos, migração) vai para opus/fable/gpt-5.5 com effort alto. ' +
      'Nunca gaste um modelo caro em tarefa trivial; nunca entregue tarefa ' +
      'crítica a um modelo fraco. Quebre missões grandes em tarefas pequenas ' +
      'e roteie cada uma individualmente.',
  );
  return parts.join('\n\n');
}

export interface SquadLaunchResult {
  ok: boolean;
  paneId?: string;
  error?: string;
}

/** Only Claude Code reliably drives the embedded nexus MCP orchestration. */
const ORCHESTRATOR_CLI = 'claude';

export function launchSquadMission(
  squad: Squad,
  adapters: AdapterInfo[],
): SquadLaunchResult {
  const orchestrator =
    squad.agents.find((a) => a.category === 'orchestrator') ?? squad.agents[0];
  if (!orchestrator) {
    return { ok: false, error: 'Este squad não tem agentes.' };
  }

  // The orchestrator ALWAYS runs on Claude — it is the only CLI that reliably
  // calls the nexus_pane_* MCP tools to spawn and coordinate workers. A codex /
  // grok / gemini orchestrator boots but never delegates (the "squad opens but
  // nothing starts" bug). Workers keep their own CLI. If a legacy squad declared
  // a different orchestrator CLI we override it here as a safety net; the wizard
  // already locks the picker to Claude.
  const claudeAdapter = adapters.find((a) => a.id === ORCHESTRATOR_CLI);
  const cli = ORCHESTRATOR_CLI;
  const model =
    (orchestrator.cli === ORCHESTRATOR_CLI ? orchestrator.model : undefined) ??
    claudeAdapter?.models.default ??
    '';
  if (!claudeAdapter?.installed) {
    return {
      ok: false,
      error:
        'O orquestrador roda no Claude, mas a CLI `claude` não foi detectada. ' +
        'Instale/entre no Claude Code (ou ajuste o binário em Configurações › Providers) e tente de novo.',
    };
  }

  // Start the mission in a clean grid with just the orchestrator pane (a
  // squad opens its own workspace). Workers are added by
  // the orchestrator via the MCP tools as it delegates. Always replaces the
  // grid so something starts — no silent no-op.
  const cwd = getActiveWorkspacePath() ?? undefined;
  const orchPane: PaneModel = {
    ...createPane('cli-agent', cwd, cli, model),
    title: `${squad.name} · orq`,
    orchRequestId: `squad-${squad.id}-${Date.now().toString(36)}`,
    role: 'orchestrator' as const,
    agentName: orchestrator.agentName,
  };
  // Preserva a missão anterior (fica na trilha) e garante 1 orquestrador só.
  killLiveAgents();
  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes([orchPane]);

  // Kickoff injection runs async — the wizard closes immediately, the
  // instructions land as soon as the CLI is booted and idle.
  void (async () => {
    const sessionId = await waitForSession(orchPane.id);
    if (!sessionId) return;
    await waitFirstIdle(sessionId);
    const prompt = kickoffPrompt(squad);
    // Bracketed paste keeps multi-line playbooks from submitting line-by-line.
    window.nexus.pty.write(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    setTimeout(() => window.nexus.pty.write(sessionId, '\r'), PASTE_SETTLE_MS);
  })();

  useOrchStore.getState().bindPaneMission(orchPane.id, undefined);
  return { ok: true, paneId: orchPane.id };
}
