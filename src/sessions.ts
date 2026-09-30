import { hashToken, randomToken } from './crypto.js';
import type { AuthChannel, RefreshTokenRow, SessionRow } from './db/schema.js';
export const SESSION_TTL_MS=15*60*1000;
export const REFRESH_TTL_MS=30*24*60*60*1000;
export interface Tokens {session:string;refresh:string;csrf:string|null;}
export async function issueTokens(db:D1Database,accountId:string,channel:AuthChannel,now=Date.now(),rotatedFrom:string|null=null):Promise<Tokens>{
  const session=randomToken(),refresh=randomToken(),csrf=channel==='web'?randomToken():null;
  const [sessionHash,refreshHash,csrfHash]=await Promise.all([hashToken(session),hashToken(refresh),csrf?hashToken(csrf):Promise.resolve(null)]);
  await db.batch([
    db.prepare('INSERT INTO sessions(id,account_id,token_hash,expires_at,created_at,csrf_hash,channel) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),accountId,sessionHash,now+SESSION_TTL_MS,now,csrfHash,channel),
    db.prepare('INSERT INTO refresh_tokens(id,account_id,token_hash,rotated_from,expires_at,created_at,channel) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),accountId,refreshHash,rotatedFrom,now+REFRESH_TTL_MS,now,channel),
  ]);return {session,refresh,csrf};
}
export async function sessionFor(db:D1Database,raw:string,channel:AuthChannel,now=Date.now()):Promise<SessionRow|null>{return db.prepare('SELECT * FROM sessions WHERE token_hash=? AND channel=? AND revoked_at IS NULL AND expires_at>? LIMIT 1').bind(await hashToken(raw),channel,now).first<SessionRow>();}
export async function revokeAll(db:D1Database,accountId:string,now=Date.now(),channel?:AuthChannel):Promise<void>{
  const clause=channel?' AND channel=?':'';const args=channel?[now,accountId,channel]:[now,accountId];
  await db.batch([db.prepare('UPDATE sessions SET revoked_at=? WHERE account_id=?'+clause).bind(...args),db.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE account_id=?'+clause).bind(...args)]);
}
export async function rotateRefresh(db:D1Database,raw:string,channel:AuthChannel,now=Date.now()):Promise<{accountId:string;tokens:Tokens}|null>{
  const hash=await hashToken(raw);
  const row=await db.prepare('UPDATE refresh_tokens SET used_at=? WHERE token_hash=? AND channel=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING *').bind(now,hash,channel,now).first<RefreshTokenRow>();
  if(!row){const prior=await db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=? AND channel=? LIMIT 1').bind(hash,channel).first<RefreshTokenRow>();if(prior)await revokeAll(db,prior.account_id,now,channel);return null;}
  return {accountId:row.account_id,tokens:await issueTokens(db,row.account_id,channel,now,row.id)};
}
export async function consumeAuthCode(db:D1Database,raw:string,verifier:string|undefined,challenge:(value:string)=>Promise<string>,now=Date.now()):Promise<string|null>{
  const hash=await hashToken(raw);const expected=verifier?await challenge(verifier):null;
  const condition=expected?'code_challenge=?':'code_challenge IS NULL';
  const statement=db.prepare(`UPDATE auth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>? AND ${condition} RETURNING account_id`);
  const args=expected?[now,hash,now,expected]:[now,hash,now];return (await statement.bind(...args).first<{account_id:string}>())?.account_id??null;
}
