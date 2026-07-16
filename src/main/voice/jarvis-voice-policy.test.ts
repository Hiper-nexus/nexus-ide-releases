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
});
