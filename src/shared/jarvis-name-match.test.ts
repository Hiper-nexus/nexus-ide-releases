import { describe, expect, it } from 'vitest';
import {
  isJarvisWakeAddress,
  looksLikeJarvisName,
  editDistance,
} from './jarvis-name-match';

describe('looksLikeJarvisName', () => {
  it('accepts exact and common STT aliases', () => {
    for (const t of [
      'jarvis',
      'Jarvis',
      'javis',
      'javes',
      'jarbas',
      'jarvix',
      'charvis',
      'jackson',
      'jasper',
      'jarvi',
    ]) {
      expect(looksLikeJarvisName(t), t).toBe(true);
    }
  });

  it('accepts near-misses within 2 edits', () => {
    expect(looksLikeJarvisName('jarviz')).toBe(true);
    expect(looksLikeJarvisName('jarvus')).toBe(true);
    expect(looksLikeJarvisName('harvis')).toBe(true);
  });

  it('rejects unrelated words', () => {
    expect(looksLikeJarvisName('terminal')).toBe(false);
    expect(looksLikeJarvisName('sim')).toBe(false);
    expect(looksLikeJarvisName('abrir')).toBe(false);
    expect(looksLikeJarvisName('xx')).toBe(false);
  });
});

describe('isJarvisWakeAddress', () => {
  it('wakes on name alone', () => {
    expect(isJarvisWakeAddress('Jarvis')).toBe(true);
    expect(isJarvisWakeAddress('javis')).toBe(true);
    expect(isJarvisWakeAddress('javes')).toBe(true);
    expect(isJarvisWakeAddress('Jarvi')).toBe(true);
  });

  it('wakes on greeting + near name', () => {
    expect(isJarvisWakeAddress('Ei, Jarvis.')).toBe(true);
    expect(isJarvisWakeAddress('Hey, Javes.')).toBe(true);
    expect(isJarvisWakeAddress('e aí jarvis')).toBe(true);
    expect(isJarvisWakeAddress('heyjarvis')).toBe(true);
  });

  it('wakes on any short vocative + Jarvis (no Hey required)', () => {
    expect(isJarvisWakeAddress('Jarvis')).toBe(true);
    expect(isJarvisWakeAddress('acorda jarvis')).toBe(true);
    expect(isJarvisWakeAddress('cheguei jarvis')).toBe(true);
    expect(isJarvisWakeAddress('olá jarvis')).toBe(true);
    expect(isJarvisWakeAddress('ouça jarvis')).toBe(true);
    expect(isJarvisWakeAddress('ouso jarvis')).toBe(true);
    expect(isJarvisWakeAddress('oi jarvis')).toBe(true);
    expect(isJarvisWakeAddress('bom dia jarvis')).toBe(true);
  });

  it('wakes on name + short command', () => {
    expect(isJarvisWakeAddress('jarvis abre')).toBe(true);
  });

  it('does not wake on ambient mention mid-sentence', () => {
    // isJarvisWakeAddress is for short clips; long ambient is handled by
    // matchPassiveWakeWord address-position rules.
    expect(isJarvisWakeAddress('hoje o jarvis falou comigo sobre o projeto')).toBe(
      false,
    );
  });
});

describe('editDistance', () => {
  it('counts basic edits', () => {
    expect(editDistance('jarvis', 'jarvis')).toBe(0);
    expect(editDistance('javis', 'jarvis')).toBe(1);
    expect(editDistance('javes', 'jarvis')).toBe(2);
  });
});
