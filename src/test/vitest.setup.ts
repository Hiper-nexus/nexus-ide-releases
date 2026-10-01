import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Windows: `%TEMP%` pode vir em nome curto 8.3 (`C:\Users\ADMINI~1\...`, com
 * usuário de mais de 8 letras). `fs.realpathSync` mantém o nome curto e o git
 * devolve o longo, então toda suíte que cria um repositório em `os.tmpdir()` e
 * compara a raiz com `git rev-parse` falhava só nessas máquinas — dezenas de
 * falhas de ambiente por versão, que escondiam defeito real (o F-654 quase
 * passou assim). As suítes rodam no diretório temporário canônico; o
 * `os.tmpdir()` relê `TEMP`/`TMP` a cada chamada e os filhos herdam.
 */
if (process.platform === 'win32') {
  try {
    const canonicalTemp = fs.realpathSync.native(os.tmpdir());
    process.env.TEMP = canonicalTemp;
    process.env.TMP = canonicalTemp;
  } catch {
    // Sem forma canônica legível, fica o TEMP original.
  }
}

const baseDir = path.join(os.tmpdir(), `nexus-ide-vitest-${process.pid}`);

process.env.NEXUS_VOICE_LOG_FILE ??= path.join(baseDir, 'voice.log');
process.env.NEXUS_VOICE_LOG_MAX_BYTES ??= '1048576';
process.env.NEXUS_JARVIS_METRICS_FILE ??= path.join(baseDir, 'jarvis-metrics.log');

/**
 * Testes herméticos do Jev (TypeSafe). A máquina do operador tem
 * `TYPESAFE_API_KEY` no shell (~/.zshenv), e todo caminho do Jev resolve a
 * chave por `stored → env`: com a env presente, a guarda do despacho, o
 * route_task e as demais superfícies falariam com a API REAL dentro dos
 * testes — vereditos não determinísticos (2 falhas medidas em
 * mcp-dispatch-security em 17/09). Sem chave, cada superfície cai em
 * `skipped` (fail-open), que é exatamente o comportamento que um teste sem
 * mock deve exercitar. Quem precisa do Jev num teste injeta `judge`.
 */
delete process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_BASE_URL;
delete process.env.NEXUS_JEV_MODEL;
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CLOUDFLARE_ACCOUNT_ID;

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

// F-572: o teto global de panes de agente (pane-admission) é uma rede de
// segurança da máquina real; na suíte unitária as sessões falsas do
// pty-manager se acumulam além do teto e derrubariam testes que não são
// sobre o teto. Os testes do próprio gate passam limites explícitos.
process.env.NEXUS_PANE_GUARD ??= 'off';
