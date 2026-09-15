import { describe, expect, it } from 'vitest';
import { resolveModelChipLabel } from './pane-model-label';

describe('resolveModelChipLabel', () => {
  it('retorna null para pane sem adapterId (shell puro)', () => {
    expect(resolveModelChipLabel(undefined, undefined, undefined)).toBeNull();
    expect(resolveModelChipLabel(undefined, 'gpt-5.6-luna', 'high')).toBeNull();
  });

  it('retorna null para adapterId não reconhecido', () => {
    expect(resolveModelChipLabel('shell', undefined, undefined)).toBeNull();
    expect(resolveModelChipLabel('unknown-cli', undefined, undefined)).toBeNull();
  });

  describe('Claude', () => {
    it('claude-code + claude-sonnet-4-5 + high', () => {
      const label = resolveModelChipLabel('claude-code', 'claude-sonnet-4-5', 'high');
      expect(label).not.toBeNull();
      expect(label!.family).toBe('Claude');
      expect(label!.version).toBe('Sonnet 4.5');
      expect(label!.effortAbbr).toBe('H');
      expect(label!.compact).toBe('Claude');
      expect(label!.medium).toBe('Claude Sonnet');
      expect(label!.full).toBe('Claude Sonnet 4.5 · High');
    });

    it('claude + claude-opus-4', () => {
      const label = resolveModelChipLabel('claude', 'claude-opus-4', undefined);
      expect(label!.family).toBe('Claude');
      expect(label!.version).toBe('Opus 4');
      expect(label!.effortAbbr).toBeUndefined();
      expect(label!.medium).toBe('Claude Opus');
      expect(label!.full).toBe('Claude Opus 4');
    });

    it('claude-code sem model retorna só família', () => {
      const label = resolveModelChipLabel('claude-code', undefined, undefined);
      expect(label!.family).toBe('Claude');
      expect(label!.version).toBe('');
      expect(label!.compact).toBe('Claude');
      expect(label!.medium).toBe('Claude');
      expect(label!.full).toBe('Claude');
    });
  });

  describe('GPT / Codex', () => {
    it('codex + gpt-5.6-luna-medium (effort embedded no model)', () => {
      const label = resolveModelChipLabel('codex', 'gpt-5.6-luna-medium', undefined);
      expect(label!.family).toBe('GPT');
      expect(label!.version).toBe('5.6 Luna');
      expect(label!.effortAbbr).toBe('M');
      expect(label!.medium).toBe('GPT 5.6');
      expect(label!.full).toBe('GPT 5.6 Luna · Medium');
    });

    it('codex + gpt-5.6-sol-medium (versão composta)', () => {
      const label = resolveModelChipLabel('codex', 'gpt-5.6-sol-medium', undefined);
      expect(label!.family).toBe('GPT');
      expect(label!.version).toBe('5.6 Sol');
      expect(label!.effortAbbr).toBe('M');
      expect(label!.medium).toBe('GPT 5.6');
      expect(label!.full).toBe('GPT 5.6 Sol · Medium');
    });

    it('effort explícito bate effort do model', () => {
      const label = resolveModelChipLabel('codex', 'gpt-5.6-luna-medium', 'high');
      // effort explícito (pane.effort) deve ter precedência
      expect(label!.effortAbbr).toBe('H');
    });
  });

  describe('AGY', () => {
    it('agy + gemini-3.1-pro + high', () => {
      const label = resolveModelChipLabel('agy', 'gemini-3.1-pro', 'high');
      expect(label!.family).toBe('AGY');
      expect(label!.version).toBe('3.1 Pro');
      expect(label!.effortAbbr).toBe('H');
      expect(label!.medium).toBe('AGY 3.1');
      expect(label!.full).toBe('AGY 3.1 Pro · High');
    });

    it('não apresenta gemini/gemini-cli como adapters', () => {
      expect(
        resolveModelChipLabel('gemini', 'gemini-3.5-flash', undefined),
      ).toBeNull();
      expect(
        resolveModelChipLabel('gemini-cli', 'gemini-3.1-pro', 'high'),
      ).toBeNull();
    });
  });

  describe('DeepSeek', () => {
    it('deepseek + deepseek-v4-pro', () => {
      const label = resolveModelChipLabel('deepseek', 'deepseek-v4-pro', undefined);
      expect(label!.family).toBe('DeepSeek');
      expect(label!.version).toBe('V4 Pro');
      expect(label!.medium).toBe('DeepSeek V4');
    });
  });

  describe('Grok', () => {
    it('grok + grok-4.5', () => {
      const label = resolveModelChipLabel('grok', 'grok-4.5', undefined);
      expect(label!.family).toBe('Grok');
      expect(label!.version).toBe('4.5');
      expect(label!.medium).toBe('Grok 4.5');
    });

    it('cursor-grok + cursor-grok-4.5-high (effort no model)', () => {
      const label = resolveModelChipLabel('cursor-grok', 'cursor-grok-4.5-high', undefined);
      expect(label!.family).toBe('Grok');
      expect(label!.effortAbbr).toBe('H');
      expect(label!.full).toBe('Grok 4.5 · High');
    });

    it('grok-4-fast não cola número e palavra com ponto', () => {
      const label = resolveModelChipLabel('grok', 'grok-4-fast', undefined);
      expect(label!.version).toBe('4 Fast');
      expect(label!.medium).toBe('Grok 4');
    });
  });

  describe('Kimi', () => {
    it('kimi + kimi-k3-max', () => {
      const label = resolveModelChipLabel('kimi', 'kimi-k3-max', undefined);
      expect(label!.family).toBe('Kimi');
      expect(label!.version).toBe('K3 Max');
      expect(label!.medium).toBe('Kimi K3');
    });

    it('kimi + kimi-code/k3', () => {
      const label = resolveModelChipLabel('kimi', 'kimi-code/k3', undefined);
      expect(label!.family).toBe('Kimi');
      expect(label!.version).toBe('K3');
      expect(label!.medium).toBe('Kimi K3');
    });

    it('kimi + kimi-k2.8', () => {
      const label = resolveModelChipLabel('kimi', 'kimi-k2.8', undefined);
      expect(label!.family).toBe('Kimi');
      expect(label!.version).toBe('K2.8');
      expect(label!.medium).toBe('Kimi K2.8');
    });
  });

  describe('adapterId sem model', () => {
    it('grok sem model → só família', () => {
      const label = resolveModelChipLabel('grok', undefined, 'high');
      expect(label!.family).toBe('Grok');
      expect(label!.version).toBe('');
      expect(label!.effortAbbr).toBe('H');
      expect(label!.compact).toBe('Grok');
      expect(label!.medium).toBe('Grok');
      expect(label!.full).toBe('Grok · High');
    });

    it('agy sem model → AGY', () => {
      const label = resolveModelChipLabel('agy', undefined, undefined);
      expect(label!.family).toBe('AGY');
      expect(label!.compact).toBe('AGY');
    });
  });

  describe('effort xhigh', () => {
    it('xhigh → abbr XH', () => {
      const label = resolveModelChipLabel('grok', 'grok-4.5', 'xhigh');
      expect(label!.effortAbbr).toBe('XH');
      expect(label!.full).toContain('XHigh');
    });
  });
});
