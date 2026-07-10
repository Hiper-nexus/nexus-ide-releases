export interface WorkspaceGrantOwner {
  id: number;
}

interface WorkspaceGrant {
  path: string;
  expiresAt: number;
}

export class WorkspaceGrantRegistry {
  private readonly grantsByOwner = new Map<number, WorkspaceGrant[]>();

  constructor(private readonly ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('workspace grant TTL must be a positive integer');
    }
  }

  grant(owner: WorkspaceGrantOwner, workspacePath: string, now = Date.now()): void {
    const current = this.grantsByOwner.get(owner.id) ?? [];
    const alive = current.filter(
      (grant) => grant.expiresAt >= now && grant.path !== workspacePath,
    );
    this.grantsByOwner.set(owner.id, [
      ...alive,
      { path: workspacePath, expiresAt: now + this.ttlMs },
    ]);
  }

  consume(
    owner: WorkspaceGrantOwner,
    workspacePath: string,
    now = Date.now(),
  ): boolean {
    const current = this.grantsByOwner.get(owner.id) ?? [];
    const match = current.find(
      (grant) => grant.path === workspacePath && grant.expiresAt >= now,
    );
    const remaining = current.filter(
      (grant) => grant !== match && grant.expiresAt >= now,
    );
    if (remaining.length > 0) this.grantsByOwner.set(owner.id, remaining);
    else this.grantsByOwner.delete(owner.id);
    return match !== undefined;
  }

  clear(owner: WorkspaceGrantOwner): void {
    this.grantsByOwner.delete(owner.id);
  }
}
