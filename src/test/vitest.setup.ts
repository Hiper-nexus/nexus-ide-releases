import os from 'node:os';
import path from 'node:path';

const baseDir = path.join(os.tmpdir(), `nexus-ide-vitest-${process.pid}`);

process.env.NEXUS_VOICE_LOG_FILE ??= path.join(baseDir, 'voice.log');
process.env.NEXUS_VOICE_LOG_MAX_BYTES ??= '1048576';
process.env.NEXUS_JARVIS_METRICS_FILE ??= path.join(baseDir, 'jarvis-metrics.log');

/**
 * `localStorage` sob jsdom.
 *
 * O jsdom desta árvore não expõe `localStorage` no contexto do teste, então
 * qualquer suíte de renderer que limpe o storage no `beforeEach` morre com
 * `Cannot read properties of undefined (reading 'clear')` — e morre ANTES de
 * asserir, o que faz o arquivo inteiro passar por "quebrado" quando na verdade
 * ele nunca chegou a verificar nada. Foi assim que a superfície de causa de
 * bloqueio ficou sem cobertura efetiva. O shim é em memória e por arquivo de
 * teste, que é exatamente o isolamento que essas suítes assumem.
 */
if (
  typeof globalThis.window !== 'undefined' &&
  // A chave PODE existir valendo `undefined`, então testar com `in` não basta.
  globalThis.localStorage === undefined
) {
  const createStorage = (): Storage => {
    const entries = new Map<string, string>();
    return {
      get length() {
        return entries.size;
      },
      clear: () => entries.clear(),
      getItem: (key: string) => entries.get(String(key)) ?? null,
      key: (index: number) => [...entries.keys()][index] ?? null,
      removeItem: (key: string) => void entries.delete(String(key)),
      setItem: (key: string, value: string) => {
        entries.set(String(key), String(value));
      },
    } as Storage;
  };
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const storage = createStorage();
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis.window, name, {
      configurable: true,
      value: storage,
    });
  }
}
