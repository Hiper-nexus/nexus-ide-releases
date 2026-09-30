export function randomToken():string {const bytes=crypto.getRandomValues(new Uint8Array(32));return base64Url(bytes);}
function base64Url(bytes:Uint8Array):string {return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export async function hashToken(value:string):Promise<string>{const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));return [...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function pkceChallenge(verifier:string):Promise<string>{return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));}
export function safeEqual(a:string,b:string):boolean{const left=new TextEncoder().encode(a),right=new TextEncoder().encode(b);let mismatch=left.length^right.length;const length=Math.max(left.length,right.length);for(let i=0;i<length;i++)mismatch|=(left[i]??0)^(right[i]??0);return mismatch===0;}
export function parseBearer(value:string|undefined):string|null{return value?.startsWith('Bearer ')&&value.length>7?value.slice(7):null;}
