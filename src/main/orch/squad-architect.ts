import fs from 'node:fs';
import path from 'node:path';
import { chatViaBrainChain } from '../voice/jarvis-brain';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { saveSquad } from './squad-store';
import {
  enrichedBlockForArchitect,
  loadEnrichedCatalog,
} from './harness-enrich';
import type { Squad } from '../../shared/orch-types';

/**
 * Squad Architect — lê o workspace (stack, estrutura, README) e GERA um squad
 * sob medida: papéis certos para o projeto, instruções de orquestração
 * específicas e CLIs/modelos adequados. Cada projeto pede um time diferente;
 * este módulo monta o time.
 *
 * Duas entradas: workspace-driven (perfil do projeto) e intent-driven (modo
 * Agêntico — o usuário descreve o objetivo em linguagem natural e o time sai
 * desenhado PARA aquele objetivo, com o workspace como contexto).
 */

const MAX_FILE_CHARS = 4_000;
const ARCHITECT_PROMPT = `Você é um arquiteto de squads de agentes de IA no
NexusIDE. Com base no PERFIL DO PROJETO abaixo, desenhe o squad ideal.

Responda APENAS com JSON neste formato:
{
  "name": "<nome curto do squad, ex.: 'API Django + React'>",
  "orchestratorInstructions": "<playbook markdown CURTO e específico do
    projeto: o que o squad faz, divisão de responsabilidades, convenções do
    projeto que os workers devem seguir>",
  "agents": [
    {"id": "<slug>", "agentName": "<nome>", "category": "executor|reviewer|scout|architect",
     "cli": "<uma CLI instalada>", "model": "<modelo disponível>", "effort": "<effort disponível>"}
  ]
}

Regras:
- 3 a 6 workers, escalando com o tamanho/complexidade do projeto; papéis
  DERIVADOS do projeto real (ex.: Django+React → backend Django, frontend
  React, QA, security, reviewer).
- SEMPRE inclua um agente de QA (category reviewer) cujo papel é RODAR o
  app/os testes de verdade e tentar quebrar as entregas — não só ler código.
- Inclua um reviewer de Segurança sempre que o projeto tocar auth,
  pagamentos, APIs expostas, rede ou dados de usuário.
- Inclua um UX/UI Designer (category reviewer, cli claude) sempre que o
  projeto tiver interface (web, mobile, desktop): ele critica hierarquia,
  acessibilidade, estados vazios e polish das entregas de UI, com mandato
  explícito de rejeitar o visual genérico de IA (sparkles, gradiente roxo,
  glassmorphism, card grids idênticos) e usar a skill impeccable quando
  disponível.
- NÃO inclua o orquestrador na lista (ele é adicionado automaticamente).
- DISTRIBUA os workers entre as CLIs INSTALADAS listadas no perfil (custo e
  diversidade): executores em CLIs rápidas/baratas; reviewer/architect nas
  mais capazes. Nunca coloque todos na mesma CLI.
- Use somente CLI/modelo/effort declarados no perfil runtime; não invente nem
  use catálogos memorizados. Prefira effort econômico em trabalho mecânico e o
  maior effort realmente disponível em revisão/arquitetura crítica.
- Instruções: cite a stack e os diretórios REAIS do perfil, e SEMPRE inclua
  os comandos reais de build/test/lint do projeto (extraia dos manifests,
  ex.: scripts do package.json, Makefile, rake, go test ./...) — são os
  gates que o orquestrador vai cobrar em cada handoff.`;

function readSafe(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, MAX_FILE_CHARS);
  } catch {
    return '';
  }
}

/** Perfil compacto do projeto: manifests + árvore de 1º nível. */
function profileWorkspace(root: string): string {
  const parts: string[] = [`# raiz: ${path.basename(root)}`];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).slice(0, 60);
    parts.push(
      '## estrutura (1º nível)\n' +
        entries
          .map((e) => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`)
          .join('\n'),
    );
  } catch {
    // sem leitura da raiz — segue só com manifests
  }
  const manifests = [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'pom.xml',
    'README.md',
  ];
  for (const m of manifests) {
    const content = readSafe(path.join(root, m));
    if (content) parts.push(`## ${m}\n${content}`);
  }
  return parts.join('\n\n').slice(0, 16_000);
}

export interface ArchitectResult {
  ok: boolean;
  squad?: Squad;
  error?: string;
}

/** Analisa o workspace e salva um squad sob medida. */
export async function designSquadForWorkspace(
  workspacePath: string,
): Promise<ArchitectResult> {
  return designSquad({ workspacePath });
}

/**
 * Modo Agêntico: o usuário descreve O QUE QUER; o arquiteto monta o time
 * para ESSE objetivo (workspace como contexto, não como fonte da missão).
 */
export async function designSquadFromIntent(
  intent: string,
  workspacePath: string,
): Promise<ArchitectResult> {
  const clean = intent.trim();
  if (!clean) return { ok: false, error: 'descreva o objetivo da missão' };
  return designSquad({ workspacePath, intent: clean.slice(0, 4_000) });
}

async function designSquad(opts: {
  workspacePath: string;
  intent?: string;
}): Promise<ArchitectResult> {
  const { workspacePath, intent } = opts;
  const installed = listAdapterInfos()
    .filter((a) => a.installed && a.id !== 'shell')
    .map((a) => `${a.id} [models: ${a.models.list.join(', ') || a.models.default}]`)
    .join('\n');
  const intentBlock = intent
    ? `OBJETIVO DO USUÁRIO (a missão deste squad — desenhe o time PARA isto):\n` +
      `"""${intent}"""\n\n` +
      `Regra extra: as orchestratorInstructions DEVEM abrir declarando este ` +
      `objetivo como a missão, e o primeiro passo do orquestrador é decompô-lo ` +
      `e delegar — sem re-perguntar o que fazer.\n\n`
    : '';
  // Arsenal enriquecido (harness-enrich): o arquiteto cita agents/skills
  // REAIS instalados em vez de inventar papéis genéricos.
  const enriched = enrichedBlockForArchitect(loadEnrichedCatalog(), 4_000);
  const profile =
    intentBlock +
    `CATÁLOGO RUNTIME DE CLIs/MODELOS (fonte de verdade):\n${installed || 'nenhuma'}\n\n` +
    (enriched ? `${enriched}\n\n` : '') +
    profileWorkspace(workspacePath);
  const raw = await chatViaBrainChain(
    [
      { role: 'system', content: ARCHITECT_PROMPT },
      { role: 'user', content: `PERFIL DO PROJETO:\n\n${profile}` },
    ],
    2_000,
  ).catch((err) => {
    throw new Error(err instanceof Error ? err.message : String(err));
  });

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, error: 'o modelo não devolveu JSON' };
  let parsed: {
    name?: string;
    orchestratorInstructions?: string;
    agents?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.warn('[orch] arquiteto devolveu JSON inválido:', raw.slice(-200));
    return { ok: false, error: 'JSON inválido do modelo (resposta truncada?)' };
  }
  if (!parsed.name || !Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    return { ok: false, error: 'squad gerado incompleto' };
  }

  const workspaceName = path.basename(workspacePath);
  // Intent mode ganha id próprio (por nome gerado) — dois squads agênticos no
  // mesmo workspace não podem colidir no id `custom-<workspace>`.
  const idBase = intent
    ? `agentic-${parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now() % 100_000}`
    : `custom-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const candidate = {
    id: idBase.slice(0, 64),
    name: parsed.name.slice(0, 80),
    createdAt: String(Date.now()),
    builtin: false,
    orchestratorInstructions: (parsed.orchestratorInstructions ?? '').slice(0, 20_000),
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        effort: 'high',
      },
      ...parsed.agents.slice(0, 6),
    ],
  };
  try {
    // saveSquad aplica withAllowlists (normalizador canônico): os workers
    // gerados aqui não carregam `allowedTools`, e é lá que ganham o `[]` que os
    // faz passar o fire-gate do wizard. Não normalizamos aqui para não duplicar
    // a regra — a persistência é o único ponto de normalização.
    const squad = saveSquad(candidate);
    console.log(`[orch] squad sob medida criado: ${squad.name} (${squad.agents.length} agentes)`);
    return { ok: true, squad };
  } catch (err) {
    return {
      ok: false,
      error: `squad inválido: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
