import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
export const MAX_BODY_BYTES=256*1024;
export async function readBoundedBody(request:Request,maxBytes=MAX_BODY_BYTES):Promise<string>{
  const declared=Number(request.headers.get('content-length'));if(declared>maxBytes)throw new HTTPException(413,{message:'Corpo da requisição muito grande.'});
  if(!request.body)return '';const reader=request.body.getReader();let total=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new HTTPException(413,{message:'Corpo da requisição muito grande.'});}chunks.push(value);}}finally{reader.releaseLock();}
  const combined=new Uint8Array(total);let offset=0;for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(combined);
}
export async function jsonBody<T>(request:Request,schema:z.ZodType<T>):Promise<T>{let data:unknown;try{data=JSON.parse(await readBoundedBody(request));}catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:'Dados inválidos.'});}const parsed=schema.safeParse(data);if(!parsed.success)throw new HTTPException(400,{message:'Dados inválidos.'});return parsed.data;}
export function safeReturnPath(value:unknown):string{return value==='/conta'?'/conta':'/conta';}
export function isAllowedWebOrigin(origin:string|null|undefined,site:string):boolean{return origin===new URL(site).origin;}
