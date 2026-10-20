export interface McpInvokeRequest {
  tool: string;
  args?: Record<string, unknown>;
}

export interface McpInvokeResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  denied?: boolean;
  requiredConfirmation?: boolean;
  confirmationReason?: string;
  /** A failed call may have applied its effect; callers must not retry blindly. */
  effectMayHaveCommitted?: boolean;
  /**
   * Caminho de recuperação que o despachante devolve junto da recusa ("crie
   * uma missão…", "pane_* funcionam sem missão"). Vai ao modelo de voz para
   * ele refazer certo em vez de repetir a mesma chamada.
   */
  hint?: string;
}

export interface McpConfirmRequest {
  tool: string;
  args?: Record<string, unknown>;
  granted?: boolean;
  token?: string;
}

export interface McpConfirmResult {
  ok: boolean;
  error?: string;
}
