'use strict';
const assert=require('assert');
const nodeCrypto=require('crypto');
const crypto=nodeCrypto.webcrypto;
const core=require('../kucoin-monitor/launcher-core.js');

function response(status,body){
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  return {
    status,
    ok:status>=200&&status<300,
    async json(){return JSON.parse(bytes.toString('utf8'))},
    async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}
  };
}
function contentsResponse(bytes){
  return response(200,{type:'file',encoding:'base64',size:bytes.byteLength,content:Buffer.from(bytes).toString('base64')});
}
async function digest(bytes){
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
}
function jsonBytes(value){return Buffer.from(JSON.stringify(value)+'\n','utf8')}

async function fixtures({
  html='<!doctype html><html><body>FUTURE DASHBOARD GENERATION</body></html>',
  manifestMutate=null,
  transportMutate=null,
  releaseMutate=null,
  releaseStatus=200,
  chunkMutate=null,
  missingTransport=false
}={}){
  const dashboardBytes=Buffer.from(html,'utf8');
  const dashboardName='dashboard-live-future.html';
  const dashboardSha=await digest(dashboardBytes);
  const manifest={
    schema_version:1,
    authority:'KUCOIN_RUNTIME_STATE_RELEASE_V1',
    trade_authority:false,
    created_at:'2026-08-21T08:45:00Z',
    source_sha:'a'.repeat(40),
    dashboard_asset:{name:dashboardName,sha256:dashboardSha,bytes:dashboardBytes.byteLength},
    dashboard_contract:{
      loader_contract_version:1,
      artifact_type:'KUCOIN_CONTROL_ROOM_STANDALONE_HTML',
      transport_tag:'runtime-state-v1',
      manifest_asset:'runtime_state_manifest.json',
      dashboard_asset:dashboardName,
      requires_sha256:true,
      generation_agnostic:true
    },
    policy:{main_is_source_authority:true,release_is_runtime_state_authority:true,runtime_state_has_no_trade_authority:true,checksum_required_before_restore:true}
  };
  if(manifestMutate)manifestMutate(manifest);
  const manifestBytes=jsonBytes(manifest);
  const manifestSha=await digest(manifestBytes);
  const split=Math.max(1,Math.floor(dashboardBytes.byteLength/2));
  const originalChunks=[dashboardBytes.subarray(0,split),dashboardBytes.subarray(split)];
  const chunks=[];
  for(let index=0;index<originalChunks.length;index++){
    const bytes=originalChunks[index];
    chunks.push({
      index,
      path:`generations/${manifestSha}/chunks/part-${String(index).padStart(4,'0')}.bin`,
      bytes:bytes.byteLength,
      sha256:await digest(bytes)
    });
  }
  const transport={
    schema_version:1,
    authority:'KUCOIN_RUNTIME_BROWSER_TRANSPORT_V1',
    trade_authority:false,
    execution_authority:false,
    release_tag:'runtime-state-v1',
    source_sha:'a'.repeat(40),
    runtime_created_at:'2026-08-21T08:45:00Z',
    generation:manifestSha,
    runtime_manifest:{
      path:`generations/${manifestSha}/runtime_state_manifest.json`,
      bytes:manifestBytes.byteLength,
      sha256:manifestSha
    },
    dashboard:{
      asset_name:dashboardName,
      bytes:dashboardBytes.byteLength,
      sha256:dashboardSha,
      chunk_bytes_max:700000,
      chunk_count:chunks.length,
      chunks
    },
    policy:{
      release_remains_runtime_authority:true,
      branch_is_browser_transport_only:true,
      release_asset_digest_verification_required_in_browser:true,
      runtime_manifest_verification_required_in_browser:true,
      no_trade_authority:true
    }
  };
  if(transportMutate)transportMutate(transport);
  const transportBytes=jsonBytes(transport);
  const release={
    id:99,
    assets:[
      {name:'runtime_state_manifest.json',size:manifestBytes.byteLength,digest:`sha256:${manifestSha}`,url:'https://api.github.test/releases/assets/manifest'},
      {name:dashboardName,size:dashboardBytes.byteLength,digest:`sha256:${dashboardSha}`,url:'https://api.github.test/releases/assets/dashboard'}
    ]
  };
  if(releaseMutate)releaseMutate(release);

  const files=new Map([
    ['transport_manifest.json',transportBytes],
    [transport.runtime_manifest.path,manifestBytes]
  ]);
  transport.dashboard.chunks.forEach((row,index)=>{
    let bytes=originalChunks[index];
    if(chunkMutate)bytes=chunkMutate(Buffer.from(bytes),index);
    files.set(row.path,bytes);
  });
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const text=String(url);calls.push(text);
    const auth=options.headers&&options.headers.Authorization;
    if(auth==='Bearer bad-token')return response(401,{message:'unauthorized'});
    if(text.includes('/releases/tags/'))return response(releaseStatus,releaseStatus===200?release:{message:'not found'});
    if(text.includes('/releases/assets/'))throw new Error('browser must not use redirecting Release asset binary endpoint');
    const match=/\/contents\/(.+?)\?ref=/.exec(text);
    if(match){
      const path=match[1].split('/').map(decodeURIComponent).join('/');
      if(missingTransport&&path==='transport_manifest.json')return response(404,{message:'not found'});
      const bytes=files.get(path);
      return bytes?contentsResponse(bytes):response(404,{message:'not found'});
    }
    return response(404,{message:'not found'});
  };
  return {fetchImpl,calls};
}
async function rejectsCode(promise,code){await assert.rejects(promise,error=>error&&error.code===code,`expected ${code}`);}

(async()=>{
  // Authentication/bootstrap failures stay fail closed.
  await rejectsCode(core.loadVerifiedDashboard({token:'',fetchImpl:async()=>{throw new Error('should not fetch')},cryptoImpl:crypto}),'MISSING_TOKEN');
  {const {fetchImpl}=await fixtures();await rejectsCode(core.loadVerifiedDashboard({token:'bad-token',fetchImpl,cryptoImpl:crypto}),'AUTH_FAILED');}
  {const {fetchImpl}=await fixtures({releaseStatus:404});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'RELEASE_UNAVAILABLE');}
  {const {fetchImpl}=await fixtures({missingTransport:true});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'BROWSER_TRANSPORT_UNAVAILABLE');}

  // A future dashboard generation loads through Contents API without touching Release binary redirects.
  {
    const {fetchImpl,calls}=await fixtures({html:'<!doctype html><html><body>CONTROL ROOM GENERATION 99</body></html>'});
    const loaded=await core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto});
    assert.match(loaded.html,/GENERATION 99/);
    assert.strictEqual(loaded.contract.name,'dashboard-live-future.html');
    assert.strictEqual(loaded.contract.loaderContract.generationAgnostic,true);
    assert.strictEqual(loaded.contract.loaderContract.version,1);
    assert.strictEqual(loaded.transportRef,'runtime-browser-v1');
    assert.ok(calls.some(url=>url.includes('/contents/transport_manifest.json')));
    assert.strictEqual(calls.some(url=>url.includes('/releases/assets/')),false);
  }

  // Release identity remains authoritative over the browser mirror.
  {const {fetchImpl}=await fixtures({releaseMutate:release=>{delete release.assets[0].digest}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'RELEASE_DIGEST_UNAVAILABLE');}
  {const {fetchImpl}=await fixtures({transportMutate:transport=>{transport.runtime_manifest.bytes+=1}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'BROWSER_TRANSPORT_STALE');}
  {const {fetchImpl}=await fixtures({releaseMutate:release=>{release.assets[1].digest=`sha256:${'f'.repeat(64)}`}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'RELEASE_ASSET_MISMATCH');}

  // Content integrity remains mandatory at chunk, manifest and complete-dashboard levels.
  {const {fetchImpl}=await fixtures({chunkMutate:(bytes,index)=>{if(index===0)bytes[0]^=1;return bytes}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'CHECKSUM_MISMATCH');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.authority='WRONG'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'MANIFEST_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_asset.sha256='not-a-sha'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'MANIFEST_INVALID');}

  // Loader contract itself is authoritative and generation-independent.
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{delete manifest.dashboard_contract}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.loader_contract_version=2}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_UNSUPPORTED');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.requires_sha256=false}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.generation_agnostic=false}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.transport_tag='wrong-release'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.manifest_asset='wrong-manifest.json'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.dashboard_asset='other-dashboard.html'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}

  // There must be no hard dependency on legacy dashboard generation markers or Release-binary browser downloads.
  const source=require('fs').readFileSync(require('path').join(__dirname,'../kucoin-monitor/launcher-core.js'),'utf8');
  assert.doesNotMatch(source,/CONTROL ROOM V4|CONTROL ROOM V5|cr-v4|cr-v5/i);
  assert.doesNotMatch(source,/fetchAssetBytes\s*\(/i);
  assert.strictEqual(core.DEFAULT_RELEASE_TAG,'runtime-state-v1');
  assert.strictEqual(core.DEFAULT_TRANSPORT_REF,'runtime-browser-v1');
  assert.strictEqual(core.SUPPORTED_LOADER_CONTRACT_VERSION,1);
  assert.strictEqual(core.SUPPORTED_TRANSPORT_SCHEMA_VERSION,1);
  console.log('KuCoin launcher runtime-state browser transport tests passed.');
})().catch(error=>{console.error(error);process.exit(1)});
