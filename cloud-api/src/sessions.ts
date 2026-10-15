import { hashToken, randomToken } from './crypto.js';
import type { AuthChannel, RefreshTokenRow, SessionRow } from './db/schema.js';
export const SESSION_TTL_MS=15*60*1000;
export const REFRESH_TTL_MS=30*24*60*60*1000;
/** A rotated refresh presented again this soon, before its successor was ever used, is the same client
 * retrying a rotation whose response it lost (timeout, quit, failed Keychain write). Counted from the
 * first rotation, so retries never extend it. */
export const REFRESH_REUSE_GRACE_MS=60*1000;
export interface Tokens {session:string;refresh:string;csrf:string|null;}
const UNREVOKED_PARENT='EXISTS(SELECT 1 FROM refresh_tokens WHERE id=? AND revoked_at IS NULL)';
/** Binds the rotated token twice: no successor of it, nor the session issued with one, was ever used. */
const SUCCESSORS_UNUSED='NOT EXISTS(SELECT 1 FROM refresh_tokens WHERE rotated_from=? AND used_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM sessions s JOIN refresh_tokens c ON c.id=s.refresh_id WHERE c.rotated_from=? AND s.last_used_at IS NOT NULL)';
/** The family is the rotated_from tree under `?`, its root included. */
const FAMILY='WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.id FROM refresh_tokens r JOIN family f ON r.rotated_from=f.id) ';
/** Prepares a token pair whose two inserts share `guard`: both happen or neither does. The session records
 * the refresh token issued with it, so revoking a family also reaches its sessions. */
async function preparePair(db:D1Database,accountId:string,channel:AuthChannel,now:number,parent:string|null,guard:string,args:string[]){
  const session=randomToken(),refresh=randomToken(),csrf=channel==='web'?randomToken():null,refreshId=crypto.randomUUID();
  const [sessionHash,refreshHash,csrfHash]=await Promise.all([hashToken(session),hashToken(refresh),csrf?hashToken(csrf):Promise.resolve(null)]);
  const where=guard?' WHERE '+guard:'';
  return {tokens:{session,refresh,csrf},refreshId,statements:[
    db.prepare('INSERT INTO sessions(id,account_id,token_hash,expires_at,created_at,csrf_hash,channel,refresh_id) SELECT ?,?,?,?,?,?,?,?'+where).bind(crypto.randomUUID(),accountId,sessionHash,now+SESSION_TTL_MS,now,csrfHash,channel,refreshId,...args),
    db.prepare('INSERT INTO refresh_tokens(id,account_id,token_hash,rotated_from,expires_at,created_at,channel) SELECT ?,?,?,?,?,?,?'+where+' RETURNING id').bind(refreshId,accountId,refreshHash,parent,now+REFRESH_TTL_MS,now,channel,...args),
  ]};
}
/** Inserts a token pair. With `parent`, both inserts only happen while that refresh token is
 * still unrevoked, in one atomic batch: a rotation that loses the race with a revocation
 * (logout or replay detection) issues nothing instead of surviving it. */
async function issue(db:D1Database,accountId:string,channel:AuthChannel,now:number,parent:string|null):Promise<Tokens|null>{
  const pair=await preparePair(db,accountId,channel,now,parent,parent?UNREVOKED_PARENT:'',parent?[parent]:[]);
  const [,inserted]=await db.batch<{id:string}>(pair.statements);return inserted.results.length?pair.tokens:null;
}
export async function issueTokens(db:D1Database,accountId:string,channel:AuthChannel,now=Date.now()):Promise<Tokens>{
  const tokens=await issue(db,accountId,channel,now,null);if(!tokens)throw new Error('token issuance failed');return tokens;
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
  const row=await db.prepare('WITH RECURSIVE up(id,parent,depth) AS (SELECT id,rotated_from,0 FROM refresh_tokens WHERE id=? UNION ALL SELECT r.id,r.rotated_from,up.depth+1 FROM refresh_tokens r JOIN up ON r.id=up.parent) SELECT id FROM up ORDER BY depth DESC LIMIT 1').bind(id).first<{id:string}>();
  return row?.id??id;
}
/** Replays a rotation whose response was lost: the unused successor and the session issued with it are
 * superseded by a new pair, in one transaction. A concurrent retry runs whole before or after this one,
 * so only one pair stays alive. Nothing is issued once any successor of `prior`, or its session, was used:
 * that is reuse. The app uses a new session right away, so the window shrinks to about one round trip. */
async function retryRotation(db:D1Database,prior:RefreshTokenRow,root:string,now:number):Promise<Tokens|null>{
  const unused='SELECT id FROM refresh_tokens WHERE rotated_from=? AND used_at IS NULL AND revoked_at IS NULL';
  // Every statement shares the guard: a refused retry changes nothing and the caller revokes the family.
  const guard=`${UNREVOKED_PARENT} AND ${SUCCESSORS_UNUSED}`,args=[prior.id,prior.id,prior.id];
  const pair=await preparePair(db,prior.account_id,prior.channel,now,prior.id,guard,args);
  const results=await db.batch<{id:string}>([
    db.prepare(`UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL AND refresh_id IN (${unused}) AND ${guard}`).bind(now,prior.id,...args),
    db.prepare(`UPDATE refresh_tokens SET revoked_at=? WHERE id IN (${unused}) AND ${guard}`).bind(now,prior.id,...args),
    ...pair.statements,
    db.prepare("INSERT INTO auth_events(id,account_id,kind,family_root,created_at) SELECT ?,?,'refresh_reuse_grace',?,? WHERE EXISTS(SELECT 1 FROM refresh_tokens WHERE id=?)").bind(crypto.randomUUID(),prior.account_id,root,now,pair.refreshId),
  ]);
  return results[3].results.length?pair.tokens:null;
}
/** Sessions issued before migration 0010 have no refresh_id and are not reached: they expire within SESSION_TTL_MS. */
async function revokeFamily(db:D1Database,accountId:string,root:string,now:number):Promise<void>{
  await db.batch([
    db.prepare(FAMILY+'UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL AND refresh_id IN (SELECT id FROM family)').bind(root,now),
    db.prepare(FAMILY+'UPDATE refresh_tokens SET revoked_at=? WHERE revoked_at IS NULL AND id IN (SELECT id FROM family)').bind(root,now),
    db.prepare("INSERT INTO auth_events(id,account_id,kind,family_root,created_at) VALUES(?,?,'refresh_reuse_family_revoked',?,?)").bind(crypto.randomUUID(),accountId,root,now),
  ]);
}
export async function rotateRefresh(db:D1Database,raw:string,channel:AuthChannel,now=Date.now()):Promise<{accountId:string;tokens:Tokens}|null>{
  const hash=await hashToken(raw);
  const row=await db.prepare('UPDATE refresh_tokens SET used_at=? WHERE token_hash=? AND channel=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING *').bind(now,hash,channel,now).first<RefreshTokenRow>();
  if(row){const tokens=await issue(db,row.account_id,channel,now,row.id);return tokens?{accountId:row.account_id,tokens}:null;}
  const prior=await db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=? AND channel=? LIMIT 1').bind(hash,channel).first<RefreshTokenRow>();
  // Only a rotated, still-unrevoked token proves reuse. A revoked or expired one is a logged-out app
  // waking up: revoking again would sign every other app out, and each of them would do the same back.
  if(!prior||prior.used_at===null||prior.revoked_at!==null||prior.expires_at<=now)return null;
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
