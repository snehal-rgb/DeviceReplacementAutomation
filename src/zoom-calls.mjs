// Narrow, authenticated call-metadata lookup for Replacement delivery threads.
// Uses encrypted Worker secrets; never returns audio or tokens.
const verifiedTokens = new Map();

export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return '1' + digits;
  if (/^1\d{10}$/.test(digits)) return digits;
  return null;
}

export function requestWindow(input, now = Date.now()) {
  if (!input || Object.keys(input).some(k => !['phone', 'from', 'to'].includes(k))) throw new Error('INVALID_REQUEST');
  const phone = phoneKey(input.phone), from = Date.parse(input.from), to = Date.parse(input.to);
  if (!phone || !Number.isFinite(from) || !Number.isFinite(to) || from >= to || to > now + 300000 || to - from > 26 * 3600000) throw new Error('INVALID_LOOKUP_WINDOW');
  return {phone, from, to};
}

export function callMetadata(rows, window) {
  const calls = new Map();
  let unverifiable = 0;
  for (const e of rows) {
    const channels = Array.isArray(e.channels) && e.channels.length ? e.channels : Array.isArray(e.channel_types) && e.channel_types.length ? e.channel_types : e.channel ? [e.channel] : [];
    if(!channels.length){unverifiable++;continue;}
    if(!Array.isArray(channels)){unverifiable++;continue;}
    if (!channels.some(c => /voice/i.test(typeof c === 'string' ? c : c.channel || ''))) continue;
    const consumers = e.consumers || [];
    if (!consumers.some(c => phoneKey(c.consumer_number) === window.phone)) { unverifiable++; continue; }
    const start = Date.parse(e.start_time);
    if (!e.engagement_id || !Number.isFinite(start)) { unverifiable++; continue; }
    if (start < window.from || start >= window.to) continue;
    const end = e.end_time ? Date.parse(e.end_time) : null;
    const duration = typeof e.talk_duration === 'number' && Number.isFinite(e.talk_duration) && e.talk_duration >= 0 ? e.talk_duration : null;
    const agents = (e.agents || e.users || []).map(a => ({
      id: String(a.user_id || a.id || ''),
      name: String(a.display_name || a.user_name || a.name || ''),
      email: String(a.user_email || a.email || '').trim().toLowerCase(),
    })).filter(a => a.id || a.name || a.email);
    const finished = end !== null && Number.isFinite(end) && end >= start;
    const connected = finished && duration !== null && duration > 0 && agents.length > 0;
    const item = {id: String(e.engagement_id), start: new Date(start).toISOString(),
      end: finished ? new Date(end).toISOString() : null,
      direction: ['inbound', 'outbound'].includes(e.direction) ? e.direction : 'unknown',
      talkSeconds: duration, agents, connected,
      outcome: connected ? 'connected' : !finished ? 'in_progress' : duration === 0 ? 'no_connected_talk_recorded' : 'unknown'};
    const previous = calls.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('CONFLICTING_CALL_RECORDS');
    calls.set(item.id, item);
  }
  return {calls: [...calls.values()].sort((a, b) => a.start.localeCompare(b.start)), unverifiable};
}

async function authorize(request, env, fetcher, now) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer xoxb-[A-Za-z0-9-]+$/.test(authorization)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SLACK_TEAM_ID+'|'+env.SLACK_BOT_USER_ID+'|'+authorization)));
  const key = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
  if ((verifiedTokens.get(key) || 0) > now) return true;
  const r = await fetcher('https://slack.com/api/auth.test', {headers: {Authorization: authorization}, signal: AbortSignal.timeout(10000)});
  const a = await r.json();
  if (!r.ok || !a.ok || a.team_id !== env.SLACK_TEAM_ID || a.user_id !== env.SLACK_BOT_USER_ID) return false;
  if (verifiedTokens.size > 32) verifiedTokens.clear();
  verifiedTokens.set(key, now + 60000);
  return true;
}

export async function replacementCalls(request, env, getZoomToken, fetcher = fetch, now = Date.now()) {
  const reply = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
  if (request.method !== 'POST') return reply({status: 'method_not_allowed'}, 405);
  try {
    if (!env.SLACK_TEAM_ID || !env.SLACK_BOT_USER_ID) return reply({status:'unavailable',reason:'slack_identity_not_configured'},503);
    if (!await authorize(request, env, fetcher, now)) return reply({status: 'unauthorized'}, 401);
    const text = await request.text();
    if (text.length > 2048) return reply({status: 'invalid_request'}, 400);
    let window;
    try { window = requestWindow(JSON.parse(text), now); } catch { return reply({status: 'invalid_request'}, 400); }
    if (!['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'].every(k => env[k])) return reply({status: 'unavailable', reason: 'zoom_connection_missing'}, 503);
    const token = await getZoomToken(env), rows = [], seen = new Set(), deadline=Date.now()+45000;
    let next = '';
    for (let page = 0; page < 10; page++) {
      if(Date.now()>=deadline)return reply({status:'unavailable',reason:'zoom_lookup_time_limit'},503);
      const url = new URL('https://api.zoom.us/v2/contact_center/engagements');
      url.search = new URLSearchParams({from: new Date(Math.floor(window.from/1000)*1000).toISOString().replace('.000Z','Z'), to: new Date(Math.ceil(window.to/1000)*1000).toISOString().replace('.000Z','Z'), timezone:'UTC', channel:'voice',
        consumer_number: window.phone, page_size: '100', ...(next ? {next_page_token: next} : {})});
      const r = await fetcher(url, {headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000)});
      if (!r.ok) return reply({status: 'unavailable', reason: r.status === 401 || r.status === 403 ? 'zoom_access_required' : 'zoom_request_failed', upstreamStatus: r.status}, 503);
      const data = await r.json();
      if (!Array.isArray(data.engagements)) return reply({status: 'unavailable', reason: 'zoom_response_incomplete'}, 503);
      rows.push(...data.engagements);
      next = data.next_page_token || '';
      if (!next) break;
      if (seen.has(next)) return reply({status: 'unavailable', reason: 'zoom_pagination_loop'}, 503);
      seen.add(next);
    }
    if (next) return reply({status: 'unavailable', reason: 'zoom_result_limit_reached'}, 503);
    const result = callMetadata(rows, window);
    return reply({status: result.unverifiable ? 'partial' : 'verified', ...result, checkedAt: new Date(now).toISOString()});
  } catch(error) {
    const reasons={ZOOM_CONNECTION_MISSING:'zoom_connection_missing',ZOOM_AUTHENTICATION_FAILED:'zoom_authentication_failed',ZOOM_TOKEN_RESPONSE_INVALID:'zoom_token_response_invalid',ZOOM_ENGAGEMENT_READ_SCOPE_MISSING:'zoom_engagement_read_scope_missing'};
    // Provider response bodies can contain contacts or credentials. Do not log them.
    return reply({status: 'unavailable', reason: reasons[error?.message] || 'lookup_failed'}, 503);
  }
}
