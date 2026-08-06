/**
 * Ingestão de plugins de agente — metade LEITORA da spec (v1.0.0).
 *
 * Só ingestão, nunca exportação: publicar o catálogo do usuário para fora é uma
 * decisão de produto que ninguém tomou, e a metade que lê já entrega o valor —
 * um plugin de terceiro passa a poder trazer agentes, skills e comandos.
 *
 * DEFENSIVO POR CONTRATO. Este é o ponto onde conteúdo escrito por outra pessoa
 * entra no Nexus, então três regras valem sem exceção:
 *
 *  1. NUNCA lançar por causa do conteúdo. Manifesto quebrado vira recusa
 *     legível com o motivo; um throw aqui derrubaria a varredura de catálogo
 *     inteira por causa de um diretório ruim de terceiro.
 *  2. Componente desconhecido DEGRADA, não invalida (D1). Uma spec futura com
 *     um tipo novo ainda instala o que este Nexus entende, e DECLARA o que
 *     ignorou — silenciar viraria "instalei tudo" mentindo.
 *  3. Nada de caminho: nome com `/`, `..` ou absoluto é recusado. Um manifesto
 *     não escolhe onde escrever no disco do usuário.
 *
 * Puro: recebe o JSON já lido, devolve veredito. Quem toca disco é o chamador,
 * e é ele quem passa pelo gate de permissão — este módulo não instala nada.
 */

/** Versão de spec fixada. Manifesto de major diferente é recusado, não adivinhado. */
export const SUPPORTED_PLUGIN_SPEC = '1.0.0';

/** Componentes que este Nexus sabe ingerir hoje. */
export const SUPPORTED_COMPONENTS = Object.freeze([
  'agents',
  'skills',
  'commands',
] as const);

export type SupportedComponent = (typeof SUPPORTED_COMPONENTS)[number];

export interface PluginComponentEntry {
  readonly component: SupportedComponent;
  /** Nome simples do item, já validado como não-caminho. */
  readonly name: string;
}

export interface AcceptedPlugin {
  readonly ok: true;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly entries: readonly PluginComponentEntry[];
  /**
   * O que veio no manifesto e este Nexus NÃO ingere. Nunca vazio por conveniência:
   * é o que impede "instalei tudo" de ser mentira.
   */
  readonly degraded: readonly { component: string; why: string }[];
}

export interface RejectedPlugin {
  readonly ok: false;
  /** Motivo em linguagem do operador — vai para a UI, não para um log. */
  readonly reason: string;
}

export type PluginManifestVerdict = AcceptedPlugin | RejectedPlugin;

/** Nome de item: sem separador, sem subida de diretório, sem raiz. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MAX_ENTRIES_PER_COMPONENT = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Major da spec. `1.2.0` é aceito por um leitor 1.0.0; `2.0.0` não é. */
function majorOf(version: string): string | null {
  const match = /^(\d+)\.\d+\.\d+/.exec(version);
  return match?.[1] ?? null;
}

export function readPluginManifest(raw: unknown): PluginManifestVerdict {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'manifesto não é um objeto JSON' };
  }

  const name = readString(raw, 'name');
  if (!SAFE_NAME.test(name)) {
    return {
      ok: false,
      reason: name
        ? `nome de plugin inválido: "${name}" (sem barras, "..", ou caminho absoluto)`
        : 'manifesto sem "name"',
    };
  }

  const specVersion = readString(raw, 'specVersion') || SUPPORTED_PLUGIN_SPEC;
  const major = majorOf(specVersion);
  if (major === null) {
    return { ok: false, reason: `specVersion ilegível: "${specVersion}"` };
  }
  if (major !== majorOf(SUPPORTED_PLUGIN_SPEC)) {
    // Recusa explícita em vez de tentar adivinhar: uma major nova pode ter
    // mudado o significado de um campo que este leitor acha que entende.
    return {
      ok: false,
      reason:
        `plugin exige spec ${specVersion}; este Nexus lê ${SUPPORTED_PLUGIN_SPEC}. ` +
        'Atualize o Nexus ou use uma versão compatível do plugin.',
    };
  }

  const entries: PluginComponentEntry[] = [];
  const degraded: { component: string; why: string }[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'name' || key === 'version' || key === 'description') continue;
    if (key === 'specVersion' || key === 'author') continue;

    if (!(SUPPORTED_COMPONENTS as readonly string[]).includes(key)) {
      // Campo desconhecido só é DEGRADAÇÃO quando parece componente (lista de
      // itens). Metadado solto de uma spec futura não merece alarme.
      if (Array.isArray(value)) {
        degraded.push({
          component: key,
          why: `componente não suportado por este Nexus (spec ${SUPPORTED_PLUGIN_SPEC})`,
        });
      }
      continue;
    }

    if (!Array.isArray(value)) {
      degraded.push({ component: key, why: 'esperava uma lista de nomes' });
      continue;
    }

    const component = key as SupportedComponent;
    let rejectedNames = 0;
    for (const item of value.slice(0, MAX_ENTRIES_PER_COMPONENT)) {
      const itemName = typeof item === 'string' ? item.trim() : '';
      if (!SAFE_NAME.test(itemName)) {
        rejectedNames += 1;
        continue;
      }
      entries.push(Object.freeze({ component, name: itemName }));
    }
    if (rejectedNames > 0) {
      degraded.push({
        component: key,
        why: `${rejectedNames} nome(s) recusado(s): um manifesto não escolhe caminho no disco`,
      });
    }
    if (value.length > MAX_ENTRIES_PER_COMPONENT) {
      degraded.push({
        component: key,
        why: `lista truncada em ${MAX_ENTRIES_PER_COMPONENT} itens`,
      });
    }
  }

  if (entries.length === 0) {
    return {
      ok: false,
      reason: `plugin "${name}" não declara nenhum componente que este Nexus ingere`,
    };
  }

  return {
    ok: true,
    name,
    version: readString(raw, 'version') || '0.0.0',
    description: readString(raw, 'description'),
    entries: Object.freeze(entries),
    degraded: Object.freeze(degraded),
  };
}

/** Frase única para a UI — a degradação precisa ser lida, não inferida de um array. */
export function describePluginIngestion(verdict: PluginManifestVerdict): string {
  if (!verdict.ok) return `Plugin recusado: ${verdict.reason}`;
  const counts = new Map<string, number>();
  for (const entry of verdict.entries) {
    counts.set(entry.component, (counts.get(entry.component) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([component, n]) => `${n} ${component}`);
  const base = `${verdict.name} ${verdict.version}: ${parts.join(', ')}`;
  if (verdict.degraded.length === 0) return base;
  const ignored = verdict.degraded.map((d) => d.component).join(', ');
  return `${base} — ignorado: ${ignored}`;
}
