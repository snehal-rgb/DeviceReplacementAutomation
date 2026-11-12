import {replacementCalls} from './zoom-calls.mjs';

let cachedToken;
export async function zoomToken(env,fetcher=fetch,now=Date.now()) {
  const identity=env.ZOOM_ACCOUNT_ID+'|'+env.ZOOM_CLIENT_ID;
  if(cachedToken?.identity===identity && cachedToken.until>now)return cachedToken.value;
  if(!env.ZOOM_ACCOUNT_ID || !env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET)throw new Error('ZOOM_CONNECTION_MISSING');
  const endpoint=new URL('https://zoom.us/oauth/token');
  endpoint.search=new URLSearchParams({grant_type:'account_credentials',account_id:env.ZOOM_ACCOUNT_ID});
  const basic=btoa(env.ZOOM_CLIENT_ID+':'+env.ZOOM_CLIENT_SECRET);
  const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:'Basic '+basic},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('ZOOM_AUTHENTICATION_FAILED');
  const data=await response.json();
  if(typeof data.access_token!=='string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in<=60)throw new Error('ZOOM_TOKEN_RESPONSE_INVALID');
  const scopes=String(data.scope || '').split(/\s+/);
  if(!scopes.includes('contact_center:read:list_engagements:admin') && !scopes.includes('contact_center_report:read:admin'))throw new Error('ZOOM_ENGAGEMENT_READ_SCOPE_MISSING');
  cachedToken={identity,value:data.access_token,until:now+(data.expires_in-60)*1000};
  return cachedToken.value;
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/health' && request.method==='GET')return Response.json({service:'device-replacement-automation',version:'1',status:'deployed',configurationPresent:['ZOOM_ACCOUNT_ID','ZOOM_CLIENT_ID','ZOOM_CLIENT_SECRET','SLACK_TEAM_ID','SLACK_BOT_USER_ID'].every(k=>!!env[k]),liveZoomVerified:false},{headers:{'Cache-Control':'no-store'}});
    if(path==='/replacement-delivery/calls')return replacementCalls(request,env,e=>zoomToken(e));
    return new Response('Not found',{status:404});
  }
};
