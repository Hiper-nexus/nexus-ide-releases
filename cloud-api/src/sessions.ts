import { hashToken, randomToken } from './crypto.js';
import type { AuthChannel, RefreshTokenRow, SessionRow } from './db/schema.js';
export const SESSION_TTL_MS=15*60*1000;
export const REFRESH_TTL_MS=30*24*60*60*1000;
/** A rotated refresh presented again this soon, before its successor or that successor's session was ever
 * used, is the same client retrying a rotation whose response it lost (timeout, quit, failed Keychain write).
 * Counted from the first rotation, so retries never extend it. */
export const REFRESH_REUSE_GRACE_MS=60*1000;
export interface Tokens {session:string;refresh:string;csrf:string|null;}
const UNREVOKED_PARENT='EXISTS(SELECT 1 FROM refresh_tokens WHERE id=? AND revoked_at IS NULL)';
/** Binds the rotated token twice: no successor of it, nor the session issued with one, was ever used. */
const SUCCESSORS_UNUSED='NOT EXISTS(SELECT 1 FROM refresh_tokens WHERE rotated_from=? AND used_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM sessions s JOIN refresh_tokens c ON c.id=s.refresh_id WHERE c.rotated_from=? AND s.last_used_at IS NOT NULL)';
/** ponytail: the walk up to the root stops after this many links (30 days of rotations every ~4 min), so a
 * corrupted rotated_from cycle ends there. A token deeper than this finds an ancestor instead of the real root;
 * the family under that ancestor still reaches every newer token. Older branches above it are left out; the
 * upgrade path is a family_id column inherited on rotation. */
const ROOT_DEPTH_LIMIT=10_000;
/** The family is the rotated_from tree under `?`, its root included. No ceiling: a LIMIT here counts rows in
 * breadth-first order from the root, so it would cut the newest tokens first, the live tip included. UNION on
 * the id alone already ends a corrupted cycle, and no depth column, which would defeat that dedup. FAMILY only
 * runs on reuse, and a family grows at most as fast as the rate limit and expiry allow. */
const FAMILY='WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.id FROM refresh_tokens r JOIN family f ON r.rotated_from=f.id) ';
/** Prepares a token pair whose two inserts share `guard`: both happen or neither does. The session records
 * the refresh token issued with it, so revoking a family also reaches its sessions. */
async function preparePair(db:D1Database,accountId:string,channel:AuthChannel,now:number,parent:string|null,guard:string,args:(string|number)[]){
  const session=randomToken(),refresh=randomToken(),csrf=channel==='web'?randomToken():null,refreshId=crypto.randomUUID();
  const [sessionHash,refreshHash,csrfHash]=await Promise.all([hashToken(session),hashToken(refresh),csrf?hashToken(csrf):Promise.resolve(null)]);
  const where=guard?' WHERE '+guard:'';
  return {tokens:{session,refresh,csrf},refreshId,statements:[
    db.prepare('INSERT INTO sessions(id,account_id,token_hash,expires_at,created_at,csrf_hash,channel,refresh_id) SELECT ?,?,?,?,?,?,?,?'+where).bind(crypto.randomUUID(),accountId,sessionHash,now+SESSION_TTL_MS,now,csrfHash,channel,refreshId,...args),
    db.prepare('INSERT INTO refresh_tokens(id,account_id,token_hash,rotated_from,expires_at,created_at,channel) SELECT ?,?,?,?,?,?,?'+where+' RETURNING id').bind(refreshId,accountId,refreshHash,parent,now+REFRESH_TTL_MS,now,channel,...args),
  ]};
}
export async function issueTokens(db:D1Database,accountId:string,channel:AuthChannel,now=Date.now()):Promise<Tokens>{
  const pair=await preparePair(db,accountId,channel,now,null,'',[]);
  const [,inserted]=await db.batch<{id:string}>(pair.statements);if(!inserted.results.length)throw new Error('token issuance failed');return pair.tokens;
}
/** Spends `row` and issues its successor in one transaction: a failure burns nothing, and a retry of the
 * same token runs whole before or after it, never in between. The inserts only follow this claim (token
 * spent now, still unrevoked, no successor yet); a rotation that lost the claim issues nothing. */
async function claimAndIssue(db:D1Database,row:RefreshTokenRow,now:number):Promise<Tokens|null>{
  const pair=await preparePair(db,row.account_id,row.channel,now,row.id,'EXISTS(SELECT 1 FROM refresh_tokens WHERE id=? AND used_at=? AND revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM refresh_tokens WHERE rotated_from=?)',[row.id,now,row.id]);
  const [,,inserted]=await db.batch<{id:string}>([
    db.prepare('UPDATE refresh_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?').bind(now,row.id,now),
    ...pair.statements,
  ]);
  return inserted.results.length?pair.tokens:null;
}
export async function sessionFor(db:D1Database,raw:string,channel:AuthChannel,now=Date.now()):Promise<SessionRow|null>{
  const row=await db.prepare('SELECT * FROM sessions WHERE token_hash=? AND channel=? AND revoked_at IS NULL AND expires_at>? LIMIT 1').bind(await hashToken(raw),channel,now).first<SessionRow>();
  // First use only, so one write per session: a used successor session closes the retry window of its parent.
  if(row&&row.last_used_at===null){
    try{await db.prepare('UPDATE sessions SET last_used_at=? WHERE id=? AND last_used_at IS NULL').bind(now,row.id).run();}
    catch(error){console.error('nexus-cloud-api: last_used_at da sessão falhou:',error instanceof Error?error.message:'unknown');}
  }
  return row;
}
export async function revokeAll(db:D1Database,accountId:string,now=Date.now(),channel?:AuthChannel):Promise<void>{
  const clause=channel?' AND channel=?':'';const args=channel?[now,accountId,channel]:[now,accountId];
  await db.batch([db.prepare('UPDATE sessions SET revoked_at=? WHERE account_id=?'+clause).bind(...args),db.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE account_id=?'+clause).bind(...args)]);
}
/** Topmost ancestor still stored (cleanup deletes expired tokens oldest first, so the chain stays contiguous). */
async function familyRoot(db:D1Database,id:string):Promise<string>{
  const row=await db.prepare(`WITH RECURSIVE up(id,parent,depth) AS (SELECT id,rotated_from,0 FROM refresh_tokens WHERE id=? UNION ALL SELECT r.id,r.rotated_from,up.depth+1 FROM refresh_tokens r JOIN up ON r.id=up.parent WHERE up.depth<${ROOT_DEPTH_LIMIT}) SELECT id FROM up ORDER BY depth DESC LIMIT 1`).bind(id).first<{id:string}>();
  return row?.id??id;
}
/** Replays a rotation whose response was lost: the unused successor and the session issued with it are
 * superseded by a new pair, in one transaction. A concurrent retry runs whole before or after this one,
 * so only one pair stays alive. Nothing is issued once any successor of `prior`, or its session, was used:
 * that is reuse. The app uses a new session right away, so the window shrinks to about one round trip. */
async function retryRotation(db:D1Database,prior:RefreshTokenRow,root:string,now:number):Promise<Tokens|null>{
  const unused='SELECT id FROM refresh_tokens WHERE rotated_from=? AND used_at IS NULL AND revoked_at IS NULL';
  // Every statement shares the guard: a refused retry changes nothing and the caller revokes the family.
  // account_id, as in revokeFamily: a corrupted edge to another account's token must not reach it.
  const guard=`${UNREVOKED_PARENT} AND ${SUCCESSORS_UNUSED}`,args=[prior.id,prior.id,prior.id];
  const pair=await preparePair(db,prior.account_id,prior.channel,now,prior.id,guard,args);
  const results=await db.batch<{id:string}>([
    db.prepare(`UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL AND refresh_id IN (${unused}) AND ${guard}`).bind(now,prior.account_id,prior.id,...args),
    db.prepare(`UPDATE refresh_tokens SET revoked_at=?,revoked_reason='superseded' WHERE account_id=? AND id IN (${unused}) AND ${guard}`).bind(now,prior.account_id,prior.id,...args),
    ...pair.statements,
    db.prepare("INSERT INTO auth_events(id,account_id,kind,family_root,created_at) SELECT ?,?,'refresh_reuse_grace',?,? WHERE EXISTS(SELECT 1 FROM refresh_tokens WHERE id=?)").bind(crypto.randomUUID(),prior.account_id,root,now,pair.refreshId),
  ]);
  return results[3].results.length?pair.tokens:null;
}
/** Sessions issued before migration 0010 have no refresh_id and are not reached: they expire within SESSION_TTL_MS.
 * A family with no live token left (a logout, an earlier detection) has nothing to revoke: no event either.
 * Superseded tokens are relabeled, so presenting one of them again does nothing. */
async function revokeFamily(db:D1Database,accountId:string,root:string,now:number):Promise<void>{
  await db.batch([
    // First, so it sees the family before this revocation.
    db.prepare(FAMILY+"INSERT INTO auth_events(id,account_id,kind,family_root,created_at) SELECT ?,?,'refresh_reuse_family_revoked',?,? WHERE EXISTS(SELECT 1 FROM refresh_tokens WHERE account_id=? AND revoked_at IS NULL AND expires_at>? AND id IN (SELECT id FROM family))").bind(root,crypto.randomUUID(),accountId,root,now,accountId,now),
    // account_id: rotation never links accounts, and a corrupted edge must not either.
    db.prepare(FAMILY+'UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL AND refresh_id IN (SELECT id FROM family)').bind(root,now,accountId),
    db.prepare(FAMILY+"UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,?),revoked_reason='family' WHERE account_id=? AND (revoked_at IS NULL OR revoked_reason='superseded') AND id IN (SELECT id FROM family)").bind(root,now,accountId),
  ]);
}
export async function rotateRefresh(db:D1Database,raw:string,channel:AuthChannel,now=Date.now()):Promise<{accountId:string;tokens:Tokens}|null>{
  const hash=await hashToken(raw);
  const find=()=>db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=? AND channel=? LIMIT 1').bind(hash,channel).first<RefreshTokenRow>();
  let prior=await find();
  if(prior&&prior.used_at===null&&prior.revoked_at===null&&prior.expires_at>now){
    const tokens=await claimAndIssue(db,prior,now);if(tokens)return{accountId:prior.account_id,tokens};
    // Another request spent or revoked it first: decide on what the token is now.
    prior=await find();
  }
  if(!prior||prior.expires_at<=now)return null;
  // A successor superseded inside the window never reached its legitimate holder: whoever presents it
  // lost the family to whoever retried. Detection only; revokeFamily is a no-op once the family is dead.
  if(prior.revoked_reason==='superseded'){await revokeFamily(db,prior.account_id,await familyRoot(db,prior.id),now);return null;}
  // Otherwise only a rotated, still-unrevoked token proves reuse. A revoked or expired one is a logged-out app
  // waking up: revoking again would sign every other app out, and each of them would do the same back.
  if(prior.used_at===null||prior.revoked_at!==null)return null;
  const root=await familyRoot(db,prior.id);
  if(now-prior.used_at<REFRESH_REUSE_GRACE_MS){const tokens=await retryRotation(db,prior,root,now);if(tokens)return{accountId:prior.account_id,tokens};}
  // Real reuse: another holder of this family. Only the family dies; the account's other devices keep theirs.
  await revokeFamily(db,prior.account_id,root,now);return null;
}
export async function consumeAuthCode(db:D1Database,raw:string,verifier:string|undefined,challenge:(value:string)=>Promise<string>,now=Date.now()):Promise<string|null>{
  const hash=await hashToken(raw);const expected=verifier?await challenge(verifier):null;
  const condition=expected?'code_challenge=?':'code_challenge IS NULL';
  const statement=db.prepare(`UPDATE auth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>? AND ${condition} RETURNING account_id`);
  const args=expected?[now,hash,now,expected]:[now,hash,now];return (await statement.bind(...args).first<{account_id:string}>())?.account_id??null;
}
