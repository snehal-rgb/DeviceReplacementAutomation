import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{zoomToken} from '../src/worker.mjs';

test('health reports configuration presence without pretending live Zoom was tested',async()=>{
 const r=await worker.fetch(new Request('https://example.test/health'),{});
 const body=await r.json();assert.equal(body.configurationPresent,false);assert.equal(body.liveZoomVerified,false);
 assert.equal((await worker.fetch(new Request('https://example.test/unknown'),{})).status,404);
});
test('missing Slack identity fails closed before an API lookup',async()=>{
 const r=await worker.fetch(new Request('https://example.test/replacement-delivery/calls',{method:'POST'}),{});
 assert.equal(r.status,503);assert.equal((await r.json()).reason,'slack_identity_not_configured');
});
test('Zoom scope and authentication failures remain explicit',async()=>{
 const env={ZOOM_ACCOUNT_ID:'test-account-1',ZOOM_CLIENT_ID:'test-client',ZOOM_CLIENT_SECRET:'test-only-not-a-secret'};
 await assert.rejects(zoomToken(env,async()=>new Response('',{status:401})),/AUTHENTICATION_FAILED/);
 await assert.rejects(zoomToken(env,async()=>Response.json({access_token:'test-token',expires_in:3600,scope:'unrelated:read'})),/READ_SCOPE_MISSING/);
});
test('Zoom authentication uses intended account and accepts historical engagement read scope',async()=>{
 const env={ZOOM_ACCOUNT_ID:'test-account-2',ZOOM_CLIENT_ID:'test-client',ZOOM_CLIENT_SECRET:'test-only-not-a-secret'};
 let seen=false;
 const token=await zoomToken(env,async(url,options)=>{
  seen=true;assert.equal(url.origin,'https://zoom.us');assert.equal(url.searchParams.get('account_id'),'test-account-2');assert.equal(options.method,'POST');
  return Response.json({access_token:'test-token',expires_in:3600,scope:'contact_center:read:list_engagements:admin'});
 });
 assert.equal(token,'test-token');assert.equal(seen,true);
});
