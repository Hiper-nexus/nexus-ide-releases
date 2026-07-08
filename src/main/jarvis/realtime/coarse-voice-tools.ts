/**
 * The 4 coarse voice tools (delegar/consultar/ler/navegar pattern) for the
 * Jarvis Live realtime session, ported from the Overclock sidecar reference
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

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export const COARSE_VOICE_TOOL_NAMES = [
  'delegar',
  'consultar',
  'ler',
  'navegar',
  'encerrar',
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
          description: 'Descrição completa e fiel da tarefa a delegar.',
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
      'Lê o output recente de um pane (o que o agente/Claude respondeu ali). Use quando o usuário perguntar "o que o pane respondeu / qual o resultado / o que apareceu". Sem paneId → lê o pane ativo.',
    parameters: {
      type: 'OBJECT',
      properties: {
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
      'Navega a UI do Nexus: abre/foca um workspace, squad, pane, terminal, browser ou tela (grid/board/settings/canvas/voz). Use SEMPRE que o usuário pedir para abrir/mostrar/ir/focar algo que JÁ EXISTE. NÃO delegue navegação.',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: {
          type: 'STRING',
          description:
            "O que navegar: 'workspace', 'squad', 'pane', 'terminal', 'browser' ou 'screen'.",
        },
        query: {
          type: 'STRING',
          description:
            'Nome/id do alvo; em screen use grid, board, settings, canvas ou voz; em browser use a URL.',
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
];

export interface CoarseToolArgs {
  briefing?: string;
  pergunta?: string;
  paneId?: string;
  target?: string;
  query?: string;
}

/** Discriminated result of resolving a coarse voice tool call. */
export type CoarseToolResolution =
  | { kind: 'action'; action: NexusRealtimeActionArgs; summary: string }
  | { kind: 'direct'; intent: 'consult' | 'read'; query: string; paneId?: string }
  | { kind: 'end' }
  | { kind: 'invalid'; reason: string };

function str(value: unknown, max = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
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
  const t = target.trim().toLowerCase();
  switch (t) {
    case 'workspace':
      return { action: 'open_workspace', workspaceName: query };
    case 'squad':
      return { action: 'open_squad', squadName: query };
    case 'pane':
      return { action: 'focus_pane', paneName: query };
    case 'terminal':
      return { action: 'open_terminal' };
    case 'browser':
      return query ? { action: 'open_browser', url: query } : { action: 'open_browser' };
    case 'screen':
    case 'tela':
      return screenToAction(query);
    default:
      // Allow a bare screen name used directly as the target ("navegar grid").
      return screenToAction(t);
  }
}

/**
 * Map a coarse voice tool call to nexus's action vocabulary or a direct-answer
 * intent. delegar → send_to_pane; navegar → the matching UI action;
 * consultar/ler → direct (answered from injected context); encerrar → end.
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
      const paneId = str(args.paneId, 128) || undefined;
      return { kind: 'direct', intent: 'read', query: paneId ?? 'ativo', paneId };
    }
    case 'encerrar':
      return { kind: 'end' };
    default:
      return { kind: 'invalid', reason: `tool de voz não suportada: ${name}` };
  }
}
