import fs from 'node:fs';
import path from 'node:path';
import { chatViaBrainChain } from '../voice/jarvis-brain';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { listSquads, saveSquad } from './squad-store';
import { pickReusableSquad } from './squad-reuse';
import {
  enrichedBlockForArchitect,
  loadEnrichedCatalog,
} from './harness-enrich';
import type { Squad } from '../../shared/orch-types';
import { diagnoseWithDoctorGrok } from '../runtime/doctor-diagnostic-engine';
import { getOrchSettings } from '../persistence/settings-store';

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
- Quando a missão exigir GERAR ou EDITAR imagem, spritesheet, avatar ou desktop
  pet, escolha um executor com geração visual nativa: priorize Codex com as
  skills imagegen/hatch-pet e depois Grok com sua ferramenta de imagem. Claude
  pode implementar/revisar código e contrato visual, mas NÃO deve ser escalado
  como gerador de imagem sem uma ferramenta de mídia Nexus explicitamente
  declarada no arsenal. Nunca atribua geração visual a uma CLI sem capacidade.
- Desktop pet v2 NÃO é uma imagem única: é um pipeline 8x11 com 9 estados de
  animação (idle, running-right, running-left, waving, jumping, failed,
  waiting, running, review), 16 direções de olhar e até 13 trabalhos visuais.
  O executor visual líder deve carregar a skill hatch-pet, criar uma base
  canônica e aterrar TODAS as linhas nela. Outro gerador é apenas fallback de
  linha completa, nunca fonte de células avulsas misturadas. Exija validação
  determinística, contact sheet, motion preview e spriteVersionNumber 2.
- Instruções: cite a stack e os diretórios REAIS do perfil, e SEMPRE inclua
  os comandos reais de build/test/lint do projeto (extraia dos manifests,
  ex.: scripts do package.json, Makefile, rake, go test ./...) — são os
  gates que o orquestrador vai cobrar em cada handoff.`;

const ARCHITECT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    orchestratorInstructions: { type: 'string' },
    agents: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          agentName: { type: 'string' },
          category: { type: 'string', enum: ['executor', 'reviewer', 'scout', 'architect'] },
          cli: { type: 'string' },
          model: { type: 'string' },
          effort: { type: 'string' },
        },
        required: ['id', 'agentName', 'category', 'cli', 'model'],
      },
    },
  },
  required: ['name', 'orchestratorInstructions', 'agents'],
} as const;

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
  warning?: string;
}

export interface SquadDesignOptions {
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

function assertSquadDesignAuthority(options: SquadDesignOptions): void {
  options.assertCurrentAuthority?.();
  if (!options.signal?.aborted) return;
  if (options.signal.reason instanceof Error) throw options.signal.reason;
  throw new Error('squad design authority was revoked');
}

function deterministicSquadFallback(
  workspacePath: string,
  intent: string | undefined,
  reason: string,
  options: SquadDesignOptions = {},
): ArchitectResult {
  assertSquadDesignAuthority(options);
  const adapters = listAdapterInfos().filter(
    (adapter) => adapter.installed && adapter.id !== 'shell',
  );
  if (adapters.length === 0) {
    return { ok: false, error: `${reason}; nenhuma CLI instalada para fallback` };
  }
  const pick = (index: number) => adapters[index % adapters.length];
  const worker = (
    id: string,
    agentName: string,
    category: 'executor' | 'reviewer' | 'scout' | 'architect',
    index: number,
    preferredAdapterId?: string,
  ) => {
    const adapter = adapters.find((item) => item.id === preferredAdapterId) ?? pick(index);
    return {
      id,
      agentName,
      category,
      cli: adapter.id,
      model: adapter.models.default || adapter.models.list[0],
    };
  };
  const objective = intent?.trim() || `Manter e evoluir ${path.basename(workspacePath)}`;
  const visual = /\b(ui|ux|visual|interface|desktop|pet|site|landing|web|mobile|react|electron)\b/i.test(
    objective,
  );
  const imageGeneration = /\b(pet|imagem|image|sprite|spritesheet|avatar|ilustra|gerar\s+(?:uma\s+)?(?:foto|arte))\b/i.test(
    objective,
  );
  const visualExecutor = imageGeneration
    ? ['codex', 'grok'].find((id) => adapters.some((adapter) => adapter.id === id))
    : undefined;
  const agents = [
    worker(
      'executor',
      imageGeneration ? 'Executor visual' : 'Executor principal',
      'executor',
      0,
      visualExecutor,
    ),
    worker('qa', 'QA de execução', 'reviewer', 1),
    worker('reviewer', 'Revisor sênior', 'reviewer', 2),
    ...(visual ? [worker('ux', 'UX e validação visual', 'reviewer', 3)] : []),
  ];
  const orchestrator = adapters.find((adapter) => adapter.orchestratorCapable) ?? adapters[0];
  // `saveSquad` is the authority-bearing global effect. Keep this assertion
  // outside the error-normalization block so revocation fails closed instead
  // of being disguised as a recoverable model/fallback error.
  assertSquadDesignAuthority(options);
  try {
    const squad = saveSquad({
      id: `agentic-fallback-${Date.now()}`,
      name: visual ? 'Execução + QA Visual' : 'Execução + QA',
      createdAt: String(Date.now()),
      builtin: false,
      orchestratorInstructions: [
        `# Missão\n${objective}`,
        'Inspecione os manifests e use os comandos reais de build, lint e teste do workspace.',
        'Delegue execução e revisão em paralelo quando os escopos não se sobrepuserem.',
        'Não declare conclusão sem evidência local dos testes e pós-condições da entrega.',
        visual
          ? 'A entrega visual exige QA da imagem/interface, estados completos e comparação com a referência anexada.'
          : '',
        imageGeneration
          ? `A geração do asset visual deve ser liderada por ${visualExecutor ?? 'um executor com ferramenta de mídia comprovada'}. Para pet v2, carregue hatch-pet e trate como pipeline 8x11: base canônica, 9 linhas de animação, 16 direções, até 13 jobs visuais, QA incremental, contact sheet e motion preview. Codex é a primeira opção; Grok é fallback visual por linha inteira. Nunca misture células avulsas de geradores diferentes. Claude sem ferramenta de mídia pode implementar/revisar, mas não gerar o asset.`
          : '',
      ].filter(Boolean).join('\n\n'),
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: orchestrator.id,
          model: orchestrator.models.default || orchestrator.models.list[0],
        },
        ...agents,
      ],
    });
    console.warn(`[orch doctor] ${reason}; squad determinístico criado: ${squad.name}`);
    return {
      ok: true,
      squad,
      warning: `${reason}. O Doctor montou um time determinístico com o catálogo local.`,
    };
  } catch (cause) {
    return {
      ok: false,
      error: `${reason}; fallback inválido: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** Analisa o workspace e salva um squad sob medida. */
export async function designSquadForWorkspace(
  workspacePath: string,
  options: SquadDesignOptions = {},
): Promise<ArchitectResult> {
  return designSquad({ workspacePath, options });
}

/**
 * Modo Agêntico: o usuário descreve O QUE QUER; o arquiteto monta o time
 * para ESSE objetivo (workspace como contexto, não como fonte da missão).
 */
export async function designSquadFromIntent(
  intent: string,
  workspacePath: string,
  options: SquadDesignOptions = {},
): Promise<ArchitectResult> {
  assertSquadDesignAuthority(options);
  const clean = intent.trim();
  if (!clean) return { ok: false, error: 'descreva o objetivo da missão' };
  // O roster que o usuário salvou vem ANTES de qualquer síntese: um squad de
  // usuário com todos os clis instalados assume a missão como está (o wizard
  // deixa revisar na tela seguinte). Só sem candidato é que o fallback
  // determinístico monta um time novo.
  const installed = new Set(
    listAdapterInfos()
      .filter((adapter) => adapter.installed && adapter.id !== 'shell')
      .map((adapter) => adapter.id),
  );
  const saved = pickReusableSquad(listSquads(), installed);
  if (saved) {
    assertSquadDesignAuthority(options);
    return {
      ok: true,
      squad: saved,
      warning: `Reusando o squad salvo "${saved.name}" — edite o roster na próxima tela se quiser outro time.`,
    };
  }
  // Interactive UX must not wait for a remote model/Doctor. The deterministic
  // router already uses live installed adapters and mission capabilities; the
  // user can review/edit the roster on the next screen immediately.
  return deterministicSquadFallback(
    workspacePath,
    clean.slice(0, 4_000),
    'Time montado localmente',
    options,
  );
}

async function designSquad(opts: {
  workspacePath: string;
  intent?: string;
  options: SquadDesignOptions;
}): Promise<ArchitectResult> {
  const { workspacePath, intent, options } = opts;
  assertSquadDesignAuthority(options);
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
  assertSquadDesignAuthority(options);
  const profile =
    intentBlock +
    `CATÁLOGO RUNTIME DE CLIs/MODELOS (fonte de verdade):\n${installed || 'nenhuma'}\n\n` +
    (enriched ? `${enriched}\n\n` : '') +
    profileWorkspace(workspacePath);
  const doctor = getOrchSettings();
  const viaAutoChain = () => chatViaBrainChain(
      [
        { role: 'system', content: ARCHITECT_PROMPT },
        { role: 'user', content: `PERFIL DO PROJETO:\n\n${profile}` },
      ],
      2_000,
      undefined,
      options.signal,
    ).catch((err) => {
      throw new Error(err instanceof Error ? err.message : String(err));
    });
  let raw: string;
  if (doctor.doctorAdapterId === 'grok') {
    try {
      raw = await diagnoseWithDoctorGrok({
        cwd: workspacePath,
        system: ARCHITECT_PROMPT,
        user: `PERFIL DO PROJETO:\n\n${profile}`,
        jsonSchema: ARCHITECT_JSON_SCHEMA,
        model: doctor.doctorModel || undefined,
        effort: doctor.doctorEffort,
        signal: options.signal,
      });
      assertSquadDesignAuthority(options);
    } catch (grokError) {
      assertSquadDesignAuthority(options);
      console.warn(
        '[orch doctor] Grok indisponível; usando seleção automática:',
        grokError instanceof Error ? grokError.message : String(grokError),
      );
      raw = await viaAutoChain();
      assertSquadDesignAuthority(options);
    }
  } else {
    raw = await viaAutoChain();
    assertSquadDesignAuthority(options);
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return deterministicSquadFallback(
      workspacePath,
      intent,
      'o modelo não devolveu JSON',
      options,
    );
  }
  let parsed: {
    name?: string;
    orchestratorInstructions?: string;
    agents?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.warn('[orch] arquiteto devolveu JSON inválido:', raw.slice(-200));
    return deterministicSquadFallback(
      workspacePath,
      intent,
      'JSON inválido do modelo (resposta truncada?)',
      options,
    );
  }
  if (!parsed.name || !Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    return deterministicSquadFallback(
      workspacePath,
      intent,
      'squad gerado incompleto',
      options,
    );
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
  assertSquadDesignAuthority(options);
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
