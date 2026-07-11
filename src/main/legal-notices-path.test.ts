import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  PACKAGED_LEGAL_FILES,
  resolveThirdPartyNoticesPath,
} from './legal-notices-path';
import { shouldPackageFile } from '../../forge.config';

describe('legal notices packaging', () => {
  it('resolves THIRD_PARTY_NOTICES from the repo cwd in dev', () => {
    const found = resolveThirdPartyNoticesPath({
      appPath: '/nonexistent/app.asar',
      cwd: process.cwd(),
    });
    expect(found).toBe(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'));
  });

  it('requires the MIT/third-party set in the packager allowlist', () => {
    for (const file of PACKAGED_LEGAL_FILES) {
      expect(shouldPackageFile(file)).toBe(true);
    }
  });
});
