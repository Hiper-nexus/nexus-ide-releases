import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveArmsRuntimeDescriptorPath,
  resolveArmsRuntimeInstance,
} from './arms-runtime-path';

describe('arms runtime descriptor path', () => {
  it('app empacotado é prod; npm start é dev, com descriptor próprio (F-644)', () => {
    const home = path.resolve('/home/u');
    expect(resolveArmsRuntimeInstance(true)).toBe('prod');
    expect(resolveArmsRuntimeInstance(false)).toBe('dev');
    expect(resolveArmsRuntimeDescriptorPath(home, 'prod')).toBe(
      path.join(home, '.nexus', 'arms-runtime.json'),
    );
    expect(resolveArmsRuntimeDescriptorPath(home, 'dev')).toBe(
      path.join(home, '.nexus', 'arms-runtime.dev.json'),
    );
  });
});
