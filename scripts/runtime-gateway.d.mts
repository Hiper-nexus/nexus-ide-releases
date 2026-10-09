export function startRuntimeGateway(nonce: string): Promise<{
  url: string;
  nonce: string;
  observations: Array<{ kind: string | undefined; step: number; tool: string }>;
  close(): Promise<void>;
}>;
