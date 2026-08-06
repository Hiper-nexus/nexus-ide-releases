/**
 * Descoberta de plugins de agente no disco (metade de IO da ingestão).
 *
 * DECISÃO DE AUTORIDADE, e ela é o desenho inteiro: este módulo NÃO instala.
 * Gravar em `~/.claude` é exatamente o que `catalog_install` faz, e essa
 * ferramenta é recusada no dispatch (RENDERER_EXACT_CONSENT_TOOLS) justamente
 * porque instalar componente de terceiro precisa da superfície nativa, onde o
 * operador vê commit, digest e alertas. Uma ingestão que instalasse sozinha
 * seria um buraco nessa fronteira com nome novo.
 *
 * O que ela faz: descobre, valida e RELATA — com a degradação declarada. O
 * operador instala pelo Marketplace, sabendo o que vai entrar.
 *
 * Toda falha de disco vira entrada de relatório, nunca exceção: um diretório de
 * plugin ruim não pode derrubar a varredura dos outros.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describePluginIngestion,
  readPluginManifest,
  type PluginManifestVerdict,
} from './agent-plugin-manifest';

export interface DiscoveredPlugin {
  /** Diretório do plugin, relativo ao HOME — caminho absoluto nunca sai daqui. */
  readonly source: string;
  readonly verdict: PluginManifestVerdict;
  /** Frase pronta para a UI. */
  readonly summary: string;
}

/**
 * Onde plugins moram. Um diretório por convenção, não configurável: caminho de
 * varredura vindo de fora seria uma leitura arbitrária de disco com outro nome.
 */
const PLUGIN_ROOTS = ['.nexus/plugins', '.claude/plugins'] as const;

const MANIFEST_NAMES = ['plugin.json', '.claude-plugin/plugin.json'] as const;

/** Teto de varredura: diretório com milhares de entradas não pendura o main. */
const MAX_PLUGINS = 200;

function homeRelative(absolute: string, home: string): string {
  const relative = path.relative(home, absolute);
  return relative.startsWith('..') ? path.basename(absolute) : `~/${relative}`;
}

function readManifestJson(pluginDir: string): unknown | null {
  for (const candidate of MANIFEST_NAMES) {
    const file = path.join(pluginDir, candidate);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Ausente ou ilegível: tenta o próximo nome. Só depois de todos é que
      // vira recusa — e recusa é relatório, não exceção.
    }
  }
  return null;
}

export function scanInstalledPlugins(
  home: string = os.homedir(),
): readonly DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];

  for (const root of PLUGIN_ROOTS) {
    const rootDir = path.join(home, root);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (found.length >= MAX_PLUGINS) return Object.freeze(found);
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(rootDir, entry.name);
      const source = homeRelative(pluginDir, home);
      const raw = readManifestJson(pluginDir);
      if (raw === null) {
        // Diretório sem manifesto legível não é erro do usuário nem silêncio:
        // aparece no relatório para ele saber por que aquilo não instalou.
        const verdict: PluginManifestVerdict = {
          ok: false,
          reason: 'sem plugin.json legível',
        };
        found.push(
          Object.freeze({
            source,
            verdict,
            summary: describePluginIngestion(verdict),
          }),
        );
        continue;
      }
      const verdict = readPluginManifest(raw);
      found.push(
        Object.freeze({
          source,
          verdict,
          summary: describePluginIngestion(verdict),
        }),
      );
    }
  }

  return Object.freeze(found);
}
