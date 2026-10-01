/** The model tour: eighteen totems around Pink City, one per CLI the NexusIDE runs.
 * Pure data and pure visit bookkeeping — the scene owns the meshes, the HUD owns the copy.
 * Icons live in /providers/ (see NOTICE.md); brand colours are the accent each mark already uses. */
export const TOUR_SIZE = 18;

export const MODELS = [
  { id: 'claude', name: 'Claude', icon: 'claude.svg', color: 0xd97757, blurb: 'Planeja e revisa com contexto longo.' },
  { id: 'codex', name: 'Codex', icon: 'codex.svg', color: 0x10a37f, blurb: 'Executa tarefas e escreve os testes.' },
  { id: 'gemini', name: 'Gemini', icon: 'gemini-color.svg', color: 0x4285f4, blurb: 'Multimodal, bom para ler telas e docs.' },
  { id: 'kimi', name: 'Kimi', icon: 'kimi.svg', color: 0x16a3a3, blurb: 'Janelas longas para repositórios inteiros.' },
  { id: 'deepseek', name: 'DeepSeek', icon: 'deepseek-color.svg', color: 0x4d6bfe, blurb: 'Raciocínio barato via API.' },
  { id: 'grok', name: 'Grok', icon: 'grok.svg', color: 0xe8e8e8, blurb: 'Respostas rápidas com acesso à rede.' },
  { id: 'glm', name: 'GLM', icon: 'glm.svg', color: 0x2b5cff, blurb: 'Agente de código da z.ai.' },
  { id: 'qwen', name: 'Qwen', icon: 'qwen-color.svg', color: 0x615ced, blurb: 'Modelo da Alibaba por API.' },
  { id: 'minimax-code', name: 'MiniMax Code', icon: 'minimax-code.svg', color: 0xff6a3d, blurb: 'CLI focada em construção.' },
  { id: 'mimo-code', name: 'MiMo Code', icon: 'mimo-code.png', color: 0xff6900, blurb: 'Agente da Xiaomi no cockpit.' },
  { id: 'longcat', name: 'LongCat', icon: 'longcat.svg', color: 0xffc300, blurb: 'Agente da Meituan.' },
  { id: 'devin', name: 'Devin CLI', icon: 'devin.svg', color: 0x16232e, blurb: 'Sessões autônomas de longa duração.' },
  { id: 'aider', name: 'Aider', icon: 'aider.png', color: 0x22c55e, blurb: 'Par de programação no terminal.' },
  { id: 'cursor-agent', name: 'Cursor Agent', icon: 'cursor-agent.svg', color: 0x7c3aed, blurb: 'Agente do Cursor em modo CLI.' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode.svg', color: 0xe5e5e5, blurb: 'CLI aberta e leve.' },
  { id: 'openclaude', name: 'OpenClaude', icon: 'openclaude.svg', color: 0xd97757, blurb: 'Cliente comunitário do Claude.' },
  { id: 'muse', name: 'Muse Code', icon: 'muse.svg', color: 0x8b5cf6, blurb: 'Fluxo criativo da Muse Spark.' },
  { id: 'agy', name: 'Antigravity', icon: 'agy.svg', color: 0x34a853, blurb: 'Agente do Google Gemini.' },
];

export const TOUR_AWARD = 50;

export function initialTour() {
  return { visited: [] };
}

/** Marks one totem as visited. Returns the same array identity when nothing changed. */
export function visitTotem(tour, id) {
  if (tour.visited.includes(id) || !MODELS.some(model => model.id === id)) return tour;
  return { visited: [...tour.visited, id] };
}

export function tourProgress(tour) {
  const count = tour.visited.length;
  return {
    count,
    total: TOUR_SIZE,
    complete: count >= TOUR_SIZE,
    label: `${count}/${TOUR_SIZE}`,
  };
}

/** The one-line HUD blurb for the totem just lit. */
export function modelBlurb(id) {
  return MODELS.find(model => model.id === id)?.blurb ?? '';
}

export function modelName(id) {
  return MODELS.find(model => model.id === id)?.name ?? id;
}
