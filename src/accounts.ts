import type { AccountRow, Provider } from './db/schema.js';
import type { Config } from './config.js';
export interface OAuthProfile {provider:Provider;subject:string;email:string|null;verified:boolean;name:string|null;avatar:string|null;}
const MAX_RACE_RETRIES=3;
export async function findOrCreateAccount(db:D1Database,profile:OAuthProfile,config:Config):Promise<AccountRow>{
  const allowlisted=profile.verified&&profile.email!==null&&config.ADMIN_EMAILS.split(',').map(value=>value.trim().toLowerCase()).includes(profile.email.trim().toLowerCase());
  for(let attempt=0;attempt<=MAX_RACE_RETRIES;attempt++){
    const existing=await db.prepare('SELECT a.* FROM accounts a JOIN identities i ON i.account_id=a.id WHERE i.provider=? AND i.provider_user_id=? LIMIT 1').bind(profile.provider,profile.subject).first<AccountRow>();if(existing){await db.prepare('UPDATE accounts SET last_seen_at=?,role=? WHERE id=?').bind(Date.now(),allowlisted?'admin':existing.role,existing.id).run();return {...existing,last_seen_at:Date.now(),role:allowlisted?'admin':existing.role};}
    const email=profile.email?.trim().toLowerCase()??null;
    const byEmail=email&&profile.verified?await db.prepare('SELECT * FROM accounts WHERE email=? LIMIT 1').bind(email).first<AccountRow>():null;
    const verified=byEmail?await db.prepare('SELECT id FROM identities WHERE account_id=? AND email_verified=1 AND lower(email)=? LIMIT 1').bind(byEmail.id,email).first<{id:string}>():null;
    const accountId=byEmail&&verified?byEmail.id:crypto.randomUUID();const accountEmail=email&&profile.verified&&!byEmail?email:`${profile.provider}:${profile.subject}`;
    const now=Date.now();const identity=db.prepare('INSERT INTO identities(id,account_id,provider,provider_user_id,email,email_verified,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),accountId,profile.provider,profile.subject,email,profile.verified?1:0,now);
    try{
      if(byEmail&&verified)await db.batch([identity,db.prepare('UPDATE accounts SET last_seen_at=?,role=? WHERE id=?').bind(now,allowlisted?'admin':byEmail.role,accountId)]);else await db.batch([db.prepare('INSERT INTO accounts(id,email,name,avatar_url,created_at,updated_at,role,trial_started_at,trial_expires_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(accountId,accountEmail,profile.name,profile.avatar,now,now,allowlisted?'admin':'user',now,now+config.TRIAL_DAYS*24*60*60*1000,now),identity]);
      const created=await db.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first<AccountRow>();if(!created)throw new Error('account insert missing');return created;
    }catch(error){if(attempt<MAX_RACE_RETRIES&&error instanceof Error&&/unique|constraint/i.test(error.message))continue;throw error;}
  }
  throw new Error('account race exhausted');
}
