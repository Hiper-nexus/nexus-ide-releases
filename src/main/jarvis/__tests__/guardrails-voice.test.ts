import { describe, expect, it } from 'vitest';
import { requiresVoiceCommandConfirmation } from '../guardrails';

describe('Jarvis voice command confirmation boundary', () => {
  it.each([
    'npm test',
    'npm run typecheck',
    'rg -n "mission" src',
    'git status --short',
    'git diff --check',
  ])('auto-approves routine local work: %s', (command) => {
    expect(requiresVoiceCommandConfirmation(command)).toBe(false);
  });

  it.each([
    'rm -rf build',
    'git reset --hard HEAD~1',
    'git push origin main',
    'npm run deploy',
    'gh release create v1.0.0',
    'ssh production.example.com',
  ])('requires confirmation for destructive or external work: %s', (command) => {
    expect(requiresVoiceCommandConfirmation(command)).toBe(true);
  });
});
