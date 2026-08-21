(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KucoinLauncherCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
  const DEFAULT_REPO='dueyouapp/kucoin-futures-monitor';
  const DEFAULT_RELEASE_TAG='runtime-state-v1';
  const DEFAULT_MANIFEST_ASSET='runtime_state_manifest.json';

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
  function assetByName(release,name){
    const assets=Array.isArray(release&&release.assets)?release.assets:[];
    return assets.find(asset=>String(asset&&asset.name||'')===String(name||''))||null;
  }
  function validateManifest(manifest){
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
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw new LauncherError('MANIFEST_INVALID','Runtime dashboard byte count is invalid.');
    return {name,sha256,bytes,createdAt:String(manifest.created_at||''),sourceSha:String(manifest.source_sha||'')};
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
  async function fetchAssetBytes({asset,token,fetchImpl}){
    if(!asset||!asset.url)throw new LauncherError('ASSET_UNAVAILABLE','Required runtime-state Release asset is unavailable.');
    let response;
    try{response=await fetchImpl(asset.url,{cache:'no-store',credentials:'omit',redirect:'follow',headers:headers(token,'application/octet-stream')});}
    catch(error){throw new LauncherError('NETWORK_ERROR',`Runtime-state asset download failed: ${error&&error.message?error.message:'network error'}.`);}
    if(response.status===401||response.status===403)throw new LauncherError('AUTH_FAILED','Private Release asset access failed. Connect or replace the read-only GitHub token.',{authFailure:true});
    if(response.status===404)throw new LauncherError('ASSET_UNAVAILABLE','Required runtime-state Release asset is unavailable.');
    if(!response.ok)throw new LauncherError('GITHUB_HTTP_ERROR',`Runtime-state asset download returned HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
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
  async function loadVerifiedDashboard(options={}){
    const token=String(options.token||'').trim();
    if(!token)throw new LauncherError('MISSING_TOKEN','Connect the private GitHub token once on this browser.');
    const repo=String(options.repo||DEFAULT_REPO);
    const releaseTag=String(options.releaseTag||DEFAULT_RELEASE_TAG);
    const manifestAssetName=String(options.manifestAssetName||DEFAULT_MANIFEST_ASSET);
    const fetchImpl=options.fetchImpl||((...args)=>fetch(...args));
    const cryptoImpl=options.cryptoImpl||(typeof crypto!=='undefined'?crypto:null);
    const release=await fetchReleaseMetadata({token,repo,releaseTag,fetchImpl});
    const manifestAsset=assetByName(release,manifestAssetName);
    if(!manifestAsset)throw new LauncherError('MANIFEST_UNAVAILABLE','Runtime-state Release manifest asset is missing.');
    const manifestBytes=await fetchAssetBytes({asset:manifestAsset,token,fetchImpl});
    let manifest;
    try{manifest=JSON.parse(decodeUtf8(manifestBytes))}catch(error){if(error instanceof LauncherError)throw error;throw new LauncherError('MANIFEST_INVALID','Runtime-state Release manifest is malformed JSON.');}
    const contract=validateManifest(manifest);
    const dashboardAsset=assetByName(release,contract.name);
    if(!dashboardAsset)throw new LauncherError('ASSET_UNAVAILABLE',`Runtime dashboard asset ${contract.name} is missing from the verified Release.`);
    const dashboardBytes=await fetchAssetBytes({asset:dashboardAsset,token,fetchImpl});
    if(dashboardBytes.byteLength!==contract.bytes)throw new LauncherError('BYTE_COUNT_MISMATCH',`Runtime dashboard byte count mismatch: expected ${contract.bytes}, observed ${dashboardBytes.byteLength}.`);
    const observedSha=await sha256Hex(dashboardBytes,cryptoImpl);
    if(observedSha!==contract.sha256)throw new LauncherError('CHECKSUM_MISMATCH','Runtime dashboard SHA-256 mismatch. Refusing to execute the asset.');
    const html=validateHtmlShell(decodeUtf8(dashboardBytes));
    return {html,manifest,contract,releaseId:release.id||null,releaseTag};
  }
  return {DEFAULT_REPO,DEFAULT_RELEASE_TAG,DEFAULT_MANIFEST_ASSET,LauncherError,assetByName,validateManifest,sha256Hex,validateHtmlShell,loadVerifiedDashboard};
});
