/**
 * Guardrails for Jarvis agent actions.
 *
 * DESTRUCTIVE_PATTERNS are regexes that match commands the agent should NEVER
 * execute without explicit user confirmation. `requiresConfirmation()` checks
 * whether a given MCP tool invocation needs a native confirmation dialog.
 *
 * Trivial actions (read, list, status, diff) execute immediately.
 * Destructive actions (write, delete, force push, etc.) require confirmation.
 */

import { canonicalToolName } from '../orch/gate';
import { requiresHumanConfirmationForTool } from '../orch/mcp-effect-policy';

/**
 * Âncora chain-aware: início do comando OU logo após `;`, `&`, `|`. Sem ela,
 * "true && sudo ..." lava o padrão ancorado em `^` — e sob Autopiloto esta
 * lista é o ÚNICO piso de shell (sem sandbox de SO) e também decide o
 * snapshot de reversibilidade. `i` em comandos de shell porque APFS resolve
 * SUDO→sudo. Mesma disciplina de REMOTE_OR_DEPLOY_PATTERNS abaixo.
 */
const CHAIN = String.raw`(?:^|[;&|]\s*)`;

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // rm com -r e -f no MESMO segmento, em qualquer grafia (-rf, -fr, -r -f).
  new RegExp(`${CHAIN}rm(?=[^;&|\\n]*\\s-[a-z]*r)(?=[^;&|\\n]*\\s-[a-z]*f)\\s`, 'i'),
  /git\s+push\s+.*--force/i,
  /git\s+push\s+.*-f\b/i,
  /git\s+reset\s+--hard/i,
  new RegExp(`${CHAIN}sudo\\s`, 'i'),
  new RegExp(`${CHAIN}dd\\s`, 'i'),
  /\bdrop\s+(table|database)\b/i,
  /\bdelete\s+from\b/i,
  new RegExp(`${CHAIN}chmod\\s+(?:-r\\s+)?0?777\\b`, 'i'),
  new RegExp(`${CHAIN}chown\\s+-r\\b`, 'i'),
  // /dev/null como fonte de clobber (cat /dev/null > arquivo). Redirect
  // benigno PARA /dev/null (2>/dev/null) flui — não é destrutivo.
  /\/dev\/null\s*>\s*\S/,
  // Escrita direta em block device.
  /(?:>|\bof=)\s*\/dev\/(?:r?disk|sd[a-z]|hd[a-z]|nvme|mmcblk)/i,
  /mkfs\./i,
  /\bformat\s+C:\b/i,
  new RegExp(`${CHAIN}(?:shutdown|reboot|halt|poweroff)\\b`, 'i'),
  new RegExp(`${CHAIN}kill\\s+-9\\b`, 'i'),
  new RegExp(`${CHAIN}docker\\s+rm\\s+-f\\b`, 'i'),
  new RegExp(`${CHAIN}docker\\s+system\\s+prune\\b`, 'i'),
  new RegExp(`${CHAIN}kubectl\\s+delete\\b`, 'i'),
  new RegExp(`${CHAIN}(?:npm|pnpm|yarn)\\s+unpublish\\b`, 'i'),
  /\bTRUNCATE\s+(TABLE\s+)?/i,
  /\bALTER\s+TABLE\s+.*\bDROP\b/i,
];

/**
 * Checks whether a full command string is destructive.
 * Matches against DESTRUCTIVE_PATTERNS.
 */
export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

const REMOTE_OR_DEPLOY_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)git\s+push\b/i,
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/i,
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|release|publish)\b/i,
  /(?:^|[;&|]\s*)gh\s+release\s+create\b/i,
  /(?:^|[;&|]\s*)docker\s+push\b/i,
  /(?:^|[;&|]\s*)kubectl\s+(?:apply|create|delete|patch|replace|rollout|scale)\b/i,
  /(?:^|[;&|]\s*)helm\s+(?:install|upgrade|uninstall|rollback)\b/i,
  /(?:^|[;&|]\s*)(?:terraform|tofu)\s+(?:apply|destroy|import)\b/i,
  /(?:^|[;&|]\s*)pulumi\s+(?:up|destroy|import)\b/i,
  /(?:^|[;&|]\s*)(?:vercel|netlify|firebase|wrangler|fly|flyctl|railway|render)\s+(?:deploy|publish|up)\b/i,
  /(?:^|[;&|]\s*)(?:aws|gcloud|az)\b[^\n]*(?:deploy|publish|push|apply|delete|destroy)\b/i,
  /(?:^|[;&|]\s*)ssh\b/i,
  /(?:^|[;&|]\s*)(?:scp|sftp)\b/i,
  /(?:^|[;&|]\s*)rsync\b[^\n]*\b[^\s:]+:/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
];

/**
 * Voice may execute routine local development work without interrupting the
 * user. Only destructive or externally-publishing commands retain the native
 * confirmation boundary.
 */
export function requiresVoiceCommandConfirmation(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return true;
  return (
    isDestructive(normalized) ||
    REMOTE_OR_DEPLOY_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/**
 * Ferramentas do Nexus que a Jarvis por voz executa SEM modal (mãos livres): a
 * fala do operador é a autorização, e o Nexus já audita cada chamada. Lista
 * explícita de propósito (default-deny): o que não está aqui, e a política por
 * efeito exige confirmar, continua pedindo — push/PR/merge remoto, instalar do
 * catálogo, mídia paga, cron, ui_action, computer_do, restore de checkpoint,
 * remote_*, skills/harness e o que for criado depois.
 *
 * `terminal_run` e `bg_run` ficam fora do conjunto: o comando decide (abaixo).
 */
const JARVIS_HANDS_FREE_TOOLS: ReadonlySet<string> = new Set([
  // panes e agentes
  'pane_write',
  'pane_write_many',
  'pane_ask',
  'pane_close',
  'agent_prompt',
  // missões, tasks e planos
  'mission_control',
  'plan_write',
  'workspace_list',
  // navegador
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_hover',
  'browser_scroll',
  'browser_find',
  'browser_extract',
  'browser_responsive',
  'browser_do',
  // arquivos e editor do workspace
  'file_write',
  'editor_insert',
  'editor_replace_selection',
  'editor_apply_patch',
  // git local (push e PR continuam confirmando)
  'git_add',
  'git_commit',
  'git_branch_create',
  'git_branch_switch',
  'git_pull',
  // preview local
  'preview_start',
  'preview_stop',
  // F-1603: parar a prévia de vídeo só encerra um processo do próprio Nexus.
  'video_preview_stop',
  // leitura de goal em andamento
  'goal_status',
]);

/** Ferramentas cujo `command` é uma linha de shell: o comando decide. */
const JARVIS_SHELL_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  'terminal_run',
  'bg_run',
]);

/** Ferramentas que escrevem texto num PTY: texto destrutivo volta a confirmar. */
const PANE_TEXT_TOOLS: ReadonlySet<string> = new Set([
  'pane_write',
  'pane_write_many',
  'pane_ask',
  'agent_prompt',
]);

/**
 * Texto que a mão do operador mandaria para um PTY, extraído dos argumentos da
 * ferramenta. Fonte única do que `isDestructivePaneInput` (mcp-consent-policy)
 * e a política mãos-livres da Jarvis examinam.
 */
export function paneInputTexts(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): string[] {
  const canonical = canonicalToolName(toolName);
  if (!PANE_TEXT_TOOLS.has(canonical)) return [];
  const texts: string[] = [];
  const pushText = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) texts.push(value);
  };
  if (canonical === 'pane_write' || canonical === 'agent_prompt') {
    pushText(args.text);
  } else if (canonical === 'pane_ask') {
    pushText(args.question);
  } else if (Array.isArray(args.writes)) {
    for (const entry of args.writes) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        pushText((entry as Record<string, unknown>).text);
      }
    }
  }
  return texts;
}

/**
 * Política mãos-livres da Jarvis por voz. Tudo que a política por efeito já
 * libera continua liberado; o que ela confirma só deixa de pedir modal quando a
 * ferramenta está em JARVIS_HANDS_FREE_TOOLS E nada nos argumentos é destrutivo:
 * - terminal_run/bg_run: comando rotineiro (dev, test, build, git local) roda;
 *   `isDestructive` e deploy/push/ssh (REMOTE_OR_DEPLOY_PATTERNS) confirmam, e
 *   `sandboxProfile: 'yolo'` (sandbox mais frouxo) também;
 * - texto escrito em PTY (pane_write/ask, agent_prompt): destrutivo confirma.
 */
export function requiresJarvisConfirmation(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (JARVIS_SHELL_COMMAND_TOOLS.has(canonical)) {
    const command = typeof args.command === 'string' ? args.command : '';
    return requiresVoiceCommandConfirmation(command) || args.sandboxProfile === 'yolo';
  }
  if (!requiresHumanConfirmationForTool(toolName)) return false;
  if (!JARVIS_HANDS_FREE_TOOLS.has(canonical)) return true;
  return paneInputTexts(toolName, args).some((text) => isDestructive(text));
}

/**
 * A chamada cabe na "mão do operador" da Jarvis: ferramenta da lista mãos-livres
 * E nada nos argumentos que peça confirmação (texto destrutivo em PTY). É o
 * critério para a Jarvis agir SEM missão (mcp-consent-policy → mcp-dispatch):
 * o dispatcher exigia autoridade de missão para quase todo efeito vindo do
 * renderer, o que tornava inútil tirar o modal. terminal_run/bg_run ficam FORA
 * de propósito: comando passa por `run_command` (pane de shell visível, com
 * confirmação de destrutivo/deploy) e pelo send_to_pane com alvo terminal.
 */
export function isJarvisOperatorHandCall(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return (
    JARVIS_HANDS_FREE_TOOLS.has(canonicalToolName(toolName)) &&
    !requiresJarvisConfirmation(toolName, args)
  );
}

export interface ConfirmationOptions {
  /**
   * Chamada da Jarvis por voz (renderer IPC): aplica a política mãos-livres.
   * Agentes CLI, remote_spawn e agent_spec_write NÃO passam isso e seguem na
   * política por efeito — afrouxar o modal para eles seria outra decisão.
   */
  readonly handsFree?: boolean;
}

/**
 * Determines whether a given MCP tool invocation requires user confirmation.
 *
 * Effect classification is centralized in mcp-effect-policy. Sem `handsFree`,
 * os argumentos servem só para explicar o risco, nunca para enfraquecer a
 * decisão. Com `handsFree` (Jarvis por voz) vale `requiresJarvisConfirmation`.
 */
export function requiresConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  options: ConfirmationOptions = {},
): boolean {
  if (options.handsFree) return requiresJarvisConfirmation(toolName, args);
  return requiresHumanConfirmationForTool(toolName);
}

/**
 * Get a human-readable description of why a tool requires confirmation.
 */
export function confirmationReason(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === 'nexus_file_write' || toolName === 'file_write') {
    return `write to ${String(args.path ?? 'unknown file')}`;
  }
  if (toolName === 'nexus_terminal_run' || toolName === 'terminal_run') {
    const cmd = typeof args.command === 'string' ? args.command : 'unknown';
    const envKeys =
      args.env && typeof args.env === 'object' && !Array.isArray(args.env)
        ? Object.keys(args.env as Record<string, unknown>).sort()
        : [];
    const envNote = envKeys.length > 0 ? ` with env: ${envKeys.join(', ')}` : '';
    if (isDestructive(cmd)) {
      return `destructive command: ${cmd}${envNote}`;
    }
    return `run command: ${cmd}${envNote}`;
  }
  if (toolName === 'nexus_git_push' || toolName === 'git_push') {
    return `push to remote ${String(args.remote ?? 'origin')} ` +
      `branch ${String(args.branch ?? 'current')}`;
  }
  if (toolName === 'nexus_git_commit' || toolName === 'git_commit') {
    return `commit: ${String(args.message ?? 'no message')}`;
  }
  if (toolName === 'nexus_cron' || toolName === 'cron') {
    const action = safeMediaArg(args.action, 'mutate');
    const name = safeMediaArg(args.name, safeMediaArg(args.id, 'unknown'));
    const target = safeMediaArg(
      args.agentName,
      safeMediaArg(args.squadId, 'saved roster'),
    );
    if (action === 'create' || action === 'update') {
      return (
        `autorizar missões futuras a iniciarem automaticamente pelo golden path ` +
        `do Nexus: cron ${action} "${name}", alvo ${target}`
      );
    }
    return `remover autoridade agendada do cron "${name}"`;
  }
  if (toolName === 'nexus_editor_insert' || toolName === 'editor_insert') {
    return `edit ${String(args.path ?? 'unknown file')}`;
  }
  if (toolName === 'nexus_editor_replace_selection' || toolName === 'editor_replace_selection') {
    return `replace in ${String(args.path ?? 'unknown file')}`;
  }
  if (toolName === 'nexus_editor_apply_patch' || toolName === 'editor_apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : '';
    const paths = [...patch.matchAll(/^\[([^\]#\n]+)(?:#[0-9A-Fa-f]{4})?\]\s*$/gm)]
      .map((match) => match[1].trim())
      .filter((value) => value.length > 0);
    const unique = [...new Set(paths)];
    if (unique.length === 0) return 'apply hashline patch';
    const shown = unique.slice(0, 5).join(', ');
    const extra = unique.length > 5 ? ` (+${unique.length - 5} more)` : '';
    return `apply hashline patch to ${shown}${extra}`;
  }
  if (toolName === 'nexus_browser_open' || toolName === 'browser_open') {
    return `open browser target ${safeBrowserTarget(args.url)}`;
  }
  if (toolName === 'nexus_browser_navigate' || toolName === 'browser_navigate') {
    return `navigate browser pane ${String(args.paneId ?? 'unknown')} to ${safeBrowserTarget(args.url)}`;
  }
  if (toolName === 'nexus_browser_click' || toolName === 'browser_click') {
    return `click element ${String(args.ref ?? 'unknown')} in browser pane ${String(args.paneId ?? 'unknown')}`;
  }
  if (toolName === 'nexus_browser_fill' || toolName === 'browser_fill') {
    return `fill element ${String(args.ref ?? 'unknown')} in browser pane ${String(args.paneId ?? 'unknown')}`;
  }
  if (toolName === 'nexus_preview_start' || toolName === 'preview_start') {
    return `serve preview directory ${safeMediaArg(args.dir, 'unknown')}`;
  }
  if (toolName === 'nexus_image_generate' || toolName === 'image_generate') {
    return mediaConfirmation('image', args);
  }
  if (toolName === 'nexus_video_generate' || toolName === 'video_generate') {
    return mediaConfirmation('video', args);
  }
  if (toolName === 'nexus_audio_generate' || toolName === 'audio_generate') {
    return mediaConfirmation('audio', args);
  }
  if (toolName === 'nexus_video_export' || toolName === 'video_export') {
    return (
      `export ${safeMediaArg(args.input, 'unknown')} for ${safeMediaArg(args.preset, 'unknown preset')} ` +
      `(loudness -14 LUFS, mute copy, cover, captions; AI label ${safeMediaArg(args.label, 'auto')}); output: ${safeMediaArg(args.outDir, '<project>/exports')}`
    );
  }
  if (toolName === 'nexus_video_preview_start' || toolName === 'video_preview_start') {
    return (
      `open the live HyperFrames Studio of ${safeMediaArg(args.projectDir, 'unknown')} (a local server that runs ` +
      "the project's HTML/JS, bound to 127.0.0.1, until stopped)"
    );
  }
  if (toolName === 'nexus_video_render' || toolName === 'video_render') {
    return (
      `render HyperFrames project ${safeMediaArg(args.projectDir, 'unknown')} (runs the project's HTML/JS in a ` +
      `headless Chrome without sandbox; first run installs the pinned engine); output: ${safeMediaArg(args.output, '<project>/renders/<name>.mp4')}`
    );
  }
  if (toolName === 'nexus_music_generate' || toolName === 'music_generate') {
    const seconds =
      typeof args.lengthMs === 'number' && Number.isFinite(args.lengthMs)
        ? Math.round(args.lengthMs / 1000)
        : 0;
    const mode = args.dryRun === true ? 'price only (dryRun, no charge)' : 'paid music';
    return (
      `${mode} via elevenlabs, ${seconds} s, ${args.instrumental === false ? 'with vocals' : 'instrumental'}; ` +
      `input: prompt (${textLength(args.prompt)} chars); output: ${safeMediaArg(args.outPath, 'music/music-<timestamp>.mp3')}`
    );
  }
  if (toolName === 'nexus_voiceover_generate' || toolName === 'voiceover_generate') {
    const source =
      typeof args.scriptPath === 'string'
        ? `script file ${safeMediaArg(args.scriptPath, 'unknown')}`
        : `script (${textLength(args.script)} chars)`;
    const mode = args.dryRun === true ? 'price only (dryRun, no charge)' : 'paid narration';
    return (
      `${mode} via elevenlabs voice ${safeMediaArg(args.voiceId, 'unset')}; input: ${source}; ` +
      `output: ${safeMediaArg(args.outDir, 'narration')}/${safeMediaArg(args.baseName, 'narration')}.mp3 + timeline/srt/vtt`
    );
  }
  if (toolName === 'nexus_catalog_install' || toolName === 'catalog_install') {
    // M8: spell out that this downloads UNVERIFIED third-party code from the
    // community catalog into ~/.claude, which the coding agent can later run.
    const kind = safeMediaArg(args.kind, 'component');
    const slug = safeMediaArg(args.slug, 'unknown');
    return `INSTALAR ${kind} de terceiro do catálogo (${slug}) em ~/.claude — código não verificado que o agente pode executar`;
  }
  return `tool: ${toolName}`;
}

function safeMediaArg(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .trim()
    .replace(/[\r\n\t\0-\x1f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .slice(0, 160);
}

function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function mediaConfirmation(
  kind: 'image' | 'video' | 'audio',
  args: Record<string, unknown>,
): string {
  const defaultOutput =
    kind === 'image'
      ? 'workspace/generated-<timestamp>.png'
      : kind === 'video'
        ? 'workspace/generated-<timestamp>.mp4'
        : 'workspace/generated-<timestamp>.mp3';
  const output = safeMediaArg(args.outPath, defaultOutput);
  if (kind === 'audio') {
    const provider = safeMediaArg(args.provider, 'elevenlabs');
    return `generate audio via ${provider}; input: text (${textLength(args.text)} chars); output: ${output}`;
  }

  const provider = safeMediaArg(
    args.provider,
    kind === 'video'
      ? 'replicate-video|google-video'
      : 'automatic (google-image, openai-image or replicate-image/seedream)',
  );
  const prompt = `prompt (${textLength(args.prompt)} chars)`;
  const image = safeMediaArg(args.imagePath, 'none');
  const refCount = Array.isArray(args.referenceImagePaths)
    ? args.referenceImagePaths.filter((x) => typeof x === 'string').length
    : 0;
  if (kind === 'image') {
    return (
      `generate image via ${provider}; inputs: ${prompt}, image: ${image}` +
      `${refCount > 0 ? `, refs: ${refCount}` : ''}; output: ${output}`
    );
  }
  const endImage = safeMediaArg(args.endImagePath, 'none');
  const model = safeMediaArg(args.model, 'default');
  return (
    `generate video via ${provider} model ${model}; inputs: ${prompt}, ` +
    `start: ${image}, end: ${endImage}` +
    `${refCount > 0 ? `, refs: ${refCount}` : ''}; output: ${output}`
  );
}

function safeBrowserTarget(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  try {
    const input = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(input);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid URL';
  }
}
