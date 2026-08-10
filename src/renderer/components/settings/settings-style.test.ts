/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computedCssValue,
  installStyleContract,
  markFocusVisible,
  styleLengthPx,
} from '../style-contract.test-utils';

const rendererStylesPath = path.resolve(
  process.cwd(),
  'src/renderer/styles',
);
const settingsCss = ['settings.css', 'settings-controls.css']
  .map((file) =>
    fs.readFileSync(path.join(rendererStylesPath, file), 'utf8'),
  )
  .join('\n');

const baseCss = fs.readFileSync(
  path.join(rendererStylesPath, 'base.css'),
  'utf8',
);
const settingsStyleSources = [baseCss, settingsCss] as const;
const requiredViewports = [
  { width: 1_100, height: 700 },
  { width: 1_280, height: 800 },
  { width: 1_400, height: 900 },
] as const;

function renderSettingsStyleFixture(): HTMLElement {
  const workspace = document.createElement('section');
  workspace.className = 'settings-workspace';
  workspace.innerHTML = `
    <nav class="settings-nav" aria-label="Configurações">
      <button class="settings-nav__item" type="button">Aparência</button>
    </nav>
    <div class="settings-detail">
      <a class="settings-link" href="#credencial">Obter credencial</a>
      <button class="ops-switch" type="button">
        <span class="ops-switch__track"><span class="ops-switch__thumb"></span></span>
        <span class="ops-switch__label">desligada</span>
      </button>
      <input class="settings-input" aria-label="Nome técnico" />
      <button class="settings-btn" type="button">Atualizar</button>
      <button class="settings-btn settings-btn--primary" type="button">Salvar alterações</button>
      <div class="acp-harness">
        <div class="acp-harness__transport">
          <button type="button">stdio</button>
        </div>
        <div class="acp-harness__actions">
          <button type="button">Verificar conexão</button>
        </div>
        <button class="btn-primary" type="button">Salvar harness</button>
      </div>
    </div>
  `;
  document.body.appendChild(workspace);
  return workspace;
}

afterEach(() => {
  document.body.replaceChildren();
  document.head
    .querySelectorAll('style[data-v2-style-contract]')
    .forEach((style) => style.remove());
});

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return settingsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Settings visual invariants', () => {
  it('uses a hairline selection without a thick active side stripe', () => {
    expect(rule('.settings-nav__item--active')).not.toMatch(
      /box-shadow:\s*inset\s+[2-9]\d*px/,
    );
  });


  it('keeps primary help and form copy at a readable caption floor', () => {
    expect(rule('.settings-detail__hint')).toContain(
      'font-size: var(--text-sm)',
    );
    expect(rule('.settings-field')).toContain('font-size: var(--text-sm)');
    expect(rule('.settings-btn')).toContain('font-size: var(--text-sm)');
  });

  it.each([
    { selector: '.settings-link', label: 'credential link' },
    { selector: '.ops-switch', label: 'operational switch' },
  ])('renders a visible >=2px focus treatment on the $label', ({ selector }) => {
    installStyleContract(settingsStyleSources, { width: 1_400 });
    const workspace = renderSettingsStyleFixture();
    const control = workspace.querySelector<HTMLElement>(selector);
    if (!control) throw new Error(`Missing settings focus fixture: ${selector}`);

    markFocusVisible(control);
    expect(document.activeElement).toBe(control);
    expect(computedCssValue(control, 'outline')).not.toBe('none');
    expect(styleLengthPx(control, 'outline')).toBeGreaterThanOrEqual(2);
  });

  it.each([
    { selector: '.settings-btn:not(.settings-btn--primary)', minimum: 32 },
    { selector: '.settings-input', minimum: 32 },
    { selector: '.settings-btn--primary', minimum: 40 },
  ])(
    'keeps $selector at a $minimum px minimum target',
    ({ selector, minimum }) => {
      installStyleContract(settingsStyleSources, { width: 1_400 });
      const workspace = renderSettingsStyleFixture();
      const control = workspace.querySelector<HTMLElement>(selector);
      if (!control) throw new Error(`Missing settings size fixture: ${selector}`);

      expect(styleLengthPx(control, 'min-height')).toBeGreaterThanOrEqual(
        minimum,
      );
    },
  );

  it.each([
    {
      selector: '.acp-harness__transport button',
      label: 'transport control',
      minimum: 32,
    },
    {
      selector: '.acp-harness__actions button',
      label: 'harness action',
      minimum: 32,
    },
    {
      selector: '.acp-harness > .btn-primary',
      label: 'primary harness action',
      minimum: 40,
    },
  ])(
    'keeps the $label at a $minimum px minimum target',
    ({ selector, minimum }) => {
      installStyleContract(settingsStyleSources, { width: 1_400 });
      const workspace = renderSettingsStyleFixture();
      const control = workspace.querySelector<HTMLElement>(selector);
      if (!control) throw new Error(`Missing harness size fixture: ${selector}`);

      expect(styleLengthPx(control, 'min-height')).toBeGreaterThanOrEqual(
        minimum,
      );
    },
  );

  it('renders the direct harness CTA with the neutral primary palette', () => {
    installStyleContract(settingsStyleSources, { width: 1_400 });
    const workspace = renderSettingsStyleFixture();
    const primary = workspace.querySelector<HTMLElement>(
      '.acp-harness > .btn-primary',
    );
    if (!primary) throw new Error('Missing primary harness action');

    const background = computedCssValue(primary, 'background');
    const ink = computedCssValue(primary, 'color');
    expect(background).toBe(computedCssValue(primary, '--btn-primary'));
    expect(ink).toBe(computedCssValue(primary, '--btn-primary-ink'));
    expect(background).not.toBe(computedCssValue(primary, '--accent'));
  });

  it('renders the primary settings CTA with the neutral primary palette', () => {
    installStyleContract(settingsStyleSources, { width: 1_400 });
    const workspace = renderSettingsStyleFixture();
    const primary = workspace.querySelector<HTMLElement>(
      '.settings-btn--primary',
    );
    if (!primary) throw new Error('Missing primary settings action');

    const background = computedCssValue(primary, 'background');
    const ink = computedCssValue(primary, 'color');
    expect(background).toBe(computedCssValue(primary, '--btn-primary'));
    expect(ink).toBe(computedCssValue(primary, '--btn-primary-ink'));
    expect(background).not.toBe(computedCssValue(primary, '--accent'));
  });

  it.each(requiredViewports)(
    'keeps the SettingsWorkspace tracks inside $width×$height',
    ({ width }) => {
      installStyleContract(settingsStyleSources, { width });
      const workspace = renderSettingsStyleFixture();
      const nav = workspace.querySelector<HTMLElement>('.settings-nav');
      const detail = workspace.querySelector<HTMLElement>('.settings-detail');
      if (!nav || !detail) {
        throw new Error('Settings workspace layout fixture is incomplete');
      }

      const declaredMinimum =
        styleLengthPx(nav, 'flex-basis') +
        styleLengthPx(detail, 'min-width');
      expect(styleLengthPx(detail, 'min-width')).toBe(0);
      expect(declaredMinimum).toBeLessThanOrEqual(width);
    },
  );
});
