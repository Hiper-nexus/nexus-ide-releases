import type { Config } from './config.js';
export async function isAuthorizedAdmin(db:D1Database,accountId:string,config:Config):Promise<boolean>{
  const emails=config.ADMIN_EMAILS.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);if(!emails.length)return false;
  const placeholders=emails.map(()=>'?').join(',');
  const row=await db.prepare(`SELECT i.id FROM identities i JOIN accounts a ON a.id=i.account_id WHERE i.account_id=? AND a.role='admin' AND i.email_verified=1 AND lower(i.email) IN (${placeholders}) LIMIT 1`).bind(accountId,...emails).first<{id:string}>();return Boolean(row);
}
