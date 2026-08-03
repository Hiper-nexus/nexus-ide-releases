/**
 * The 4 coarse voice tools (delegar/consultar/ler/navegar pattern) for the
 * Jarvis Live realtime session, ported from the peer ADE sidecar reference
 * (`GeminiLiveSession.js` functionDeclarations). The Live session exposes these
 * COARSE tools — not the full action catalog — so the voice loop never blocks on
 * the slower brain: 'delegar' hands real work to a pane; consultar/ler are
 * answered directly from context; navegar drives the nexus UI.
 *
 * The declarations use Gemini's uppercase schema types ('OBJECT'/'STRING'). The
 * resolver maps a coarse call to nexus's existing action vocabulary
 * (NexusRealtimeActionArgs) or to a direct-answer intent — pure, testable.
 */
import {
  type NexusRealtimeActionArgs,
  summarizeNexusRealtimeAction,
} from '../../../shared/voice-realtime-actions';
import type { RealtimeToolDefinition } from './provider';

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    [key: string]: unknown;
  };
}

export const COARSE_VOICE_TOOL_NAMES = [
  'delegar',
  'consultar',
  'ler',
  'navegar',
  'encerrar',
  'comandar',
  'restaurar',
  'perguntar',
] as const;

export type CoarseVoiceToolName = (typeof COARSE_VOICE_TOOL_NAMES)[number];

/**
 * functionDeclarations declared inline in the Gemini Live setup. Descriptions
 * are re-expressed in nexus's vocabulary (workspaces/squads/panes/terminal/
 * browser/screens) while preserving the coarse delegar/consultar/ler/navegar
 * pattern from the reference.
 */
export const COARSE_VOICE_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: 'delegar',
    description:
      'Delega trabalho substancial ao pane ativo do Nexus (codar, pesquisar, criar/rodar tarefa). Use para pedidos de TRABALHO real. NÃO use para abrir/mostrar/focar workspace, pane ou tela — isso é "navegar", não trabalho.',
    parameters: {
      type: 'OBJECT',
      properties: {
        briefing: {
          type: 'STRING',
          description:
            'Write an execution-ready engineering prompt in English with explicit sections: Objective, Execution requirements, and Acceptance criteria. Preserve every user constraint and relevant current Nexus context. Infer only necessary implementation and verification details; do not invent product scope, stack, provider, account, target pane, or destructive action. If a missing choice would materially change the result, ask the user instead of calling this tool.',
        },
      },
      required: ['briefing'],
    },
  },
  {
    name: 'consultar',
    description:
      'Consulta estado do Nexus (workspaces, panes, squads, missões, tela atual) e responde direto a partir do contexto fornecido. Use para perguntas de estado/UI ("quais panes?", "que tela é essa?").',
    parameters: {
      type: 'OBJECT',
      properties: {
        pergunta: {
          type: 'STRING',
          description: 'O que o usuário quer saber.',
        },
      },
      required: ['pergunta'],
    },
  },
  {
    name: 'ler',
    description:
      'Lê conteúdo visível no Nexus. Para output recente de um pane (o que o agente/Claude respondeu ali), use scope "pane" e paneId opcional; sem paneId lê o pane ativo. Para "leia esta tela/página", "o que tem aqui" ou conteúdo visível fora de um pane, use scope "view" — ele coleta a visão atual por accessibility tree + OCR local. Nunca invente texto que a leitura não retornar.',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: {
          type: 'STRING',
          description:
            '"pane" (default) lê o output de um pane; "view" lê a tela/página visível atual por accessibility + OCR local.',
        },
        paneId: {
          type: 'STRING',
          description: 'Id/nome do pane, ou "ativo" para o pane atual.',
        },
      },
      required: [],
    },
  },
  {
    name: 'navegar',
    description:
      'Navega a UI do Nexus: abre/foca workspace, squad, pane, terminal, browser ou tela (grid/board/settings/canvas/voz). Também dirige o wizard: "mission-new" abre Nova Missão; "squad-picker" abre a lista de squads salvos sem criar nem iniciar um; "mission-agentic" abre Nova Missão diretamente no Modo Agêntico (query recebe o objetivo se o usuário já o disse); "workspace-new" abre o assistente de NOVO workspace (pasta + setup — NÃO confundir com abrir um projeto existente); "design-squad" cria um squad novo e abre a revisão; "wizard-fire" usa o squad revisado e avança o wizard (como o botão Usar este squad), sem substituir a aprovação nativa antes da execução. Para iniciar/criar missão no modo agêntico, use mission-agentic — NUNCA use voz/settings nem design-squad. Use SEMPRE que o usuário pedir para abrir/mostrar/ir/focar/criar missão/novo workspace/confirmar. NÃO delegue navegação.',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: {
          type: 'STRING',
          description:
            "O que navegar: 'workspace', 'workspace-new', 'squad', 'squad-picker', 'pane', 'terminal', 'browser', 'screen', 'mission-new', 'mission-agentic', 'design-squad' ou 'wizard-fire'.",
        },
        query: {
          type: 'STRING',
          description:
            'Nome/id do alvo; em screen use grid, board, settings, canvas ou voz; em browser use a URL; em workspace use o nome do projeto; em mission-agentic use o objetivo falado, se houver; vazio em workspace-new/mission-new/design-squad/wizard-fire.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'encerrar',
    description:
      'Encerra a sessão de voz (o usuário se despediu: "tchau", "é só isso", "valeu", "pode desligar"). Responda 1 frase curta de despedida E chame esta função — nunca desligue sem chamá-la.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'comandar',
    // peer ADE GeminiLiveSession.js — literal pane_write; never invent text.
    description:
      'Digita e envia (Enter) um comando/prompt literal no terminal de um pane já aberto — ex. "/model opus", "/effort high", ou uma pergunta rápida. Use quando o usuário pedir EXPLICITAMENTE para mandar/digitar algo NUM PANE JÁ ABERTO. NÃO use para abrir pane novo (isso é "delegar") nem para trabalho substancial (isso também é "delegar"). NUNCA invente o texto — use exatamente o que o usuário pediu para mandar.',
    parameters: {
      type: 'OBJECT',
      properties: {
        paneId: {
          type: 'STRING',
          description:
            'Id do pane alvo, "ativo" para o pane focado/mais recente, ou um trecho do nome/agente. Vazio = pane ativo.',
        },
        texto: {
          type: 'STRING',
          description:
            'O comando/prompt EXATO a digitar e enviar, do jeito que o usuário pediu (ex. "/model opus").',
        },
      },
      required: ['texto'],
    },
  },
  {
    name: 'restaurar',
    // peer ADE C-091 — same route as "Restaurar todos"; never re-implements spawn.
    description:
      'Restaura pane(s) SALVOS (fechados) da missão na tela — mesma ação do botão "Restaurar todos". Use quando o usuário pedir pra restaurar/reabrir panes salvos. Sem alvo = restaura todos.',
    parameters: {
      type: 'OBJECT',
      properties: {
        alvo: {
          type: 'STRING',
          description:
            'Nome/filtro do pane ou missão a restaurar (opcional — sem ele restaura todos).',
        },
      },
      required: [],
    },
  },
  {
    name: 'perguntar',
    // peer ADE — work/domain question to a pane; narrate the pane's answer.
    description:
      'Repassa uma pergunta de TRABALHO/domínio ao pane que o usuário está usando e narra a RESPOSTA do pane (nunca invente a resposta você mesmo). Use quando o usuário, com uma missão/pane ativo, perguntar sobre o TRABALHO em si. NÃO use para perguntas de UI/estado do app — isso é "consultar"/"navegar". NÃO use para mandar um comando literal (isso é "comandar").',
    parameters: {
      type: 'OBJECT',
      properties: {
        pergunta: {
          type: 'STRING',
          description: 'A pergunta de trabalho a enviar ao pane.',
        },
        paneId: {
          type: 'STRING',
          description: 'Id do pane alvo (opcional — sem ele usa o pane ativo).',
        },
      },
      required: ['pergunta'],
    },
  },
];

/**
 * OpenAI Realtime uses lowercase JSON-schema tokens, unlike Gemini Live. Keep
 * the same bounded eight-tool voice surface on both transports so an OpenAI
 * fallback can consult/read state rather than guessing a UI action.
 */
export function coarseVoiceToolsAsRealtimeDefinitions(): RealtimeToolDefinition[] {
  return COARSE_VOICE_TOOLS.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters.properties).map(([key, prop]) => [
          key,
          {
            ...prop,
            type: typeof prop.type === 'string' ? prop.type.toLowerCase() : 'string',
          },
        ]),
      ),
      ...(tool.parameters.required?.length ? { required: tool.parameters.required } : {}),
    },
  }));
}

export interface CoarseToolArgs {
  briefing?: string;
  pergunta?: string;
  paneId?: string;
  scope?: string;
  target?: string;
  query?: string;
  texto?: string;
  alvo?: string;
}

/** Discriminated result of resolving a coarse voice tool call. */
export type CoarseToolResolution =
  | { kind: 'action'; action: NexusRealtimeActionArgs; summary: string }
  | { kind: 'direct'; intent: 'consult' | 'read' | 'ask'; query: string; paneId?: string }
  | { kind: 'restore'; alvo?: string }
  | { kind: 'end' }
  | { kind: 'invalid'; reason: string };

function str(value: unknown, max = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function navToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\s]+/g, '-');
}

function isNewWorkspaceAlias(value: string): boolean {
  const token = navToken(value);
  if (!token) return true; // navegar workspace sem nome → wizard (não open_workspace vazio)
  return [
    'workspace-new',
    'new-workspace',
    'novo-workspace',
    'nova-workspace',
    'workspace-novo',
    'workspace-nova',
    'novo',
    'nova',
    'new',
  ].includes(token);
}

function screenToAction(query: string): NexusRealtimeActionArgs | null {
  switch (query.trim().toLowerCase()) {
    case 'grid':
    case 'grade':
      return { action: 'open_grid' };
    case 'board':
    case 'quadro':
    case 'missões':
    case 'missoes':
      return { action: 'open_board' };
    case 'settings':
    case 'config':
    case 'configurações':
    case 'configuracoes':
      return { action: 'open_settings' };
    case 'voz':
    case 'voice':
      return { action: 'open_voice_settings' };
    case 'canvas':
      return { action: 'open_canvas' };
    default:
      return null;
  }
}

function navegarToAction(target: string, query: string): NexusRealtimeActionArgs | null {
  const t = navToken(target);
  switch (t) {
    case 'workspace':
      if (isNewWorkspaceAlias(query)) return { action: 'new_workspace' };
      return { action: 'open_workspace', workspaceName: query };
    case 'squad':
      return query
        ? { action: 'open_squad', squadName: query }
        : { action: 'open_squad_picker' };
    case 'squad-picker':
    case 'squad-select':
    case 'modo-squad':
      return { action: 'open_squad_picker' };
    case 'pane':
      return { action: 'focus_pane', paneName: query };
    case 'terminal':
      return { action: 'open_terminal' };
    case 'browser':
      return query ? { action: 'open_browser', url: query } : { action: 'open_browser' };
    case 'mission-new':
    case 'mission':
    case 'nova-missao':
      return { action: 'new_mission' };
    case 'mission-agentic':
    case 'agentic-mission':
    case 'missao-agentica':
    case 'missao-agentico':
    case 'nova-missao-agentica':
      return {
        action: 'new_agentic_mission',
        ...(query ? { intent: query } : {}),
      };
    case 'workspace-new':
    case 'new-workspace':
    case 'new_workspace':
    case 'novo-workspace':
    case 'novo_workspace':
      // "abrir novo workspace" — wizard, NOT open_workspace / new_mission.
      return { action: 'new_workspace' };
    case 'design-squad':
    case 'design_squad':
    case 'montar-squad':
      return { action: 'design_squad' };
    case 'wizard-fire':
    case 'confirm-squad':
    case 'confirm_squad':
    case 'iniciar-squad':
      return { action: 'confirm_squad' };
    case 'screen':
    case 'tela':
      return screenToAction(query);
    default:
      // Allow a bare screen name used directly as the target ("navegar grid").
      return screenToAction(t);
  }
}

function isCurrentViewScope(value: string): boolean {
  return [
    'view',
    'current-view',
    'screen',
    'tela',
    'visao',
    'pagina',
    'page',
  ].includes(navToken(value));
}

/**
 * Map a coarse voice tool call to nexus's action vocabulary or a direct-answer
 * intent. delegar → send_to_pane; navegar → the matching UI action;
 * consultar → direct (answered from injected context); ler → audited pane
 * read action; encerrar → end.
 */
export function resolveCoarseVoiceTool(
  name: string,
  args: CoarseToolArgs,
): CoarseToolResolution {
  switch (name) {
    case 'delegar': {
      const briefing = str(args.briefing);
      if (!briefing) return { kind: 'invalid', reason: 'delegar requer um briefing' };
      const action: NexusRealtimeActionArgs = { action: 'send_to_pane', text: briefing };
      return { kind: 'action', action, summary: summarizeNexusRealtimeAction(action) };
    }
    case 'navegar': {
      const target = str(args.target, 64);
      if (!target) return { kind: 'invalid', reason: 'navegar requer um target' };
      const query = str(args.query, 4_096);
      const action = navegarToAction(target, query);
      if (!action) {
        return { kind: 'invalid', reason: `navegar: alvo não reconhecido "${target}"` };
      }
      return { kind: 'action', action, summary: summarizeNexusRealtimeAction(action) };
    }
    case 'consultar': {
      const query = str(args.pergunta, 400);
      return { kind: 'direct', intent: 'consult', query };
    }
    case 'ler': {
      if (isCurrentViewScope(str(args.scope, 64))) {
        const action: NexusRealtimeActionArgs = { action: 'read_current_view' };
        return { kind: 'action', action, summary: summarizeNexusRealtimeAction(action) };
      }
      const paneId = str(args.paneId, 128) || undefined;
      const action: NexusRealtimeActionArgs = {
        action: 'read_pane',
        ...(paneId ? { paneId } : {}),
      };
      return { kind: 'action', action, summary: summarizeNexusRealtimeAction(action) };
    }
    case 'encerrar':
      return { kind: 'end' };
    case 'comandar': {
      const texto = str(args.texto);
      if (!texto) return { kind: 'invalid', reason: 'comandar requer um texto' };
      const paneId = str(args.paneId, 128) || undefined;
      const action: NexusRealtimeActionArgs = { action: 'send_to_pane', text: texto, ...(paneId ? { paneId } : {}) };
      return { kind: 'action', action, summary: summarizeNexusRealtimeAction(action) };
    }
    case 'restaurar': {
      const alvo = str(args.alvo, 128) || undefined;
      return { kind: 'restore', alvo };
    }
    case 'perguntar': {
      const pergunta = str(args.pergunta, 400);
      if (!pergunta) return { kind: 'invalid', reason: 'perguntar requer uma pergunta' };
      const paneId = str(args.paneId, 128) || undefined;
      return { kind: 'direct', intent: 'ask', query: pergunta, paneId };
    }
    default:
      return { kind: 'invalid', reason: `tool de voz não suportada: ${name}` };
  }
}
