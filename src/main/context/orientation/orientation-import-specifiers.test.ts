import { describe, expect, it } from 'vitest';
import { extractOrientationImportSpecifiers } from './orientation-import-graph';

describe('extractOrientationImportSpecifiers: side-effect imports', () => {
  it('keeps a side-effect import that is immediately followed by a `from` import', () => {
    const content = "import './side';\nimport { something } from './other';\n";
    expect(extractOrientationImportSpecifiers(content)).toEqual(['./side', './other']);
  });

  it('keeps a side-effect import followed by export-from', () => {
    const content = "import './polyfill';\nexport { bar } from './bar';\n";
    expect(extractOrientationImportSpecifiers(content)).toEqual(['./polyfill', './bar']);
  });

  it('still resolves multi-line named imports and require/dynamic import', () => {
    const content =
      "import './side';\n" +
      'import {\n  Foo,\n  Bar,\n} from \'./types\';\n' +
      "const x = require('./thing');\n" +
      "void import('./dyn');\n";
    expect(extractOrientationImportSpecifiers(content)).toEqual([
      './side',
      './types',
      './thing',
      './dyn',
    ]);
  });
});
