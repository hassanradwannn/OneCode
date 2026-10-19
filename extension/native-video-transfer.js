/** Browser-only download relay. Signed native URLs never enter app RPCs, history or tool results. */
export function nativeVideoDownloadUrl(provider, value, mimeType) {
  try {
    if(provider!=='gemini'||typeof value!=='string'||value.length>8192)return null;
    const url=new URL(value);
    if(url.origin!=='https://contribution.usercontent.google.com'||url.pathname!=='/download'||url.username||url.password||url.hash)return null;
    const extension=/\.(mp4|webm)$/i.exec(url.searchParams.get('filename')||'')?.[1]?.toLowerCase();
    return mimeType===`video/${extension}`?url.href:null;
  }catch{return null;}
}

export async function streamNativeVideoDownload(job, sourceUrl, {current, fetch: fetchDownload, send}) {
  const url=nativeVideoDownloadUrl(job.provider,sourceUrl,job.mimeType);
  if(!url)return{error:'identity_changed'};
  try{if(!await current())return{error:'identity_changed'};}catch{return{error:'identity_changed'};}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),170_000);
  let reader;
  try{
    const response=await fetchDownload(url,{credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
    if(!await current())return{error:'identity_changed'};
    if(!response.ok||!response.body)return{error:'fetch_failed'};
    if((response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase()!==job.mimeType)return{error:'not_video'};
    const declared=Number(response.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>job.maxBytes)return{error:'too_large'};
    reader=response.body.getReader();const packet=new Uint8Array(job.chunkBytes);let length=0,total=0;
    const flush=async()=>{
      if(!await current())throw Error('identity_changed');
      let binary='';for(let at=0;at<length;at+=0x8000)binary+=String.fromCharCode(...packet.subarray(at,Math.min(length,at+0x8000)));
      const reply=await send({nonce:job.nonce,offset:total-length,data:btoa(binary)});
      if(!await current())throw Error('identity_changed');
      if(!reply?.ok)throw Error('fetch_failed');length=0;
    };
    while(true){
      const {done,value}=await reader.read();if(!await current())throw Error('identity_changed');if(done)break;
      if(!(value instanceof Uint8Array))throw Error('fetch_failed');if(total+value.length>job.maxBytes)throw Error('too_large');
      let at=0;while(at<value.length){const size=Math.min(packet.length-length,value.length-at);packet.set(value.subarray(at,at+size),length);length+=size;total+=size;at+=size;if(length===packet.length)await flush();}
    }
    if(!total)throw Error('fetch_failed');if(length)await flush();if(!await current())throw Error('identity_changed');
    const reply=await send({nonce:job.nonce,done:true,totalBytes:total});return reply?.ok?{ok:true}:{error:'fetch_failed'};
  }catch(error){const reason=String(error?.message);return{error:['identity_changed','too_large'].includes(reason)?reason:'fetch_failed'};}
  finally{clearTimeout(timer);controller.abort();try{await reader?.cancel();}catch{}}
}
