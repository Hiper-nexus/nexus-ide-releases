import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('./styles/base.css', import.meta.url), 'utf8');

describe('renderer boot weight', () => {
  it('keeps the launcher screen eager and defers panels that open later', () => {
    expect(appSource).toContain("import { MissionSetup } from './components/mission/MissionSetup'");
    expect(appSource).not.toContain("import { MissionBoard }");
    expect(appSource).not.toContain("import { SettingsWorkspace }");
    expect(appSource).not.toContain("import { FirstRunWizard }");
    for (const panel of [
      'SettingsWorkspace',
      'MediaStudioPanel',
      'OperatorProfile',
      'MemoryWorkspace',
      'TaskBoardWorkspace',
      'MissionBoard',
      'ProjectOverviewConnected',
      'VoiceSettings',
      'BugReportDialog',
      'KeyboardCheatsheet',
      'FanoutComparePanel',
      'FirstRunWizard',
    ]) {
      expect(appSource, panel).toContain(`const ${panel} = lazy(`);
    }
    expect(appSource).toContain('requestIdleCallback');
    expect(appSource).toContain('prefetchDeferredPanels(wizardHydrated && wizardOpen)');
    expect(appSource).toContain('{wizardOpen ? (');
    expect(appSource).toContain('<Suspense fallback={<div className="product-workspace"');
  });

  it('preloads only the first-paint faces, as woff2', () => {
    expect(html).toContain('VT323-Regular.woff2');
    expect(html).toContain('Inter.var.woff2');
    expect(html).not.toContain('JetBrainsMono');
    expect(html).not.toContain('.ttf');
    expect(baseCss).toContain("url('./fonts/Inter.var.woff2') format('woff2')");
    expect(baseCss).toContain("url('./fonts/VT323-Regular.woff2') format('woff2')");
    expect(baseCss).toContain("url('./fonts/JetBrainsMono.var.woff2') format('woff2')");
    expect(baseCss).toContain('font-display: swap');
    expect(baseCss).not.toContain('.ttf');
  });
});
