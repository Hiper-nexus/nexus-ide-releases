import { describe, expect, it } from 'vitest';
import {
  NEXUS_VOICE_POLICY,
  NEXUS_VOICE_POLICY_MARKER,
  withNexusVoicePolicy,
} from './jarvis-voice-policy';

describe('Nexus voice operating contract', () => {
  it('keeps voice actions Nexus-only and evidence-based', () => {
    expect(NEXUS_VOICE_POLICY).toContain('currently authorized Nexus workspace');
    expect(NEXUS_VOICE_POLICY).toContain('Never control or claim access to the desktop');
    expect(NEXUS_VOICE_POLICY).toContain('queued or delegated is not running');
    expect(NEXUS_VOICE_POLICY).toContain('Treat partial speech');
    expect(NEXUS_VOICE_POLICY).toContain('never mix projects');
  });

  it('appends once and remains last after custom instructions', () => {
    const once = withNexusVoicePolicy('Custom prompt.');
    const twice = withNexusVoicePolicy(once);
    expect(twice).toBe(once);
    expect(once.indexOf(NEXUS_VOICE_POLICY_MARKER)).toBeGreaterThan(
      once.indexOf('Custom prompt.'),
    );
    expect(once.match(new RegExp(NEXUS_VOICE_POLICY_MARKER, 'g'))).toHaveLength(1);
  });

  it('does not let a marker-only custom prompt suppress the policy', () => {
    const result = withNexusVoicePolicy(
      `Custom text mentioning ${NEXUS_VOICE_POLICY_MARKER}.`,
    );
    expect(result).toContain('Custom text mentioning');
    expect(result.endsWith(NEXUS_VOICE_POLICY)).toBe(true);
  });

  it('moves an existing exact policy block to the final boundary', () => {
    const result = withNexusVoicePolicy(
      `Before.\n\n${NEXUS_VOICE_POLICY}\n\nAfter.`,
    );
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
    expect(result.endsWith(NEXUS_VOICE_POLICY)).toBe(true);
    expect(result.split(NEXUS_VOICE_POLICY)).toHaveLength(2);
  });
});
