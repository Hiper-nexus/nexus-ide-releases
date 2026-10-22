import { describe, expect, it } from 'vitest';
import {
  ceremonyProfileNote,
  classifyCeremonyDiff,
  isNonExecutableDiffPath,
  missionCeremonyProfile,
} from './mission-ceremony-profile';

describe('classifyCeremonyDiff', () => {
  it.each([
    [['src/theme.css', 'src/layout.SCSS', 'styles/app.less']],
    [['README.md', 'guide/setup.rst', 'manual/intro.adoc']],
    [['public/logo.svg', 'public/hero.png', 'public/photo.JPEG', 'fonts/Inter.woff2']],
  ])('a diff made only of styles, prose or static assets is non-executable: %j', paths => {
    expect(classifyCeremonyDiff(paths)).toBe('non-executable');
  });

  it.each([
    ['one TS file among styles', ['src/theme.css', 'src/theme.ts']],
    ['a deleted module listed with the styles', ['src/theme.css', 'src/legacy.tsx']],
    ['MDX compiles to JSX', ['docs/page.mdx']],
    ['JSON can be imported by code and tests', ['src/theme.css', 'src/tokens.json']],
    ['HTML carries scripts and the build entry', ['index.html']],
    ['Python requirements are dependencies', ['requirements.txt']],
    ['plain text can be a fixture', ['fixtures/input.txt']],
    ['config files', ['vite.config.ts']],
    ['a file without extension', ['Makefile']],
  ])('%s keeps the diff classified as code', (_label, paths) => {
    expect(classifyCeremonyDiff(paths)).toBe('code');
  });

  it('an unknown or empty diff never subtracts anything', () => {
    expect(classifyCeremonyDiff(undefined)).toBe('code');
    expect(classifyCeremonyDiff([])).toBe('code');
  });

  it('recognizes single paths case-insensitively', () => {
    expect(isNonExecutableDiffPath('A/B.CSS')).toBe(true);
    expect(isNonExecutableDiffPath('a/b.css.ts')).toBe(false);
  });
});

describe('missionCeremonyProfile', () => {
  it('labels the work kind from the goal, not from the lane', () => {
    expect(missionCeremonyProfile('Ajustar a cor do botão primário na tela de login', 'non-executable').workKind).toBe('visual');
    expect(missionCeremonyProfile('Corrigir o bug do checkout que cobra duas vezes', 'code').workKind).toBe('bug');
  });

  it('drops the typecheck only for a non-executable diff', () => {
    expect(missionCeremonyProfile('Ajustar a cor do botão primário', 'non-executable').dropped).toEqual(['typecheck']);
  });

  it.each([
    'Escrever a documentação do módulo de pagamentos',
    'Ajustar a cor do botão primário',
    'Corrigir o bug do login',
  ])('never drops a check for a code diff, whatever the work kind: %s', goal => {
    expect(missionCeremonyProfile(goal, 'code').dropped).toEqual([]);
  });

  it('the note names the kind and what was dropped, and stays empty when nothing was', () => {
    expect(ceremonyProfileNote(missionCeremonyProfile('Ajustar a cor do botão primário', 'non-executable')))
      .toMatch(/visual.*typecheck dispensado/u);
    expect(ceremonyProfileNote(missionCeremonyProfile('Ajustar a cor do botão primário', 'code'))).toBe('');
  });
});
