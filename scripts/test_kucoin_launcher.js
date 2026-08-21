'use strict';
const assert=require('assert');
const crypto=require('crypto').webcrypto;
const core=require('../kucoin-monitor/launcher-core.js');

function response(status,body){
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  return {status,ok:status>=200&&status<300,async json(){return JSON.parse(bytes.toString('utf8'))},async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}};
}
async function digest(bytes){
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
}
async function fixtures({html='<!doctype html><html><body>FUTURE DASHBOARD GENERATION</body></html>',manifestMutate=null,releaseStatus=200,dashboardMutate=null}={}){
  const dashboardBytes=Buffer.from(html,'utf8');
  const dashboardName='dashboard-live-future.html';
  const manifest={
    schema_version:1,
    authority:'KUCOIN_RUNTIME_STATE_RELEASE_V1',
    trade_authority:false,
    created_at:'2026-08-21T08:45:00Z',
    source_sha:'abc123',
    dashboard_asset:{name:dashboardName,sha256:await digest(dashboardBytes),bytes:dashboardBytes.byteLength},
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
  const release={id:99,assets:[{name:'runtime_state_manifest.json',url:'https://api.github.test/assets/manifest'},{name:manifest.dashboard_asset&&manifest.dashboard_asset.name||dashboardName,url:'https://api.github.test/assets/dashboard'}]};
  const fetchImpl=async(url,options={})=>{
    const auth=options.headers&&options.headers.Authorization;
    if(auth==='Bearer bad-token')return response(401,'unauthorized');
    if(url.includes('/releases/tags/'))return response(releaseStatus,releaseStatus===200?release:{message:'not found'});
    if(url.endsWith('/manifest'))return response(200,Buffer.from(JSON.stringify(manifest),'utf8'));
    if(url.endsWith('/dashboard'))return response(200,dashboardMutate?dashboardMutate(dashboardBytes):dashboardBytes);
    return response(404,{message:'not found'});
  };
  return {fetchImpl};
}
async function rejectsCode(promise,code){await assert.rejects(promise,error=>error&&error.code===code,`expected ${code}`);}

(async()=>{
  // Authentication/bootstrap failures stay fail closed.
  await rejectsCode(core.loadVerifiedDashboard({token:'',fetchImpl:async()=>{throw new Error('should not fetch')},cryptoImpl:crypto}),'MISSING_TOKEN');
  {const {fetchImpl}=await fixtures();await rejectsCode(core.loadVerifiedDashboard({token:'bad-token',fetchImpl,cryptoImpl:crypto}),'AUTH_FAILED');}
  {const {fetchImpl}=await fixtures({releaseStatus:404});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'RELEASE_UNAVAILABLE');}

  // A future dashboard generation loads without any V4/V5 DOM marker contract.
  {const {fetchImpl}=await fixtures({html:'<!doctype html><html><body>CONTROL ROOM GENERATION 99</body></html>'});const loaded=await core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto});assert.match(loaded.html,/GENERATION 99/);assert.strictEqual(loaded.contract.name,'dashboard-live-future.html');assert.strictEqual(loaded.contract.loaderContract.generationAgnostic,true);assert.strictEqual(loaded.contract.loaderContract.version,1);}

  // Content integrity remains mandatory.
  {const {fetchImpl}=await fixtures({dashboardMutate:bytes=>Buffer.concat([bytes,Buffer.from('tampered')])});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'BYTE_COUNT_MISMATCH');}
  {const {fetchImpl}=await fixtures({dashboardMutate:bytes=>Buffer.from(bytes.toString('utf8').replace('FUTURE','BROKEN'),'utf8')});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'CHECKSUM_MISMATCH');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.authority='WRONG'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'MANIFEST_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_asset.sha256='not-a-sha'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'MANIFEST_INVALID');}

  // Loader contract itself is now authoritative and generation-independent.
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{delete manifest.dashboard_contract}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.loader_contract_version=2}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_UNSUPPORTED');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.requires_sha256=false}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.generation_agnostic=false}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.transport_tag='wrong-release'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.manifest_asset='wrong-manifest.json'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}
  {const {fetchImpl}=await fixtures({manifestMutate:manifest=>{manifest.dashboard_contract.dashboard_asset='other-dashboard.html'}});await rejectsCode(core.loadVerifiedDashboard({token:'good-token',fetchImpl,cryptoImpl:crypto}),'LOADER_CONTRACT_INVALID');}

  // There must be no hard dependency on legacy dashboard generation markers.
  const source=require('fs').readFileSync(require('path').join(__dirname,'../kucoin-monitor/launcher-core.js'),'utf8');
  assert.doesNotMatch(source,/CONTROL ROOM V4|CONTROL ROOM V5|cr-v4|cr-v5/i);
  assert.strictEqual(core.DEFAULT_RELEASE_TAG,'runtime-state-v1');
  assert.strictEqual(core.SUPPORTED_LOADER_CONTRACT_VERSION,1);
  console.log('KuCoin launcher runtime-state tests passed.');
})().catch(error=>{console.error(error);process.exit(1)});
