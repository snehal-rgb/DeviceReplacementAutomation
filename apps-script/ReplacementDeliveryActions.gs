/** Replacement delivery cases only. The screenshot is a design reference.
 * Install beside the existing Win-Onb handler. No writes to inventory column S.
 * Staged until rdActivate() is run after the deployed callback test succeeds.
 */
var RD = (function(){
  var p=PropertiesService.getScriptProperties();
  return Object.freeze({sheet:p.getProperty('RD_SHEET_ID') || '',tab:Number(p.getProperty('RD_TAB_ID') || 0),
    channel:p.getProperty('RD_SLACK_CHANNEL_ID') || '',team:p.getProperty('RD_SLACK_TEAM_ID') || '',app:p.getProperty('RD_SLACK_APP_ID') || '',zone:'America/Chicago',
    firstRow:1000,action:'replacement_delivery_accept_v2',prefix:'RD_V2_',
    managers:JSON.parse(p.getProperty('RD_MANAGER_USER_IDS') || '[]'),morningMinute:480,reportMinute:1380});
})();

function rdProps_(){return PropertiesService.getScriptProperties();}
function rdJson_(v){return ContentService.createTextOutput(JSON.stringify(v)).setMimeType(ContentService.MimeType.JSON);}
function rdEscape_(v){return String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function rdHash_(v){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(v),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function rdDay_(at){return Utilities.formatDate(new Date(at),RD.zone,'yyyy-MM-dd');}
function rdTime_(at){return Utilities.formatDate(new Date(at),RD.zone,'MMM d, yyyy h:mm a z');}
function rdPhone_(value){var n=String(value || '').replace(/\D/g,'');return /^\d{10}$/.test(n)?'1'+n:/^1\d{10}$/.test(n)?n:null;}
function rdTracking_(value){var s=String(value || '').trim(),m=s.match(/^https:\/\/track\.goshippo\.com\/tracking\/[a-f0-9]{32}\/([a-z0-9_]+)\/([a-zA-Z0-9]+)\/?(?:\?.*)?$/i);return m?{number:m[2],url:s.split('?')[0]}:/^\d{20,34}$/.test(s)?{number:s,url:'https://tools.usps.com/go/TrackConfirmAction?tLabels='+s}:/^1Z[A-Z0-9]{16}$/i.test(s)?{number:s.toUpperCase(),url:'https://www.ups.com/track?tracknum='+s}:null;}
function rdKey_(v){var t=rdTracking_(v[13]);return rdHash_(JSON.stringify([String(v[0]).trim(),t?t.number:String(v[13]).trim(),String(v[14]).trim()]));}
function rdRead_(key){var value=rdProps_().getProperty(RD.prefix+key);return value?JSON.parse(value):null;}
function rdChange_(key,change){var lock=LockService.getScriptLock();if(!lock.tryLock(500))throw new Error('Replacement state is busy; retry shortly');try{var next=change(rdRead_(key));if(next!==undefined){if(next===null)rdProps_().deleteProperty(RD.prefix+key);else rdProps_().setProperty(RD.prefix+key,JSON.stringify(next));}return next;}finally{lock.releaseLock();}}
function rdRecords_(){var p=rdProps_().getProperties();return Object.keys(p).filter(function(k){return k.indexOf(RD.prefix+'CASE_')===0;}).map(function(k){return JSON.parse(p[k]);});}
function rdRows_(){var s=SpreadsheetApp.openById(RD.sheet).getSheets().filter(function(s){return s.getSheetId()===RD.tab;})[0];if(!s || s.getName()!=='SSIQM-InventorySheet')throw new Error('Inventory tab mismatch');if(s.getLastRow()<RD.firstRow)return [];return s.getRange(RD.firstRow,1,s.getLastRow()-RD.firstRow+1,19).getDisplayValues().map(function(v,i){return {row:RD.firstRow+i,v:v,key:rdKey_(v)};}).filter(function(x){return x.v[15].trim()==='Replacement';});}
function rdCurrent_(record,rows){var found=rows.filter(function(x){return x.key===record.key;});if(found.length!==1)return null;return found[0];}
function rdToken_(){var c=rpConfig_(),token=c.token;if(typeof token!=='string' || token.indexOf('xoxb-')!==0)throw new Error('Replacement Slack connection is missing');return token;}
function rdApi_(method,body){
  var response;try{response=UrlFetchApp.fetch('https://slack.com/api/'+method,{method:'post',contentType:'application/json; charset=utf-8',headers:{Authorization:'Bearer '+rdToken_()},payload:JSON.stringify(body),muteHttpExceptions:true});}catch(_){throw new Error('Slack send outcome is uncertain');}
  var result;try{result=JSON.parse(response.getContentText());}catch(_){throw new Error('Slack send outcome is uncertain');}
  if(response.getResponseCode()!==200 || !result.ok){var e=new Error('Slack '+method+': '+String(result.error || response.getResponseCode()));e.definite=response.getResponseCode()===429 || response.getResponseCode()<500 && !!result.error && ['internal_error','request_timeout','fatal_error'].indexOf(result.error)<0;throw e;}return result;
}
function rdAgents_(){return JSON.parse(rdProps_().getProperty('RD_AGENT_USER_IDS') || '{}');}
function rdOwner_(x){var name=x.v[18].trim(),id=rdAgents_()[name];if(!id)throw new Error('Support tech in column S needs a verified Slack mapping');return {name:name,id:id};}
function rdDetails_(x){var labels=['Store name','Email','First name','Last name','Phone number','Street number','Street name','City','State','ZIP code'];return labels.map(function(label,i){return '*'+label+':* '+rdEscape_(x.v[i] || '—');}).join('\n');}
function rdText_(x,r){var t=rdTracking_(x.v[13]),accepted=r && r.acceptedBy;return (accepted?'✅ *Accepted: Replacement delivery*':'📦 *Replacement device delivered — action required*')+'\n'+(accepted?'<@'+accepted+'> accepted at '+rdTime_(r.acceptedAt):'<@'+rdOwner_(x).id+'> please accept and follow up with this customer.')+'\n\n'+rdDetails_(x)+'\n*Device:* '+rdEscape_(x.v[14])+'\n*Status:* '+rdEscape_(x.v[16])+'\n*Tracking:* '+(t?'<'+t.url+'|'+rdEscape_(t.number)+'>':rdEscape_(x.v[13]))+'\n*Inventory row:* <https://docs.google.com/spreadsheets/d/'+RD.sheet+'/edit#gid='+RD.tab+'&range=A'+x.row+':S'+x.row+'|'+x.row+'>\n*FYI:* <@'+RD.managers[0]+'> <@'+RD.managers[1]+'>';}
function rdBlocks_(x,r){var text=rdText_(x,r),parts=text.split('\n'),sections=[],part='';parts.forEach(function(line){if((part+'\n'+line).length>2800){sections.push({type:'section',text:{type:'mrkdwn',text:part}});part='';}part+=(part?'\n':'')+line;});if(part)sections.push({type:'section',text:{type:'mrkdwn',text:part}});if(r && r.acceptedBy)sections.push({type:'context',elements:[{type:'mrkdwn',text:'✅ Accepted by <@'+r.acceptedBy+'> · '+rdTime_(r.acceptedAt)}]});else sections.push({type:'actions',elements:[{type:'button',style:'primary',text:{type:'plain_text',text:'Accept'},action_id:RD.action,value:x.key}]});return sections;}

// No external API calls while holding the lock. A pending claim immediately
// suppresses unaccepted reminders; the worker verifies the current sheet first.
function rdRoute_(event){
  if(!event || !event.parameter || !event.parameter.payload)return null;
  var p;try{p=JSON.parse(event.parameter.payload);}catch(_){return null;}
  var a=p.actions && p.actions[0];if(p.type!=='block_actions' || !a || a.action_id!==RD.action)return null;
  var props=rdProps_();
  if(!rpVerifiedPayload_(p,{p:props,verification:props.getProperty('REPLACEMENT_SLACK_VERIFICATION_TOKEN')}))return rdJson_({response_type:'ephemeral',text:'The Slack request could not be verified.'});
  if(!/^[a-f0-9]{64}$/.test(a.value || '') || !p.user || !/^[UW][A-Z0-9]+$/.test(p.user.id))return rdJson_({response_type:'ephemeral',text:'Invalid acceptance request.'});
  var timestamp=Number(a.action_ts)*1000;
  if(!Number.isFinite(timestamp) || timestamp<Date.now()-300000 || timestamp>Date.now()+30000)return rdJson_({response_type:'ephemeral',text:'This acceptance request expired. Please click Accept again.'});
  var answer='Acceptance is being verified and will appear in this thread shortly.';
  try{rdChange_('CASE_'+a.value,function(r){
    if(!r || !p.channel || p.channel.id!==RD.channel || (p.message && p.message.ts || p.container && p.container.message_ts)!==r.rootTs){answer='This button does not match an active Replacement delivery case.';return;}
    if(r.closedAt){answer='This delivery case is already completed or no longer eligible.';return;}
    if(r.acceptedBy || r.claim){answer=r.acceptedBy?'<@'+r.acceptedBy+'> already accepted this case.':'An acceptance is already being saved.';return;}
    if(p.user.id!==r.assignedId && RD.managers.indexOf(p.user.id)<0){answer='This case is assigned to <@'+r.assignedId+'>. The assigned tech or a support lead can accept it.';return;}
    r.claim={user:p.user.id,queuedAt:new Date().toISOString(),event:a.action_ts};return r;
  });}catch(_){answer='Another update is being saved. Please click Accept again shortly.';}
  return rdJson_({response_type:'ephemeral',text:answer});
}

function rdSendOnce_(id,body){
  var acquired=false,existing=rdChange_('SEND_'+rdHash_(id),function(r){if(r)return r;acquired=true;return {state:'sending',at:new Date().toISOString()};});
  if(!acquired){if(existing.state==='sent')return existing.receipt;throw new Error('A previous Slack delivery needs review; it will not be repeated automatically');}
  try{var result=rdApi_('chat.postMessage',body);if(!result.ts || !result.channel)throw new Error('Slack receipt missing');var receipt={ts:result.ts,channel:result.channel};rdChange_('SEND_'+rdHash_(id),function(){return {state:'sent',at:new Date().toISOString(),receipt:receipt};});return receipt;}
  catch(e){rdChange_('SEND_'+rdHash_(id),function(r){if(e.definite)return null;r.state='uncertain';return r;});throw e;}
}
function rdRender_(x,r){return rdApi_('chat.update',{channel:RD.channel,ts:r.rootTs,text:rdText_(x,r),blocks:rdBlocks_(x,r),unfurl_links:false,unfurl_media:false});}

function rdMorning_(rows,now){
  var day=rdDay_(now);
  rows.filter(function(x){return x.v[16].trim()==='Delivered';}).forEach(function(x){
    var owner=rdOwner_(x),r=rdRead_('CASE_'+x.key);
    if(!r){var receipt=rdSendOnce_('root:'+x.key,{channel:RD.channel,text:rdText_(x),blocks:rdBlocks_(x),unfurl_links:false,unfurl_media:false});r=rdChange_('CASE_'+x.key,function(old){return old || {key:x.key,row:x.row,rootTs:receipt.ts,assignedId:owner.id,assignedName:owner.name,openedAt:new Date(now).toISOString(),lastReminderDay:day};});}
    if(r.closedAt || r.acceptedBy || r.claim || r.lastReminderDay===day)return;
    // A new assignment must not continue tagging the previous owner.
    r=rdChange_('CASE_'+x.key,function(live){live.assignedId=owner.id;live.assignedName=owner.name;return live;});
    rdRender_(x,r);
    rdSendOnce_('reminder:'+x.key+':'+day,{channel:RD.channel,thread_ts:r.rootTs,text:'🔔 <@'+owner.id+'> this delivered Replacement device is still waiting for acceptance. Please use *Accept* on the original message.\n*FYI:* <@'+RD.managers[0]+'> <@'+RD.managers[1]+'>',unfurl_links:false});
    rdChange_('CASE_'+x.key,function(live){live.lastReminderDay=day;return live;});
  });
}
function rdFinishClaims_(rows){
  rdRecords_().filter(function(r){return r.claim || r.acceptedBy && !r.acceptancePublished;}).forEach(function(snapshot){
    var x=rdCurrent_(snapshot,rows),owner=x?rdOwner_(x):null,claim=snapshot.claim;
    if(!x || snapshot.claim && (x.v[16].trim()!=='Delivered' || owner.id!==snapshot.assignedId)){
      rdChange_('CASE_'+snapshot.key,function(r){if(claim && r.claim && r.claim.event===claim.event)delete r.claim;return r;});
      if(!claim)return;rdSendOnce_('rejected:'+snapshot.key+':'+claim.event,{channel:RD.channel,thread_ts:snapshot.rootTs,text:'The case changed while acceptance was being saved. No acceptance was recorded. Please review the latest inventory details.'});return;
    }
    var r=rdChange_('CASE_'+snapshot.key,function(live){if(!live.acceptedBy && claim && live.claim && live.claim.event===claim.event){live.acceptedBy=claim.user;live.acceptedAt=claim.queuedAt;delete live.claim;}return live;});
    if(r.acceptedBy){rdRender_(x,r);rdSendOnce_('accepted:'+r.key,{channel:RD.channel,thread_ts:r.rootTs,text:rdText_(x,r),blocks:rdBlocks_(x,r),unfurl_links:false,unfurl_media:false});rdChange_('CASE_'+r.key,function(l){l.acceptancePublished=true;return l;});}
  });
}
function rdZoom_(phone,from,to){
  var endpoint=rdProps_().getProperty('RD_ZOOM_BRIDGE_URL');
  if(!endpoint)return {status:'unavailable',reason:'Zoom call-log connection is not configured'};
  if(!/^https:\/\/[a-z0-9.-]+\.workers\.dev\/replacement-delivery\/calls$/.test(endpoint))return {status:'unavailable',reason:'Zoom bridge endpoint needs review'};
  try{var r=UrlFetchApp.fetch(endpoint,{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+rdToken_()},payload:JSON.stringify({phone:phone,from:new Date(from).toISOString(),to:new Date(to).toISOString()}),muteHttpExceptions:true,followRedirects:false});var d=JSON.parse(r.getContentText());if(r.getResponseCode()!==200 || ['verified','partial'].indexOf(d.status)<0)return {status:'unavailable',reason:d.reason || 'Zoom lookup failed'};return d;}catch(_){return {status:'unavailable',reason:'Zoom lookup failed'};}
}
function rdCallLines_(call){return '*Zoom call:* '+rdEscape_(call.id)+'\n*Agent:* '+(call.agents || []).map(function(a){return rdEscape_(a.name || a.email || a.id);}).join(', ')+'\n*Time:* '+rdTime_(call.start)+'\n*Direction:* '+rdEscape_(call.direction)+'\n*Result:* '+rdEscape_(call.outcome)+'\n*Talk time:* '+(call.talkSeconds===null?'Not available':call.talkSeconds+' seconds');}
function rdPollCalls_(rows,now,force){
  var records=rdRecords_().filter(function(r){return !r.closedAt;}),phones={};
  records.forEach(function(r){var x=rdCurrent_(r,rows),p=x && rdPhone_(x.v[4]);if(p)phones[p]=(phones[p] || 0)+1;});
  var checked=0,deadline=Date.now()+180000;
  records.sort(function(a,b){return (a.lastLookupAt || '').localeCompare(b.lastLookupAt || '');}).forEach(function(r){
    if(Date.now()>=deadline || checked>=6 || !force && r.lastLookupAt && now-Date.parse(r.lastLookupAt)<300000)return;
    var x=rdCurrent_(r,rows);
    if(!x){rdChange_('CASE_'+r.key,function(l){l.closedAt=new Date(now).toISOString();l.closedReason=x?x.v[16]:'Inventory shipment changed or moved outside the configured scope';return l;});return;}
    var phone=rdPhone_(x.v[4]);checked++;
    var lookupFrom=Math.max(Date.parse(r.openedAt),now-25*3600000);if(lookupFrom>=now)return;
    var result=!phone?{status:'unavailable',reason:'Customer phone number needs review'}:phones[phone]>1?{status:'unavailable',reason:'Multiple open Replacement cases share this number; a case-specific call match needs review'}:rdZoom_(phone,lookupFrom,now);
    if(result.status==='verified' || result.status==='partial'){
      (result.calls || []).forEach(function(call){
        var key='CALL_'+r.key+'_'+rdHash_(call.id),previous=rdRead_(key);
        if(!previous || previous.outcome!==call.outcome || previous.talkSeconds!==call.talkSeconds)rdChange_(key,function(){return {caseKey:r.key,call:call};});
        if(call.connected)rdSendOnce_('connected:'+r.key+':'+call.id,{channel:RD.channel,thread_ts:r.rootTs,text:'📞 *Customer reached — verified Zoom call*\n'+rdCallLines_(call),unfurl_links:false});
      });
    }
    rdChange_('CASE_'+r.key,function(l){l.lastLookupAt=new Date(now).toISOString();l.callStatus=result.status;l.callReason=result.reason || (result.unverifiable?'Some records could not be matched safely':'');if(['Onboarding Done','Device Returned'].indexOf(x.v[16].trim())>=0){l.closedAt=new Date(now).toISOString();l.closedReason=x.v[16];}return l;});
  });return checked;
}
function rdCallsFor_(key,day){var all=rdProps_().getProperties();return Object.keys(all).filter(function(k){return k.indexOf(RD.prefix+'CALL_'+key+'_')===0;}).map(function(k){return JSON.parse(all[k]).call;}).filter(function(c){return rdDay_(c.start)===day;}).sort(function(a,b){return a.start.localeCompare(b.start);});}
function rdReportLines_(rows,now){
  var day=rdDay_(now),records=rdRecords_(),accepted=[],missed=[],pending=[],completed=[];
  records.forEach(function(r){
    var x=rdCurrent_(r,rows);if(!x)return;
    if(r.closedAt && rdDay_(r.closedAt)!==day)return;
    var link='<https://app.slack.com/archives/'+RD.channel+'/p'+r.rootTs.replace('.','')+'|'+rdEscape_(x.v[0])+' · row '+x.row+'>',calls=rdCallsFor_(r.key,day);
    var title=r.claim?'⏳ Acceptance pending verification':r.acceptedBy?'✅ Accepted by <@'+r.acceptedBy+'> at '+rdTime_(r.acceptedAt):r.closedAt?'✅ Completed':'❌ Not accepted · assigned to <@'+r.assignedId+'>';
    var details=[title+'\n'+link];
    if(calls.length)details=details.concat(calls.map(rdCallLines_));
    else details.push(r.callStatus==='verified'?'*Zoom calls:* No matching calls recorded today.':'*Zoom calls:* '+rdEscape_(r.callReason || 'Not checked yet; call evidence unavailable.'));
    if(r.callStatus==='partial')details.push('*Call-data note:* '+rdEscape_(r.callReason || 'Some records could not be matched safely.'));
    (r.claim?pending:r.acceptedBy?accepted:r.closedAt?completed:missed).push(details.join('\n'));
  });
  return {day:day,accepted:accepted,missed:missed,pending:pending,completed:completed};
}
function rdReportText_(report){return ['*Replacement delivery — end-of-day report*','*Date:* '+report.day+' · Central Time',report.accepted.length+' accepted · '+report.missed.length+' not accepted · '+report.pending.length+' pending verification · '+report.completed.length+' completed',
  '\n*Accepted cases*'].concat(report.accepted.length?report.accepted:['None.'],['\n*Missed / not accepted*'],report.missed.length?report.missed:['None.'],['\n*Pending acceptance verification*'],report.pending.length?report.pending:['None.'],['\n*Completed without recorded acceptance*'],report.completed.length?report.completed:['None.']).join('\n\n');}
function rdChunks_(text){var parts=[],part='';text.split('\n\n').forEach(function(s){if(s.length>3500)throw new Error('A case report exceeds the Slack message limit; no incomplete report was sent');if((part+'\n\n'+s).length>3500){parts.push(part);part='';}part+=(part?'\n\n':'')+s;});if(part)parts.push(part);return parts;}
function rdEod_(rows,now){
  var day=rdDay_(now),frozen=rdRead_('REPORT_'+day);
  if(!frozen){var report=rdReportLines_(rows,now),prepared=rdChunks_(rdReportText_(report));prepared.forEach(function(text,i){rdChange_('REPORT_PART_'+day+'_'+i,function(){return {text:text};});});frozen={day:day,parts:prepared.length,recipients:RD.managers.length,accepted:report.accepted.length,missed:report.missed.length,pending:report.pending.length};rdChange_('REPORT_'+day,function(){return frozen;});}
  RD.managers.forEach(function(user){var dm=rdApi_('conversations.open',{users:user});if(!dm.channel || !dm.channel.id)throw new Error('Report DM could not be opened');for(var i=0;i<frozen.parts;i++){var part=rdRead_('REPORT_PART_'+day+'_'+i);if(!part)throw new Error('Saved daily report is incomplete');rdSendOnce_('eod:'+day+':'+user+':'+i,{channel:dm.channel.id,text:part.text,unfurl_links:false,unfurl_media:false});}});return frozen;
}
function rdPreview(){var rows=rdRows_(),report=rdReportLines_(rows,Date.now());console.log(JSON.stringify({enabled:rdProps_().getProperty(RD.prefix+'ENABLED')==='true',morning:'08:00 America/Chicago',eod:'23:00 America/Chicago',caseCount:rdRecords_().length,reportCounts:{accepted:report.accepted.length,missed:report.missed.length,pending:report.pending.length},zoomConfigured:!!rdProps_().getProperty('RD_ZOOM_BRIDGE_URL')}));return report;}
function rdTick(){
  if(rdProps_().getProperty(RD.prefix+'ENABLED')!=='true')return;
  var now=Date.now(),lease=Utilities.getUuid(),won=false;
  rdChange_('LEASE',function(old){if(old && old.until>now)return;won=true;return {id:lease,until:now+290000};});if(!won)return;
  try{var day=rdDay_(now),minute=Number(Utilities.formatDate(new Date(now),RD.zone,'H'))*60+Number(Utilities.formatDate(new Date(now),RD.zone,'m')),rows=rdRows_();
    rdFinishClaims_(rows);
    if(minute>=RD.morningMinute && minute<RD.morningMinute+60)rdMorning_(rows,now);
    rdPollCalls_(rows,now,false);
    if(minute>=RD.reportMinute && !rdRead_('EOD_'+day)){var ready=rdRecords_().every(function(r){return r.closedAt || r.lastLookupAt && now-Date.parse(r.lastLookupAt)<600000;});if(ready){var report=rdEod_(rows,now);rdChange_('EOD_'+day,function(){return report;});}}
  }finally{rdChange_('LEASE',function(old){return old && old.id===lease?null:old;});}
}
function rdActivate(){
  if(rdProps_().getProperty('RD_V2_LIVE_TEST_VERIFIED')!=='true')throw new Error('Live callback, Zoom lookup, and report tests must be verified before activation');
  if(RD.managers.length!==2 || !RD.sheet || !RD.tab || !RD.channel)throw new Error('Replacement workflow configuration is incomplete');
  rdToken_();if(!rdProps_().getProperty('RD_ZOOM_BRIDGE_URL'))throw new Error('Verify the Zoom bridge before activating this workflow');
  var existing=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='rdTick';});if(existing.length>1)throw new Error('Duplicate Replacement worker triggers need review');if(!existing.length)ScriptApp.newTrigger('rdTick').timeBased().everyMinutes(1).create();
  rdProps_().setProperty(RD.prefix+'ENABLED','true');return rdPreview();
}
