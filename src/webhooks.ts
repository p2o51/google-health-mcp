/** Google Health webhook receiver. Raw payloads/health IDs are never logged or stored. */
const KEYSET_URL = 'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';
const MAX_BYTES = 262_144;
interface WebhookEnv { OAUTH_KV: KVNamespace; WEBHOOK_SECRET?: string; WEBHOOK_HEALTH_USER_ID?: string; }
type Keyset = { key: Array<{ status: string; keyId: number; outputPrefixType: string; keyData: { typeUrl: string; value: string } }> };
let cached: { until: number; value: Keyset } | undefined;
const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');

// Minimal bounded protobuf decoder for Tink EcdsaPublicKey and EcdsaParams.
function proto(raw: Uint8Array): Map<number, Uint8Array | number> {
  const fields = new Map<number, Uint8Array | number>(); let i = 0;
  const integer = () => { let value = 0, scale = 1; for (let n=0;n<5;n++) { const b=raw[i++]; if (b === undefined) throw new Error('Truncated protobuf'); value += (b & 127)*scale; if (!(b&128)) return value; scale *= 128; } throw new Error('Invalid varint'); };
  while (i < raw.length) {
    const tag=integer(), field=tag>>>3, wire=tag&7;
    if (!field || fields.has(field)) throw new Error('Invalid protobuf field');
    if (wire===0) fields.set(field,integer());
    else if (wire===2) { const len=integer(); if (len > raw.length-i) throw new Error('Invalid protobuf length'); fields.set(field,raw.slice(i,i+len));i+=len; }
    else throw new Error('Unsupported protobuf wire type');
  }
  return fields;
}
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0]!==48 || der[1]!==der.length-2) throw new Error('Invalid DER sequence');
  let at=2; const result=new Uint8Array(64);
  for (let part=0;part<2;part++) {
    if (der[at++]!==2) throw new Error('Invalid DER integer');
    const length=der[at++]; if (!length || length>33 || at+length>der.length || der[at]!&128) throw new Error('Invalid DER integer length/sign');
    let n=der.slice(at,at+length);at+=length;
    if (n.length===33) { if(n[0]!==0 || !(n[1]!&128)) throw new Error('Invalid DER padding');n=n.slice(1); }
    result.set(n,part*32+32-n.length);
  }
  if(at!==der.length)throw new Error('Trailing DER data');return result;
}
/** Decode Google's Tink DER/P-256 key; coordinates may include a leading sign byte. */
export async function importGooglePublicKey(value: string): Promise<CryptoKey> {
  const key=proto(bytes(value)), params=key.get(2), x=key.get(3), y=key.get(4);
  if((key.get(1)??0)!==0 || !(params instanceof Uint8Array) || !(x instanceof Uint8Array) || !(y instanceof Uint8Array))throw new Error('Invalid EC key');
  const config=proto(params);
  // Tink EcdsaSignatureEncoding: IEEE_P1363=1, DER=2.
  if(config.get(1)!==3 || config.get(2)!==2 || config.get(3)!==2)throw new Error('Unsupported EC parameters');
  const coordinate=(input:Uint8Array)=>{
    const n=input.length===33 && input[0]===0 ? input.slice(1) : input;
    if(n.length!==32)throw new Error('Invalid P-256 coordinate');
    return base64url(n);
  };
  return crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:coordinate(x),y:coordinate(y),ext:true},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
}
export async function verifyGoogleSignature(raw: Uint8Array, header: string, keyset: Keyset): Promise<boolean> {
  try {
    const signed=bytes(header);
    if(signed.length<13 || signed[0]!==1)return false;
    const keyId=new DataView(signed.buffer,signed.byteOffset, signed.byteLength).getUint32(1);
    const entry=keyset.key.find(k=>k.keyId===keyId && k.status==='ENABLED' && k.outputPrefixType==='TINK');
    if(!entry || entry.keyData.typeUrl!=='type.googleapis.com/google.crypto.tink.EcdsaPublicKey')return false;
    const publicKey = await importGooglePublicKey(entry.keyData.value);
    return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,derToRaw(signed.slice(5)),new Uint8Array(raw));
  } catch {return false;}
}
async function keyset(force=false): Promise<Keyset> {
  if(!force && cached && cached.until>Date.now())return cached.value;
  const response=await fetch(KEYSET_URL,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Keyset unavailable');
  const value=await response.json() as Keyset;
  if(!Array.isArray(value.key) || value.key.length>20)throw new Error('Invalid keyset');
  cached={value,until:Date.now()+3600_000};return value;
}
async function digest(value: Uint8Array): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(value))));
}
async function secretEqual(a: string,b: string) {
  const encoder=new TextEncoder();const x=await digest(encoder.encode(a)),y=await digest(encoder.encode(b));let diff=0;
  for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);return diff===0;
}
export async function receiveWebhook(request: Request, env: WebhookEnv, loadKeys: () => Promise<Keyset> = keyset): Promise<Response> {
  const answer=(status:number)=>new Response(null,{status,headers:{'Cache-Control':'no-store'}});
  if(!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length<32 || !env.WEBHOOK_HEALTH_USER_ID)return answer(404);
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
  if(!(await secretEqual(request.headers.get('Authorization')??'',`Bearer ${env.WEBHOOK_SECRET}`)))return answer(401);
  if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))return answer(415);
  // Bound the actual stream, not just the untrusted Content-Length header.
  const reader=request.body?.getReader();if(!reader)return answer(400);
  const chunks: Uint8Array[]=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();return answer(413);}chunks.push(value);}
  const raw=new Uint8Array(size);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}
  let payload:any;try{payload=JSON.parse(new TextDecoder().decode(raw));}catch{return answer(400);}
  if(payload?.type==='verification' && Object.keys(payload).length===1)return answer(200);
  const signature=request.headers.get('GOOGLE-HEALTH-API-SIGNATURE');if(!signature || signature.length>512)return answer(401);
  let valid=false;
  try {
    valid=await verifyGoogleSignature(raw,signature,await loadKeys());
    // Handle Google's rotating signing keys; never fetch a key URL from input.
    if(!valid && loadKeys===keyset) valid=await verifyGoogleSignature(raw,signature,await keyset(true));
  } catch {return answer(503);}
  if(!valid)return answer(401);
  const events=Array.isArray(payload)?payload:[payload];if(events.length>99)return answer(400);
  const own=events.map(e=>e?.data).filter(e=>e?.healthUserId===env.WEBHOOK_HEALTH_USER_ID);
  if(!own.length)return answer(204);
  if(own.some(e=>typeof e.dataType!=='string' || !/^[a-z][a-z0-9-]{0,79}$/.test(e.dataType) || !['UPSERT','DELETE'].includes(e.operation)))return answer(400);
  const dedupe=`health:webhook:seen:${await digest(raw)}`;
  if(await env.OAUTH_KV.get(dedupe))return answer(204);
  const marker={received_at:new Date().toISOString(),data_types:[...new Set(own.map(e=>e.dataType))],operations:[...new Set(own.map(e=>e.operation))]};
  // Persist before acknowledging; failures remain retryable by Google. A duplicate
  // under concurrent/eventually-consistent KV delivery only rewrites this marker.
  try{
    await env.OAUTH_KV.put('health:webhook:last',JSON.stringify(marker),{expirationTtl:30*86400});
    await env.OAUTH_KV.put(dedupe,'1',{expirationTtl:7*86400});
  }catch{return answer(503);}
  return answer(204);
}
