# Billing + Team — Plano de Implementação (Parte 4/4: app Electron)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Pré-requisito:** Partes 1–3 (backend completo: checkout/portal/webhook/license/team).

**Goal:** O app consome o backend: `apiFetch` com refresh automático, checkout/portal reais, licença renovada no boot + polling pós-checkout, bloco de time no AccountSection.

**Architecture:** `api-client.ts` (main) é a ÚNICA porta de saída autenticada do app — anexa Bearer do Keychain e rota o 401→refresh→retry. `billing-ipc` e `license-sync` consomem ele. IPC novo mínimo (`team:*`) espelhando o padrão `auth:login`.

**Tech Stack:** Electron main/preload/renderer, vitest, deps injetadas (zero rede nos testes).

## Global Constraints

- Sem menção a concorrentes; comentários pt-BR; testes `npx vitest run <arquivo>` na RAIZ; typecheck `npm run typecheck`.
- Sessões concorrentes no working tree: **reler cada arquivo IMEDIATAMENTE antes de editar** (preload/types/channels/AccountSection mudam com frequência); `git add` por arquivo.
- Módulos main testáveis sem electron: lazy-require de electron/secrets dentro de `defaultDeps()` (padrão de `auth-client.ts`).

---

### Task 9: contract + api-client (Bearer + refresh→retry)

**Files:**
- Modify: `shared/contract.ts` (tipos de team/checkout)
- Create: `src/main/api-client.ts`
- Test: `src/main/api-client.test.ts`

**Interfaces:**
- Consumes: `getSecret`/`setSecret` de `src/main/persistence/secrets-store.ts` (lazy).
- Produces: em `shared/contract.ts`: `TeamMemberInfo`, `TeamInfo`, `InviteInfo`, `CheckoutRequest`. Em `api-client.ts`: `apiFetch(path: string, init?: {method?: string; body?: unknown}, deps?: ApiDeps): Promise<{status: number; json: unknown} | {status: 0; json: null}>` — status 0 = rede caiu. `interface ApiDeps { backendUrl: string; fetchFn: typeof fetch; getSecret: (k: string) => string | null; setSecret: (k: string, v: string) => { ok: boolean; error?: string } }`.

- [ ] **Step 1: Tipos no contract** — em `shared/contract.ts` acrescentar:

```ts
/** Membro do time como o backend devolve em GET /v1/team. */
export interface TeamMemberInfo {
  accountId: string;
  role: 'owner' | 'member';
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface InviteInfo {
  codePrefix: string;
  usedCount: number;
  maxUses: number;
  expiresAt: string;
}

export interface TeamInfo {
  team: { id: string; name: string; role: 'owner' | 'member' } | null;
  members?: TeamMemberInfo[];
  seats?: { used: number; total: number };
  overLimit?: boolean;
  status?: string;
  invites?: InviteInfo[];
}

export interface CheckoutRequest {
  plan: 'pro' | 'team';
  seats?: number;
  teamName?: string;
}
```

- [ ] **Step 2: Teste falhando** — `src/main/api-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';

function deps(over: Record<string, unknown> = {}) {
  const store: Record<string, string> = {
    'auth:session': 'sess-1', 'auth:refresh': 'ref-1',
  };
  return {
    backendUrl: 'https://api.test',
    fetchFn: vi.fn(),
    getSecret: (k: string) => store[k] ?? null,
    setSecret: (k: string, v: string) => { store[k] = v; return { ok: true }; },
    _store: store,
    ...over,
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiFetch', () => {
  it('anexa o Bearer da sessão e devolve o json', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json({ ok: true, data: 1 }));
    const r = await apiFetch('/v1/team', {}, d as never);
    expect(r.status).toBe(200);
    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.test/v1/team');
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer sess-1');
  });

  it('401 → roda o refresh, guarda o par novo e repete UMA vez', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(json({ ok: false }, 401))                       // 1ª chamada
      .mockResolvedValueOnce(json({ ok: true, data: { session: 's2', refresh: 'r2' } })) // refresh
      .mockResolvedValueOnce(json({ ok: true, data: 42 }));                  // retry
    const r = await apiFetch('/v1/team', {}, d as never);
    expect(r.status).toBe(200);
    expect(d._store['auth:session']).toBe('s2');
    expect(d._store['auth:refresh']).toBe('r2');
    const refreshCall = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(refreshCall[0]).toBe('https://api.test/v1/auth/refresh');
  });

  it('refresh também falha → devolve o 401 (sem loop)', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(json({ ok: false }, 401))
      .mockResolvedValueOnce(json({ ok: false }, 401));
    const r = await apiFetch('/v1/team', {}, d as never);
    expect(r.status).toBe(401);
    expect((d.fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('sem sessão no Keychain → 401 sintético sem tocar a rede', async () => {
    const d = deps();
    (d as { getSecret: (k: string) => string | null }).getSecret = () => null;
    const r = await apiFetch('/v1/team', {}, d as never);
    expect(r.status).toBe(401);
    expect((d.fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('rede caiu → {status: 0} (nunca lança)', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    const r = await apiFetch('/v1/team', {}, d as never);
    expect(r.status).toBe(0);
  });
});
```

- [ ] **Step 3:** `npx vitest run src/main/api-client.test.ts` → FAIL.

- [ ] **Step 4: Implementar** — `src/main/api-client.ts`:

```ts
/**
 * Porta de saída autenticada do app → backend SaaS. Anexa o Bearer da sessão
 * (Keychain) e trata 401 com UMA rotação de refresh + retry. Nunca lança:
 * rede caída vira {status: 0}. Deps injetáveis (padrão auth-client).
 */

export interface ApiDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  getSecret: (key: string) => string | null;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
}

export interface ApiResult {
  status: number; // 0 = rede caiu
  json: unknown;
}

function defaultDeps(): ApiDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  return {
    backendUrl: process.env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    fetchFn: fetch,
    getSecret: (k) => secrets.getSecret(k),
    setSecret: (k, v) => secrets.setSecret(k, v),
  };
}

async function doFetch(
  deps: ApiDeps, path: string, init: { method?: string; body?: unknown }, session: string,
): Promise<Response> {
  return deps.fetchFn(`${deps.backendUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** Tenta renovar a sessão com o refresh; retorna a sessão nova ou null. */
async function tryRefresh(deps: ApiDeps): Promise<string | null> {
  const refresh = deps.getSecret('auth:refresh');
  if (!refresh) return null;
  try {
    const res = await deps.fetchFn(`${deps.backendUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as {
      ok: boolean; data?: { session: string; refresh: string };
    };
    if (!out.ok || !out.data) return null;
    if (!deps.setSecret('auth:session', out.data.session).ok) return null;
    deps.setSecret('auth:refresh', out.data.refresh);
    return out.data.session;
  } catch {
    return null;
  }
}

export async function apiFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
  deps: ApiDeps = defaultDeps(),
): Promise<ApiResult> {
  const session = deps.getSecret('auth:session');
  if (!session) return { status: 401, json: null };
  try {
    let res = await doFetch(deps, path, init, session);
    if (res.status === 401) {
      const renewed = await tryRefresh(deps);
      if (!renewed) return { status: 401, json: null };
      res = await doFetch(deps, path, init, renewed);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null }; // offline — o app segue local-first
  }
}
```

- [ ] **Step 5:** testes PASS (5); `npm run typecheck` limpo.

- [ ] **Step 6: Commit** — `git add shared/contract.ts src/main/api-client.ts src/main/api-client.test.ts && git commit -m "feat(app): api-client autenticado (Bearer + refresh→retry) + tipos de team no contract"`

---

### Task 10: billing-ipc real + license-sync (boot + polling)

**Files:**
- Modify: `src/main/persistence/billing-ipc.ts` (checkout/portal via backend)
- Create: `src/main/license-sync.ts`
- Test: `src/main/license-sync.test.ts`
- Modify: `src/main/main.ts` (chamar `syncLicenseOnBoot` após app ready)

**Interfaces:**
- Consumes: `apiFetch` (Task 9), `applyLicenseToken` (billing-ipc), `BILLING_CHANNELS`.
- Produces: `syncLicenseOnce(deps?): Promise<boolean>` (true = licença aplicada), `startCheckoutPolling(deps?): void` (5s × 24 tentativas), `syncLicenseOnBoot(): void`. `interface LicenseSyncDeps { api: typeof apiFetch; applyLicense: (jwt: string) => { ok: boolean }; notify: () => void; setIntervalFn/clearIntervalFn }`.

- [ ] **Step 1: Teste falhando** — `src/main/license-sync.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { startCheckoutPolling, syncLicenseOnce } from './license-sync';

function deps(over: Record<string, unknown> = {}) {
  return {
    api: vi.fn().mockResolvedValue({ status: 200, json: { ok: true, data: { licenca: 'jwt-1' } } }),
    applyLicense: vi.fn().mockReturnValue({ ok: true }),
    notify: vi.fn(),
    setIntervalFn: vi.fn(),
    clearIntervalFn: vi.fn(),
    ...over,
  };
}

describe('syncLicenseOnce', () => {
  it('200 → aplica a licença e notifica o renderer', async () => {
    const d = deps();
    expect(await syncLicenseOnce(d as never)).toBe(true);
    expect(d.applyLicense).toHaveBeenCalledWith('jwt-1');
    expect(d.notify).toHaveBeenCalled();
  });
  it('401/offline → false sem aplicar nada', async () => {
    const d = deps({ api: vi.fn().mockResolvedValue({ status: 401, json: null }) });
    expect(await syncLicenseOnce(d as never)).toBe(false);
    expect(d.applyLicense).not.toHaveBeenCalled();
  });
});

describe('startCheckoutPolling', () => {
  it('agenda o intervalo e para quando o plano deixa de ser free', async () => {
    let tick: () => Promise<void> = async () => {};
    const d = deps({
      setIntervalFn: vi.fn((fn: () => Promise<void>) => { tick = fn; return 7 as never; }),
      api: vi.fn()
        // 1º tick: ainda free → segue
        .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: 'free-jwt' } } })
        // 2º tick: virou pro → para
        .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: 'pro-jwt' } } }),
      readPlan: vi.fn().mockReturnValueOnce('free').mockReturnValueOnce('pro'),
    });
    startCheckoutPolling(d as never);
    expect(d.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5_000);
    await tick();
    expect(d.clearIntervalFn).not.toHaveBeenCalled();
    await tick();
    expect(d.clearIntervalFn).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2:** rodar → FAIL.

- [ ] **Step 3: Implementar** — `src/main/license-sync.ts`:

```ts
import type { apiFetch } from './api-client';

/**
 * Sincroniza a licença com o backend: uma vez no boot/reconexão e em POLLING
 * curto depois que o usuário abre um checkout (o upgrade aparece sem
 * reiniciar). Local-first: falhou/offline → app segue com a licença atual.
 */

export interface LicenseSyncDeps {
  api: typeof apiFetch;
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
  /** Plano atual persistido (p/ saber quando o polling pode parar). */
  readPlan: () => string;
  notify: () => void; // BILLING_CHANNELS.changed → renderer
  setIntervalFn: (fn: () => Promise<void>, ms: number) => unknown;
  clearIntervalFn: (id: unknown) => void;
}

const POLL_MS = 5_000;
const POLL_MAX = 24; // ~2min

function defaultDeps(): LicenseSyncDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { apiFetch: api } = require('./api-client') as typeof import('./api-client');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const billing = require('./persistence/billing-ipc') as typeof import('./persistence/billing-ipc');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BrowserWindow } = require('electron') as typeof import('electron');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BILLING_CHANNELS } = require('../shared/billing-types') as typeof import('../shared/billing-types');
  return {
    api,
    applyLicense: (jwt) => billing.applyLicenseToken(jwt),
    readPlan: () => billing.currentPlan(),
    notify: () => BrowserWindow.getAllWindows()[0]?.webContents.send(BILLING_CHANNELS.changed),
    setIntervalFn: (fn, ms) => setInterval(() => void fn(), ms),
    clearIntervalFn: (id) => clearInterval(id as NodeJS.Timeout),
  };
}

export async function syncLicenseOnce(
  deps: LicenseSyncDeps = defaultDeps(),
): Promise<boolean> {
  const r = await deps.api('/v1/license');
  if (r.status !== 200) return false;
  const body = r.json as { ok?: boolean; data?: { licenca?: string } } | null;
  const jwt = body?.ok ? body.data?.licenca : undefined;
  if (!jwt) return false;
  if (!deps.applyLicense(jwt).ok) return false;
  deps.notify();
  return true;
}

/** Após abrir um checkout: tenta por ~2min até o plano sair de free. */
export function startCheckoutPolling(deps: LicenseSyncDeps = defaultDeps()): void {
  let runs = 0;
  const id = deps.setIntervalFn(async () => {
    runs += 1;
    await syncLicenseOnce(deps);
    if (deps.readPlan() !== 'free' || runs >= POLL_MAX) deps.clearIntervalFn(id);
  }, POLL_MS);
}

/** Boot: renova em background (nunca bloqueia a janela). */
export function syncLicenseOnBoot(): void {
  void syncLicenseOnce().catch(() => undefined);
}
```

- [ ] **Step 4: billing-ipc real** — em `src/main/persistence/billing-ipc.ts` (RELER antes — arquivo sofre edits concorrentes):
  1. Exportar `currentPlan(): string` → `readLicense().plan`.
  2. Substituir os handlers checkout/portal:

```ts
ipcMain.handle(BILLING_CHANNELS.checkout, async (_e, raw: unknown) => {
  const req = (typeof raw === 'object' && raw !== null ? raw : { plan: raw }) as
    { plan?: unknown; seats?: number; teamName?: string };
  const plan: PlanId = req.plan === 'team' ? 'team' : 'pro';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { apiFetch } = require('../api-client') as typeof import('../api-client');
  const r = await apiFetch('/v1/billing/checkout', {
    method: 'POST',
    body: { plan, seats: req.seats, teamName: req.teamName },
  });
  const body = r.json as { ok?: boolean; data?: { url?: string }; error?: string } | null;
  if (r.status !== 200 || !body?.data?.url) {
    const error = r.status === 401 ? 'entre na sua conta primeiro'
      : body?.error ?? 'backend indisponível — tente de novo';
    return { ok: false, error };
  }
  void shell.openExternal(body.data.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startCheckoutPolling } = require('../license-sync') as typeof import('../license-sync');
  startCheckoutPolling();
  return { ok: true };
});

ipcMain.handle(BILLING_CHANNELS.portal, async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { apiFetch } = require('../api-client') as typeof import('../api-client');
  const r = await apiFetch('/v1/billing/portal', { method: 'POST' });
  const body = r.json as { ok?: boolean; data?: { url?: string }; error?: string } | null;
  if (r.status !== 200 || !body?.data?.url) {
    return { ok: false, error: r.status === 401 ? 'entre na sua conta primeiro' : body?.error ?? 'backend indisponível' };
  }
  void shell.openExternal(body.data.url);
  return { ok: true };
});
```

  3. Remover a constante `BILLING_BASE` (não é mais usada) e atualizar o comentário de cabeçalho do arquivo.

- [ ] **Step 5: Boot** — em `src/main/main.ts` (RELER antes), depois de `registerBillingIpc()`:

```ts
const { syncLicenseOnBoot } = await import('./license-sync');
syncLicenseOnBoot();
```

(ajustar à forma de import do arquivo — se o bloco usa require síncrono, seguir o padrão local)

- [ ] **Step 6:** `npx vitest run src/main/license-sync.test.ts` → PASS; `npm run typecheck` limpo; suíte inteira do app verde.

- [ ] **Step 7: Commit** — `git add src/main/license-sync.ts src/main/license-sync.test.ts src/main/persistence/billing-ipc.ts src/main/main.ts && git commit -m "feat(app): checkout/portal reais via backend + licença no boot e polling pós-checkout"`

---

### Task 11: IPC de team + bloco no AccountSection + gates finais

**Files:**
- Modify: `src/shared/channels.ts`, `src/shared/types.ts`, `src/preload/preload.ts`
- Create: `src/main/team-ipc.ts`
- Modify: `src/main/main.ts` (registrar)
- Modify: `src/renderer/components/settings/AccountSection.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `TeamInfo`/`InviteInfo` do contract.
- Produces: `TEAM_CHANNELS = { get: 'team:get', join: 'team:join', invite: 'team:invite', remove: 'team:removeMember', leave: 'team:leave' }`; `window.nexus.team.{get, join(code), invite(), removeMember(accountId), leave()}`.

- [ ] **Step 1: Canais e tipos** — em `src/shared/channels.ts` (RELER):

```ts
export const TEAM_CHANNELS = {
  get: 'team:get',
  join: 'team:join',
  invite: 'team:invite',
  remove: 'team:removeMember',
  leave: 'team:leave',
} as const;
```

Em `src/shared/types.ts`, no `NexusApi` (RELER; importar `TeamInfo`, `InviteInfo` de `../../shared/contract`):

```ts
team: {
  get(): Promise<{ ok: boolean; data?: TeamInfo; error?: string }>;
  join(code: string): Promise<{ ok: boolean; error?: string }>;
  invite(): Promise<{ ok: boolean; data?: { code: string; url: string }; error?: string }>;
  removeMember(accountId: string): Promise<{ ok: boolean; error?: string }>;
  leave(): Promise<{ ok: boolean; error?: string }>;
};
```

- [ ] **Step 2: main handler** — `src/main/team-ipc.ts`:

```ts
import { ipcMain } from 'electron';
import { TEAM_CHANNELS } from '../shared/channels';
import { apiFetch } from './api-client';

/** IPC fino: renderer → backend /v1/team/* (toda auth fica no api-client). */

type Envelope = { ok?: boolean; data?: unknown; error?: string } | null;

async function call(path: string, method = 'GET', body?: unknown) {
  const r = await apiFetch(path, { method, ...(body !== undefined ? { body } : {}) });
  const env = r.json as Envelope;
  if (r.status === 401) return { ok: false, error: 'entre na sua conta primeiro' };
  if (r.status === 0) return { ok: false, error: 'sem conexão' };
  if (!env?.ok) return { ok: false, error: env?.error ?? 'erro do servidor' };
  return { ok: true, data: env.data };
}

export function registerTeamIpc(): void {
  ipcMain.handle(TEAM_CHANNELS.get, () => call('/v1/team'));
  ipcMain.handle(TEAM_CHANNELS.join, (_e, code: unknown) =>
    call('/v1/team/join', 'POST', { code: String(code ?? '') }));
  ipcMain.handle(TEAM_CHANNELS.invite, () => call('/v1/team/invites', 'POST'));
  ipcMain.handle(TEAM_CHANNELS.remove, (_e, accountId: unknown) =>
    call(`/v1/team/members/${String(accountId ?? '')}`, 'DELETE'));
  ipcMain.handle(TEAM_CHANNELS.leave, () => call('/v1/team/leave', 'POST'));
}
```

Registrar em `main.ts` junto de `registerBillingIpc()`: `registerTeamIpc()` (import no topo do bloco de imports).

- [ ] **Step 3: preload** — em `src/preload/preload.ts` (RELER), adicionar ao objeto `api` (imports: `TEAM_CHANNELS`):

```ts
team: {
  get: () => ipcRenderer.invoke(TEAM_CHANNELS.get),
  join: (code: string) => ipcRenderer.invoke(TEAM_CHANNELS.join, code),
  invite: () => ipcRenderer.invoke(TEAM_CHANNELS.invite),
  removeMember: (accountId: string) => ipcRenderer.invoke(TEAM_CHANNELS.remove, accountId),
  leave: () => ipcRenderer.invoke(TEAM_CHANNELS.leave),
},
```

- [ ] **Step 4: AccountSection** — em `AccountSection.tsx` (RELER — mexido por sessões concorrentes), adicionar bloco de time abaixo do bloco de login, seguindo classes existentes (`settings-detail__hint`, `agent-picker__btn`):

```tsx
// estado no topo do componente:
const [team, setTeam] = useState<TeamInfo | null>(null);
const [joinCode, setJoinCode] = useState('');
const [inviteUrl, setInviteUrl] = useState<string | null>(null);
useEffect(() => {
  if (license?.email) void window.nexus.team.get().then((r) => r.ok && setTeam(r.data ?? null));
}, [license?.email]);

// JSX (após o bloco de login, só quando logado):
{license?.email && (
  <div className="account__team">
    {team?.team ? (
      <>
        <span className="settings-detail__hint">
          Time: {team.team.name} — {team.seats?.used}/{team.seats?.total} assentos
          {team.overLimit ? ' (acima do limite)' : ''}
        </span>
        {team.team.role === 'owner' && (
          <button className="agent-picker__btn" onClick={() =>
            void window.nexus.team.invite().then((r) => r.ok && setInviteUrl(r.data?.url ?? null))
          }>Gerar convite</button>
        )}
        {inviteUrl && <code className="account__invite-url">{inviteUrl}</code>}
        {team.team.role === 'member' && (
          <button className="agent-picker__btn" onClick={() =>
            void window.nexus.team.leave().then(() => setTeam(null))
          }>Sair do time</button>
        )}
      </>
    ) : (
      <div className="account__login-buttons">
        <input
          className="settings-input"
          placeholder="Código de convite (AB12-CD34)"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
        />
        <button className="agent-picker__btn" onClick={() =>
          void window.nexus.team.join(joinCode).then((r) => {
            if (r.ok) void window.nexus.team.get().then((g) => g.ok && setTeam(g.data ?? null));
          })
        }>Entrar num time</button>
      </div>
    )}
  </div>
)}
```

(Import: `type TeamInfo` de `../../../shared/billing-types` se re-exportado, senão de `../../../../shared/contract`. Re-exportar `TeamInfo`/`InviteInfo` em `src/shared/billing-types.ts` junto dos exports existentes do contract.)

- [ ] **Step 5: Commit** — `git add src/shared/channels.ts src/shared/types.ts src/preload/preload.ts src/main/team-ipc.ts src/main/main.ts src/renderer/components/settings/AccountSection.tsx src/shared/billing-types.ts && git commit -m "feat(app): IPC de time + bloco de time no AccountSection (convite/join/leave)"`

---

### Task 12: páginas web mínimas + gates finais

**Files:**
- Create: `server/src/web/pages.ts`
- Test: `server/src/web/pages.test.ts`
- Modify: `server/src/index.ts` (montar SEM prefixo /v1)

**Interfaces:**
- Produces: `buildWebPages(): Router` com `GET /billing/success`, `GET /billing/cancel`, `GET /join/:code` — HTML server-rendered mínimo (casca §6 da arquitetura; visual final é spec da landing). NENHUM segredo nas URLs: a página de join só instrui a colar o código no app.

- [ ] **Step 1: Teste falhando** — `server/src/web/pages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildWebPages } from './pages';

describe('páginas web mínimas', () => {
  const app = express().use(buildWebPages());
  it('success/cancel/join respondem HTML com instrução de voltar ao app', async () => {
    const ok = await request(app).get('/billing/success');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('NexusIDE');
    expect((await request(app).get('/billing/cancel')).status).toBe(200);
    const join = await request(app).get('/join/AB12-CD34');
    expect(join.status).toBe(200);
    expect(join.text).toContain('AB12-CD34');
    // código malformado não é refletido (anti-XSS): só o formato canônico
    const evil = await request(app).get('/join/<script>x</script>');
    expect(evil.text).not.toContain('<script>x');
  });
});
```

- [ ] **Step 2:** `cd server && npx vitest run src/web/pages.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — `server/src/web/pages.ts`:

```ts
import { Router } from 'express';

/** Casca web mínima (§6 da arquitetura): páginas funcionais server-rendered.
 * O visual final pertence à spec da landing — aqui é só o essencial. */

const CODE_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/i;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — NexusIDE</title>
<style>body{font-family:system-ui;background:#0b0e14;color:#e6e9ef;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}
main{max-width:460px;text-align:center;padding:24px}
code{background:#1a2130;padding:4px 10px;border-radius:6px;font-size:18px}</style>
</head><body><main>${body}</main></body></html>`;
}

export function buildWebPages(): Router {
  const r = Router();
  r.get('/billing/success', (_req, res) => {
    res.send(page('Pagamento confirmado', '<h1>Pago ✓</h1><p>Volte ao NexusIDE — seu plano atualiza sozinho em instantes.</p>'));
  });
  r.get('/billing/cancel', (_req, res) => {
    res.send(page('Pagamento cancelado', '<h1>Sem problemas</h1><p>Nada foi cobrado. Volte ao NexusIDE quando quiser.</p>'));
  });
  r.get('/join/:code', (req, res) => {
    const raw = String(req.params.code);
    const code = CODE_RE.test(raw) ? raw.toUpperCase() : null; // nunca refletir lixo
    res.send(page('Convite de time', code
      ? `<h1>Você foi convidado!</h1><p>Abra o NexusIDE → Configurações → Conta e cole o código:</p><code>${code}</code>`
      : '<h1>Convite inválido</h1><p>Confira o link com quem te convidou.</p>'));
  });
  return r;
}
```

Montar em `createApp` (index.ts, RELER antes) FORA do `/v1`: `app.use(buildWebPages());` (antes do errorHandler).

- [ ] **Step 4: Gates finais (Definition of Done do subsistema)**

```
cd server && npx vitest run && npx tsc --noEmit   # backend verde
cd .. && npm test && npm run typecheck            # app verde
```

- [ ] **Step 5: Commit** — `git add server/src/web/pages.ts server/src/web/pages.test.ts server/src/index.ts && git commit -m "feat(server): páginas web mínimas (success/cancel/join) sem refletir input"`
