import { describe, expect, it } from 'vitest';
import {
  readAgentPluginSkill,
  reduceAgentPluginAllowedTools,
  stripAgentPluginAllowedTools,
} from './agent-plugin-skill';
import { isToolAllowed } from './gate';

describe('Agent Skills validation inside a plugin', () => {
  it('accepts required frontmatter and keeps the instruction body', () => {
    const verdict = readAgentPluginSkill({
      directoryName: 'code-review',
      content: `---
name: code-review
description: Review code and explain findings. Use for pull requests.
---

# Workflow

Read the diff first.
`,
    });

    expect(verdict).toMatchObject({
      ok: true,
      skill: {
        name: 'code-review',
        description: 'Review code and explain findings. Use for pull requests.',
        body: expect.stringContaining('Read the diff first.'),
      },
    });
  });

  it('parses YAML block scalars and validates optional metadata types', () => {
    const verdict = readAgentPluginSkill({
      directoryName: 'code-review',
      content: `---
name: code-review
description: >-
  Review code, identify defects, and explain fixes.
  Use for pull requests and patches.
license: Apache-2.0
compatibility: Requires git
metadata:
  author: acme
  version: "1.2"
allowed-tools: Bash(git:*) Read
---

Review safely.
`,
    });

    expect(verdict).toMatchObject({
      ok: true,
      skill: {
        license: 'Apache-2.0',
        compatibility: 'Requires git',
        metadata: { author: 'acme', version: '1.2' },
        declaredAllowedTools: 'Bash(git:*) Read',
        allowedToolsHonored: false,
        permissionGate: 'PreToolUse',
      },
    });
  });

  it.each([
    ['directory mismatch', 'other-name', 'code-review'],
    ['uppercase', 'Code-Review', 'Code-Review'],
    ['consecutive hyphen', 'code--review', 'code--review'],
  ])('rejects an invalid skill name: %s', (_label, name, directoryName) => {
    const verdict = readAgentPluginSkill({
      directoryName,
      content: `---\nname: ${name}\ndescription: Review code.\n---\n`,
    });

    expect(verdict.ok).toBe(false);
  });

  it('rejects unknown frontmatter fields instead of granting provider-specific behavior', () => {
    const verdict = readAgentPluginSkill({
      directoryName: 'code-review',
      content: `---
name: code-review
description: Review code.
disable-model-invocation: true
---
`,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('disable-model-invocation');
  });

  it('rejects malformed YAML and non-string metadata values without throwing', () => {
    const malformed = readAgentPluginSkill({
      directoryName: 'code-review',
      content: '---\nname: [unterminated\n---\n',
    });
    const wrongMetadata = readAgentPluginSkill({
      directoryName: 'code-review',
      content: `---
name: code-review
description: Review code.
metadata:
  retries: 3
---
`,
    });

    expect(malformed.ok).toBe(false);
    expect(wrongMetadata.ok).toBe(false);
  });
});

describe('plugin skill permission sanitization', () => {
  it('never lets a broad plugin request exceed the user policy and reports every reduction', () => {
    const userPolicy = ['nexus_file_read'];
    const reduction = reduceAgentPluginAllowedTools(
      'Read Bash(git:*) nexus_file_read nexus_file_write nexus_git_push',
      userPolicy,
    );

    expect(reduction.granted).toEqual(['nexus_file_read']);
    expect(reduction.removed).toEqual([
      'Read',
      'Bash(git:*)',
      'nexus_file_write',
      'nexus_git_push',
    ]);
    expect(reduction.wasReduced).toBe(true);
    expect(reduction.notice).toContain('4');
    expect(
      reduction.granted.every((tool) => isToolAllowed(userPolicy, tool)),
    ).toBe(true);
  });

  it('removes allowed-tools while preserving all instructions', () => {
    const content = `---
name: code-review
description: Review code.
allowed-tools: Bash(git:*) Read
metadata:
  author: acme
---

# Workflow

Read the diff first.
`;

    const sanitized = stripAgentPluginAllowedTools(content);

    expect(sanitized).not.toContain('allowed-tools');
    expect(sanitized).toContain('name: code-review');
    expect(sanitized).toContain('author: acme');
    expect(sanitized).toContain('# Workflow');
    expect(sanitized).toContain('Read the diff first.');
  });
});
