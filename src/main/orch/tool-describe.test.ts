import { describe, expect, it } from 'vitest';
import { describeEnvelope, DESCRIBE_PROPERTY } from './tool-describe';

describe('describeEnvelope', () => {
  it('returns null when describe is not requested', () => {
    expect(describeEnvelope(undefined, 'run', { type: 'object' })).toBeNull();
    expect(describeEnvelope(false, 'run', { type: 'object' })).toBeNull();
  });

  it('wraps the op schema on describe:true', () => {
    const env = describeEnvelope(true, 'save', { type: 'object', properties: { id: {} } });
    expect(env).toMatchObject({ describe: true, op: 'save' });
    expect(env?.inputSchema).toHaveProperty('properties');
    expect(env?.note).toContain('schema do op sob demanda');
    expect(DESCRIBE_PROPERTY.describe.type).toBe('boolean');
  });
});