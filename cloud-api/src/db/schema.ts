import type { BugCategory, BugEventKind, BugImpact, BugPlatform, BugSeverity, BugStatus } from '../bugs/constants.js';

/** D1 SELECT row contracts. SQL names are intentionally preserved for imports.
 * UUIDs are created by crypto.randomUUID() before inserts. Dates are epoch-ms.
 * Hash fields contain SHA-256 digests, never raw session/refresh/invite tokens.
 */
export type Plan = 'free' | 'pro' | 'team';
export type Provider = 'github' | 'google';
export type OwnerType = 'account' | 'team';
export type TeamRole = 'owner' | 'member';
export type AuthChannel = 'desktop' | 'web';
export type AccountRole = 'user' | 'admin';
export type AdminAuditAction = 'suspend' | 'resume' | 'extend_trial' | 'mint_license_code' | 'revoke_license_code' | 'test_notice' | 'create_coupon' | 'disable_coupon';
export type NoticeKind = 'welcome' | 'trial_ending_3d' | 'trial_ending_1d' | 'trial_ended';
export type CronStatus = 'active' | 'paused' | 'deleted';
export type SqlBoolean = 0 | 1;
export type EpochMilliseconds = number;
export type SerializedJson = string;

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatar_url: string | null;
  readonly plan: Plan;
  readonly stripe_customer_id: string | null;
  readonly created_at: EpochMilliseconds;
  readonly updated_at: EpochMilliseconds;
  readonly role: AccountRole;
  readonly trial_started_at: EpochMilliseconds | null;
  readonly trial_expires_at: EpochMilliseconds | null;
  readonly suspended_at: EpochMilliseconds | null;
  readonly suspension_reason: string | null;
  readonly last_seen_at: EpochMilliseconds | null;
  readonly checkout_generation: number;
  readonly checkout_open_until: EpochMilliseconds | null;
  readonly checkout_interval: string;
  readonly checkout_coupon: string;
  readonly checkout_session_id: string | null;
  readonly notices_opt_out: SqlBoolean;
}

export interface IdentityRow {
  readonly id: string;
  readonly account_id: string;
  readonly provider: Provider;
  readonly provider_user_id: string;
  readonly email: string | null;
  readonly email_verified: SqlBoolean;
  readonly created_at: EpochMilliseconds;
}

export interface SessionRow {
  readonly id: string;
  readonly account_id: string;
  readonly token_hash: string;
  readonly expires_at: EpochMilliseconds;
  readonly revoked_at: EpochMilliseconds | null;
  readonly created_at: EpochMilliseconds;
  readonly last_used_at: EpochMilliseconds | null;
  readonly csrf_hash: string | null;
  readonly channel: AuthChannel;
  /** Refresh token issued with this session (migration 0010); null for older sessions. */
  readonly refresh_id: string | null;
}

export interface RefreshTokenRow {
  readonly id: string;
  readonly account_id: string;
  readonly token_hash: string;
  readonly rotated_from: string | null;
  readonly used_at: EpochMilliseconds | null;
  readonly expires_at: EpochMilliseconds;
  readonly revoked_at: EpochMilliseconds | null;
  readonly created_at: EpochMilliseconds;
  readonly channel: AuthChannel;
  /** Migration 0011: 'superseded' by a retry, revoked with its 'family', or null (logout, older rows). */
  readonly revoked_reason: 'superseded' | 'family' | null;
}

/** Desktop app that started a login; each one registers its own deep-link scheme. */
export type DesktopClient = 'nexus' | 'shot';

export interface OAuthStateRow {
  readonly state: string;
  readonly provider: Provider;
  readonly code_verifier: string;
  readonly app_state: string | null;
  readonly code_challenge: string | null;
  readonly created_at: EpochMilliseconds;
  readonly expires_at: EpochMilliseconds;
  readonly flow: AuthChannel;
  readonly web_state_hash: string | null;
  readonly client: DesktopClient;
}

export interface AuthCodeRow {
  readonly code_hash: string;
  readonly account_id: string;
  readonly used_at: EpochMilliseconds | null;
  readonly expires_at: EpochMilliseconds;
  readonly created_at: EpochMilliseconds;
  readonly code_challenge: string | null;
}

export interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly owner_account_id: string;
  readonly created_at: EpochMilliseconds;
}

export interface TeamMemberRow {
  readonly team_id: string;
  readonly account_id: string;
  readonly role: TeamRole;
  readonly joined_at: EpochMilliseconds;
}

export interface TeamInviteRow {
  readonly code_hash: string;
  readonly code_prefix: string;
  readonly team_id: string;
  readonly created_by: string;
  readonly max_uses: number;
  readonly used_count: number;
  readonly expires_at: EpochMilliseconds;
  readonly revoked_at: EpochMilliseconds | null;
  readonly created_at: EpochMilliseconds;
}

export interface SubscriptionRow {
  readonly id: string;
  readonly owner_type: OwnerType;
  readonly account_id: string | null;
  readonly team_id: string | null;
  readonly stripe_subscription_id: string;
  readonly stripe_customer_id: string;
  readonly plan: Plan;
  readonly billing_interval: string | null;
  readonly status: string;
  readonly seats: number;
  readonly current_period_end: EpochMilliseconds | null;
  readonly grace_until: EpochMilliseconds | null;
  readonly created_at: EpochMilliseconds;
  readonly updated_at: EpochMilliseconds;
}

export interface StripeEventRow {
  readonly event_id: string;
  readonly type: string;
  readonly processed_at: EpochMilliseconds | null;
  readonly payload: SerializedJson;
  readonly created_at: EpochMilliseconds;
}

export interface CronScheduleRow {
  readonly account_id: string;
  readonly project_id: string;
  readonly schedule_id: string;
  readonly version: number;
  readonly definition: SerializedJson;
  readonly definition_hash: string;
  readonly status: CronStatus;
  readonly updated_at: EpochMilliseconds;
}

export interface CronLeaseRow {
  readonly account_id: string;
  readonly project_id: string;
  readonly schedule_id: string;
  readonly occurrence_at: EpochMilliseconds;
  readonly token_hash: string | null;
  readonly version: number;
  readonly expires_at: EpochMilliseconds;
  readonly updated_at: EpochMilliseconds;
}

export interface SyncProjectRow {
  readonly account_id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly entities: SerializedJson;
  readonly entity_count: number;
  readonly state_bytes: number;
  readonly updated_at: EpochMilliseconds;
}

export interface SystemMetadataRow {
  readonly key: string;
  readonly value: string;
}

export interface LicenseCodeRow {
  readonly id: string;
  readonly code_hash: string;
  readonly code_suffix: string;
  readonly plan: Plan;
  readonly period_days: number | null;
  readonly max_uses: number;
  readonly note: string;
  readonly created_by: string | null;
  readonly expires_at: EpochMilliseconds | null;
  readonly revoked_at: EpochMilliseconds | null;
  readonly created_at: EpochMilliseconds;
}

export interface LicenseRedemptionRow {
  readonly code_id: string;
  readonly account_id: string;
  readonly redeemed_at: EpochMilliseconds;
}

export interface AccountNoticeRow {
  readonly account_id: string;
  readonly kind: NoticeKind;
  readonly sent_at: EpochMilliseconds;
  readonly provider_id: string | null;
}

export interface AdminAuditRow {
  readonly id: string;
  readonly actor_account_id: string | null;
  readonly target_account_id: string | null;
  readonly action: AdminAuditAction;
  readonly details: SerializedJson;
  readonly created_at: EpochMilliseconds;
}

export interface BugReportRow {
  readonly id: string;
  readonly account_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly steps: string | null;
  readonly category: BugCategory;
  readonly impact: BugImpact;
  readonly severity: BugSeverity;
  readonly status: BugStatus;
  readonly app_version: string;
  readonly platform: BugPlatform;
  readonly arch: string;
  readonly os_version: string | null;
  readonly adapter: string | null;
  readonly model: string | null;
  readonly pane_count: number | null;
  readonly mission_active: SqlBoolean | null;
  readonly diagnostics_json: SerializedJson | null;
  readonly fingerprint: string;
  readonly duplicate_of: string | null;
  readonly fix_summary: string | null;
  readonly fix_pr_url: string | null;
  readonly created_at: EpochMilliseconds;
  readonly updated_at: EpochMilliseconds;
  readonly diagnostics_expires_at: EpochMilliseconds;
}

export interface BugReportEventRow {
  readonly id: string;
  readonly report_id: string;
  readonly actor_account_id: string | null;
  readonly kind: BugEventKind;
  readonly details_json: SerializedJson;
  readonly created_at: EpochMilliseconds;
}
