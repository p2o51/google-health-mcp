import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { receiveWebhook, verifyGoogleSignature, derToRaw } from '../src/webhooks.ts';
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk=publicKey.export({format:'jwk'});
const protobuf=(tag:number,b:Uint8Array)=>Buffer.concat([Buffer.from([tag,b.length]),b]);
const keyValue=Buffer.concat([protobuf(18,Buffer.from([8,3,16,2,24,1])),protobuf(26,Buffer.from(jwk.x!,'base64url')),protobuf(34,Buffer.from(jwk.y!,'base64url'))]);
const keys={key:[{status:'ENABLED',keyId:42,outputPrefixType:'TINK',keyData:{typeUrl:'type.googleapis.com/google.crypto.tink.EcdsaPublicKey',value:keyValue.toString('base64')}}]};
const secret='test-secret-'.repeat(4);
const marker={data:{healthUserId:'owner-id',operation:'UPSERT',dataType:'sleep'}};
const signature=(body:string)=>Buffer.concat([Buffer.from([1,0,0,0,42]),sign('sha256',Buffer.from(body),privateKey)]).toString('base64');
function setup(){
 const map=new Map<string,string>();let puts=0;
 const env={WEBHOOK_SECRET:secret,WEBHOOK_HEALTH_USER_ID:'owner-id',OAUTH_KV:{async get(key:string,type?:string){const v=map.get(key);return v==null?null:type==='json'?JSON.parse(v):v;},async put(key:string,v:string){puts++;map.set(key,v);}} as unknown as KVNamespace};
 return {map,env,puts:()=>puts};
}
function req(body:string,auth=true,sig=signature(body)){
 return new Request('https://mcp.test/webhooks/health',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${secret}`}:{ }),'GOOGLE-HEALTH-API-SIGNATURE':sig},body});
}
test('valid Tink P256 DER signature verifies exact bytes; altered content, key ID and malformed DER fail',async()=>{
 const raw=JSON.stringify(marker);assert.equal(await verifyGoogleSignature(Buffer.from(raw),signature(raw),keys),true);
 assert.equal(await verifyGoogleSignature(Buffer.from(raw+' '),signature(raw),keys),false);
 assert.equal(await verifyGoogleSignature(Buffer.from(raw),signature(raw),{key:[]}),false);
 assert.equal(await verifyGoogleSignature(Buffer.from(raw),'garbage',keys),false);
 assert.throws(()=>derToRaw(new Uint8Array([48,2,2,0])));
});
test('two-step verification accepts configured bearer, rejects missing bearer without fetching keys',async()=>{
 const {env}=setup();const noKeys=async()=>{throw new Error('should not fetch');};
 assert.equal((await receiveWebhook(req('{"type":"verification"}'),env,noKeys)).status,200);
 assert.equal((await receiveWebhook(req('{"type":"verification"}',false),env,noKeys)).status,401);
});
test('signed owned notifications persist only change markers and duplicate delivery is idempotent',async()=>{
 const {env,map,puts}=setup();const body=JSON.stringify([marker]);
 assert.equal((await receiveWebhook(req(body),env,async()=>keys)).status,204);assert.equal(puts(),2);
 assert.equal((await receiveWebhook(req(body),env,async()=>keys)).status,204);assert.equal(puts(),2);
 const stored=map.get('health:webhook:last')!;assert.deepEqual(JSON.parse(stored).data_types,['sleep']);assert.ok(!stored.includes('owner-id'));assert.ok(!stored.includes('healthUserId'));
});
test('signature failure or wrong user cannot alter status, disabled webhook exposes nothing',async()=>{
 const {env,puts}=setup();const raw=JSON.stringify(marker);
 assert.equal((await receiveWebhook(req(raw,true,signature(raw+'x')),env,async()=>keys)).status,401);
 assert.equal((await receiveWebhook(req(JSON.stringify({data:{...marker.data,healthUserId:'someone-else'}})),env,async()=>keys)).status,204);
 assert.equal(puts(),0);assert.equal((await receiveWebhook(req(raw),{...env,WEBHOOK_SECRET:''},async()=>keys)).status,404);
});
test('body limits apply without content-length; keyset outages are retryable',async()=>{
 const {env}=setup();assert.equal((await receiveWebhook(req('x'.repeat(262145)),env,async()=>keys)).status,413);
 assert.equal((await receiveWebhook(req(JSON.stringify(marker)),env,async()=>{throw new Error('offline');})).status,503);
});
test('bad notification batches are rejected and KV errors remain retryable',async()=>{
 const {env}=setup();let body=JSON.stringify({data:{...marker.data,operation:'INVALID'}});
 assert.equal((await receiveWebhook(req(body),env,async()=>keys)).status,400);
 env.OAUTH_KV.put=async()=>{throw new Error('KV down');};body=JSON.stringify(marker);
 assert.equal((await receiveWebhook(req(body),env,async()=>keys)).status,503);
});
