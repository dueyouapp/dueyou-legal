'use strict';

const assert=require('node:assert/strict');
const {webcrypto,createHash}=require('node:crypto');
const core=require('./launcher-core.js');

const sha=bytes=>createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const jsonBytes=value=>Buffer.from(JSON.stringify(value)+'\n','utf8');
const response=(status,payload)=>({
  status,
  ok:status>=200&&status<300,
  async json(){return payload;}
});
const contentsResponse=bytes=>response(200,{
  type:'file',
  encoding:'base64',
  size:bytes.length,
  content:Buffer.from(bytes).toString('base64')
});

async function happyPath(){
  const dashboard=Buffer.from('<!doctype html><html><body>verified mobile control room</body></html>\n','utf8');
  const dashboardSha=sha(dashboard);
  const runtimeManifest={
    schema_version:1,
    authority:'KUCOIN_RUNTIME_STATE_RELEASE_V1',
    trade_authority:false,
    created_at:'2026-08-21T10:00:00+00:00',
    source_sha:'a'.repeat(40),
    dashboard_asset:{name:'dashboard-live.html',sha256:dashboardSha,bytes:dashboard.length},
    dashboard_contract:{
      loader_contract_version:1,
      artifact_type:'KUCOIN_CONTROL_ROOM_STANDALONE_HTML',
      transport_tag:'runtime-state-v1',
      manifest_asset:'runtime_state_manifest.json',
      dashboard_asset:'dashboard-live.html',
      requires_sha256:true,
      generation_agnostic:true
    },
    policy:{
      release_is_runtime_state_authority:true,
      runtime_state_has_no_trade_authority:true,
      checksum_required_before_restore:true
    }
  };
  const runtimeManifestBytes=jsonBytes(runtimeManifest);
  const runtimeManifestSha=sha(runtimeManifestBytes);
  const chunkA=dashboard.subarray(0,31),chunkB=dashboard.subarray(31);
  const transport={
    schema_version:1,
    authority:'KUCOIN_RUNTIME_BROWSER_TRANSPORT_V1',
    trade_authority:false,
    execution_authority:false,
    release_tag:'runtime-state-v1',
    source_sha:runtimeManifest.source_sha,
    runtime_created_at:runtimeManifest.created_at,
    generation:runtimeManifestSha,
    runtime_manifest:{
      path:`generations/${runtimeManifestSha}/runtime_state_manifest.json`,
      bytes:runtimeManifestBytes.length,
      sha256:runtimeManifestSha
    },
    dashboard:{
      asset_name:'dashboard-live.html',
      bytes:dashboard.length,
      sha256:dashboardSha,
      chunk_bytes_max:700000,
      chunk_count:2,
      chunks:[
        {index:0,path:`generations/${runtimeManifestSha}/chunks/part-0000.bin`,bytes:chunkA.length,sha256:sha(chunkA)},
        {index:1,path:`generations/${runtimeManifestSha}/chunks/part-0001.bin`,bytes:chunkB.length,sha256:sha(chunkB)}
      ]
    },
    policy:{
      release_remains_runtime_authority:true,
      branch_is_browser_transport_only:true,
      release_asset_digest_verification_required_in_browser:true,
      runtime_manifest_verification_required_in_browser:true,
      no_trade_authority:true
    }
  };
  const transportBytes=jsonBytes(transport);
  const release={
    id:7,
    assets:[
      {name:'runtime_state_manifest.json',size:runtimeManifestBytes.length,digest:`sha256:${runtimeManifestSha}`,url:'https://api.github.com/repos/x/y/releases/assets/1'},
      {name:'dashboard-live.html',size:dashboard.length,digest:`sha256:${dashboardSha}`,url:'https://api.github.com/repos/x/y/releases/assets/2'}
    ]
  };
  const files=new Map([
    ['transport_manifest.json',transportBytes],
    [transport.runtime_manifest.path,runtimeManifestBytes],
    [transport.dashboard.chunks[0].path,chunkA],
    [transport.dashboard.chunks[1].path,chunkB]
  ]);
  const calls=[];
  const fetchImpl=async url=>{
    calls.push(String(url));
    if(String(url).includes('/releases/tags/runtime-state-v1'))return response(200,release);
    const match=/\/contents\/(.+?)\?ref=/.exec(String(url));
    if(match){
      const path=match[1].split('/').map(decodeURIComponent).join('/');
      const bytes=files.get(path);
      return bytes?contentsResponse(bytes):response(404,{message:'Not Found'});
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const verified=await core.loadVerifiedDashboard({token:'read-only-test-token',fetchImpl,cryptoImpl:webcrypto});
  assert.equal(verified.html,dashboard.toString('utf8'));
  assert.equal(verified.contract.sha256,dashboardSha);
  assert.equal(verified.transportGeneration,runtimeManifestSha);
  assert.ok(calls.some(url=>url.includes('/contents/transport_manifest.json')));
  assert.equal(calls.some(url=>url.includes('/releases/assets/')),false,'browser must never use redirecting Release asset binary endpoint');
}

async function rejectsUnboundMirror(){
  const release={id:8,assets:[{name:'runtime_state_manifest.json',size:12,digest:`sha256:${'f'.repeat(64)}`}]};
  const badTransport={
    schema_version:1,
    authority:'KUCOIN_RUNTIME_BROWSER_TRANSPORT_V1',
    trade_authority:false,
    execution_authority:false,
    release_tag:'runtime-state-v1',
    source_sha:'a'.repeat(40),
    generation:'e'.repeat(64),
    runtime_manifest:{path:`generations/${'e'.repeat(64)}/runtime_state_manifest.json`,bytes:12,sha256:'e'.repeat(64)},
    dashboard:{asset_name:'dashboard-live.html',bytes:10,sha256:'d'.repeat(64),chunk_count:1,chunks:[{index:0,path:`generations/${'e'.repeat(64)}/chunks/part-0000.bin`,bytes:10,sha256:'c'.repeat(64)}]},
    policy:{release_remains_runtime_authority:true,branch_is_browser_transport_only:true,release_asset_digest_verification_required_in_browser:true,runtime_manifest_verification_required_in_browser:true,no_trade_authority:true}
  };
  const fetchImpl=async url=>{
    if(String(url).includes('/releases/tags/'))return response(200,release);
    return contentsResponse(jsonBytes(badTransport));
  };
  await assert.rejects(
    ()=>core.loadVerifiedDashboard({token:'token',fetchImpl,cryptoImpl:webcrypto}),
    error=>error&&error.code==='BROWSER_TRANSPORT_STALE'
  );
}

(async()=>{
  await happyPath();
  await rejectsUnboundMirror();
  console.log('launcher-core browser transport tests: PASS');
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
