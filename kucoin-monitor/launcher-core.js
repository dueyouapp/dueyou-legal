(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KucoinLauncherCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
  const DEFAULT_REPO='dueyouapp/kucoin-futures-monitor';
  const DEFAULT_RELEASE_TAG='runtime-state-v1';
  const DEFAULT_MANIFEST_ASSET='runtime_state_manifest.json';
  const DEFAULT_TRANSPORT_REF='runtime-browser-v1';
  const DEFAULT_TRANSPORT_MANIFEST='transport_manifest.json';
  const SUPPORTED_LOADER_CONTRACT_VERSION=1;
  const SUPPORTED_TRANSPORT_SCHEMA_VERSION=1;
  const DASHBOARD_ARTIFACT_TYPE='KUCOIN_CONTROL_ROOM_STANDALONE_HTML';
  const TRANSPORT_AUTHORITY='KUCOIN_RUNTIME_BROWSER_TRANSPORT_V1';
  const MAX_DASHBOARD_BYTES=25_000_000;

  class LauncherError extends Error{
    constructor(code,message,options={}){
      super(message);
      this.name='LauncherError';
      this.code=code;
      this.authFailure=Boolean(options.authFailure);
    }
  }

  const headers=(token,accept)=>({
    Accept:accept,
    Authorization:`Bearer ${token}`,
    'X-GitHub-Api-Version':'2022-11-28'
  });

  function releaseUrl(repo,tag){return `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;}
  function encodePath(path){return String(path||'').split('/').filter(Boolean).map(encodeURIComponent).join('/');}
  function contentsUrl(repo,path,ref){return `https://api.github.com/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;}
  function assetByName(release,name){
    const assets=Array.isArray(release&&release.assets)?release.assets:[];
    return assets.find(asset=>String(asset&&asset.name||'')===String(name||''))||null;
  }
  function assetSha256(asset){
    const digest=String(asset&&asset.digest||'').trim().toLowerCase();
    const match=/^sha256:([0-9a-f]{64})$/.exec(digest);
    if(!match)throw new LauncherError('RELEASE_DIGEST_UNAVAILABLE',`GitHub did not expose a SHA-256 digest for Release asset ${String(asset&&asset.name||'unknown')}. Refusing unverified browser transport.`);
    return match[1];
  }
  function validateManifest(manifest,expected={}){
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw new LauncherError('MANIFEST_INVALID','Runtime manifest is not a JSON object.');
    if(Number(manifest.schema_version)!==1)throw new LauncherError('MANIFEST_UNSUPPORTED','Unsupported runtime-state manifest schema.');
    if(manifest.authority!=='KUCOIN_RUNTIME_STATE_RELEASE_V1')throw new LauncherError('MANIFEST_INVALID','Runtime manifest authority is invalid.');
    if(manifest.trade_authority!==false)throw new LauncherError('MANIFEST_INVALID','Runtime-state manifest unexpectedly claims trading authority.');
    const policy=manifest.policy;
    if(!policy||policy.release_is_runtime_state_authority!==true||policy.runtime_state_has_no_trade_authority!==true||policy.checksum_required_before_restore!==true)throw new LauncherError('MANIFEST_INVALID','Runtime-state safety policy is incomplete.');

    const dashboard=manifest.dashboard_asset;
    if(!dashboard||typeof dashboard!=='object')throw new LauncherError('MANIFEST_INVALID','Runtime manifest has no dashboard asset contract.');
    const name=String(dashboard.name||'').trim();
    const sha256=String(dashboard.sha256||'').trim().toLowerCase();
    if(!name)throw new LauncherError('MANIFEST_INVALID','Runtime dashboard asset name is missing.');
    if(!/^[0-9a-f]{64}$/.test(sha256))throw new LauncherError('MANIFEST_INVALID','Runtime dashboard SHA-256 is missing or malformed.');
    const bytes=Number(dashboard.bytes);
    if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX_DASHBOARD_BYTES)throw new LauncherError('MANIFEST_INVALID','Runtime dashboard byte count is invalid or exceeds the browser safety ceiling.');

    const loader=manifest.dashboard_contract;
    if(!loader||typeof loader!=='object'||Array.isArray(loader))throw new LauncherError('LOADER_CONTRACT_INVALID','Runtime manifest has no dashboard loader contract.');
    if(Number(loader.loader_contract_version)!==SUPPORTED_LOADER_CONTRACT_VERSION)throw new LauncherError('LOADER_CONTRACT_UNSUPPORTED','Unsupported dashboard loader contract version.');
    if(String(loader.artifact_type||'')!==DASHBOARD_ARTIFACT_TYPE)throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard artifact type is invalid.');
    if(loader.requires_sha256!==true)throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard loader contract does not require SHA-256.');
    if(loader.generation_agnostic!==true)throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard loader contract is not generation-agnostic.');
    const transportTag=String(loader.transport_tag||'').trim();
    const manifestAsset=String(loader.manifest_asset||'').trim();
    const dashboardAsset=String(loader.dashboard_asset||'').trim();
    if(!transportTag||!manifestAsset||!dashboardAsset)throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard loader contract asset identity is incomplete.');
    if(dashboardAsset!==name)throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard loader contract disagrees with the checksummed dashboard asset.');
    if(expected.releaseTag&&transportTag!==String(expected.releaseTag))throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard loader contract Release tag does not match the requested transport.');
    if(expected.manifestAssetName&&manifestAsset!==String(expected.manifestAssetName))throw new LauncherError('LOADER_CONTRACT_INVALID','Dashboard loader contract manifest asset does not match the verified bootstrap asset.');

    return {
      name,sha256,bytes,
      createdAt:String(manifest.created_at||''),
      sourceSha:String(manifest.source_sha||''),
      loaderContract:{
        version:SUPPORTED_LOADER_CONTRACT_VERSION,
        artifactType:DASHBOARD_ARTIFACT_TYPE,
        transportTag,
        manifestAsset,
        dashboardAsset,
        requiresSha256:true,
        generationAgnostic:true
      }
    };
  }
  function validateTransportManifest(transport,expected={}){
    if(!transport||typeof transport!=='object'||Array.isArray(transport))throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport manifest is not a JSON object.');
    if(Number(transport.schema_version)!==SUPPORTED_TRANSPORT_SCHEMA_VERSION)throw new LauncherError('BROWSER_TRANSPORT_UNSUPPORTED','Unsupported browser transport schema.');
    if(String(transport.authority||'')!==TRANSPORT_AUTHORITY)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport authority is invalid.');
    if(transport.trade_authority!==false||transport.execution_authority!==false)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport unexpectedly claims trade or execution authority.');
    if(expected.releaseTag&&String(transport.release_tag||'')!==String(expected.releaseTag))throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport Release tag does not match the requested runtime Release.');
    const policy=transport.policy||{};
    if(policy.release_remains_runtime_authority!==true||policy.branch_is_browser_transport_only!==true||policy.release_asset_digest_verification_required_in_browser!==true||policy.runtime_manifest_verification_required_in_browser!==true||policy.no_trade_authority!==true)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport safety policy is incomplete.');

    const generation=String(transport.generation||'').trim().toLowerCase();
    if(!/^[0-9a-f]{64}$/.test(generation))throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport generation is malformed.');
    const runtimeManifest=transport.runtime_manifest||{};
    const manifestPath=String(runtimeManifest.path||'').trim();
    const manifestSha=String(runtimeManifest.sha256||'').trim().toLowerCase();
    const manifestBytes=Number(runtimeManifest.bytes);
    if(!manifestPath||manifestSha!==generation||!Number.isSafeInteger(manifestBytes)||manifestBytes<=0||manifestBytes>=1_000_000)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport runtime-manifest identity is invalid.');
    if(!manifestPath.startsWith(`generations/${generation}/`))throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport runtime-manifest path is outside its generation.');

    const dashboard=transport.dashboard||{};
    const assetName=String(dashboard.asset_name||'').trim();
    const dashboardSha=String(dashboard.sha256||'').trim().toLowerCase();
    const dashboardBytes=Number(dashboard.bytes);
    const chunks=Array.isArray(dashboard.chunks)?dashboard.chunks:[];
    if(!assetName||!/^[0-9a-f]{64}$/.test(dashboardSha)||!Number.isSafeInteger(dashboardBytes)||dashboardBytes<=0||dashboardBytes>MAX_DASHBOARD_BYTES)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport dashboard identity is invalid.');
    if(Number(dashboard.chunk_count)!==chunks.length||chunks.length<=0)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport chunk count is invalid.');
    let total=0;
    const normalized=[];
    chunks.forEach((row,index)=>{
      const path=String(row&&row.path||'').trim();
      const sha256=String(row&&row.sha256||'').trim().toLowerCase();
      const bytes=Number(row&&row.bytes);
      if(Number(row&&row.index)!==index||!path.startsWith(`generations/${generation}/chunks/`)||!/^[0-9a-f]{64}$/.test(sha256)||!Number.isSafeInteger(bytes)||bytes<=0||bytes>=1_000_000)throw new LauncherError('BROWSER_TRANSPORT_INVALID',`Browser transport chunk ${index} is invalid.`);
      total+=bytes;
      normalized.push({index,path,sha256,bytes});
    });
    if(total!==dashboardBytes)throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport chunk byte total does not match dashboard byte count.');
    return {
      generation,
      sourceSha:String(transport.source_sha||''),
      runtimeCreatedAt:String(transport.runtime_created_at||''),
      runtimeManifest:{path:manifestPath,sha256:manifestSha,bytes:manifestBytes},
      dashboard:{assetName,sha256:dashboardSha,bytes:dashboardBytes,chunks:normalized}
    };
  }
  async function fetchReleaseMetadata({token,repo,releaseTag,fetchImpl}){
    let response;
    try{response=await fetchImpl(releaseUrl(repo,releaseTag),{cache:'no-store',credentials:'omit',headers:headers(token,'application/vnd.github+json')});}
    catch(error){throw new LauncherError('NETWORK_ERROR',`GitHub Release lookup failed: ${error&&error.message?error.message:'network error'}.`);}
    if(response.status===401||response.status===403)throw new LauncherError('AUTH_FAILED','Private repository access failed. Connect or replace the read-only GitHub token.',{authFailure:true});
    if(response.status===404)throw new LauncherError('RELEASE_UNAVAILABLE','Verified runtime-state Release is unavailable. Refusing an unverified fallback.');
    if(!response.ok)throw new LauncherError('GITHUB_HTTP_ERROR',`GitHub Release lookup returned HTTP ${response.status}.`);
    try{return await response.json();}catch(_){throw new LauncherError('RELEASE_METADATA_MALFORMED','GitHub returned malformed Release metadata.');}
  }
  function decodeBase64(value){
    const compact=String(value||'').replace(/\s+/g,'');
    if(!compact)throw new LauncherError('BROWSER_TRANSPORT_INVALID','GitHub Contents API returned empty inline content.');
    try{
      if(typeof atob==='function'){
        const binary=atob(compact),bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        return bytes;
      }
      if(typeof Buffer!=='undefined')return new Uint8Array(Buffer.from(compact,'base64'));
    }catch(_){throw new LauncherError('BROWSER_TRANSPORT_INVALID','GitHub Contents API returned malformed base64 content.');}
    throw new LauncherError('BROWSER_TRANSPORT_INVALID','This browser cannot decode GitHub Contents API base64 data.');
  }
  async function fetchContentsBytes({token,repo,path,ref,fetchImpl}){
    let response;
    try{response=await fetchImpl(contentsUrl(repo,path,ref),{cache:'no-store',credentials:'omit',headers:headers(token,'application/vnd.github+json')});}
    catch(error){throw new LauncherError('NETWORK_ERROR',`Private browser transport fetch failed: ${error&&error.message?error.message:'network error'}.`);}
    if(response.status===401||response.status===403)throw new LauncherError('AUTH_FAILED','Private repository access failed. Connect or replace the read-only GitHub token.',{authFailure:true});
    if(response.status===404)throw new LauncherError('BROWSER_TRANSPORT_UNAVAILABLE','Verified browser transport is not available yet. Refusing an unverified fallback.');
    if(!response.ok)throw new LauncherError('GITHUB_HTTP_ERROR',`GitHub Contents API returned HTTP ${response.status}.`);
    let payload;
    try{payload=await response.json();}catch(_){throw new LauncherError('BROWSER_TRANSPORT_INVALID','GitHub Contents API returned malformed metadata.');}
    if(!payload||Array.isArray(payload)||String(payload.type||'')!=='file'||String(payload.encoding||'').toLowerCase()!=='base64'||typeof payload.content!=='string')throw new LauncherError('BROWSER_TRANSPORT_INVALID',`GitHub Contents API did not return inline file bytes for ${path}.`);
    const bytes=decodeBase64(payload.content);
    if(Number.isSafeInteger(Number(payload.size))&&Number(payload.size)!==bytes.byteLength)throw new LauncherError('BYTE_COUNT_MISMATCH',`GitHub Contents byte count mismatch for ${path}.`);
    return bytes;
  }
  async function sha256Hex(bytes,cryptoImpl){
    if(!cryptoImpl||!cryptoImpl.subtle||typeof cryptoImpl.subtle.digest!=='function')throw new LauncherError('CRYPTO_UNAVAILABLE','This browser cannot perform mandatory SHA-256 verification.');
    const digest=await cryptoImpl.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  }
  function decodeUtf8(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch(_){throw new LauncherError('DASHBOARD_INVALID','Verified dashboard bytes are not valid UTF-8.');}}
  function validateHtmlShell(html){
    const text=String(html||'');
    if(!/<!doctype\s+html/i.test(text)||!/<html[\s>]/i.test(text)||!/<\/html>/i.test(text))throw new LauncherError('DASHBOARD_INVALID','Verified dashboard asset is not a complete standalone HTML document.');
    return text;
  }
  async function verifyBytes(bytes,expectedSha,expectedBytes,label,cryptoImpl){
    if(bytes.byteLength!==Number(expectedBytes))throw new LauncherError('BYTE_COUNT_MISMATCH',`${label} byte count mismatch: expected ${expectedBytes}, observed ${bytes.byteLength}.`);
    const observed=await sha256Hex(bytes,cryptoImpl);
    if(observed!==String(expectedSha).toLowerCase())throw new LauncherError('CHECKSUM_MISMATCH',`${label} SHA-256 mismatch. Refusing to execute the asset.`);
    return observed;
  }
  async function loadVerifiedDashboard(options={}){
    const token=String(options.token||'').trim();
    if(!token)throw new LauncherError('MISSING_TOKEN','Connect the private GitHub token once on this browser.');
    const repo=String(options.repo||DEFAULT_REPO);
    const releaseTag=String(options.releaseTag||DEFAULT_RELEASE_TAG);
    const manifestAssetName=String(options.manifestAssetName||DEFAULT_MANIFEST_ASSET);
    const transportRef=String(options.transportRef||DEFAULT_TRANSPORT_REF);
    const transportManifestName=String(options.transportManifestName||DEFAULT_TRANSPORT_MANIFEST);
    const fetchImpl=options.fetchImpl||((...args)=>fetch(...args));
    const cryptoImpl=options.cryptoImpl||(typeof crypto!=='undefined'?crypto:null);

    const release=await fetchReleaseMetadata({token,repo,releaseTag,fetchImpl});
    const releaseManifestAsset=assetByName(release,manifestAssetName);
    if(!releaseManifestAsset)throw new LauncherError('MANIFEST_UNAVAILABLE','Runtime-state Release manifest asset is missing.');
    const releaseManifestSha=assetSha256(releaseManifestAsset);

    const transportBytes=await fetchContentsBytes({token,repo,path:transportManifestName,ref:transportRef,fetchImpl});
    let transportRaw;
    try{transportRaw=JSON.parse(decodeUtf8(transportBytes));}catch(error){if(error instanceof LauncherError)throw error;throw new LauncherError('BROWSER_TRANSPORT_INVALID','Browser transport manifest is malformed JSON.');}
    const transport=validateTransportManifest(transportRaw,{releaseTag});
    if(transport.runtimeManifest.sha256!==releaseManifestSha||transport.runtimeManifest.bytes!==Number(releaseManifestAsset.size))throw new LauncherError('BROWSER_TRANSPORT_STALE','Browser transport does not match the current runtime-state Release manifest.');

    const manifestBytes=await fetchContentsBytes({token,repo,path:transport.runtimeManifest.path,ref:transportRef,fetchImpl});
    await verifyBytes(manifestBytes,releaseManifestSha,Number(releaseManifestAsset.size),'Runtime-state Release manifest',cryptoImpl);
    let manifest;
    try{manifest=JSON.parse(decodeUtf8(manifestBytes));}catch(error){if(error instanceof LauncherError)throw error;throw new LauncherError('MANIFEST_INVALID','Runtime-state Release manifest is malformed JSON.');}
    const contract=validateManifest(manifest,{releaseTag,manifestAssetName});
    if(transport.sourceSha&&transport.sourceSha!==contract.sourceSha)throw new LauncherError('BROWSER_TRANSPORT_STALE','Browser transport source SHA does not match the verified runtime manifest.');
    if(transport.dashboard.assetName!==contract.name||transport.dashboard.sha256!==contract.sha256||transport.dashboard.bytes!==contract.bytes)throw new LauncherError('BROWSER_TRANSPORT_STALE','Browser transport dashboard identity does not match the verified runtime manifest.');

    const releaseDashboardAsset=assetByName(release,contract.name);
    if(!releaseDashboardAsset)throw new LauncherError('ASSET_UNAVAILABLE',`Runtime dashboard asset ${contract.name} is missing from the verified Release.`);
    const releaseDashboardSha=assetSha256(releaseDashboardAsset);
    if(releaseDashboardSha!==contract.sha256||Number(releaseDashboardAsset.size)!==contract.bytes)throw new LauncherError('RELEASE_ASSET_MISMATCH','Runtime Release asset metadata disagrees with the verified runtime manifest.');

    const dashboardBytes=new Uint8Array(contract.bytes);
    let offset=0;
    for(const chunk of transport.dashboard.chunks){
      const bytes=await fetchContentsBytes({token,repo,path:chunk.path,ref:transportRef,fetchImpl});
      await verifyBytes(bytes,chunk.sha256,chunk.bytes,`Runtime dashboard chunk ${chunk.index}`,cryptoImpl);
      dashboardBytes.set(bytes,offset);
      offset+=bytes.byteLength;
    }
    if(offset!==contract.bytes)throw new LauncherError('BYTE_COUNT_MISMATCH','Reassembled runtime dashboard byte count is invalid.');
    await verifyBytes(dashboardBytes,contract.sha256,contract.bytes,'Runtime dashboard',cryptoImpl);
    if(contract.sha256!==releaseDashboardSha)throw new LauncherError('RELEASE_ASSET_MISMATCH','Reassembled dashboard does not match the current Release asset digest.');
    const html=validateHtmlShell(decodeUtf8(dashboardBytes));
    return {html,manifest,contract,releaseId:release.id||null,releaseTag,transportRef,transportGeneration:transport.generation};
  }
  return {DEFAULT_REPO,DEFAULT_RELEASE_TAG,DEFAULT_MANIFEST_ASSET,DEFAULT_TRANSPORT_REF,DEFAULT_TRANSPORT_MANIFEST,SUPPORTED_LOADER_CONTRACT_VERSION,SUPPORTED_TRANSPORT_SCHEMA_VERSION,DASHBOARD_ARTIFACT_TYPE,TRANSPORT_AUTHORITY,LauncherError,assetByName,assetSha256,validateManifest,validateTransportManifest,sha256Hex,validateHtmlShell,loadVerifiedDashboard};
});
