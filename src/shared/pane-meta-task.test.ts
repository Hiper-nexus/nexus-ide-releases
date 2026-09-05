import { describe, expect, it } from 'vitest';
import { extractMetaPaneQuestion, isPaneMetaTask } from './pane-meta-task';

describe('explicit questions to mission panes', () => {
  it.each([
    ['pergunte aos panes quanto é 1+1', 'quanto é 1+1'],
    ['How much is 2x2 and they have to answer you.', 'How much is 2x2'],
    ['ask the agents: what is 3+3?', 'what is 3+3?'],
  ])('keeps the addressed question in %s', (objective, question) => {
    expect(isPaneMetaTask(objective)).toBe(true);
    expect(extractMetaPaneQuestion(objective)).toBe(question);
  });

  it('does not classify a terminal UI change as a question to workers', () => {
    expect(isPaneMetaTask('corrija o botão de fechar o pane')).toBe(false);
  });

  it.each([
    'Build a UI that lets the user ask agents questions.',
    'Please create a quiz where they have to answer questions.',
    'Crie uma tela onde o usuário pergunte aos panes sobre o projeto.',
  ])('keeps implementation as work: %s', (objective) => {
    expect(isPaneMetaTask(objective)).toBe(false);
  });

  it('recognizes a direct polite request addressed to agents', () => {
    expect(isPaneMetaTask('Please ask the agents what is 2+2?')).toBe(true);
  });
});
