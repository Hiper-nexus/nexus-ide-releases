import { z } from 'zod';

/**
 * Multi-account model with automatic failover (Orca-style hot-swap + Nexus
 * failover). An account belongs to an adapter and is either:
 *  - SUBSCRIPTION: Claude Keychain OAuth, or file-backed managed home for
 *    Codex/Grok/Kimi/OpenCode/AGY (auth.json snapshotted into the vault and
 *    materialized under ~/.nexus/managed-accounts on switch/spawn);
 *  - API-KEY: native provider key OR routed upstream (GLM/z.ai, DeepSeek…).
 *
 * Hot-swap rewrites the active credential pointer (no re-login). Running panes
 * keep their account until restart. Failover auto-switches on limit signatures.
 */

export type AccountMode = 'subscription' | 'api-key';
export type FailoverReasonKind =
  | 'rate-limit'
  | 'quota'
  | 'auth'
  | 'transient'
  /** Pane morta por MODELO rejeitado (CLI desatualizada/id aposentado): a conta está sadia; o renderer rotaciona o modelo do pane e religa na mesma conta. */
  | 'model';

export interface Account {
  id: string;
  adapterId: string;
  label: string;
  mode: AccountMode;
  /** Routed upstream for api-key accounts (anthropic|glm|sakana|…). */
  upstream: string;
  /** Real email claim when the provider exposes one; never a synthesized id. */
  email?: string;
  /** Epoch ms until which this account is skipped after hitting a limit. */
  cooldownUntil?: number;
  /** Last failure reason shown in the UI. */
  lastError?: string;
  createdAt: number;
}

/** Secret-free account view for the renderer (never carries keys/blobs). */
export interface AccountInfo extends Account {
  active: boolean;
  hasCredential: boolean;
  onCooldown: boolean;
  /**
   * A credencial existe no vault mas a renovação falhou (ex.: refresh OAuth
   * morto) — spawn nesta conta é 401 garantido. A UI mostra "sessão
   * expirada — entre novamente" em vez do enganoso "pronta".
   */
  needsRelogin: boolean;
}

export const addAccountSchema = z.object({
  adapterId: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  mode: z.enum(['subscription', 'api-key']),
  upstream: z.string().max(32).default('anthropic'),
  /** For api-key mode: the key to store. For subscription: ignored (snapshot). */
  key: z.string().max(4096).optional(),
});
export type AddAccountRequest = z.infer<typeof addAccountSchema>;

export const accountIdSchema = z.object({ id: z.string().min(1).max(128) });
export const renameAccountSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
});

/**
 * Main → renderer: a pane's account hit a limit.
 * Cross-account: pin + fresh session + continuity pack, or native resume of
 * the same conversation when `nativeResume` (F-1473).
 * Same-account recovery: native resume may still apply.
 */
export interface FailoverEvent {
  paneId: string;
  fromAccountLabel: string;
  toAccountLabel: string;
  reason: string;
  /**
   * Main-owned classification of the provider failure. Optional only for
   * compatibility with an already-open renderer during an app update.
   */
  kind?: FailoverReasonKind;
  /** Whether recovery was applied; model rotation is true only after respawn proof. */
  switched: boolean;
  /** Replacement account pinned to the pane before its resume spawn. */
  toAccountId?: string;
  /**
   * kind='model': modelo alternativo escolhido pelo Main. O renderer aplica
   * no pedido e religa na MESMA conta — credencial não é punida.
   */
  toModel?: string;
  /** Pedido de respawn ou recibo posterior de aplicação comprovada pelo Main. */
  modelRotationPhase?: 'requested' | 'applied';
  /**
   * F-765/F-775: a tarefa saiu deste pane — o Main a reabriu pela rota do
   * spawn (outro modelo ou outra CLI) e o pane novo é este. O renderer não
   * religa nada: o pane antigo já foi fechado pelo Main; só avisa.
   */
  toPaneId?: string;
  /** CLI do pane novo quando a tarefa foi reaberta. */
  toAdapterId?: string;
  /** CLI do pane que parou. */
  fromAdapterId?: string;
  /**
   * F-775: troca de CLI NO LUGAR (pane do operador, sem missão): 'requested'
   * pede ao renderer que religue o pane em `toAdapterId` (e `toModel`) com o
   * `continuityPack`; só o recibo 'applied' diz se a troca existiu.
   */
  cliSwitchPhase?: 'requested' | 'applied';
  /** F-775: pacote de continuidade pronto (montado pelo Main) para o pedido. */
  continuityPack?: string;
  /** F-775: nomes das CLIs para o aviso ("Claude esgotou…; continuando em Codex"). */
  fromAdapterLabel?: string;
  toAdapterLabel?: string;
  /**
   * F-775: fatos medidos pelo Main para o pacote de continuidade que o
   * renderer monta na troca de conta: janela/reset da conta esgotada e o
   * estado da tarefa no cwd do pane (arquivos tocados, `git diff --stat`).
   */
  continuity?: {
    limitWindow?: string | null;
    limitResetsAt?: number | null;
    limitCooldownMs?: number | null;
    touchedFiles?: string[];
    diffStat?: string;
    /** F-1482: último(s) pedido(s) entregue(s) ao pane, reentregue(s) no pack. */
    inFlightRequest?: string;
  };
  /** Exhausted account id (when known). */
  fromAccountId?: string;
  /**
   * True when credentials change (multi-account handoff). Renderer must NOT
   * exact-resume a provider session id from the previous account — unless
   * `nativeResume` says Main moved that conversation to the new account.
   */
  crossAccount?: boolean;
  /**
   * F-1473: the CLI's history is shared across accounts (Claude) and Main
   * already moved this pane's conversation to `toAccountId`. The renderer
   * resumes it natively with a short note; the continuity pack is the fallback.
   */
  nativeResume?: boolean;
  /** True when this pane re-used a recent switch decision for the same from-account. */
  coalesced?: boolean;
  /** Mission bound to the failing pane when known (continuity pack). */
  missionId?: string;
  /**
   * Quando switched=false com todas as contas em cooldown: menor blockedUntil
   * entre as irmãs elegíveis (epoch ms). O main agenda um retry automático em
   * min(fim do cooldown da própria conta, este instante) + 1s; a UI pode
   * mostrar o horário em vez de só "nenhuma conta disponível".
   */
  nextUnblockAtMs?: number;
  /** Epoch ms do retry automático agendado pelo main (espera-pela-irmã). */
  scheduledRetryAtMs?: number;
  /**
   * True quando uma task advisory Guided foi dispensada pelo Main (receipt
   * `advisory_provider_unavailable`): a missão segue sem esta análise opcional
   * e o pane físico será fechado — a UI não deve mostrar um dead-end.
   */
  missionTaskWaived?: boolean;
  /**
   * True quando a troca é uma SONDAGEM last-resort: a conta destino ainda
   * está em cooldown, mas a janela de probe venceu e não havia alternativa.
   */
  probe?: boolean;
  /**
   * kind='transient' (erro do provider — nunca troca de conta): em que ponto
   * do episódio o evento foi emitido. 'detected' = aviso inicial (a UI não
   * toast'a — a CLI costuma se recuperar sozinha em segundos); 'stopped' =
   * a CLI parou no erro num pane do operador (ele decide); 'nudged' = pane de
   * missão parado recebeu um "continue" na MESMA sessão; 'stalled' = a CLI
   * ficou ~3 min tentando sem resposta e a vigília encerrou. A UI escolhe a
   * cópia por este campo, nunca pelo texto de `reason`.
   */
  transientPhase?: 'detected' | 'stopped' | 'nudged' | 'stalled';
  /**
   * F-995: o Main JÁ religou o pane na conta nova (orquestrador de missão
   * num pane do renderer, inclusive o pane do operador adotado). O evento é
   * o recibo da troca aplicada: o renderer só espelha a conta e avisa — nunca
   * religa de novo nem tenta matar a sessão de missão.
   */
  respawnedByMain?: true;
}

/** Main → renderer: user activated an account; panes may need restart. */
export interface AccountActivatedEvent {
  accountId: string;
  adapterId: string;
  label: string;
  /** Running CLI panes keep the old credential until respawned. */
  needsRestart: boolean;
}

/** Per-account quota/cooldown view for status-bar usage chip (P4). */
export interface AccountQuotaInfo {
  accountId: string;
  adapterId: string;
  label: string;
  active: boolean;
  onCooldown: boolean;
  cooldownUntil?: number;
  lastError?: string;
  email?: string;
  mode: AccountMode;
  hasCredential: boolean;
  /** Human status for the chip: ready | cooldown | no-credential. */
  status: 'ready' | 'cooldown' | 'no-credential' | 'inactive';
}

export const ACCOUNT_CHANNELS = {
  list: 'account:list',
  add: 'account:add',
  addActiveClaude: 'account:addActiveClaude',
  addActiveSession: 'account:addActiveSession',
  rename: 'account:rename',
  remove: 'account:remove',
  activate: 'account:activate',
  supportsSnapshot: 'account:supportsSnapshot',
  prepareAgyLogin: 'account:prepareAgyLogin',
  restoreAgyLogin: 'account:restoreAgyLogin',
  quota: 'account:quota',
  changed: 'account:changed',
  activated: 'account:activated',
  failover: 'account:failover',
} as const;

export const addActiveSessionSchema = z.object({
  adapterId: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  /**
   * Reautenticação de uma linha existente. Sem este id o Main precisa
   * adivinhar o destino por e-mail/token — ambíguo quando a linhagem OAuth
   * rodou inteira ou duas contas compartilham o mesmo e-mail.
   */
  accountId: z.string().min(1).max(128).optional(),
});
export type AddActiveSessionRequest = z.infer<typeof addActiveSessionSchema>;
