import path from "node:path";

/**
 * Onde cada instância do Nexus publica o descriptor do Arms (porta + gate).
 * Módulo sem dependências para o pty-manager usar sem importar o mcp-server.
 */
export type ArmsRuntimeInstance = "prod" | "dev";

export function resolveArmsRuntimeInstance(isPackaged: boolean): ArmsRuntimeInstance {
  return isPackaged ? "prod" : "dev";
}

export function resolveArmsRuntimeDescriptorPath(
  homedir: string,
  instance: ArmsRuntimeInstance,
): string {
  const filename =
    instance === "prod" ? "arms-runtime.json" : "arms-runtime.dev.json";
  return path.join(homedir, ".nexus", filename);
}
