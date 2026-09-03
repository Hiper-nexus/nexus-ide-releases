import type { Terminal } from "@xterm/xterm";

export type GhostPhase = "unknown" | "typing" | "executing";

export interface GhostCandidate {
  readonly prefix: string;
  readonly tail: string;
  readonly source: string;
  readonly fullCommand: string;
  readonly reason?: string;
}

export interface TerminalGhostContext {
  getCwd: () => string;
  getShell?: () => string;
  getGitBranch?: () => string;
}

export interface TerminalGhostAssistOptions {
  terminal: Terminal;
  screenElement: HTMLElement;
  context: TerminalGhostContext;
  writeToPty: (data: string) => void;
  localLookup?: (
    prefix: string,
    cwd: string,
    shell: string,
  ) => Promise<string | null>;
  remotePredict?: (
    prefix: string,
    context: TerminalGhostContext,
    signal: AbortSignal,
  ) => Promise<string | null>;
  enabled?: boolean;
  onAccepted?: (info: { source: string; command: string }) => void;
  onDismissed?: (reason: string) => void;
}

/** Sanitize tail so it never writes control characters or unexpected escapes into PTY */
export function sanitizeGhostTail(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

/** Check if command is a redundant cd to current directory */
export function isRedundantCd(command: string, cwd: string): boolean {
  if (!cwd) return false;
  const match = /^cd\s+["']?(.+?)["']?\s*$/i.exec(command);
  if (!match) return false;
  const target = match[1].replace(/^\.\//, '').replace(/\/+$/, '');
  if (!target || target === '.' || target === './') return true;
  const normalizedCwd = cwd.replace(/\/+$/, '');
  const lastFolder = normalizedCwd.split('/').pop() ?? '';
  return (
    target === normalizedCwd ||
    target === lastFolder ||
    normalizedCwd.endsWith(`/${target}`)
  );
}

export class TerminalInputState {
  #phase: GhostPhase = "unknown";
  #buffer = "";
  #ghost: GhostCandidate | null = null;
  #version = 0;

  get phase(): GhostPhase {
    return this.#phase;
  }

  get buffer(): string {
    return this.#buffer;
  }

  get ghost(): GhostCandidate | null {
    return this.#ghost;
  }

  get version(): number {
    return this.#version;
  }

  setPhase(next: GhostPhase): void {
    if (this.#phase !== next) {
      this.#phase = next;
      this.#version += 1;
    }
  }

  resetBuffer(): void {
    if (this.#buffer !== "") {
      this.#buffer = "";
      this.#version += 1;
    }
  }

  setGhost(candidate: GhostCandidate): void {
    if (!candidate.tail) {
      this.invalidateGhost("empty_tail");
      return;
    }
    if (this.#phase === "typing" && this.#buffer.startsWith(candidate.prefix)) {
      this.#ghost = candidate;
      this.#version += 1;
    }
  }

  invalidateGhost(_reason?: string): void {
    if (this.#ghost !== null) {
      this.#ghost = null;
      this.#version += 1;
    }
  }

  visibleTail(): string | null {
    if (!this.#ghost || !this.#buffer.startsWith(this.#ghost.prefix)) {
      return null;
    }
    const typedAfterPrefix = this.#buffer.slice(this.#ghost.prefix.length);
    if (typedAfterPrefix.length === 0) {
      return this.#ghost.tail;
    }
    if (this.#ghost.tail.startsWith(typedAfterPrefix)) {
      const remaining = this.#ghost.tail.slice(typedAfterPrefix.length);
      return remaining.length > 0 ? remaining : null;
    }
    return null;
  }

  ingestPtyMarkers(data: string): void {
    if (data.includes("\x1b]133;A")) {
      this.#phase = "typing";
      this.resetBuffer();
      this.invalidateGhost("prompt_start");
    } else if (data.includes("\x1b]133;B") || data.includes("\x1b]133;C")) {
      this.#phase = "executing";
      this.resetBuffer();
      this.invalidateGhost("command_start");
    } else if (data.includes("\x1b]133;D")) {
      this.#phase = "executing";
      this.invalidateGhost("command_finished");
    }
  }

  ingestUserInput(input: string): void {
    if (!input) return;

    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);

      if (code === 27) {
        this.#buffer = "";
        this.#phase = "unknown";
        this.invalidateGhost("escape_sequence");
        return;
      }

      if (code === 127 || code === 8) {
        if (this.#buffer.length > 0) {
          this.#buffer = this.#buffer.slice(0, -1);
          this.#version += 1;
          if (this.#ghost && !this.#buffer.startsWith(this.#ghost.prefix)) {
            this.invalidateGhost("buffer_shorter_than_prefix");
          }
        }
        continue;
      }

      if (code === 3) {
        this.#buffer = "";
        this.#version += 1;
        this.invalidateGhost("sigint");
        continue;
      }

      if (code === 13 || code === 10) {
        this.#buffer = "";
        this.#phase = "executing";
        this.invalidateGhost("enter");
        continue;
      }

      if (code === 9) {
        this.invalidateGhost("tab");
        continue;
      }

      if (code < 32) {
        this.#buffer = "";
        this.#phase = "unknown";
        this.invalidateGhost("control_char");
        return;
      }

      this.#phase = "typing";
      this.#buffer += input[i];
      this.#version += 1;

      if (this.#ghost) {
        if (!this.#buffer.startsWith(this.#ghost.prefix)) {
          this.invalidateGhost("buffer_diverged_from_prefix");
        } else {
          const typedAfterPrefix = this.#buffer.slice(this.#ghost.prefix.length);
          if (!this.#ghost.tail.startsWith(typedAfterPrefix)) {
            this.invalidateGhost("buffer_diverged_from_ghost");
          }
        }
      }
    }
  }
}

export class TerminalGhostAssist {
  readonly #options: TerminalGhostAssistOptions;
  readonly #state = new TerminalInputState();
  #enabled: boolean;
  #overlay: HTMLSpanElement | null = null;
  #ghostTextNode: Text | null = null;
  #abortController: AbortController | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #disposables: Array<() => void> = [];
  #disposed = false;

  constructor(options: TerminalGhostAssistOptions) {
    this.#options = options;
    this.#enabled = options.enabled ?? true;

    if (typeof document !== "undefined" && options.screenElement) {
      this.#mountOverlay();
    }
    this.#attachListeners();
  }

  get state(): TerminalInputState {
    return this.#state;
  }

  get isEnabled(): boolean {
    return this.#enabled;
  }

  setEnabled(val: boolean): void {
    this.#enabled = val;
    if (!val) {
      this.#state.invalidateGhost("disabled");
      this.#hideOverlay();
    }
  }

  #mountOverlay(): void {
    if (typeof window !== "undefined" && window.getComputedStyle) {
      const computed = window.getComputedStyle(this.#options.screenElement).position;
      if (computed === "static") {
        this.#options.screenElement.style.position = "relative";
      }
    }

    const overlay = document.createElement("span");
    overlay.className = "nexus-terminal-ghost-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = [
      "position: absolute",
      "left: 0",
      "top: 0",
      "pointer-events: none",
      "color: rgba(255, 255, 255, 0.38)",
      "font-variant-ligatures: none",
      "white-space: pre",
      "user-select: none",
      "z-index: 10",
      "display: none",
    ].join(";");

    const textNode = document.createTextNode("");
    overlay.appendChild(textNode);

    this.#overlay = overlay;
    this.#ghostTextNode = textNode;
    this.#options.screenElement.appendChild(overlay);
  }

  #attachListeners(): void {
    const term = this.#options.terminal;
    if (!term) return;

    if (typeof term.onCursorMove === "function") {
      const d = term.onCursorMove(() => this.repaint());
      this.#disposables.push(() => d.dispose());
    }
    if (typeof term.onRender === "function") {
      const d = term.onRender(() => this.repaint());
      this.#disposables.push(() => d.dispose());
    }
    if (typeof term.onResize === "function") {
      const d = term.onResize(() => this.repaint());
      this.#disposables.push(() => d.dispose());
    }
  }

  ingestPtyData(data: string): void {
    if (this.#disposed) return;
    this.#state.ingestPtyMarkers(data);
    this.repaint();
  }

  ingestUserInput(input: string): void {
    if (this.#disposed || !this.#enabled) return;

    this.#state.ingestUserInput(input);
    const buf = this.#state.buffer;

    if (this.#state.phase === "typing" && buf.length >= 1) {
      this.#triggerLocalPrediction(buf);
      if (buf.length >= 3) {
        this.#triggerRemotePrediction(buf);
      }
    } else {
      this.repaint();
    }
  }

  async #triggerLocalPrediction(prefix: string): Promise<void> {
    if (!this.#options.localLookup) return;
    const cwd = this.#options.context.getCwd();
    const shell = this.#options.context.getShell?.() ?? "";

    try {
      const suggestion = await this.#options.localLookup(prefix, cwd, shell);
      if (this.#disposed || !this.#enabled) return;
      if (!suggestion || !suggestion.startsWith(prefix)) return;
      if (isRedundantCd(suggestion, cwd)) return;

      if (this.#state.buffer === prefix && this.#state.phase === "typing") {
        const tail = suggestion.slice(prefix.length);
        if (tail.length > 0) {
          this.#state.setGhost({
            prefix,
            tail,
            source: "local-history",
            fullCommand: suggestion,
          });
          this.repaint();
        }
      }
    } catch {
      // Best-effort
    }
  }

  #triggerRemotePrediction(prefix: string): void {
    if (!this.#options.remotePredict) return;

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    if (this.#abortController) {
      this.#abortController.abort();
    }

    this.#debounceTimer = setTimeout(async () => {
      this.#debounceTimer = null;
      const ac = new AbortController();
      this.#abortController = ac;

      try {
        const result = await this.#options.remotePredict!(
          prefix,
          this.#options.context,
          ac.signal,
        );
        if (this.#disposed || ac.signal.aborted || !this.#enabled) return;
        if (!result || !result.startsWith(prefix)) return;

        if (this.#state.buffer === prefix && this.#state.phase === "typing") {
          const tail = result.slice(prefix.length);
          if (tail.length > 0) {
            this.#state.setGhost({
              prefix,
              tail,
              source: "llm-assist",
              fullCommand: result,
            });
            this.repaint();
          }
        }
      } catch {
        // Best-effort
      }
    }, 400);
  }

  tryAcceptGhost(): boolean {
    if (this.#disposed || !this.#enabled) return false;
    const tail = this.#state.visibleTail();
    if (!tail) return false;

    const clean = sanitizeGhostTail(tail);
    if (!clean) {
      this.#state.invalidateGhost("tail_sanitized_to_empty");
      this.repaint();
      return false;
    }

    const currentGhost = this.#state.ghost;
    this.#options.writeToPty(clean);
    this.#state.ingestUserInput(clean);

    if (currentGhost && this.#options.onAccepted) {
      this.#options.onAccepted({
        source: currentGhost.source,
        command: currentGhost.fullCommand,
      });
    }

    this.#state.invalidateGhost("accepted");
    this.repaint();
    return true;
  }

  tryAcceptGhostWord(): boolean {
    if (this.#disposed || !this.#enabled) return false;
    const tail = this.#state.visibleTail();
    if (!tail) return false;

    const match = /^\s*\S+/.exec(tail);
    const word = match ? match[0] : tail;
    const clean = sanitizeGhostTail(word);
    if (!clean) {
      this.#state.invalidateGhost("tail_sanitized_to_empty");
      this.repaint();
      return false;
    }

    this.#options.writeToPty(clean);
    this.#state.ingestUserInput(clean);
    this.repaint();
    return true;
  }

  dismiss(reason = "user_dismissed"): void {
    this.#state.invalidateGhost(reason);
    this.#options.onDismissed?.(reason);
    this.repaint();
  }

  repaint(): void {
    if (this.#disposed || !this.#overlay || !this.#ghostTextNode) return;

    const tail = this.#state.visibleTail();
    if (!tail || !this.#enabled) {
      this.#hideOverlay();
      return;
    }

    const term = this.#options.terminal;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderService = (term as any)._core?._renderService;
    const cell = renderService?.dimensions?.css?.cell;
    const cellWidth = cell?.width ?? 9;
    const cellHeight = cell?.height ?? 17;

    const active = term.buffer.active;
    const left = active.cursorX * cellWidth;
    const top = active.cursorY * cellHeight;

    this.#ghostTextNode.textContent = tail;
    this.#overlay.style.display = "inline";
    this.#overlay.style.left = left + "px";
    this.#overlay.style.top = top + "px";
    this.#overlay.style.lineHeight = cellHeight + "px";
    this.#overlay.style.height = cellHeight + "px";
  }

  #hideOverlay(): void {
    if (this.#overlay) {
      this.#overlay.style.display = "none";
    }
    if (this.#ghostTextNode) {
      this.#ghostTextNode.textContent = "";
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    if (this.#abortController) {
      this.#abortController.abort();
    }
    for (const d of this.#disposables) {
      try {
        d();
      } catch {
        // Best-effort
      }
    }
    this.#disposables = [];
    if (this.#overlay) {
      this.#overlay.remove();
      this.#overlay = null;
    }
  }
}
