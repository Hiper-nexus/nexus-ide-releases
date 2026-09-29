import { getOrchSettings } from '../persistence/settings-store';

const PROMPT_WINDOW = 4_096;
/** After auto-accepting a boot prompt, hold prompt injection briefly so the TUI can leave the menu. */
const SETTLE_AFTER_ACCEPT_MS = 450;
/**
 * Only watch the first N ms of a session for interactive boot menus. After that
 * we unbind: otherwise Claude-family panes with skipDangerous set would keep
 * stripAnsi on every PTY chunk for the whole mission.
 */
const DEFAULT_WATCH_WINDOW_MS = 20_000;
/**
 * Diálogos de TRUST pintam tarde em cold start: GLM/Z.ai é um binário node
 * pesado nascendo num home isolado NOVO (nenhum trust por projeto salvo), e o
 * relógio do watch começa no spawn, não no diálogo. Com 20s o autoresponder
 * desistia ANTES do diálogo existir e o pane ficava "Aguardando" para sempre
 * (F-529: pane GLM do operador preso no "Yes, I trust this folder").
 */
const TRUST_WATCH_WINDOW_MS = 60_000;
/**
 * First-run screens that only paint AFTER a one-time migration. MiMo Code
 * prints "Performing one time database migration, may take a few minutes..."
 * and only then the Bypass Permissions modal — a 20s watch (and even the 60s
 * trust window) expires mid-migration, the autoresponder unbinds, and the
 * pane sits on "No, exit (recommended)" forever while the brief is typed into
 * the modal and swallowed.
 */
const FIRST_RUN_WATCH_WINDOW_MS = 180_000;
/**
 * Um TUI que aceitou a tecla SEMPRE emite repaint na hora. Silêncio completo
 * depois da resposta = a tecla se perdeu (race com o desenho do diálogo) —
 * reenviar é idempotente e seguro; nunca digitar de novo não é.
 */
const ACCEPT_QUIET_RETRY_MS = 1_800;
/** Envio original + 2 reenvios; depois o diálogo é do operador. */
const MAX_ACCEPT_ATTEMPTS = 3;

interface PromptSignature {
  adapterIds: readonly string[];
  name: string;
  phrases: readonly string[];
  response: string;
  /**
   * Sent ~120ms after `response` by the force-accept path when a TUI build
   * ignores the primary keys. Must select the SAME option as `response`.
   */
  fallbackResponse?: string;
  /**
   * Banner-only hold: start deferring injection as soon as this phrase is
   * visible, before the menu options finish painting. Also authorizes
   * force-accept once visible (the phrase IS the menu banner).
   */
  earlyPhrase?: string;
  /**
   * Pre-menu banner that ONLY holds injection (MiMo's one-time DB migration).
   * Never authorizes force-accept: typing the accept keys here would hit the
   * migration stream, not a menu.
   */
  holdPhrase?: string;
  /**
   * Resposta lida da TELA, para telas cujo aceite não é uma tecla fixa: a
   * mesma caixa lista as opções em ordem diferente entre builds e o Enter
   * confirma o item focado (o errado encerra o pane). `null` = recusa
   * responder, nunca um chute.
   */
  responseFor?: (raw: string) => string | null;
  /**
   * Janela de observação própria (default 20s). Diálogos de trust ganham
   * janela maior: podem pintar depois do cold start da CLI (F-529).
   */
  watchMs?: number;
  /**
   * Só em pane NÃO governado (mão do operador e filhos dele). Confiar numa
   * pasta liga config, hooks e regras dela — o perfil governado de missão a
   * deixa restrita de propósito (F-666) e nunca recebe esta resposta.
   */
  ungovernedOnly?: boolean;
}

export const ACCEPT_DEFAULT_PROMPT_RESPONSE = '\r';
/** Move from the safe first option to the explicit second option, then enter. */
export const ACCEPT_SECOND_PROMPT_RESPONSE = '\x1b[B\r';
/** Fallback when Down+Enter is ignored (some Claude Code TUI builds). */
export const ACCEPT_SECOND_OPTION_BY_NUMBER = '2\r';
/** Pick the first numbered option explicitly (Claude-family workspace trust). */
export const ACCEPT_FIRST_OPTION_BY_NUMBER = '1\r';
/**
 * Move the trust cursor OFF the parked cancel item onto "Yes, …", then confirm.
 *
 * Claude Code 2.1.267 desenha o diálogo de trust SEM números e com o cursor
 * parado em "No, exit": o Enter sozinho encerra o CLI (probe ao vivo 10/09 —
 * exit 1) e o antigo `1\r` vira uma tecla ignorada seguida desse mesmo Enter
 * fatal. Ver `claudeWorkspaceTrustResponse`.
 */
export const ACCEPT_SECOND_TRUST_OPTION_RESPONSE = '\x1b[B\r';

/**
 * Claude Code 2.1.x (and Claude-family shells: glm/glm-flash/longcat) show this disclaimer
 * whenever full-auto / bypass is enabled. The live UI no longer always prints
 * "Enter to confirm" — matching on that phrase left GLM workers stuck forever.
 */
export const BUILTIN_PROMPT_SIGNATURES: readonly PromptSignature[] = [
  {
    adapterIds: ['mimo-code'],
    name: 'mimo-bypass-permissions',
    phrases: [
      'warning: bypass permissions mode',
      'mimo code will read, edit, and execute files',
      'no, exit (recommended)',
      'yes, i accept the risks and want to skip permissions',
    ],
    response: ACCEPT_SECOND_PROMPT_RESPONSE,
    // Menu banner authorizes force-accept; the migration banner before it
    // only holds injection (holdPhrase).
    earlyPhrase: 'warning: bypass permissions mode',
    holdPhrase: 'performing one time database migration',
    watchMs: FIRST_RUN_WATCH_WINDOW_MS,
  },
  {
    adapterIds: ['claude', 'glm', 'glm-flash', 'longcat'],
    name: 'claude-bypass-acknowledgement',
    phrases: [
      'claude code running in bypass permissions mode',
      '1. no, exit',
      '2. yes, i accept',
    ],
    response: ACCEPT_SECOND_PROMPT_RESPONSE,
    fallbackResponse: ACCEPT_SECOND_OPTION_BY_NUMBER,
    earlyPhrase: 'claude code running in bypass permissions mode',
  },
  {
    // F-681: o Claude Code novo desenha o mesmo aviso SEM números e com o
    // cursor já em "Yes, I accept" (campo 29/09) — a assinatura numerada acima
    // não casa e o pane ficava parado. As teclas saem do cursor desenhado.
    adapterIds: ['claude', 'glm', 'glm-flash', 'longcat'],
    name: 'claude-bypass-acknowledgement-unnumbered',
    phrases: [
      'claude code running in bypass permissions mode',
      'no, exit',
      'yes, i accept',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    responseFor: claudeBypassAcknowledgementResponse,
    earlyPhrase: 'claude code running in bypass permissions mode',
  },
  {
    // Claude-family workspace trust ("Do you trust the files in this
    // folder?"). Isolated third-party homes (GLM/GLM Flash/LongCat under
    // ~/.nexus/homes/<id>) carry no per-project trust, so the FIRST spawn in
    // every project cwd hits this dialog; unanswered it stays up forever and
    // the mission/review brief is pasted into the modal and swallowed.
    // Option 1 is "Yes, proceed" — never force the default-accept here:
    // Down+Enter would pick "No, exit" and kill the session.
    adapterIds: ['claude', 'glm', 'glm-flash', 'longcat'],
    name: 'claude-workspace-trust',
    phrases: [
      'do you trust the files in this folder?',
      'yes, proceed',
      'no, exit',
    ],
    response: ACCEPT_FIRST_OPTION_BY_NUMBER,
    earlyPhrase: 'do you trust the files in this folder?',
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
  {
    // Claude Code 2.1.220 replaced the legacy folder-trust copy above. Keep a
    // separate exact signature so future wording changes fail closed instead
    // of turning generic terminal text into an automatic keypress.
    //
    // 2.1.267 mudou a FORMA além da redação: as opções perderam os números e o
    // cursor nasce em "No, exit" — a tecla que aceitava na 2.1.220 (`1\r`)
    // encerra o pane agora. Por isso a resposta é lida da própria tela.
    adapterIds: ['claude', 'glm', 'glm-flash', 'longcat'],
    name: 'claude-workspace-trust-quick-safety-check',
    phrases: [
      'quick safety check: is this a project you created or one you trust?',
      'yes, i trust this folder',
      'no, exit',
    ],
    response: ACCEPT_SECOND_TRUST_OPTION_RESPONSE,
    responseFor: claudeWorkspaceTrustResponse,
    earlyPhrase: 'quick safety check: is this a project',
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
  {
    adapterIds: ['agy'],
    name: 'agy-workspace-trust',
    phrases: [
      'do you trust the contents of this project?',
      'antigravity cli requires permission to read, edit, and execute files here',
      'yes, i trust this folder',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
  {
    adapterIds: ['grok'],
    name: 'grok-folder-trust',
    phrases: [
      'do you trust the contents of this directory?',
      'grok build may run or modify contents in this directory',
      'yes, proceed',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
  {
    // Kimi Code 0.41+ (0.42.0 observado ao vivo) para na tela "Trust this
    // folder?" ANTES do composer. O menu é de setas com "Trust this folder"
    // já destacado; Enter seleciona — mesma forma do grok-folder-trust. Sem
    // resposta a pane fica muda e o brief da missão é colado no modal e
    // engolido (campo 09/09: "o kimi não está nem abrindo"). Trust também
    // habilita o MCP de projeto que o próprio Nexus injeta.
    adapterIds: ['kimi'],
    name: 'kimi-folder-trust',
    phrases: [
      'trust this folder?',
      'trust starts the listed project mcp targets',
      "don't trust",
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    earlyPhrase: 'trust this folder?',
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
  {
    // F-666: Codex 0.157 abre "Folder access" antes do composer quando a
    // pasta tem `trust_level = "untrusted"` — exatamente o que o perfil
    // governado grava para a worktree de um writer de missão. "Open
    // restricted" é a postura que o perfil quer (config, hooks e exec policies
    // da pasta ficam desligados); nunca "Trust and continue". Sem resposta o
    // brief caía no modal e o Codex saía (worker morto em 15 s, 28/09).
    adapterIds: ['codex'],
    name: 'codex-folder-access-restricted',
    phrases: ['folder access', 'open restricted', 'quit'],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    responseFor: codexFolderAccessResponse,
    earlyPhrase: 'folder access',
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
  {
    // F-681: pasta sem decisão de confiança (o projeto que o operador abriu
    // pelo "+ Pane"): o Codex 0.157 para em "Trust this folder? / Trust and
    // continue / Quit" e o pane fica mudo até alguém apertar Enter. Mesma
    // postura do trust de Claude/Kimi/Grok/Devin nos panes do operador. Nunca
    // em pane governado, e nunca quando a tela oferece "Open restricted" (é o
    // diálogo do F-666, que responde restrito).
    adapterIds: ['codex'],
    name: 'codex-folder-trust',
    phrases: ['trust this folder?', 'trust and continue', 'quit'],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    responseFor: codexFolderTrustResponse,
    earlyPhrase: 'trust this folder?',
    watchMs: TRUST_WATCH_WINDOW_MS,
    ungovernedOnly: true,
  },
  {
    // Devin CLI (herdr workspace_trust_prompt). Interactive spawn cannot pass
    // `--respect-workspace-trust false` (print-mode only). The cursor starts on
    // "Yes, trust …"; Enter accepts. Unanswered, the mission brief is pasted
    // into the modal and spawn dies with "agent pane did not start".
    adapterIds: ['devin'],
    name: 'devin-workspace-trust',
    phrases: [
      'do you trust the authors of this directory?',
      'with untrusted content.',
      'yes, trust ',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    earlyPhrase: 'do you trust the authors of this directory?',
    watchMs: TRUST_WATCH_WINDOW_MS,
  },
];

function normalizePromptText(output: string): string {
  return output.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Pane estreito quebra a frase no MEIO da palavra e intercala a moldura do
 * TUI ("is this a --project you created" no voo real de 19/08) — o include
 * contíguo nunca casa e o trust fica na tela pra sempre. A forma compacta
 * (só [a-z0-9?]) sobrevive a qualquer wrap/borda mantendo a ordem.
 */
function compactPromptText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9?]/g, '');
}

/**
 * Qual tecla aceita o trust do Claude Code — lida da PRÓPRIA tela.
 *
 * A 2.1.220 listava "Yes, I trust this folder" primeiro e numerado; a 2.1.267
 * lista "No, exit" primeiro, sem números e com o cursor nele. O Enter confirma
 * o item focado, então a tecla que aceitava numa versão encerra o pane na
 * outra. Só a ordem renderizada diz qual é qual: com as duas etiquetas na tela
 * a resposta é derivada; sem elas, `null` (o operador responde) — nunca um
 * chute que possa escolher "No, exit".
 */
/**
 * F-681: menu SEM números (Claude Code novo) — as teclas saem de onde o cursor
 * (`❯`/`›`) está desenhado na última pintura depois do `banner`. Sem cursor
 * visível, sem as duas opções ou com o alvo ausente: `null` (o operador
 * responde). Nunca supõe o cursor na primeira opção: no aviso de bypass novo
 * ele nasce em "Yes, I accept", e Seta+Enter dali voltava a "No, exit".
 */
export function focusedMenuResponse(
  raw: string,
  banner: string,
  labels: readonly string[],
  target: string,
): string | null {
  const plain = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  const start = plain.toLowerCase().lastIndexOf(banner);
  if (start < 0) return null;
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`([❯›])?[ \\t]*(${escaped.join('|')})`, 'gi');
  const found: Array<{ label: string; focused: boolean }> = [];
  for (const match of plain.slice(start).matchAll(re)) {
    const label = match[2].toLowerCase();
    const seen = found.find((option) => option.label === label);
    if (seen) {
      seen.focused ||= Boolean(match[1]);
    } else {
      found.push({ label, focused: Boolean(match[1]) });
    }
  }
  if (found.length !== labels.length) return null;
  const targetIndex = found.findIndex((option) => option.label === target);
  const focusedIndexes = found.flatMap((option, index) => (option.focused ? [index] : []));
  if (targetIndex < 0 || focusedIndexes.length !== 1) return null;
  const delta = targetIndex - focusedIndexes[0]!;
  return (delta >= 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)) + '\r';
}

function claudeBypassAcknowledgementResponse(raw: string): string | null {
  return focusedMenuResponse(
    raw,
    'claude code running in bypass permissions mode',
    ['no, exit', 'yes, i accept'],
    'yes, i accept',
  );
}

function claudeWorkspaceTrustResponse(raw: string): string | null {
  const compact = compactPromptText(raw);
  const cancel = compact.indexOf(compactPromptText('no, exit'));
  const accept = compact.indexOf(compactPromptText('yes, i trust this folder'));
  if (cancel < 0 || accept < 0) return null;
  return cancel < accept
    ? ACCEPT_SECOND_TRUST_OPTION_RESPONSE
    : ACCEPT_DEFAULT_PROMPT_RESPONSE;
}

const CODEX_FOLDER_OPTION_RE =
  /(›|>)?[ \t]*(\d)\.[ \t]*(open restricted|trust and continue|open existing task|quit)/gi;

/**
 * Teclas até "Open restricted" no "Folder access" do Codex, lidas da última
 * pintura da tela: o cursor (`›`) nasce no primeiro item e a ordem dos itens
 * muda conforme a pasta (com ou sem "Trust and continue"). Sem "Open
 * restricted" desenhado, `null` — o operador responde.
 */
export function codexFolderAccessResponse(raw: string): string | null {
  const plain = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  const start = plain.toLowerCase().lastIndexOf('folder access');
  if (start < 0) return null;
  const options = new Map<number, { focused: boolean; label: string }>();
  for (const match of plain.slice(start).matchAll(CODEX_FOLDER_OPTION_RE)) {
    const number = Number(match[2]);
    if (!options.has(number)) {
      options.set(number, { focused: Boolean(match[1]), label: match[3].toLowerCase() });
    }
  }
  const ordered = [...options.entries()].sort(([a], [b]) => a - b).map(([, option]) => option);
  const target = ordered.findIndex((option) => option.label === 'open restricted');
  if (target < 0) return null;
  const focused = Math.max(0, ordered.findIndex((option) => option.focused));
  const delta = target - focused;
  return (delta >= 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)) + '\r';
}

/**
 * F-681: seta até "Trust and continue" lida da tela, depois Enter. `null`
 * quando o diálogo também oferece "Open restricted" (F-666) ou quando a opção
 * não está pintada — nunca um chute.
 */
export function codexFolderTrustResponse(raw: string): string | null {
  const plain = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  const start = plain.toLowerCase().lastIndexOf('trust this folder?');
  if (start < 0) return null;
  const tail = plain.slice(start);
  if (/open restricted|folder access/i.test(tail)) return null;
  const options = new Map<number, { focused: boolean; label: string }>();
  for (const match of tail.matchAll(CODEX_FOLDER_OPTION_RE)) {
    const number = Number(match[2]);
    if (!options.has(number)) {
      options.set(number, { focused: Boolean(match[1]), label: match[3].toLowerCase() });
    }
  }
  const ordered = [...options.entries()].sort(([a], [b]) => a - b).map(([, option]) => option);
  const target = ordered.findIndex((option) => option.label === 'trust and continue');
  if (target < 0) return null;
  const focused = Math.max(0, ordered.findIndex((option) => option.focused));
  const delta = target - focused;
  return (delta >= 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)) + '\r';
}

export function matchesPromptSignature(
  output: string,
  signature: PromptSignature,
): boolean {
  const normalized = normalizePromptText(output);
  if (signature.phrases.every((phrase) => normalized.includes(phrase))) {
    return true;
  }
  const compact = compactPromptText(output);
  return signature.phrases.every((phrase) =>
    compact.includes(compactPromptText(phrase)),
  );
}

function signaturesFor(adapterId: string, governed: boolean): PromptSignature[] {
  return BUILTIN_PROMPT_SIGNATURES.filter(
    (signature) =>
      signature.adapterIds.includes(adapterId) &&
      !(governed && signature.ungovernedOnly),
  );
}

/** Estado da resposta já enviada, aguardando o TUI provar que aceitou. */
interface AcceptVerification {
  readonly signature: PromptSignature;
  readonly response: string;
  readonly fallbackResponse?: string;
  attempts: number;
}

export class CliPromptAutoResponder {
  private readonly buffers = new Map<string, string>();
  private readonly sessions = new Map<string, PromptSignature[]>();
  private readonly settlingUntil = new Map<string, number>();
  private readonly boundAt = new Map<string, number>();
  /**
   * Respostas enviadas cujo efeito ainda não foi comprovado por saída nova.
   * Um TUI que aceitou repinta a tela na hora; silêncio = tecla perdida e o
   * reenvio é agendado (F-529: pane do operador preso no trust para sempre
   * porque Down+Enter foi digitado DENTRO da race do desenho do diálogo).
   */
  private readonly accepted = new Map<string, AcceptVerification>();
  private writer: ((sessionId: string, data: string) => void) | null = null;

  constructor(
    private readonly enabled: () => boolean = () => true,
    private readonly schedule: (fn: () => void, ms: number) => void = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
  ) {}

  /** Instala quem digita os REENVIOS (o envio original é do caller). */
  setWriter(writer: (sessionId: string, data: string) => void): void {
    this.writer = writer;
  }

  private isEnabled(sessionId?: string): boolean {
    let enabled = false;
    try {
      enabled = this.enabled();
    } catch {
      // A broken settings read can never authorize an automatic keypress.
      enabled = false;
    }
    if (!enabled && sessionId) this.drop(sessionId);
    return enabled;
  }

  bind(
    sessionId: string,
    adapterId: string,
    now = Date.now(),
    options: { governed?: boolean } = {},
  ): void {
    if (!this.isEnabled(sessionId)) return;
    // Sem informação de governança, trata como governado (fail-closed).
    const signatures = signaturesFor(adapterId, options.governed ?? true);
    if (signatures.length === 0) return;
    this.sessions.set(sessionId, signatures);
    this.boundAt.set(sessionId, now);
    this.buffers.delete(sessionId);
    this.settlingUntil.delete(sessionId);
  }

  unbind(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
    this.boundAt.delete(sessionId);
    // Intentionally keep settlingUntil so post-accept inject hold still works.
  }

  /** Drop every per-session map, including settle (session exit / shutdown). */
  drop(sessionId: string): void {
    this.unbind(sessionId);
    this.settlingUntil.delete(sessionId);
    this.accepted.delete(sessionId);
  }

  /** True while we are still watching PTY output for a known boot prompt. */
  isPending(sessionId: string, now = Date.now()): boolean {
    if (!this.isEnabled(sessionId)) return false;
    return this.watchingSignatures(sessionId, now) !== null;
  }

  /**
   * True enquanto uma resposta enviada aguarda prova de aceitação: o tap de
   * PTY deve continuar entregando chunks ao `observe` nesse estado, senão o
   * repaint que provaria o aceite nunca chega e os reenvios disparam à cega.
   */
  isVerifying(sessionId: string): boolean {
    return this.accepted.has(sessionId);
  }

  private watchingSignatures(
    sessionId: string,
    now: number,
  ): PromptSignature[] | null {
    const signatures = this.sessions.get(sessionId);
    if (!signatures) return null;
    const started = this.boundAt.get(sessionId) ?? now;
    // A janela é a MAIOR entre as assinaturas assistidas: trust pinta tarde
    // (60s), menus de boot rápidos seguram o default (20s).
    const watchMs = signatures.reduce(
      (max, signature) => Math.max(max, signature.watchMs ?? DEFAULT_WATCH_WINDOW_MS),
      0,
    );
    if (now - started > watchMs) {
      this.unbind(sessionId);
      return null;
    }
    return signatures;
  }

  /**
   * The signature currently holding injection: full phrase match, or early
   * hold as soon as a known banner is visible (options may still be painting).
   */
  private pendingMatch(
    sessionId: string,
    now: number,
  ): PromptSignature | null {
    const signatures = this.watchingSignatures(sessionId, now);
    if (!signatures) return null;
    const raw = this.buffers.get(sessionId) ?? '';
    const buffer = normalizePromptText(raw);
    if (!buffer) return null;
    const compact = compactPromptText(raw);
    return (
      signatures.find(
        (signature) =>
          matchesPromptSignature(raw, signature) ||
          (signature.earlyPhrase !== undefined &&
            (buffer.includes(signature.earlyPhrase) ||
              compact.includes(compactPromptText(signature.earlyPhrase)))) ||
          (signature.holdPhrase !== undefined &&
            (buffer.includes(signature.holdPhrase) ||
              compact.includes(compactPromptText(signature.holdPhrase)))),
      ) ?? null
    );
  }

  /**
   * Hold nexus prompt injection while a known interactive boot menu is on
   * screen or we just auto-accepted one (TUI still leaving the dialog).
   */
  shouldDeferInjection(sessionId: string, now = Date.now()): boolean {
    if (!this.isEnabled(sessionId)) return false;
    const settleUntil = this.settlingUntil.get(sessionId);
    if (settleUntil !== undefined) {
      if (now < settleUntil) return true;
      this.settlingUntil.delete(sessionId);
    }
    // Uma resposta em verificação pode reenviar: o diálogo talvez siga na
    // tela, e digitar o brief da missão nele é exatamente o que o settle evita.
    if (this.accepted.has(sessionId)) return true;
    return this.pendingMatch(sessionId, now) !== null;
  }

  /**
   * True quando o que segura a injeção é SÓ um banner de `holdPhrase` (a
   * migração do MiMo): não há menu para forçar, então quem espera deve seguir
   * esperando em vez de colar o brief no stream da migração. Limitado pela
   * própria janela de observação da assinatura (`watchMs`).
   */
  isHoldingForBanner(sessionId: string, now = Date.now()): boolean {
    if (!this.isEnabled(sessionId)) return false;
    const match = this.pendingMatch(sessionId, now);
    if (!match || match.holdPhrase === undefined) return false;
    return this.forceAcceptResponseMatch(sessionId, now) === null;
  }

  /** Full match or `earlyPhrase` — never `holdPhrase` (see forceAcceptResponse). */
  private forceAcceptResponseMatch(
    sessionId: string,
    now: number,
  ): PromptSignature | null {
    const signatures = this.watchingSignatures(sessionId, now);
    if (!signatures) return null;
    const raw = this.buffers.get(sessionId) ?? '';
    const buffer = normalizePromptText(raw);
    const compact = compactPromptText(raw);
    // F-681: a assinatura que casa por INTEIRO vence a que só viu o banner —
    // o aviso de bypass numerado e o sem números têm o mesmo banner, e as
    // teclas de um encerram o pane no outro.
    return (
      signatures.find((signature) => matchesPromptSignature(raw, signature)) ??
      signatures.find(
        (signature) =>
          signature.earlyPhrase !== undefined &&
          (buffer.includes(signature.earlyPhrase) ||
            compact.includes(compactPromptText(signature.earlyPhrase))),
      ) ??
      null
    );
  }

  /**
   * Keys to force-dismiss a still-visible boot menu when the normal observe
   * path did not fire before inject timeout. Returns the matched signature's
   * own response (plus its same-option fallback) — never a blind Down+Enter,
   * which picks "No, exit" on menus whose safe option is the first one.
   *
   * Full signature match OR `earlyPhrase` (the menu banner). NEVER
   * `holdPhrase`: that is a pre-menu banner (MiMo's DB migration) where
   * typing the accept keys would hit the migration stream.
   */
  forceAcceptResponse(
    sessionId: string,
    now = Date.now(),
  ): { response: string; fallbackResponse?: string } | null {
    if (!this.isEnabled(sessionId)) return null;
    const match = this.forceAcceptResponseMatch(sessionId, now);
    if (!match) return null;
    const raw = this.buffers.get(sessionId) ?? '';
    const response = this.answerFor(match, raw);
    if (response === null) return null;
    // Settle so callers wait before typing the mission brief.
    this.unbind(sessionId);
    this.settlingUntil.set(sessionId, now + SETTLE_AFTER_ACCEPT_MS);
    this.armAcceptVerification(sessionId, match, response);
    return {
      response,
      ...(match.fallbackResponse !== undefined
        ? { fallbackResponse: match.fallbackResponse }
        : {}),
    };
  }

  /**
   * Teclas para a tela que casou: fixas na assinatura, ou derivadas do que
   * está desenhado quando o aceite depende da ordem das opções naquele build.
   * `null` = recusa (o operador responde).
   */
  private answerFor(signature: PromptSignature, raw: string): string | null {
    if (signature.responseFor) return signature.responseFor(raw);
    return signature.response;
  }

  /**
   * Registra a resposta enviada e agenda o reenvio caso o TUI fique mudo.
   * O envio ORIGINAL é responsabilidade do caller (que já tinha a resposta);
   * daqui em diante a prova é do stream: qualquer chunk novo limpa o estado.
   */
  private armAcceptVerification(
    sessionId: string,
    signature: PromptSignature,
    response: string,
  ): void {
    this.accepted.set(sessionId, {
      signature,
      response,
      ...(signature.fallbackResponse !== undefined
        ? { fallbackResponse: signature.fallbackResponse }
        : {}),
      attempts: 1,
    });
    this.schedule(() => this.recheckAccept(sessionId), ACCEPT_QUIET_RETRY_MS);
  }

  /**
   * Silêncio desde o último envio: reenvia. Última tentativa usa o fallback
   * numérico quando a assinatura tem um. Esgotadas as tentativas, o diálogo é
   * do operador — nunca se digita além do que a assinatura conhece.
   */
  private recheckAccept(sessionId: string): void {
    const state = this.accepted.get(sessionId);
    if (!state) return; // houve saída: aceite comprovado (observe limpou).
    if (state.attempts >= MAX_ACCEPT_ATTEMPTS) {
      this.accepted.delete(sessionId);
      console.warn(
        `[cli-prompt] resposta de "${state.signature.name}" ignorada ` +
          `${state.attempts}x na sessão ${sessionId} — o diálogo segue para o operador`,
      );
      return;
    }
    const useFallback =
      state.attempts + 1 >= MAX_ACCEPT_ATTEMPTS &&
      state.fallbackResponse !== undefined;
    const data = useFallback
      ? (state.fallbackResponse ?? state.response)
      : state.response;
    state.attempts += 1;
    try {
      this.writer?.(sessionId, data);
    } catch (error) {
      console.warn(
        `[cli-prompt] reenvio falhou na sessão ${sessionId}`,
        error,
      );
    }
    this.schedule(() => this.recheckAccept(sessionId), ACCEPT_QUIET_RETRY_MS);
  }

  clear(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.settlingUntil.clear();
    this.boundAt.clear();
    this.accepted.clear();
  }

  observe(sessionId: string, output: string, now = Date.now()): string | null {
    if (!this.isEnabled(sessionId)) return null;
    // Resposta já enviada: qualquer saída do TUI é a prova do aceite (o
    // diálogo aceito repinta a tela). Nada de re-casar assinaturas aqui.
    if (this.accepted.has(sessionId)) {
      if (output.trim().length > 0) this.accepted.delete(sessionId);
      return null;
    }
    const signatures = this.watchingSignatures(sessionId, now);
    if (!signatures) return null;
    const buffer = `${this.buffers.get(sessionId) ?? ''}${output}`.slice(
      -PROMPT_WINDOW,
    );
    const match = signatures.find((signature) =>
      matchesPromptSignature(buffer, signature),
    );
    if (!match) {
      this.buffers.set(sessionId, buffer);
      return null;
    }
    const response = this.answerFor(match, buffer);
    if (response === null) {
      // A tela casou, mas não dá para provar qual item está focado — e um
      // Enter no item errado encerra o pane. Segue observando (as opções
      // podem ainda estar pintando) sem digitar nada.
      this.buffers.set(sessionId, buffer);
      return null;
    }
    this.unbind(sessionId);
    this.settlingUntil.set(sessionId, now + SETTLE_AFTER_ACCEPT_MS);
    this.armAcceptVerification(sessionId, match, response);
    return response;
  }
}

/** Process-wide instance shared by MCP spawn decoration and prompt injection. */
export const cliPromptAutoResponder = new CliPromptAutoResponder(
  () => getOrchSettings().cliPromptAutoResponderEnabled,
);
