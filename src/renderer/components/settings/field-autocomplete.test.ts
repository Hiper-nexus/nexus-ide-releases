import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Chaves, passphrases e endereços locais não são dado de formulário: o motor
 * pode oferecer preenchimento (e o estado `:-webkit-autofill` repinta o campo
 * com a cor clara do UA). Segredo declara `new-password`; o resto, `off`.
 * Guard estático — lê o fonte, sem montar os componentes (que pedem dezenas de
 * mocks de IPC só para chegar até o campo).
 */
const COMPONENTS_DIR = path.resolve(process.cwd(), 'src/renderer/components');

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Tags `<input …>` do fonte. Chaves e aspas são balanceadas: o `>` de um
 * `onChange={(e) => …}` não encerra a tag.
 */
function inputTags(source: string): string[] {
  const tags: string[] = [];
  for (const start of source.matchAll(/<input(?=[\s/>])/g)) {
    let depth = 0;
    let quote: string | null = null;
    let end = start.index!;
    for (; end < source.length; end += 1) {
      const char = source[end]!;
      if (quote) {
        if (char === '\\') end += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) break;
    }
    tags.push(source.slice(start.index!, end + 1));
  }
  return tags;
}

const AUTOCOMPLETE = /autoComplete=["']([a-z-]+)["']/;

describe('autofill hygiene of settings fields', () => {
  it('declares autoComplete on every password input in the renderer', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(COMPONENTS_DIR)) {
      for (const tag of inputTags(fs.readFileSync(file, 'utf8'))) {
        if (!/type=["']password["']/.test(tag)) continue;
        const value = AUTOCOMPLETE.exec(tag)?.[1];
        if (value !== 'new-password' && value !== 'off') {
          offenders.push(`${path.relative(COMPONENTS_DIR, file)}: ${tag.split('\n')[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // [arquivo, trecho que identifica o campo, valor esperado]
  const FIELDS = [
    ['settings/AccountsManager.tsx', 'placeholder="nome da conta (ex.: z.ai', 'off'],
    ['settings/AccountsManager.tsx', 'placeholder="cole a API key"', 'new-password'],
    ['settings/ProvidersPanel.tsx', 'aria-label={keyLabel}', 'new-password'],
    ['settings/ProvidersPanel.tsx', 'placeholder="ex.: glm-5.3', 'off'],
    ['settings/ProvidersPanel.tsx', 'placeholder={provider.detectedBin}', 'off'],
    ['settings/ProvidersPanel.tsx', 'placeholder="ex.: --verbose --foo bar"', 'off'],
    ['settings/ApiKeysSection.tsx', 'aria-label="Passphrase do pacote de keys"', 'new-password'],
    ['settings/OrchestratorDefaults.tsx', 'aria-label="Base URL do gateway de IA local"', 'off'],
  ] as const;

  it.each(FIELDS)('%s › %s uses autoComplete="%s"', (file, marker, expected) => {
    const source = fs.readFileSync(path.join(COMPONENTS_DIR, file), 'utf8');
    const tag = inputTags(source).find((candidate) => candidate.includes(marker));
    if (!tag) throw new Error(`No <input> with ${marker} in ${file}`);
    expect(AUTOCOMPLETE.exec(tag)?.[1]).toBe(expected);
  });
});
