import fs from "node:fs";
import path from "node:path";
import { chatViaBrainChain } from "../voice/jarvis-brain";
import {
  listSquads,
  normalizeEphemeralSquadCandidate,
} from "./squad-store";
import { pickReusableSquad } from "./squad-reuse";
import {
  enrichedBlockForArchitect,
  loadEnrichedCatalog,
} from "./harness-enrich";
import type { Squad } from "../../shared/orch-types";
import { diagnoseWithDoctorGrok } from "../runtime/doctor-diagnostic-engine";
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { orchestrationEvidenceOf } from "../../shared/adapter-types";
import { assessStandardSquadReadiness } from "./squad-runtime-policy";
import {
  liveSquadRuntimeInventory,
  warmSquadRuntimeSubscriptionAuth,
} from "./squad-runtime-inventory";
import { applyGuidedSquadSkillPolicy } from "./guided-squad-skills";

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
const ARCHITECT_PROMPT_BASE = `Você é um arquiteto de squads de agentes de IA no
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
- Inclua um UX/UI Designer (category reviewer, em uma CLI de worker elegível)
  sempre que o
  projeto tiver interface (web, mobile, desktop): ele critica hierarquia,
  acessibilidade, estados vazios e polish das entregas de UI, com mandato
  explícito de rejeitar o visual genérico de IA (sparkles, gradiente roxo,
  glassmorphism, card grids idênticos) e usar a skill impeccable quando
  disponível.
- NÃO inclua o orquestrador na lista (ele é adicionado automaticamente).
- Atribua executor, reviewer, scout e architect SOMENTE a linhas marcadas
  "worker guided: qualificado" no perfil runtime. Se houver uma única CLI
  qualificada, todos os workers podem e devem usar essa CLI.
- Use somente CLI/modelo/effort declarados no perfil runtime; não invente nem
  use catálogos memorizados. Prefira effort econômico em trabalho mecânico e o
  maior effort realmente disponível em revisão/arquitetura crítica.
- Quando a missão exigir GERAR ou EDITAR imagem, spritesheet, avatar ou desktop
  pet, escolha um executor worker guided. O main concede a ele a skill
  nexus-visual-media e exatamente as tools nexus_media_providers e
  nexus_image_generate. Não prometa imagegen/hatch-pet, geração nativa da CLI
  ou API key ambiente: esses caminhos não pertencem à autoridade da missão.
  Nunca atribua geração visual a um agente sem a ferramenta de mídia Nexus
  explicitamente declarada no arsenal.
- Desktop pet v2 NÃO é uma imagem única: é um pipeline 8x11 com 9 estados de
  animação (idle, running-right, running-left, waving, jumping, failed,
  waiting, running, review), 16 direções de olhar e até 13 trabalhos visuais.
  O executor visual líder deve usar nexus-visual-media, criar uma base canônica
  e aterrar TODAS as linhas nela. Outro gerador é apenas fallback de linha
  completa, nunca fonte de células avulsas misturadas. Exija validação
  determinística, contact sheet, motion preview e spriteVersionNumber 2.
- Instruções: cite a stack e os diretórios REAIS do perfil, e SEMPRE inclua
  os comandos reais de build/test/lint do projeto (extraia dos manifests,
  ex.: scripts do package.json, Makefile, rake, go test ./...) — são os
  gates que o orquestrador vai cobrar em cada handoff.`;

function architectPrompt(operatorChoice: boolean): string {
  const policy = operatorChoice
    ? `POLÍTICA AUTOPILOTO:
- Use qualquer linha "worker guided: qualificado": ela já representa CLI
  instalada, autenticada e capaz de devolver handoff pelo Nexus.
- Preserve as CLIs escolhidas pelo operador; não substitua uma marca por Codex.
- Pode haver no máximo UM processo Claude na missão inteira. Se Claude for o
  Maestro, não o atribua a worker; se outro CLI for Maestro, atribua Claude a
  no máximo um worker.`
    : `POLÍTICA HARDENED:
- Claude é reservado ao Maestro: nunca o atribua a executor, reviewer, scout
  ou architect.
- A lista instalada não basta. Use somente workers marcados "worker guided:
  qualificado". Painel, terminal, handoff ou
  rota experimental não substituem confinamento autônomo.`;
  return `${ARCHITECT_PROMPT_BASE}\n\n${policy}`;
}

const ARCHITECT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    orchestratorInstructions: { type: "string" },
    agents: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          agentName: { type: "string" },
          category: {
            type: "string",
            enum: ["executor", "reviewer", "scout", "architect"],
          },
          cli: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
        },
        required: ["id", "agentName", "category", "cli", "model"],
      },
    },
  },
  required: ["name", "orchestratorInstructions", "agents"],
} as const;

function readSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").slice(0, MAX_FILE_CHARS);
  } catch {
    return "";
  }
}

/** Perfil compacto do projeto: manifests + árvore de 1º nível. */
function profileWorkspace(root: string): string {
  const parts: string[] = [`# raiz: ${path.basename(root)}`];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).slice(0, 60);
    parts.push(
      "## estrutura (1º nível)\n" +
        entries
          .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
          .join("\n"),
    );
  } catch {
    // sem leitura da raiz — segue só com manifests
  }
  const manifests = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "Gemfile",
    "pom.xml",
    "README.md",
  ];
  for (const m of manifests) {
    const content = readSafe(path.join(root, m));
    if (content) parts.push(`## ${m}\n${content}`);
  }
  return parts.join("\n\n").slice(0, 16_000);
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
  /**
   * Opt-in: reuse the newest fully-installed saved user squad instead of
   * designing a fresh team. OFF by default — Modo Agêntico means "design a
   * team for this objective from scratch", so silently substituting a saved
   * squad (e.g. an unrelated project's roster) violated that intent. Users who
   * want a saved squad pick it explicitly in Modo Squad.
   */
  readonly preferSavedSquad?: boolean;
}

function assertSquadDesignAuthority(options: SquadDesignOptions): void {
  options.assertCurrentAuthority?.();
  if (!options.signal?.aborted) return;
  if (options.signal.reason instanceof Error) throw options.signal.reason;
  throw new Error("squad design authority was revoked");
}

function noMaestroError(operatorChoice: boolean): string {
  return operatorChoice
    ? "Nenhuma CLI autenticada com lançamento, prompt, observação de status e handoff está pronta para atuar como Maestro. Confira Configurações › Providers."
    : "Nenhum Maestro com orquestração verificada está pronto. Instale, ative ou autentique Claude Code ou Codex e confira Configurações › Providers. Integrações experimentais só podem ser escolhidas manualmente na revisão.";
}

function deterministicSquadFallback(
  workspacePath: string,
  intent: string | undefined,
  reason: string,
  options: SquadDesignOptions = {},
  recoveredFromFailure = true,
): ArchitectResult {
  assertSquadDesignAuthority(options);
  const inventory = liveSquadRuntimeInventory();
  const { adapters, workerAdapters, orchestratorAdapters } = inventory;
  const settings = getOrchSettings();
  const operatorChoice = isOperatorChoicePolicy(settings.squadCliPolicy);
  if (adapters.length === 0) {
    return {
      ok: false,
      error:
        `${reason}; nenhuma CLI está pronta para execução autônoma. ` +
        "Confira instalação, provider habilitado, autenticação e contas disponíveis.",
    };
  }
  if (orchestratorAdapters.length === 0) {
    return { ok: false, error: `${reason}; ${noMaestroError(operatorChoice)}` };
  }
  const orchestrator =
    orchestratorAdapters.find(
      (adapter) => adapter.id === settings.defaultAdapterId,
    ) ?? orchestratorAdapters[0]!;
  const eligibleWorkerAdapters = workerAdapters.filter(
    (adapter) => !(adapter.id === "claude" && orchestrator.id === "claude"),
  );
  if (eligibleWorkerAdapters.length === 0) {
    return {
      ok: false,
      error:
        `${reason}; nenhuma CLI de worker está pronta. ` +
        (operatorChoice
          ? "Autopiloto requer ao menos uma rota autenticada com handoff; a única sessão Claude não pode ser duplicada."
          : "Claude permanece reservado ao Maestro. Nesta versão, o guided automático exige Codex autenticado com escrita autônoma confinada. Kimi, OpenCode, Grok e AGY continuam disponíveis somente em painéis, terminais ou fluxos manuais/experimentais conforme a capability declarada."),
    };
  }
  const pick = (index: number) =>
    eligibleWorkerAdapters[index % eligibleWorkerAdapters.length]!;
  let hasClaudeWorker = false;
  const worker = (
    id: string,
    agentName: string,
    category: "executor" | "reviewer" | "scout" | "architect",
    index: number,
    preferredAdapterId?: string,
  ) => {
    const preferred = eligibleWorkerAdapters.find(
      (item) => item.id === preferredAdapterId,
    );
    let adapter = preferred ?? pick(index);
    if (adapter.id === "claude" && hasClaudeWorker) {
      adapter =
        eligibleWorkerAdapters.find((item) => item.id !== "claude") ??
        adapter;
    }
    if (adapter.id === "claude") hasClaudeWorker = true;
    return {
      id,
      agentName,
      category,
      cli: adapter.id,
      model: adapter.models.default || adapter.models.list[0],
    };
  };
  const objective =
    intent?.trim() || `Manter e evoluir ${path.basename(workspacePath)}`;
  const visual =
    /\b(ui|ux|visual|interface|desktop|pet|site|landing|web|mobile|react|electron)\b/i.test(
      objective,
    );
  const imageGeneration =
    /\b(pet|imagem|image|sprite|spritesheet|avatar|ilustra|gerar\s+(?:uma\s+)?(?:foto|arte))\b/i.test(
      objective,
    );
  const visualExecutor = imageGeneration
    ? eligibleWorkerAdapters[0]?.id
    : undefined;
  const agents = [
    worker(
      "executor",
      imageGeneration ? "Executor visual" : "Executor principal",
      "executor",
      0,
      visualExecutor,
    ),
    worker("qa", "QA de execução", "reviewer", 1),
    worker("reviewer", "Revisor sênior", "reviewer", 2),
    ...(visual ? [worker("ux", "UX e validação visual", "reviewer", 3)] : []),
  ];
  const candidate = {
    id: `agentic-fallback-${Date.now()}`,
    name: visual ? "Execução + QA Visual" : "Execução + QA",
    createdAt: String(Date.now()),
    builtin: false,
    orchestratorInstructions: [
      `# Missão\n${objective}`,
      "Inspecione os manifests e use os comandos reais de build, lint e teste do workspace.",
      "Delegue execução e revisão em paralelo quando os escopos não se sobrepuserem.",
      "Não declare conclusão sem evidência local dos testes e pós-condições da entrega.",
      visual
        ? "A entrega visual exige QA da imagem/interface, estados completos e comparação com a referência anexada."
        : "",
      imageGeneration
        ? `A geração do asset visual deve ser liderada por ${visualExecutor} com a skill nexus-visual-media e somente as tools Nexus autorizadas. Para pet v2, trate como pipeline 8x11: base canônica, 9 linhas de animação, 16 direções, até 13 jobs visuais, QA incremental, contact sheet e motion preview. Nunca use imagegen/hatch-pet, API key ambiente ou geração nativa fora da autoridade da missão. Nunca misture células avulsas de geradores diferentes.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    agents: [
      {
        id: "orch",
        agentName: "Maestro",
        category: "orchestrator",
        cli: orchestrator.id,
        model: orchestrator.models.default || orchestrator.models.list[0],
      },
      ...agents,
    ],
  };
  const readiness = assessStandardSquadReadiness(
    candidate.agents,
    inventory.policy,
    inventory.verifiedOrchestratorCliIds,
    operatorChoice,
  );
  if (!readiness.ok) {
    return {
      ok: false,
      error: `${reason}; fallback sem capacidade standard: ${readiness.detail}`,
    };
  }
  // Designing is read-only. The returned candidate remains main-owned and
  // ephemeral until either launch creates a hidden runtime snapshot or the
  // operator explicitly chooses "Salvar configuração".
  assertSquadDesignAuthority(options);
  try {
    const squad = applyGuidedSquadSkillPolicy(
      normalizeEphemeralSquadCandidate(candidate),
      { objective },
    );
    if (recoveredFromFailure) {
      console.warn(
        `[orch doctor] ${reason}; squad determinístico criado: ${squad.name}`,
      );
    }
    return {
      ok: true,
      squad,
      ...(recoveredFromFailure
        ? {
            warning: `${reason}. O Doctor montou um time determinístico com o catálogo local.`,
          }
        : {}),
    };
  } catch (cause) {
    return {
      ok: false,
      error: `${reason}; fallback inválido: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** Analisa o workspace e devolve um candidato de squad ainda não persistido. */
export async function designSquadForWorkspace(
  workspacePath: string,
  options: SquadDesignOptions = {},
): Promise<ArchitectResult> {
  // The sync inventory below reads only the warm subscription cache; warm the
  // keychain-only providers (AGY) first so a live session is not read as
  // login-needed and wrongly excluded from the designed roster.
  await warmSquadRuntimeSubscriptionAuth();
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
  // Same cold-keychain hazard as designSquadForWorkspace: warm before the
  // sync liveSquadRuntimeInventory reads below.
  await warmSquadRuntimeSubscriptionAuth();
  const clean = intent.trim();
  if (!clean) return { ok: false, error: "descreva o objetivo da missão" };
  // Reuso de um squad salvo é OPT-IN. Modo Agêntico = "desenhe um time novo
  // para este objetivo do zero"; substituir isso silenciosamente pelo squad de
  // usuário mais recente (ex.: o roster de OUTRO projeto que por acaso tem
  // todos os clis instalados) atropelava exatamente esse pedido. Quem quer um
  // squad salvo escolhe no Modo Squad. Só reusa quando o chamador pede.
  if (options.preferSavedSquad) {
    const inventory = liveSquadRuntimeInventory();
    const saved = pickReusableSquad(
      listSquads(),
      inventory.policy,
      inventory.verifiedOrchestratorCliIds,
      isOperatorChoicePolicy(getOrchSettings().squadCliPolicy),
    );
    if (saved) {
      assertSquadDesignAuthority(options);
      return {
        ok: true,
        squad: saved,
        warning: `Reusando o squad salvo "${saved.name}" — edite o roster na próxima tela se quiser outro time.`,
      };
    }
  }
  // Interactive UX must not wait for a remote model/Doctor. The deterministic
  // router already uses live installed adapters and mission capabilities; the
  // user can review/edit the roster on the next screen immediately.
  return deterministicSquadFallback(
    workspacePath,
    clean.slice(0, 4_000),
    "Time montado localmente",
    options,
    false,
  );
}

async function designSquad(opts: {
  workspacePath: string;
  intent?: string;
  options: SquadDesignOptions;
}): Promise<ArchitectResult> {
  const { workspacePath, intent, options } = opts;
  assertSquadDesignAuthority(options);
  const inventory = liveSquadRuntimeInventory();
  const { adapters, workerAdapters, orchestratorAdapters } = inventory;
  const settings = getOrchSettings();
  const operatorChoice = isOperatorChoicePolicy(settings.squadCliPolicy);
  if (orchestratorAdapters.length === 0) {
    return { ok: false, error: noMaestroError(operatorChoice) };
  }
  const guidedWorkerIds = new Set(workerAdapters.map((adapter) => adapter.id));
  const runtimeCatalog = adapters
    .map(
      (adapter) =>
        `${adapter.id} [models: ${adapter.models.list.join(", ") || adapter.models.default}; ` +
        `orquestração: ${orchestrationEvidenceOf(adapter)}; ` +
        `worker guided: ${guidedWorkerIds.has(adapter.id) ? "qualificado" : "não qualificado (somente painel/terminal/manual)"}]`,
    )
    .join("\n");
  const intentBlock = intent
    ? `OBJETIVO DO USUÁRIO (a missão deste squad — desenhe o time PARA isto):\n` +
      `"""${intent}"""\n\n` +
      `Regra extra: as orchestratorInstructions DEVEM abrir declarando este ` +
      `objetivo como a missão, e o primeiro passo do orquestrador é decompô-lo ` +
      `e delegar — sem re-perguntar o que fazer.\n\n`
    : "";
  // Arsenal enriquecido (harness-enrich): o arquiteto cita agents/skills
  // REAIS instalados em vez de inventar papéis genéricos.
  const enriched = enrichedBlockForArchitect(loadEnrichedCatalog(), 4_000);
  assertSquadDesignAuthority(options);
  const profile =
    intentBlock +
    `CATÁLOGO RUNTIME DE CLIs/MODELOS (fonte de verdade):\n${runtimeCatalog || "nenhuma"}\n\n` +
    (enriched ? `${enriched}\n\n` : "") +
    profileWorkspace(workspacePath);
  const doctor = getOrchSettings();
  const systemPrompt = architectPrompt(operatorChoice);
  const viaAutoChain = () =>
    chatViaBrainChain(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `PERFIL DO PROJETO:\n\n${profile}` },
      ],
      2_000,
      undefined,
      options.signal,
    ).catch((err) => {
      throw new Error(err instanceof Error ? err.message : String(err));
    });
  let raw: string;
  if (doctor.doctorAdapterId === "grok") {
    try {
      raw = await diagnoseWithDoctorGrok({
        cwd: workspacePath,
        system: systemPrompt,
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
        "[orch doctor] Grok indisponível; usando seleção automática:",
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
      "o modelo não devolveu JSON",
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
    console.warn("[orch] arquiteto devolveu JSON inválido:", raw.slice(-200));
    return deterministicSquadFallback(
      workspacePath,
      intent,
      "JSON inválido do modelo (resposta truncada?)",
      options,
    );
  }
  if (
    !parsed.name ||
    !Array.isArray(parsed.agents) ||
    parsed.agents.length === 0
  ) {
    return deterministicSquadFallback(
      workspacePath,
      intent,
      "squad gerado incompleto",
      options,
    );
  }

  const workspaceName = path.basename(workspacePath);
  const orchestrator =
    orchestratorAdapters.find(
      (adapter) => adapter.id === settings.defaultAdapterId,
    ) ?? orchestratorAdapters[0]!;
  // Intent mode ganha id próprio (por nome gerado) — dois squads agênticos no
  // mesmo workspace não podem colidir no id `custom-<workspace>`.
  const idBase = intent
    ? `agentic-${parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now() % 100_000}`
    : `custom-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const candidate = {
    id: idBase.slice(0, 64),
    name: parsed.name.slice(0, 80),
    createdAt: String(Date.now()),
    builtin: false,
    orchestratorInstructions: (parsed.orchestratorInstructions ?? "").slice(
      0,
      20_000,
    ),
    agents: [
      {
        id: "orch",
        agentName: "Maestro",
        category: "orchestrator",
        cli: orchestrator.id,
        model: orchestrator.models.default || orchestrator.models.list[0],
        effort: "high",
      },
      ...parsed.agents.slice(0, 6),
    ],
  };
  const readiness = assessStandardSquadReadiness(
    candidate.agents,
    inventory.policy,
    inventory.verifiedOrchestratorCliIds,
    operatorChoice,
  );
  if (!readiness.ok) {
    return deterministicSquadFallback(
      workspacePath,
      intent,
      `squad gerado sem capacidade standard: ${readiness.detail}`,
      options,
    );
  }
  assertSquadDesignAuthority(options);
  try {
    // Apply the same canonical allowlist normalization as global persistence,
    // but keep the candidate out of SQLite/the reusable catalog.
    const squad = applyGuidedSquadSkillPolicy(
      normalizeEphemeralSquadCandidate(candidate),
      {
        objective:
          intent ??
          `${parsed.name}\n${parsed.orchestratorInstructions ?? ""}`,
      },
    );
    console.log(
      `[orch] candidato de squad criado: ${squad.name} (${squad.agents.length} agentes)`,
    );
    return { ok: true, squad };
  } catch (err) {
    return {
      ok: false,
      error: `squad inválido: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
