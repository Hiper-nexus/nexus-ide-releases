import type { Config } from './config.js';
import { entitlementFor } from './licences.js';
import type { AccountRow } from './db/schema.js';
import { isAuthorizedAdmin } from './admin-identity.js';
export interface AccessView {access:'trial'|'pro'|'suspended'|'inactive';plan:'free'|'pro'|'team';status:'none'|'active'|'past_due';trialEndsAt:string|null;maxAgents:number|null;cloudSync:boolean;}
export async function accountAccess(db:D1Database,accountId:string,config:Config,now=Date.now()):Promise<AccessView>{
  const account=await db.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first<AccountRow>();
  const inactive:AccessView={access:'inactive',plan:'free',status:'none',trialEndsAt:null,maxAgents:0,cloudSync:false};if(!account)return inactive;
  const trialEndsAt=account.trial_expires_at?new Date(account.trial_expires_at).toISOString():null;
  if(account.suspended_at!==null)return {...inactive,access:'suspended',trialEndsAt};
  const paid=await entitlementFor(db,accountId,now);if(paid.plan!=='free')return {access:'pro',plan:paid.plan,status:paid.status,trialEndsAt,maxAgents:null,cloudSync:true};
  if(account.role==='admin'&&await isAuthorizedAdmin(db,accountId,config))return {access:'pro',plan:'pro',status:'active',trialEndsAt,maxAgents:null,cloudSync:true};
  if(account.trial_expires_at!==null&&account.trial_expires_at>now)return {access:'trial',plan:'pro',status:'active',trialEndsAt,maxAgents:config.TRIAL_MAX_AGENTS,cloudSync:config.TRIAL_CLOUD_SYNC==='true'};
  return {...inactive,trialEndsAt};
}
