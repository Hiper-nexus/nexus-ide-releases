import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonFileAtomic } from '../persistence/atomic-json-file';
import { listInstalledCatalogItems } from './catalog';

/**
 * Harness Enrich — a passada de LLM que transforma o arsenal instalado
 * (agents + skills) em um catálogo ANOTADO: tier (scout|builder|reviewer),
 * blurb curto e quando-usar, persistido em ~/.nexus/harness-enriched.json.
 * O Squad Architect consome esse bloco na hora de desenhar squads — o time
 * sai citando itens REAIS do arsenal em vez de inventar papéis genéricos.
 *
 * Lógica pura (chat injetado) — a borda com a cadeia de brain providers vive
 * em runHarnessEnrichWithBrain().
 */

export type HarnessTier = import('../../shared/types').HarnessTier;
export type EnrichedItem = import('../../shared/types').EnrichedCatalogItem;
export type EnrichedCatalog = import('../../shared/types').EnrichedCatalogInfo;

export interface EnrichableItem {
  name: string;
  kind: 'agent' | 'skill';
}

export const ENRICH_CHUNK_SIZE = 16;
export const ENRICH_MAX_ITEMS = 512;
const ENRICH_MAX_CHUNK_SIZE = 64;
const ENRICH_RETRY_CHUNK_SIZE = 8;
const BLURB_MAX = 160;
const WHEN_MAX = 120;
const TIERS: HarnessTier[] = ['scout', 'builder', 'reviewer'];
const REVIEWER_NAME_RE =
  /(?:review|audit|security|secure|vulnerab|quality|\bqa\b|test|lint|debug|compliance|critic|verify|validation)/i;
const SCOUT_NAME_RE =
  /(?:research|search|explor|discover|investigat|analysis|analyz|map|architect|planner|strategy|docs?|knowledge|context)/i;

const ENRICH_SYSTEM = `Você classifica componentes de um arsenal de agentes de
IA (agents e skills instalados) na topologia de 3 papéis:
- "scout": pesquisa, descoberta, leitura, análise, mapeamento.
- "builder": execução, construção de código/UI/mídia/copy.
- "reviewer": QA, teste, auditoria, segurança, crítica de entrega.

Responda APENAS com JSON:
{"items":[{"name":"<nome exato>","kind":"agent|skill","tier":"scout|builder|reviewer",
"blurb":"<~120 chars: o que faz>","whenToUse":"<~100 chars: quando escalar>"}]}

Regras: use o NOME EXATO recebido; um item por entrada; blurb objetivo e
específico (nunca "agente útil"); em dúvida de tier, escolha builder.`;

export function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function buildEnrichMessages(
  chunk: EnrichableItem[],
): Array<{ role: string; content: string }> {
  const list = chunk.map((i) => `- ${i.name} (${i.kind})`).join('\n');
  return [
    { role: 'system', content: ENRICH_SYSTEM },
    { role: 'user', content: `ARSENAL A CLASSIFICAR:\n${list}` },
  ];
}

/**
 * Valida a resposta de um chunk: só aceita nomes que estavam no chunk (o
 * modelo não pode inventar itens), tier fora da taxonomia cai para builder,
 * textos são clampados. Resposta ilegível degrada para [] — nunca lança.
 */
export function parseEnrichResponse(
  raw: string,
  chunk: EnrichableItem[],
): EnrichedItem[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: { items?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.items)) return [];
  const expected = new Map(chunk.map((i) => [`${i.kind}:${i.name}`, i]));
  const out: EnrichedItem[] = [];
  for (const entry of parsed.items) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const kind = entry.kind === 'skill' ? 'skill' : 'agent';
    if (!name || !expected.has(`${kind}:${name}`)) continue;
    const tier = TIERS.includes(entry.tier as HarnessTier)
      ? (entry.tier as HarnessTier)
      : 'builder';
    const blurb =
      typeof entry.blurb === 'string' ? entry.blurb.trim().slice(0, BLURB_MAX) : '';
    const whenToUse =
      typeof entry.whenToUse === 'string' && entry.whenToUse.trim()
        ? entry.whenToUse.trim().slice(0, WHEN_MAX)
        : undefined;
    out.push({ name, kind, tier, blurb, ...(whenToUse ? { whenToUse } : {}) });
  }
  return out;
}

/** Merge acumulativo por (kind, name) — o fresco vence, o resto permanece. */
export function mergeEnriched(
  prev: EnrichedCatalog | null,
  fresh: EnrichedItem[],
  now: number,
): EnrichedCatalog {
  const byKey = new Map<string, EnrichedItem>();
  for (const item of prev?.items ?? []) byKey.set(`${item.kind}:${item.name}`, item);
  for (const item of fresh) byKey.set(`${item.kind}:${item.name}`, item);
  return { version: 1, updatedAt: now, items: [...byKey.values()] };
}

function fallbackEnrichedItem(item: EnrichableItem): EnrichedItem {
  const readableName = item.name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tier: HarnessTier = REVIEWER_NAME_RE.test(readableName)
    ? 'reviewer'
    : SCOUT_NAME_RE.test(readableName)
      ? 'scout'
      : 'builder';
  const purpose =
    tier === 'reviewer'
      ? 'revisão, validação e controle de qualidade'
      : tier === 'scout'
        ? 'pesquisa, análise e descoberta de contexto'
        : 'execução e construção especializada';
  return {
    ...item,
    tier,
    blurb: `${readableName}: ${purpose}.`.slice(0, BLURB_MAX),
    whenToUse: `Quando a missão exigir ${purpose}.`.slice(0, WHEN_MAX),
  };
}

export interface RunEnrichOptions {
  chunkSize?: number;
  prev?: EnrichedCatalog | null;
  now?: () => number;
  signal?: AbortSignal;
  assertCurrentAuthority?: () => void;
}

function assertEnrichAuthority(
  options: Pick<RunEnrichOptions, 'signal' | 'assertCurrentAuthority'>,
): void {
  options.assertCurrentAuthority?.();
  if (!options.signal?.aborted) return;
  if (options.signal.reason instanceof Error) throw options.signal.reason;
  throw new Error('harness enrichment authority was revoked');
}

/**
 * Roda a passada de enriquecimento: chunks sequenciais, chunk que falha
 * degrada para [] (nunca derruba a passada inteira), merge acumulativo.
 */
export async function runHarnessEnrich(
  items: EnrichableItem[],
  chat: (
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
  ) => Promise<string>,
  opts: RunEnrichOptions = {},
): Promise<EnrichedCatalog> {
  const { chunkSize = ENRICH_CHUNK_SIZE, prev = null, now = Date.now } = opts;
  assertEnrichAuthority(opts);
  if (items.length > ENRICH_MAX_ITEMS) {
    throw new Error(
      `harness inventory exceeds ${ENRICH_MAX_ITEMS} installed items`,
    );
  }
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > ENRICH_MAX_CHUNK_SIZE
  ) {
    throw new Error(
      `harness chunk size must be between 1 and ${ENRICH_MAX_CHUNK_SIZE}`,
    );
  }
  const inventory = [
    ...new Map(items.map((item) => [`${item.kind}:${item.name}`, item])).values(),
  ];
  const fresh: EnrichedItem[] = [];
  for (const chunk of chunkItems(inventory, chunkSize)) {
    assertEnrichAuthority(opts);
    let parsed: EnrichedItem[] = [];
    try {
      const raw = await chat(buildEnrichMessages(chunk), opts.signal);
      assertEnrichAuthority(opts);
      parsed = parseEnrichResponse(raw, chunk);
      fresh.push(...parsed);
    } catch (err) {
      // Provider failures degrade to deterministic annotations; an authority
      // revocation is different and must terminate the operation fail-closed.
      assertEnrichAuthority(opts);
      console.warn(
        '[harness] chunk de enriquecimento falhou (tentando lacunas):',
        err instanceof Error ? err.message : err,
      );
    }

    // JSON truncado ou provider instável não pode deixar a maior parte do
    // arsenal permanentemente sem anotação. Reenvia somente as lacunas, uma
    // vez, em grupos menores e mergeia nomes exatos (sem loop infinito).
    const covered = new Set(parsed.map((entry) => `${entry.kind}:${entry.name}`));
    const missing = chunk.filter((entry) => !covered.has(`${entry.kind}:${entry.name}`));
    for (const retryChunk of chunkItems(missing, ENRICH_RETRY_CHUNK_SIZE)) {
      assertEnrichAuthority(opts);
      try {
        const raw = await chat(buildEnrichMessages(retryChunk), opts.signal);
        assertEnrichAuthority(opts);
        fresh.push(...parseEnrichResponse(raw, retryChunk));
      } catch (err) {
        assertEnrichAuthority(opts);
        console.warn(
          '[harness] retry de enriquecimento falhou (seguindo):',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  const covered = new Set(fresh.map((item) => `${item.kind}:${item.name}`));
  for (const item of inventory) {
    if (!covered.has(`${item.kind}:${item.name}`)) {
      fresh.push(fallbackEnrichedItem(item));
    }
  }
  assertEnrichAuthority(opts);
  const installed = new Set(
    inventory.map((item) => `${item.kind}:${item.name}`),
  );
  const merged = mergeEnriched(prev, fresh, now());
  return {
    ...merged,
    items: merged.items.filter((item) =>
      installed.has(`${item.kind}:${item.name}`),
    ),
  };
}

/**
 * Bloco de prompt para o Squad Architect: arsenal agrupado por tier, capado
 * em `cap` chars. Vazio quando não há catálogo enriquecido.
 */
export function enrichedBlockForArchitect(
  cat: EnrichedCatalog | null,
  cap: number,
): string {
  if (!cat || cat.items.length === 0) return '';
  const lines: string[] = [
    'ARSENAL ENRIQUECIDO (agents/skills instalados — cite-os nas instruções',
    'quando couberem ao objetivo, pelo NOME exato):',
  ];
  for (const tier of TIERS) {
    const of = cat.items.filter((i) => i.tier === tier);
    if (of.length === 0) continue;
    lines.push(`## ${tier.toUpperCase()}`);
    for (const item of of) {
      lines.push(`- ${item.name} (${item.kind}): ${item.blurb}`);
    }
  }
  return lines.join('\n').slice(0, cap);
}

// ── Persistência + borda (brain chain) ───────────────────────────────────────

export function enrichedFilePath(): string {
  return path.join(os.homedir(), '.nexus', 'harness-enriched.json');
}

export function loadEnrichedCatalog(): EnrichedCatalog | null {
  try {
    if (fs.existsSync(enrichedFilePath())) {
      const parsed = JSON.parse(
        fs.readFileSync(enrichedFilePath(), 'utf8'),
      ) as EnrichedCatalog;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
        return parsed;
      }
    }
  } catch {
    // If corrupt, fall through to fallback generation
  }

  try {
    const rawItems = listInstalledCatalogItems().filter(
      (i) => i.kind === 'agent' || i.kind === 'skill',
    );
    const uniqueItems = [
      ...new Map(rawItems.map((i) => [`${i.kind}:${i.name}`, i])).values(),
    ];
    const items = uniqueItems.map((i) =>
      fallbackEnrichedItem({ name: i.name, kind: i.kind as 'agent' | 'skill' }),
    );

    const catalog: EnrichedCatalog = {
      version: 1,
      updatedAt: Date.now(),
      items,
    };
    saveEnrichedCatalog(catalog);
    return catalog;
  } catch (err) {
    console.warn('[harness] failed to bootstrap fallback catalog:', err);
    return null;
  }
}

export function saveEnrichedCatalog(cat: EnrichedCatalog): void {
  writeJsonFileAtomic(enrichedFilePath(), cat);
}

/**
 * Borda: enriquece o arsenal INSTALADO usando a cadeia de brain providers
 * (Gemini → OpenAI → Groq). O require tardio do jarvis-brain mantém o módulo testável.
 */
export interface RunHarnessEnrichWithBrainOptions {
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
  readonly listInstalledItems?: () => ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
  }>;
  readonly chat?: (
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly loadPrevious?: () => EnrichedCatalog | null;
  readonly save?: (catalog: EnrichedCatalog) => void;
}

export async function runHarnessEnrichWithBrain(
  options: RunHarnessEnrichWithBrainOptions = {},
): Promise<EnrichedCatalog> {
  const listInstalledItems = options.listInstalledItems ?? listInstalledCatalogItems;
  const chat = options.chat ?? ((
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- jarvis-brain arrasta ~960 módulos e o Electron; tardio, harness-enrich segue testável com `chat` injetado
    const { chatViaBrainChain } = require('../voice/jarvis-brain') as typeof import('../voice/jarvis-brain');
    return chatViaBrainChain(messages, 4_000, undefined, signal);
  });
  const loadPrevious = options.loadPrevious ?? loadEnrichedCatalog;
  const save = options.save ?? saveEnrichedCatalog;

  assertEnrichAuthority(options);
  const items: EnrichableItem[] = listInstalledItems()
    .filter((i) => i.kind === 'agent' || i.kind === 'skill')
    .map((i) => ({ name: i.name, kind: i.kind as 'agent' | 'skill' }));
  assertEnrichAuthority(options);
  const result = await runHarnessEnrich(
    items,
    chat,
    {
      prev: loadPrevious(),
      signal: options.signal,
      assertCurrentAuthority: options.assertCurrentAuthority,
    },
  );
  assertEnrichAuthority(options);
  save(result);
  return result;
}
