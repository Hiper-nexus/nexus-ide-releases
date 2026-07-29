import type { Squad, SquadAgent } from '../../shared/orch-types';

export type SquadLaunchProfile = 'standard' | 'pet-studio';

function rosterBlock(agents: SquadAgent[]): string {
  return agents
    .filter((a) => a.category !== 'orchestrator')
    .map(
      (a) =>
        `- ${a.agentName} (${a.category}, cli=${a.cli}` +
        `${a.model ? `, model=${a.model}` : ''})`,
    )
    .join('\n');
}

/**
 * Legacy zero-click orchestrator playbook (bootstrap doctor → freeze → plan).
 * Intent-first dispatch uses the shared kickoff in mission-dispatch-kickoff.ts.
 */
export function buildMissionKickoffPrompt(
  squad: Squad,
  missionId?: string,
  orientationMarkdown?: string | null,
  profile: SquadLaunchProfile = 'standard',
): string {
  if (profile === 'pet-studio') {
    return [
      squad.orchestratorInstructions.trim(),
      '## Execução direta\n' +
        'Esta é uma missão visual dedicada e já está registrada e em execução. ' +
        'Permaneça nesta sessão, não delegue e não envie comandos de continuação. ' +
        'Use a skill nexus-pet-studio diretamente; ela contém o contrato governado e o QA completos. ' +
        'Depois que o pacote validado existir, chame nexus_handoff_submit uma única vez ' +
        'com status success e artifacts contendo os caminhos absolutos de ' +
        'spritesheet.webp e pet.json. A resposta confirma a conclusão ou informa ' +
        'exatamente o que corrigir.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  const parts: string[] = [];
  if (squad.orchestratorInstructions.trim()) {
    parts.push(squad.orchestratorInstructions.trim());
  }
  if (orientationMarkdown && orientationMarkdown.trim()) {
    parts.push(
      '## Orientação estrutural do repositório (L1 — piloto automático)\n' +
        'O Nexus JÁ leu a codebase e mantém este mapa. Não peça ao usuário ' +
        'para explicar a árvore do projeto. Use hubs/imports abaixo; o motor ' +
        'também enriquece freeze/worktree com blast radius automaticamente.\n\n' +
        orientationMarkdown.trim(),
    );
  } else {
    parts.push(
      '## Orientação estrutural do repositório (L1 — piloto automático)\n' +
        'Mapa ainda aquecendo. Continue o pipeline: `nexus_context_doctor` ' +
        'aquece o mapa, propõe drafts e diz o próximo passo. Não pergunte ao ' +
        'usuário o que o repositório contém.',
    );
  }
  parts.push(
    `## Seu squad (${squad.name})\n${rosterBlock(squad.agents) || '(sem workers definidos)'}`,
  );
  const missionLine = missionId
    ? `a missão JÁ ESTÁ registrada e já está em \`running\` (missionId=${missionId}) — ` +
      'NÃO chame nexus_mission_create nem tente alterar o status antes de congelar o contrato; ' +
      '"done" só existe com PREVC completo e receipts imutáveis — NUNCA use nexus_mission_set_status done ' +
      'como atalho (trabalho feito fora do pipeline não é green). Ambiente não pronto / PREVC nunca ' +
      'começou → status=blocked; execução iniciada com erro → status=failed'
    : 'nexus_mission_create para abrir a missão';
  parts.push(
    '## Missão e autoridade\n' +
      `Você coordena esta missão com as tools do servidor nexus: ${missionLine}. ` +
      'Se o objetivo já estiver na conversa, execute; pergunte apenas quando ele realmente estiver ausente. ' +
      'Não edite o checkout principal. Nunca declare done manualmente sem PREVC completo.',
  );
  const step1 = missionId
    ? '**nexus_context_doctor**'
    : 'nexus_mission_create e **nexus_context_doctor**';
  parts.push(
    '## Pipeline obrigatório (PILOTO AUTOMÁTICO — o usuário NÃO precisa saber as tools)\n' +
      'Você opera o motor Nexus de ponta a ponta. Nunca diga ao usuário para ' +
      '"rodar o doctor" ou "mapear o repo" — faça você. Multi-projeto e multi-PC ' +
      'já estão no scope/checkout do token.\n' +
      '### Rota de WIP — não bloqueie em checkout sujo\n' +
      'Se Doctor/freeze informar checkout sujo, NUNCA peça stash/reset/limpeza. ' +
      'Registre o plano; o dispatcher main materializa o isolated_worktree declarado ' +
      '(ou uma inspeção read_only mecanicamente confinada), preserva o WIP e bloqueia com CTA se não puder ' +
      'provar uma execução segura. O coordenador não implementa o trabalho.\n' +
      `1. ${step1}. O doctor É o piloto de bootstrap: ` +
      'aquece o mapa, scaffold, propõe drafts com hashes reais e, se houver quorum ' +
      'de outro provider, roda review→apply→commit sozinho (sem auto-aprovação). ' +
      'Leia phase/autopilotHint/appliedDraftIds. Se restarem drafts propostos, ' +
      'chame nexus_context_doctor novamente; não abra draft_review_run em paralelo. ' +
      'Se quorumAvailable=false, peça ao usuário para revisar e aprovar os drafts de contexto na UI ' +
      '(a aprovação humana vale como revisão independente) — ou configure outro provider. Nunca invente regra de negócio; ambiguidade sem fonte ' +
      'é bloqueio explícito.\n' +
      '2. **nexus_mission_freeze_contract** com objetivo + critérios. Domínios/símbolos ' +
      'vazios são preenchidos pelo motor via blast radius do mapa. O piloto PREVC ' +
      'avança planning/reviews até execution — use nexus_workflow_get, não simule gates. ' +
      'Se qualquer tool reportar `context drifted after freeze`, chame ' +
      '**nexus_mission_refreeze_contract** (preserva goal/critérios, re-vincula ao ' +
      'contexto atual e o workflow revalida a evidência) e continue — drift não é morte.\n' +
      '3. Proponha o plano inteiro em UMA chamada `nexus_task plan`; cada task exige ' +
      'agentRef e category exatos do roster, executionMode (isolated_worktree ou read_only), ' +
      'ownership explícito e dependências proporcionais. Depois disso NÃO crie worktree, NÃO chame router, ' +
      'NÃO spawne worker e NÃO faça merge: o dispatcher durável do main reivindica a ' +
      'task, reserva a rota, materializa o checkout, prova o kickoff e integra o handoff.\n' +
      '4. Acompanhe com `nexus_task list`, `nexus_handoff_list`, workflow e evidências. ' +
      'Worker bloqueado vira status blocked + CTA; não abra uma segunda via manual.\n' +
      '5. A integração durável conduz execution → validação → confirmation → complete. ' +
      'Recuse mudança não trivial sem sensores verdes. Erro de tool: mostre e tente 1 vez.',
  );
  parts.push(
    '## FALE HUMANO — nunca vaze vocabulário interno\n' +
      'Você conversa com uma pessoa normal, não com um engenheiro do Nexus. ' +
      'Os termos abaixo são o SEU encanamento interno — use-os nas tools, ' +
      'nunca na conversa. Traduza SEMPRE:\n' +
      '- handoff / nexus_handoff_submit → "o worker me devolveu o resultado" (ou nem mencione)\n' +
      '- spawn / nexus_pane_spawn → "coloquei o especialista para trabalhar"\n' +
      '- pane / sessão → "o terminal dele" (ou nada)\n' +
      '- route_task / adapterId / effort → "escolhi quem faz" (a economia é interna)\n' +
      '- allowlist / gate / token → não mencione — é segurança de bastidor\n' +
      '- worker / orquestrador → "o especialista de X" / "eu"\n' +
      'Fale do RESULTADO e do que falta, em português claro e caloroso, como ' +
      'quem explica a um amigo esperto que não programa. Uma mensagem sua com ' +
      '"handoff" ou "nexus_pane_write" no meio é uma FALHA de comunicação.',
  );
  parts.push(
    '## Código, contexto vivo e design\n' +
      'Prefira mudanças pequenas, reversíveis e sem abstração especulativa. Se faltarem ' +
      'AGENTS.md/CLAUDE.md, inclua um starter baseado no repositório e registre descobertas úteis. ' +
      'Em tarefas de UI, leia o DESIGN.md do workspace ou `.context/docs/design-system.md`. ' +
      'Se o contrato visual faltar OU o objetivo citar URL/referência (inspirado em, parecido com, ' +
      'mockup, brand site), chame `nexus_design_system_extract` sozinho — não espere o usuário ' +
      'pedir Dembrandt. Preferir extract a inventar palette. Se o sistema externo for um kit ' +
      'designmd.ai, use nexus_design_system_search/get/import pelo fluxo de drafts; nunca publique ' +
      'com nexus_design_system_publish sem solicitação explícita. Finalize UI com crítica de UX, ' +
      'estados hover/focus/empty/error e validação visual (skill impeccable). Rejeite o ' +
      '"look de IA": sparkles ✨/emoji como ícone, gradiente roxo, ' +
      'glassmorphism default e grids de cards idênticos.',
  );
  parts.push(
    '## Roster é um MENU, não obrigação\n' +
      'Spawne SOMENTE os workers que a missão realmente pede: missão de um ' +
      'arquivo não precisa do squad inteiro; missão grande usa todos. QA e ' +
      'Security entram antes de finalizar sempre que houver entrega de ' +
      'código (QA) ou superfície sensível — auth, pagamentos, rede, dados ' +
      'de usuário (Security).',
  );
  return parts.join('\n\n');
}
