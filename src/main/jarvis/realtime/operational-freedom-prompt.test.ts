/**
 * O contrato de liberdade operacional da Jarvis vive em texto (prompt do
 * sistema + descrição da tool nexus_action). Estes testes travam o que o modelo
 * precisa ler para operar o Nexus sem pedir permissão a cada passo — e o que
 * NÃO pode voltar ("NEVER writes to a terminal").
 */
import { describe, expect, it } from 'vitest';
import { geminiInstructions, loadJarvisSystemPrompt } from './factory';
import { createNexusRealtimeTools } from './nexus-realtime-tools';

const OPERATIONAL_MARKERS = [
  'nexus_pane_list',
  'nexus_pane_read',
  'send_to_pane',
  'nexus_mission_',
  'nexus_browser_',
  'native confirmation',
];

describe('prompt do sistema — liberdade operacional', () => {
  it('o prompt empacotado manda agir sem pedir permissão e nomeia as ferramentas', () => {
    const prompt = loadJarvisSystemPrompt();

    expect(prompt).toContain('Operational freedom');
    expect(prompt).toContain('hands-free');
    for (const marker of OPERATIONAL_MARKERS) expect(prompt).toContain(marker);
    // Endereçamento por número do pane e terminal como alvo.
    expect(prompt).toContain('"pane 2"');
    expect(prompt).toContain('terminal (shell) pane');
  });

  it('o prompt de reserva (arquivo ilegível) carrega o mesmo contrato', () => {
    const prompt = loadJarvisSystemPrompt('/caminho/que/nao/existe/system.md');

    expect(prompt).toContain('Operational freedom');
    for (const marker of OPERATIONAL_MARKERS) expect(prompt).toContain(marker);
  });

  it('o Gemini recebe o contrato no adendo das tools grossas', () => {
    const prompt = geminiInstructions('base');

    expect(prompt).toContain('Operational freedom');
    expect(prompt).toContain('nexus_pane_read');
    expect(prompt).toContain('hands-free');
    expect(prompt).toContain('native confirmation');
  });

  it('não promete ao modelo uma tool que a lane da Jarvis barra sem missão', () => {
    // terminal_run / bg_run exigem autoridade de missão no despachante; o
    // caminho do comando é run_command ou send_to_pane com alvo terminal.
    const [tool] = createNexusRealtimeTools();
    for (const text of [
      loadJarvisSystemPrompt(),
      loadJarvisSystemPrompt('/nao/existe'),
      geminiInstructions('base'),
      tool.description,
    ]) {
      expect(text).not.toContain('nexus_terminal_run');
      expect(text).not.toContain('nexus_bg_run');
    }
  });

  it('mantém as travas que não podem afrouxar', () => {
    for (const prompt of [loadJarvisSystemPrompt(), loadJarvisSystemPrompt('/nao/existe')]) {
      expect(prompt).toContain('Do not claim an action was performed');
      expect(prompt).toMatch(/never bypass|do not bypass/i);
    }
  });
});

describe('descrição da tool nexus_action — liberdade operacional', () => {
  const [tool] = createNexusRealtimeTools();
  const props = (tool.parameters as {
    properties: Record<string, { description?: string }>;
  }).properties;

  it('diz que send_to_pane escreve em qualquer pane (agente ou terminal)', () => {
    expect(tool.description).toContain('operational freedom');
    expect(tool.description).toContain('terminal (shell) pane');
    expect(tool.description).toContain('exactly that pane');
    expect(tool.description).not.toContain('NEVER writes to a terminal');
    expect(tool.description).not.toContain('ONLY for delegating');
  });

  it('lista as tools operacionais e o que continua confirmando', () => {
    for (const marker of OPERATIONAL_MARKERS) expect(tool.description).toContain(marker);
    expect(tool.description).toContain('pull request creation or merge');
    expect(tool.description).toContain('catalog installs');
  });

  it('mantém a regra de não usar nexus_git_* para o sync diário', () => {
    expect(tool.description).toContain('NEVER use mcp_tool nexus_git_*');
    expect(tool.description).toContain('sync_repo_via_pane');
  });

  it('paneId aceita número e recusa número desconhecido; text distingue agente e terminal', () => {
    expect(props.paneId.description).toContain('pane number');
    expect(props.paneId.description).toContain('never redirected');
    expect(props.text.description).toContain('terminal (shell) pane');
    expect(props.text.description).toContain('single-line shell command');
    // O texto para agente continua exigindo o briefing estruturado.
    expect(props.text.description).toContain('Objective');
    expect(props.text.description).toContain('Acceptance criteria');
  });
});
