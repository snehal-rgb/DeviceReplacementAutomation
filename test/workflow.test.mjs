import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import {phoneKey, requestWindow, callMetadata, replacementCalls} from '../src/zoom-calls.mjs';
globalThis.crypto ||= webcrypto;
const now=Date.parse('2026-11-13T22:00:00Z');
const window={phone:'12025558391',from:now-3600000,to:now};
const engagement={engagement_id:'call1',channel_types:['voice'],consumers:[{consumer_number:'+1 (202) 555-8391'}],start_time:'2026-11-13T21:30:00Z',end_time:'2026-11-13T21:35:00Z',talk_duration:120,agents:[{user_id:'agent1',display_name:'Tech'}],direction:'outbound'};
function script(){
 const props=new Map(), posts=[];
 const p={getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k),getProperties:()=>Object.fromEntries(props)};
 const context=vm.createContext({console,Date,JSON,Number,Object,String,Error,PropertiesService:{getScriptProperties:()=>p},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({body:JSON.parse(s),setMimeType(){return this;}})},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>[...createHash('sha256').update(s).digest()],formatDate:(d,zone,format)=>format==='yyyy-MM-dd'?new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(d):d.toISOString()},rpConfig_:()=>({token:'xoxb-test'}),rpVerifiedPayload_:payload=>payload.token==='verified'});
 p.setProperty('RD_MANAGER_USER_IDS',JSON.stringify(['UMANAGER1','UMANAGER2']));p.setProperty('RD_AGENT_USER_IDS',JSON.stringify({Dixit:'UASSIGNED'}));p.setProperty('RD_SLACK_CHANNEL_ID','CTEST');
 vm.runInContext(fs.readFileSync(new URL('../apps-script/ReplacementDeliveryActions.gs',import.meta.url),'utf8'),context);
 context.rdApi_=(method,body)=>{if(method==='conversations.open')return {channel:{id:'DM-'+body.users}};posts.push({method,body});return {channel:body.channel,ts:'123.456'};};
 const row={row:1002,v:Array(19).fill(''),key:'a'.repeat(64)};row.v[0]='Test store';row.v[4]='2025558391';row.v[13]='9400111206213123456789';row.v[15]='Replacement';row.v[16]='Delivered';row.v[18]='Dixit';
 const record={key:row.key,row:1002,rootTs:'123.456',assignedId:'UASSIGNED',openedAt:'2026-11-13T14:00:00Z'};
 const put=r=>context.rdChange_('CASE_'+r.key,()=>r);
 const click=(user='UASSIGNED',ts='123.456')=>({parameter:{payload:JSON.stringify({type:'block_actions',token:'verified',user:{id:user},channel:{id:context.RD.channel},message:{ts},actions:[{action_id:context.RD.action,value:row.key,action_ts:String(Date.now()/1000)}]})}});
 return {c:context,props,posts,row,record,put,click};
}
test('US phone normalization and lookup window validation',()=>{
 assert.equal(phoneKey('(202) 555-8391'),'12025558391');assert.equal(phoneKey('+44 1234567890'),null);
 assert.throws(()=>requestWindow({phone:'2025558391',from:'2026-11-10',to:'2026-11-13'},now));
 assert.throws(()=>requestWindow({phone:'2025558391',from:new Date(now).toISOString(),to:new Date(now).toISOString()},now));
});
test('call matching requires exact customer number and connected talk evidence',()=>{
 assert.equal(callMetadata([engagement],window).calls[0].connected,true);
 assert.equal(callMetadata([{...engagement,talk_duration:0}],window).calls[0].connected,false);
 assert.equal(callMetadata([{...engagement,consumers:[{consumer_number:'9999999999'}]}],window).calls.length,0);
 assert.equal(callMetadata([{...engagement,agents:[]}],window).calls[0].connected,false);
 assert.throws(()=>callMetadata([engagement,{...engagement,talk_duration:121}],window));
});
test('Zoom lookup paginates and rejects failed upstream lookup as unavailable',async()=>{
 let pages=0;
 const fetcher=async url=>String(url).includes('slack.com')?Response.json({ok:true,team_id:'TTEST',user_id:'UBOT'}):Response.json({engagements:pages++?[{...engagement,engagement_id:'call2'}]:[engagement],next_page_token:pages===1?'second':''});
 const request=()=>new Request('https://example.test/replacement-delivery/calls',{method:'POST',headers:{Authorization:'Bearer xoxb-test'},body:JSON.stringify({phone:window.phone,from:new Date(window.from).toISOString(),to:new Date(now).toISOString()})});
 const env={SLACK_TEAM_ID:'TTEST',SLACK_BOT_USER_ID:'UBOT',ZOOM_ACCOUNT_ID:'a',ZOOM_CLIENT_ID:'c',ZOOM_CLIENT_SECRET:'s'};
 const result=await replacementCalls(request(),env,async()=>'zoom-test',fetcher,now);
 assert.equal((await result.json()).calls.length,2);assert.equal(pages,2);
 const denied=await replacementCalls(request(),env,async()=>'zoom-test',async()=>new Response('',{status:403}),now);
 assert.equal(denied.status,503);assert.equal((await denied.json()).status,'unavailable');
});
test('missing bot authorization cannot reach Zoom',async()=>{
 let used=false;const r=await replacementCalls(new Request('https://example.test',{method:'POST'}),{SLACK_TEAM_ID:'TTEST',SLACK_BOT_USER_ID:'UBOT'},()=>{used=true;},()=>{used=true;},now);
 assert.equal(r.status,401);assert.equal(used,false);
});
test('acceptance rejects unauthorized tech, forged thread, and duplicate claims',()=>{
 const {c,record,put,click}=script();put(record);
 assert.match(c.rdRoute_(click('UOTHER')).body.text,/assigned/);
 assert.match(c.rdRoute_(click('UASSIGNED','wrong')).body.text,/does not match/);
 c.rdRoute_(click());assert.equal(c.rdRead_('CASE_'+record.key).claim.user,record.assignedId);
 assert.match(c.rdRoute_(click()).body.text,/already being saved/);
});
test('accepted cases suppress missed reminders and publish acceptance in same thread',()=>{
 const {c,row,record,put,click,posts}=script();put(record);c.rdRoute_(click());c.rdFinishClaims_([row]);
 assert.equal(c.rdRead_('CASE_'+record.key).acceptedBy,record.assignedId);
 assert.equal(c.rdRead_('CASE_'+record.key).acceptancePublished,true);
 const accepted=posts.find(p=>p.method==='chat.postMessage');assert.equal(accepted.body.thread_ts,record.rootTs);
 const before=posts.length;c.rdMorning_([row],now);assert.equal(posts.length,before);
 const report=c.rdReportLines_([row],now);assert.equal(report.accepted.length,1);assert.equal(report.missed.length,0);
});
test('accepted confirmation resumes safely after a temporary render failure',()=>{
 const {c,row,record,put,click}=script();put(record);c.rdRoute_(click());const real=c.rdRender_;c.rdRender_=()=>{throw Error('temporary');};
 assert.throws(()=>c.rdFinishClaims_([row]));assert.equal(c.rdRead_('CASE_'+record.key).acceptedBy,record.assignedId);
 c.rdRender_=real;c.rdFinishClaims_([row]);assert.equal(c.rdRead_('CASE_'+record.key).acceptancePublished,true);
});
test('both managers receive identical frozen daily reports and repeat runs do not duplicate',()=>{
 const {c,row,record,put,posts}=script();put(record);c.rdEod_([row],now);
 const reports=posts.filter(p=>p.method==='chat.postMessage');assert.equal(reports.length,2);
 assert.equal(reports[0].body.text,reports[1].body.text);assert.match(reports[0].body.text,/1 not accepted/);assert.match(reports[0].body.text,/Not checked yet/);
 record.acceptedBy=record.assignedId;record.acceptedAt=new Date(now).toISOString();put(record);c.rdEod_([row],now);assert.equal(posts.filter(p=>p.method==='chat.postMessage').length,2);
});
test('unknown Slack send outcome is held instead of sending duplicates',()=>{
 const {c}=script();let sends=0;c.rdApi_=()=>{sends++;throw Error('uncertain');};
 assert.throws(()=>c.rdSendOnce_('test',{channel:'C'}));assert.throws(()=>c.rdSendOnce_('test',{channel:'C'}));assert.equal(sends,1);
});
test('Central reporting dates follow daylight saving changes',()=>{
 const {c}=script();assert.equal(c.rdDay_('2026-07-01T05:30:00Z'),'2026-07-01');assert.equal(c.rdDay_('2026-11-13T05:30:00Z'),'2026-11-12');
});
