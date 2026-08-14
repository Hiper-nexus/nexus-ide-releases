import { describe, expect, it } from 'vitest';
import { holdSecret, takeSecret, wipeSecret } from './ssh-secret';

describe('ssh-secret', () => {
  it('wipes the password from the holder after take', () => {
    const holder = holdSecret('super-secret-once');
    const taken = takeSecret(holder);
    expect(taken).toBe('super-secret-once');
    expect(holder.value).toBe('');
    wipeSecret(holder);
    expect(holder.value).toBe('');
  });
});
