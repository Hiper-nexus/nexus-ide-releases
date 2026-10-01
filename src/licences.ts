import { importPKCS8, SignJWT } from 'jose';
import type { Config } from './config.js';
import type { AccountRow, Plan, SubscriptionRow } from './db/schema.js';
import { accountAccess } from './access.js';
const PERSONAL_TTL_SECONDS=30*24*60*60,TEAM_TTL_SECONDS=7*24*60*60;
const RANK:Record<Plan,number>={free:0,pro:1,team:2};
export interface Entitlement {plan:Plan;status:'none'|'active'|'past_due';renewsAt:string|null;graceUntil:string|null;ttl:number;}
export function selectEntitlement(rows:readonly SubscriptionRow[],now=Date.now()):Entitlement{
  let best:SubscriptionRow|null=null;
  for(const row of rows){const active=['active','trialing'].includes(row.status)&&row.current_period_end!==null&&row.current_period_end>now;const grace=row.status==='past_due'&&row.grace_until!==null&&row.grace_until>now;if(!active&&!grace)continue;if(!best||RANK[row.plan]>RANK[best.plan])best=row;}
  if(!best)return {plan:'free',status:'none',renewsAt:null,graceUntil:null,ttl:PERSONAL_TTL_SECONDS};
  const deadline=best.status==='past_due'?best.grace_until:best.current_period_end;const maximum=best.owner_type==='team'?TEAM_TTL_SECONDS:PERSONAL_TTL_SECONDS;
  return {plan:best.plan,status:best.status==='past_due'?'past_due':'active',renewsAt:best.current_period_end&&!best.stripe_subscription_id?.startsWith('codegrant:')?new Date(best.current_period_end).toISOString():null,graceUntil:best.grace_until?new Date(best.grace_until).toISOString():null,ttl:Math.max(1,Math.min(maximum,Math.floor(((deadline??now+maximum*1000)-now)/1000)))};
}
export async function entitlementFor(db:D1Database,accountId:string,now=Date.now()):Promise<Entitlement>{
  const rows=await db.prepare("SELECT s.* FROM subscriptions s WHERE (s.owner_type='account' AND s.account_id=?) OR (s.owner_type='team' AND s.team_id IN(SELECT team_id FROM team_members WHERE account_id=?)) ORDER BY CASE s.owner_type WHEN 'account' THEN 0 ELSE 1 END").bind(accountId,accountId).all<SubscriptionRow>();return selectEntitlement(rows.results,now);
}
export async function licenseForAccount(db:D1Database,accountId:string,config:Config,now=Date.now()):Promise<string>{
  const account=await db.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first<AccountRow>();if(!account)throw new Error('license account missing');
  const access=await accountAccess(db,accountId,config,now);const paid=await entitlementFor(db,accountId,now);const cacheSeconds=24*60*60;
  const remainingTrial=account.trial_expires_at?Math.max(1,Math.floor((account.trial_expires_at-now)/1000)):cacheSeconds;
  const ttl=access.access==='trial'?Math.min(cacheSeconds,remainingTrial):access.access==='pro'?Math.min(cacheSeconds,paid.plan==='free'?cacheSeconds:paid.ttl):5*60;
  const key=await importPKCS8(config.LICENSE_PRIVATE_KEY,'EdDSA');const issued=Math.floor(now/1000);
  return new SignJWT({plan:access.plan,email:account.email.includes('@')?account.email:null,status:access.status,renewsAt:paid.renewsAt,graceUntil:paid.graceUntil,access:access.access,trialEndsAt:access.trialEndsAt,limits:{maxAgents:access.maxAgents,cloudSync:access.cloudSync}}).setProtectedHeader({alg:'EdDSA',typ:'JWT'}).setSubject(account.id).setIssuer(new URL(config.PUBLIC_BASE_URL).origin).setAudience('nexus-desktop').setIssuedAt(issued).setExpirationTime(issued+ttl).sign(key);
}
