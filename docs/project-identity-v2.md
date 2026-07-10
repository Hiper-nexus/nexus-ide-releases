# Portable project identity v2

`.nexus/project.json` is an authorization boundary, not just project metadata.
Schema v2 binds its stable `projectId` to portable Git lineage so copying the
file into an unrelated repository cannot make two projects share runtime data.

```json
{
  "schemaVersion": 2,
  "projectId": "018f6f5e-c2e8-7a59-8d75-3f7e5ab87c91",
  "name": "Nexus",
  "repository": {
    "vcs": "git",
    "originHashes": ["origin-sha256-<64 lowercase hex characters>"],
    "rootCommits": ["<40 or 64 lowercase hex Git object id>"],
    "anchorCommits": ["<commit reachable only in the intended lineage>"]
  }
}
```

Use `createProjectManifest(workspaceRoot, { projectId, name })` from
`src/main/persistence/project-identity.ts` to build the object. It normalizes
credential-free network origins, hashes them, and records reachable root
commits. Do not construct origin hashes from filesystem paths.

## Verification rules

- A full-history clone must contain at least one manifest anchor as an ancestor
  of `HEAD`. Root commits remain audit evidence, but are not sufficient alone:
  sibling forks can share a template root. Merely configuring the same remote
  URL is also not enough to bless unrelated history.
- When both sides expose portable network origins, they must match as well as
  the anchor. Anchor-only fallback is allowed only when one side genuinely has
  no portable origin, such as an offline full-history clone.
- A shallow clone cannot see the repository roots, so it must have a matching
  portable `origin`. SSH and HTTP(S) forms of the same host/repository normalize
  to the same proof.
- Absolute paths, relative paths, `file://` remotes, inode and device numbers
  are never accepted as portable repository proof.
- A full repository without any remote is supported through root commits.
- A shallow repository without a network origin is quarantined because its
  lineage cannot be proved safely.
- Rewriting all root history intentionally invalidates the old proof. Regenerate
  and review the manifest as an explicit identity migration; never silently
  copy the previous `projectId` into unrelated history.

## Legacy migration

Schema v1 contains only a `projectId` and is therefore unverified. Nexus and
Nexus Doctor quarantine it with remediation instead of adopting or upgrading
it automatically.

Migration is deliberate:

1. Confirm the repository origin and history out of band.
2. Back up the v1 file for audit purposes.
3. Generate a v2 object with `createProjectManifest` from the confirmed Git
   worktree root.
4. Review that the intended `projectId` is correct, replace the file, and commit
   it normally.

## Checkout continuity

Each local checkout receives a random token at
`<exact git-dir>/nexus/checkout.json`. This location is not committed:

- independent clones and Git worktrees receive different tokens;
- moving a repository, including copy-then-delete moves across volumes,
  preserves the token and therefore its `checkoutId`;
- copying a live checkout with its `.git` directory duplicates the token and is
  quarantined until one copy receives a new token intentionally.

The installation registry at `~/.nexus/checkouts.json` uses token-based entries
in schema v2. A registry v1 entry is migrated only when its old local
device/inode/birthtime fingerprint still matches the current checkout. If that
proof was already lost in a pre-upgrade cross-volume move, Nexus allocates a new
checkout identity instead of guessing and risking a collision.
