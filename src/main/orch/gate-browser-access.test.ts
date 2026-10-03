import { describe, expect, it } from 'vitest';
import { isToolAllowedForRole } from './gate';
import { NEXUS_BROWSER_WORKER_TOOLS } from './nexus-browser-policy';

describe('worker browser and desktop tool allowlists', () => {
  it.each([
    'nexus_browser_open', 'nexus_browser_navigate', 'nexus_browser_read',
    'nexus_browser_screenshot', 'nexus_browser_click', 'nexus_browser_fill',
    'nexus_browser_press', 'nexus_browser_scroll', 'nexus_browser_hover',
    'nexus_browser_responsive', 'nexus_browser_do', 'nexus_computer_do',
  ])('allows %s without a role-only restriction, retaining the token allowlist', (tool) => {
    expect(isToolAllowedForRole('worker', null, tool)).toBe(true);
    expect(isToolAllowedForRole('worker', [tool], tool)).toBe(true);
    expect(isToolAllowedForRole('worker', [], tool)).toBe(false);
    expect(isToolAllowedForRole('worker', ['nexus_file_read'], tool)).toBe(false);
  });
});

describe('F-797: a allowlist padrão do worker libera só leitura e extração de página', () => {
  const defaults = [...NEXUS_BROWSER_WORKER_TOOLS];
  it.each([...NEXUS_BROWSER_WORKER_TOOLS])('%s passa pelo gate do worker', (tool) => {
    expect(isToolAllowedForRole('worker', defaults, tool)).toBe(true);
  });
  it.each([
    'nexus_browser_click', 'nexus_browser_fill', 'nexus_browser_press', 'nexus_browser_scroll',
    'nexus_browser_hover', 'nexus_browser_responsive', 'nexus_browser_do', 'nexus_computer_do',
    'nexus_terminal_run', 'nexus_file_write', 'nexus_git_push',
  ])('%s continua fora do alcance do worker padrão', (tool) => {
    expect(isToolAllowedForRole('worker', defaults, tool)).toBe(false);
  });
});
