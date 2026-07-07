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
