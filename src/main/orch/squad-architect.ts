import fs from 'node:fs';
import path from 'node:path';
import { chatOnce, defaultBrainDeps } from '../voice/jarvis-brain';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { saveSquad } from './squad-store';
import type { Squad } from '../../shared/orch-types';

/**
 * Squad Architect — lê o workspace (stack, estrutura, README) e GERA um squad
 * sob medida: papéis certos para o projeto, instruções de orquestração
 * específicas e CLIs/modelos adequados. Cada projeto pede um time diferente;
 * este módulo monta o time.
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
     "cli": "claude", "effort": "low|medium|high"}
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
  acessibilidade, estados vazios e polish das entregas de UI.
- NÃO inclua o orquestrador na lista (ele é adicionado automaticamente).
- DISTRIBUA os workers entre as CLIs INSTALADAS listadas no perfil (custo e
  diversidade): executores em CLIs rápidas/baratas; reviewer/architect nas
  mais capazes. Nunca coloque todos na mesma CLI.
- effort baixo para tarefas mecânicas, high para revisão/arquitetura.
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
  const installed = listAdapterInfos()
    .filter((a) => a.installed && a.id !== 'shell')
    .map((a) => a.id)
    .join(', ');
  const profile =
    `CLIs instaladas nesta máquina: ${installed || 'claude'}\n\n` +
    profileWorkspace(workspacePath);
  const raw = await (async () => {
    const groq = defaultBrainDeps.getKey('GROQ_API_KEY');
    const openai = defaultBrainDeps.getKey('OPENAI_API_KEY');
    const messages = [
      { role: 'system', content: ARCHITECT_PROMPT },
      { role: 'user', content: `PERFIL DO PROJETO:\n\n${profile}` },
    ];
    // Qualidade primeiro aqui (não é tempo-real): OpenAI → Groq.
    if (openai) {
      try {
        return await chatOnce(
          'https://api.openai.com/v1/chat/completions',
          openai,
          'gpt-4o-mini',
          messages,
          defaultBrainDeps,
          true,
        );
      } catch {
        // cai para o Groq
      }
    }
    if (groq) {
      return chatOnce(
        'https://api.groq.com/openai/v1/chat/completions',
        groq,
        'llama-3.3-70b-versatile',
        messages,
        defaultBrainDeps,
        true,
      );
    }
    throw new Error('nenhuma key de modelo (OPENAI_API_KEY ou GROQ_API_KEY)');
  })().catch((err) => {
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
    return { ok: false, error: 'JSON inválido do modelo' };
  }
  if (!parsed.name || !Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    return { ok: false, error: 'squad gerado incompleto' };
  }

  const workspaceName = path.basename(workspacePath);
  const candidate = {
    id: `custom-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64),
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
