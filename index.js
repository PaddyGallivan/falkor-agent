
// falkor-agent v2.7.0 — Phase 60 screen vision: screenshot → /vision chain
// v1.7.0 adds:
//   1. Live context pre-loader — fetches weather/calendar/sport/tips before first reply
//   2. Auto-memory — every 5 turns, Haiku extracts memorable facts → falkor-brain
//   3. Action handlers — "email me X", "note this", "remind me about X" → real actions

const BRAIN_URL    = 'https://falkor-brain.luckdragon.io';
const CALENDAR_URL = 'https://falkor-calendar.luckdragon.io';
const SPORT_URL    = 'https://falkor-sport.luckdragon.io';
const WEATHER_URL  = 'https://asgard-ai.luckdragon.io';
const PUSH_URL     = 'https://falkor-push.luckdragon.io';
const WORKFLOWS_URL = 'https://falkor-workflows.luckdragon.io';

// WPS coordinates (Williamstown Primary School)
const WPS_LAT = -37.8594;
const WPS_LON = 144.8750;

// Context bundle TTL: 10 minutes (don't re-fetch every message)
const CONTEXT_TTL_MS = 10 * 60 * 1000;

// Auto-memory: extract facts every N assistant turns
const MEMORY_EXTRACT_INTERVAL = 5;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Pin, Upgrade, Connection',
};

// ── User context builder ──────────────────────────────────────────────────────
function buildUserContext(userId) {
  const profiles = {
    paddy: {
      name: 'Paddy',
      desc: "a PE teacher at Williamstown Primary School (WPS). He runs Kow Brainer Trivia (KBT), loves AFL (Essendon), runs family footy tips and racing tipping comps, and manages three sports products: Carnival Timing, School Sport Portal, and SportCarnival.",
      interests: ['AFL', 'Essendon', 'KBT trivia', 'PE', 'WPS school', 'footy tips', 'TAB racing', 'family'],
      email: 'pgallivan@outlook.com',
    },
    jacky: {
      name: 'Jacky',
      desc: "a family member who uses Falkor for footy tips, racing, and general queries.",
      interests: ['footy tips', 'racing', 'family'],
      email: null,
    },
    george: {
      name: 'George',
      desc: "a family member who uses Falkor for footy tips, racing, and general queries.",
      interests: ['footy tips', 'racing', 'family'],
      email: null,
    },
    aeneas: {
      name: 'Aeneas',
      desc: "Paddy's brother. Uses Falkor for footy tips, racing, and family comps.",
      interests: ['footy tips', 'AFL', 'racing', 'family'],
      email: 'aeneasg@hotmail.com',
    },
  };
  return profiles[userId] || { name: userId || 'there', desc: 'a Falkor user.', interests: [], email: null };
}

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}


// ── Paddy's mode detector (AEST) ─────────────────────────────────────────────
function getPaddyState() {
  const nowAEST = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const h = nowAEST.getUTCHours();
  const d = nowAEST.getUTCDay();
  const isWeekday = d >= 1 && d <= 5;
  if (h >= 23 || h < 6)  return { mode: 'sleep',   quiet: true,  label: 'probably asleep — keep it brief if they somehow messaged' };
  if (isWeekday && h >= 8  && h < 15) return { mode: 'school',  quiet: true,  label: 'at school (WPS) — ultra concise, he has kids around' };
  if (isWeekday && h >= 7  && h < 8)  return { mode: 'commute', quiet: true,  label: 'commuting — short replies only' };
  if (isWeekday && h >= 15 && h < 16) return { mode: 'commute', quiet: false, label: 'just finished school, leaving' };
  if (h >= 18 && h < 23)              return { mode: 'evening', quiet: false, label: 'evening — relaxed, can be conversational' };
  return { mode: 'free', quiet: false, label: 'free time' };
}

// ── A2A Sub-agent Registry ────────────────────────────────────────────────────
const AGENTS = {
  sport:     SPORT_URL,
  kbt:       'https://falkor-kbt.luckdragon.io',
  brain:     BRAIN_URL,
  workflows: WORKFLOWS_URL,
  school:    'https://falkor-school.luckdragon.io',
  web:       'https://falkor-web.luckdragon.io',
  code:      'https://falkor-code.luckdragon.io',
  desktop:   'https://falkor-desktop.luckdragon.io',
};

const AGENT_MODEL_OVERRIDES = { sport: 'haiku', kbt: 'haiku', web: 'haiku' };

function routeIntent(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(afl|footy|football|ladder|tip|tipping|squiggle|racing|horse|race|round|score|fixture|essendon|collingwood|hawks|bombers|cats|demons|carlton|richmond|western bulldogs|fremantle|geelong|hawthorn|melbourne|port adelaide|gold coast|gws|brisbane|sydney|west coast|st kilda|north melbourne|adelaide|nrl|rugby league|panthers|penrith|warriors|roosters|rabbitohs|broncos|bulldogs|sharks|tigers|raiders|cowboys|sea eagles|eels|storm|titans|knights|dragons|rabbitohs|dolphins)\b/.test(t))
    return { agent: 'sport', action: 'summary' };
  if (/\b(trivia|kbt|kow|brainer|quiz|question|pub quiz|game|host|players|leaderboard|event tonight|next event)\b/.test(t))
    return { agent: 'kbt', action: 'query' };
  if (/\b(deploy|fix worker|broken worker|fleet|falkor-code|self.heal|redeploy|worker health|which workers|code agent)\b/.test(t)) {
    // Detect specific deploy/fix/self-heal actions
    const workerMatch = t.match(/\bfalkor-[\w-]+\b/);
    const workerName = workerMatch ? workerMatch[0] : null;
    if (/\bself[\s.-]?heal\b/.test(t)) return { agent: 'code', action: 'self_heal' };
    if (/\b(fix|repair|broken)\b/.test(t) && workerName) return { agent: 'code', action: 'fix', workerName };
    if (/\b(deploy|redeploy)\b/.test(t) && workerName) return { agent: 'code', action: 'deploy', workerName };
    return { agent: 'code', action: 'summary' };
  }
  if (/(lesson plan|plan.*week|week.*plan|plan.*lesson|what should i teach|teaching plan|activities for|session plan|plan.*pe|pe.*plan|plan.*class|class.*plan)/.test(t))
    return { agent: 'school', action: 'lesson_week' };
  if (/(single lesson|one lesson|today.*lesson|lesson.*today|45.*min|30.*min|60.*min lesson)/.test(t) && /(pe|sport|lesson|teach|class|activity)/.test(t))
    return { agent: 'school', action: 'lesson_single' };
  if (/\b(xc.*results|cross.country.*results|show.*xc|xc.*leaderboard|who.*won.*xc|xc.*standings|district.*xc|xc.*today|today.*xc|xc.*scores)\b/.test(t))
    return { agent: 'school', action: 'xc_query' };
  if (/\b(record.*result|came.*first|came.*second|finished.*first|xc.*result|result.*xc)\b/.test(t) && /\b(1st|2nd|3rd|first|second|third|\d+th)\b/i.test(t))
    return { agent: 'school', action: 'xc_record' };
  if (/\b(xc.*email|email.*xc|send.*xc|xc.*results.*email|email.*cross.country|cross.country.*email)\b/.test(t))
    return { agent: 'school', action: 'xc_email' };
  if (/(pe|physical education|sports day|cross.country|carnival|students|wps|williamstown primary|outdoor|weather for school|athletics|sprint|house points|outdoor.*activity|suitable.*pe|pe.*suitable)/.test(t))
    return { agent: 'school', action: 'query' };
  if (/\b(weather|temperature|forecast|rain|uv|wind|celsius|degrees|conditions)\b/.test(t) && !/school|pe|lesson/.test(t))
    return { agent: 'workflows', action: 'weather' };
  if (/\b(remember|recall|what do you know|brain|memory|stored|learned|told you|history of)\b/.test(t))
    return { agent: 'brain', action: 'recall' };
  if (/\b(search|look up|find|google|what is|who is|latest|news|current|today's|recent)\b/.test(t) && t.length < 200)
    return { agent: 'web', action: 'search' };
  if (/\b(open app|open program|take screenshot|screenshot|click|type on screen|computer control|run command|show on screen|my computer|desktop task|what.s on my screen|see my screen|look at my screen|what do you see|what am i looking at|analyse my screen|check my screen|read my screen|screen capture|what.s on screen)\b/.test(t))
    return { agent: 'desktop', action: 'command' };
  return null;
}

async function callSubAgent(agentKey, action, text, pin, aiPin, intentCtx) {
  const baseUrl = AGENTS[agentKey];
  if (!baseUrl) return null;
  try {
    switch (agentKey) {
      case 'sport':
        return fetch(`${baseUrl}/summary`, { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null);
      case 'kbt':
        return fetch(`${baseUrl}/summary`, { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null);
      case 'code': {
        const codeAction = agentKey === 'code' ? action : 'summary';
        const workerName = intentCtx && intentCtx.workerName;
        if (codeAction === 'self_heal') {
          return fetch(`${baseUrl}/self-heal`, { method: 'POST', headers: { 'X-Pin': pin, 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.ok ? r.json() : null);
        }
        if (codeAction === 'deploy' && workerName) {
          return fetch(`${baseUrl}/deploy`, { method: 'POST', headers: { 'X-Pin': pin, 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_name: workerName }) }).then(r => r.ok ? r.json() : null);
        }
        if (codeAction === 'fix' && workerName) {
          return fetch(`${baseUrl}/fix`, { method: 'POST', headers: { 'X-Pin': pin, 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_name: workerName }) }).then(r => r.ok ? r.json() : null);
        }
        return fetch(`${baseUrl}/summary`, { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null);
      }
      case 'brain':
        return fetch(`${baseUrl}/recall`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({ query: text, top_k: 5, answer: true }),
        }).then(r => r.ok ? r.json() : null);
      case 'workflows':
        return fetch(`${WEATHER_URL}/weather?lat=${WPS_LAT}&lon=${WPS_LON}`, {
          headers: { 'X-Pin': aiPin || pin },
        }).then(r => r.ok ? r.json() : null);
      case 'school': {
        const schoolAction = intent.action || 'query';
        if (schoolAction === 'xc_query' || schoolAction === 'xc_record') {
          const today = new Date().toISOString().slice(0, 10);
          const catM = userText.match(/\b(\d+\s*(?:boys?|girls?|mixed)|open\s*(?:boys?|girls?)|yr\s*\d+\s*(?:boys?|girls?)|u\s*\d+\s*(?:boys?|girls?))\b/i);
          const xcCat = catM ? catM[0].replace(/\s+/g, '').toLowerCase() : '';
          if (schoolAction === 'xc_query') {
            const qurl = xcCat ? 'https://falkor-school.luckdragon.io/xc/results?category=' + encodeURIComponent(xcCat) + '&event_date=' + today : 'https://falkor-school.luckdragon.io/xc/results?event_date=' + today;
            const qr = await fetch(qurl, { headers: { 'X-Pin': env.AGENT_PIN } });
            const qd = await qr.json().catch(() => ({}));
            if (xcCat && qd.results) {
              if (!qd.results.length) return Response.json({ reply: 'No XC results yet for ' + xcCat + ' today.', source: 'school' });
              const lines = qd.results.map(function(x) { return x.position + '. ' + x.name + (x.time ? ' (' + x.time + ')' : ''); }).join(', ');
              return Response.json({ reply: 'XC ' + xcCat + ': ' + lines, source: 'school' });
            } else if (qd.categories) {
              const cats = Object.entries(qd.categories);
              if (!cats.length) return Response.json({ reply: 'No XC results recorded today yet.', source: 'school' });
              const summary = cats.map(function(e) { return e[0] + ': ' + (e[1][0] ? '1st ' + e[1][0].name : 'no results'); }).join(' | ');
              return Response.json({ reply: "Today's XC: " + summary, source: 'school' });
            }
            return Response.json({ reply: 'Could not fetch XC results.', source: 'school' });
          }
          const posM = userText.match(/\b(1st|2nd|3rd|\d+th|\d+)(?:st|nd|rd|th)?\b/i);
          const timeM = userText.match(/\b(\d{1,2}:\d{2}(?:\.\d+)?)\b/);
          const nameM = userText.match(/(?:1st|2nd|3rd|\d+th?|first|second|third)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
          if (!xcCat || !posM || !nameM) return Response.json({ reply: 'Include age group, position and name. E.g. "10 boys 1st Elias 8:06". Or use /xc in Telegram.', source: 'school' });
          const pos = posM[1].replace(/[^0-9]/g, '') || '1';
          const rr = await fetch('https://falkor-school.luckdragon.io/xc/result', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': env.AGENT_PIN }, body: JSON.stringify({ category: xcCat, position: pos, name: nameM[1], time: timeM ? timeM[1] : '', event_date: today }) });
          const rd = await rr.json().catch(() => ({}));
          if (rd.ok) return Response.json({ reply: 'Recorded: ' + xcCat + ' ' + pos + '. ' + nameM[1] + (timeM ? ' (' + timeM[1] + ')' : '') + '. ' + rd.results.length + ' result(s) today.', source: 'school' });
          return Response.json({ reply: 'Failed: ' + (rd.error || 'unknown'), source: 'school' });
        }
        if (schoolAction === 'xc_email') {
          const dateM = userText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
          const xcDate = dateM ? dateM[1] : new Date().toISOString().slice(0, 10);
          const er = await fetch('https://falkor-school.luckdragon.io/xc/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Pin': env.AGENT_PIN },
            body: JSON.stringify({ event_date: xcDate, to: 'pgallivan@outlook.com' })
          });
          const ed = await er.json().catch(function() { return {}; });
          if (ed.ok) return Response.json({ reply: 'XC results email sent for ' + xcDate + ' (' + ed.categories + ' categories, ' + ed.runners + ' runners) to pgallivan@outlook.com.', source: 'school' });
          return Response.json({ reply: 'Email failed: ' + (ed.error || 'unknown error'), source: 'school' });
        }
        if (schoolAction === 'lesson_week' || schoolAction === 'lesson_single') {
          // Parse year level, duration, theme from the query
          const ylMatch = text.match(/year\s*(\d+(?:\/\d+)?|f(?:oundation)?)/i);
          const yl = ylMatch ? 'Year ' + ylMatch[1].charAt(0).toUpperCase() + ylMatch[1].slice(1) : 'Mixed F-6';
          const durMatch = text.match(/(\d+)\s*min/i);
          const dur = durMatch ? parseInt(durMatch[1]) : 45;
          const themeMatch = text.match(/(?:about|on|for|theme[:\s]+)\s*([\w\s]+?)(?:\s*\d+\s*min|\s*$)/i);
          const rawTheme = themeMatch ? themeMatch[1].trim() : '';
          const stopWords = ['plan', 'lesson', 'week', 'my', 'the', 'a', 'an', 'class', 'session'];
          const theme = rawTheme.split(' ').filter(w => !stopWords.includes(w.toLowerCase())).join(' ').trim();
          if (schoolAction === 'lesson_week') {
            const res = await fetch(baseUrl + '/lesson-week', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
              body: JSON.stringify({ year_level: yl, duration: dur, theme: theme || null }),
            });
            if (!res.ok) return null;
            return res.json();
          } else {
            const res = await fetch(baseUrl + '/lesson-plan', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
              body: JSON.stringify({ year_level: yl, duration: dur, focus: theme || null }),
            });
            if (!res.ok) return null;
            return res.json();
          }
        }
        return fetch(baseUrl + '/summary', { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null);
      }
      case 'web':
        return fetch(`${baseUrl}/search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({ query: text }),
        }).then(r => r.ok ? r.json() : null);
      case 'desktop': {
        // Check if this is a screen vision request
        const isScreenVision = /screenshot|what.s on.*(screen|display)|see.*screen|look.*screen|what am i looking at|what do you see|analyse.*screen|read.*screen/i.test(text);
        if (isScreenVision) {
          // Route to /screenshot which queues + polls for base64 result
          const sRes = await fetch(baseUrl + '/screenshot', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
            body: JSON.stringify({ prompt: text, requested_by: 'falkor-agent' }),
          });
          if (!sRes.ok) return null;
          const sData = await sRes.json();
          if (sData.image_b64) {
            // Pass base64 to asgard-ai vision
            const vRes = await fetch('https://asgard-ai.luckdragon.io/chat/vision', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': aiPin },
              body: JSON.stringify({
                image_base64: sData.image_b64,
                image_mime: sData.image_mime || 'image/jpeg',
                message: text,
                model: 'haiku',
              })
            });
            if (vRes.ok) {
              const vd = await vRes.json();
              return { vision_reply: vd.reply || '', screenshot_taken: true, cmd_id: sData.cmd_id };
            }
          }
          return sData; // return whatever we got (timeout message etc)
        }
        // Regular desktop command
        return fetch(baseUrl + '/command', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({ command: text, intent: 'desktop', requested_by: 'falkor-agent' }),
        }).then(r => r.ok ? r.json() : null);
      }
      default: return null;
    }
  } catch { return null; }
}

// ── Action handler — detect and execute Jarvis-style actions ─────────────────
function detectAction(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  // Email actions — self summary
  if (/\b(email me|send me|email summary|send (a )?summary|mail me)\b/.test(t))
    return { type: 'email', subject: 'Falkor summary', body: text };
  // Email to external recipient: "email Tom about X" / "send email to Jane about Y"
  const emailToRe = /\b(?:email|send\s+(?:an?\s+)?email|write\s+(?:an?\s+)?email|compose)\s+(?:to\s+)?([\w][\w\s.]*?)\s+(?:about|re:|regarding|saying|with subject)\s+(.+)/i;
  const emailToMatch = t.match(emailToRe);
  if (emailToMatch) {
    return { type: 'email_compose', to_name: emailToMatch[1].trim(), subject_hint: emailToMatch[2].trim(), original: text };
  }
  // Check inbox
  if (/\b(check\s+(?:my\s+)?emails?|read\s+(?:my\s+)?emails?|any\s+(?:new\s+)?emails?|what(?:'s|\s+is)?\s+in\s+(?:my\s+)?inbox|new\s+emails?)\b/.test(t))
    return { type: 'check_email' };
  // Note / save actions
  if (/^(note|save|remember|log|jot)[\s:]+/.test(t) || /\b(note this|save this|log this|jot this|remember this)\b/.test(t))
    return { type: 'note', content: text.replace(/^(note|save|remember|log|jot)[\s:]+/i, '').trim() };
  // Remind actions
  const remindMatch = t.match(/remind me (about |to )?(.+?)( on | at | tomorrow| next week)?$/);
  if (remindMatch && /\b(remind)\b/.test(t))
    return { type: 'remind', content: remindMatch[2], original: text };
  // Task / background research intent
  const taskKeywords = /^(research|find out|look into|investigate|queue[:\s]+|overnight[:\s]+|background[:\s]+|do this later[:\s]+)/i;
  const taskAmbient = /\b(overnight|do this later|queue this|background task|run this later)\b/i;
  if (taskKeywords.test(t) || taskAmbient.test(t)) {
    const query = text.replace(/^(research|find out|look into|investigate|queue[:\s]+|overnight[:\s]+|background[:\s]+|do this later[:\s]+)/i, '').trim();
    let taskType = 'research';
    if (/\b(tipping|tips|standings|leaderboard)\b/i.test(text)) taskType = 'tipping_report';
    else if (/\b(venture|priorities|projects|dashboard)\b/i.test(text)) taskType = 'venture_report';
    else if (/\b(kbt|trivia|quiz|questions)\b/i.test(text)) taskType = 'kbt_prep';
    return { type: 'task', taskType, query: query || text, title: (query || text).slice(0, 80) };
  }
  return null;
}

async function executeAction(action, userId, userCtx, pin, env) {
  switch (action.type) {
    case 'email': {
      const toAddr = action.to || userCtx.email || 'pgallivan@outlook.com';
      const resendKey = (env && env.RESEND_API_KEY) || '';
      if (resendKey) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Falkor <falkor@luckdragon.io>',
              to: [toAddr],
              subject: action.subject || 'Message from Falkor',
              text: action.body || action.content || '',
            }),
          });
          const rd = await r.json().catch(() => ({}));
          if (rd.id) return `Sent to ${toAddr} ✓`;
          return `Couldn't send — Resend said: ${JSON.stringify(rd).slice(0,100)}`;
        } catch(e) {
          return `Email failed: ${e.message}`;
        }
      }
      // Fallback: log via workflows
      try {
        await fetch(`${WORKFLOWS_URL}/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({ to: toAddr, subject: action.subject, html: `<p>${action.body || action.content}</p>` }),
        });
      } catch { /* non-fatal */ }
      return `Queued to ${toAddr} — no direct send key available.`;
    }
    case 'note': {
      try {
        await fetch(`${BRAIN_URL}/remember`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({
            text: `[${userCtx.name}] ${action.content}`,
            category: 'note', tags: ['note', userId],
          }),
        });
      } catch { /* non-fatal */ }
      return `Got it — I've saved that note: "${action.content}"`;
    }
    case 'email_compose': {
      // Compose and send email to an external recipient via AI + Resend
      const resendKey = (env && env.RESEND_API_KEY) || '';
      if (!resendKey) return 'Email unavailable — RESEND_API_KEY not set.';
      let subject = (action.subject_hint || action.original || '').slice(0, 60);
      let body = action.original || action.subject_hint || '';
      try {
        const composeResp = await fetch('https://asgard-ai.luckdragon.io/chat/smart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': '535554' },
          body: JSON.stringify({
            message: 'Write a brief professional email based on this: ' + action.original + '. Output ONLY valid JSON: {"subject":"...","body":"..."}',
            model: 'haiku', max_tokens: 300,
            system: 'Output only valid JSON with subject and body fields. Be concise and professional.',
          }),
        });
        if (composeResp && composeResp.ok) {
          const cd = await composeResp.json().catch(function() { return {}; });
          const raw = (cd.reply || '').trim();
          const m2 = raw.match(/\{[\s\S]*?\}/);
          if (m2) {
            try {
              const composed = JSON.parse(m2[0]);
              if (composed.subject) subject = composed.subject;
              if (composed.body) body = composed.body;
            } catch(pe) { /* use original */ }
          }
        }
      } catch(ce) { /* compose optional */ }
      const knownContacts = { paddy: 'pgallivan@outlook.com', me: 'pgallivan@outlook.com' };
      const toKey = (action.to_name || '').toLowerCase().split(' ')[0];
      const toAddr = knownContacts[toKey] || userCtx.email || 'pgallivan@outlook.com';
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Falkor <falkor@luckdragon.io>', to: [toAddr], subject: subject, text: body }),
        });
        const rd = await r.json().catch(function() { return {}; });
        if (rd.id) return 'Email sent to ' + toAddr + ' — "' + subject + '" ✓';
        return 'Email failed: ' + JSON.stringify(rd).slice(0, 100);
      } catch(se) { return 'Email error: ' + se.message; }
    }
    case 'check_email': {
      // Read Outlook inbox via Microsoft Graph API if token available
      const graphToken = (env && (env.GRAPH_ACCESS_TOKEN || env.MS_ACCESS_TOKEN)) || '';
      if (graphToken) {
        try {
          const resp = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=8&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,isRead,bodyPreview', {
            headers: { 'Authorization': 'Bearer ' + graphToken, 'Accept': 'application/json' },
          });
          if (resp.ok) {
            const data = await resp.json().catch(function() { return {}; });
            const msgs = data.value || [];
            if (!msgs.length) return 'Inbox is clear.';
            return 'Recent emails:\n' + msgs.map(function(m) {
              const unread = m.isRead ? '' : '[unread] ';
              const fromName = (m.from && m.from.emailAddress) ? (m.from.emailAddress.name || m.from.emailAddress.address) : 'unknown';
              const d = new Date(m.receivedDateTime).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne' });
              return unread + m.subject + ' — ' + fromName + ' (' + d + ')';
            }).join('\n');
          }
          if (resp.status === 401) return 'Microsoft token expired — refresh GRAPH_ACCESS_TOKEN in vault.';
        } catch(ge) { return 'Email read error: ' + ge.message; }
      }
      return 'To read your Outlook inbox, add a GRAPH_ACCESS_TOKEN secret to falkor-agent. See Paddy for setup.';
    }
    case 'remind': {
      try {
        await fetch(`${BRAIN_URL}/remember`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({
            text: `[REMINDER for ${userCtx.name}] ${action.content} — original: ${action.original}`,
            category: 'reminder', tags: ['reminder', userId],
          }),
        });
      } catch { /* non-fatal */ }
      return `Reminder saved: "${action.content}". I'll surface this when relevant.`;
    }
    case 'task': {
      try {
        // Use WORKFLOWS_SERVICE binding if available on env (injected from DO env)
        const wfUrl = 'https://falkor-workflows.luckdragon.io/tasks';
        const wfReq = new Request(wfUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: JSON.stringify({
            title: action.title || action.query,
            type: action.taskType || 'research',
            query: action.query,
            notify: 1,
          }),
        });
        const tRes = (env && env.WORKFLOWS_SERVICE)
          ? await env.WORKFLOWS_SERVICE.fetch(wfReq)
          : await fetch(wfReq);
        const d = await tRes.json().catch(() => ({}));
        if (d.ok) {
          return `✅ Queued task #${d.id}: "${action.title}". I'll handle it in the background and notify you when done.`;
        }
        return `Couldn't queue task: ${d.error || 'unknown error'}`;
      } catch(e) {
        return `Task queue error: ${e.message}`;
      }
    }
  }
  return null;
}

// ── Live context pre-loader ───────────────────────────────────────────────────
// Fetches weather + calendar + sport + tips in parallel, returns a context string
async function loadLiveContext(pin, aiPin) {
  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

  const safe = (p) => Promise.race([p, timeout(4000)]).catch(() => null);

  const [weather, calToday, calTomorrow, sport, nrlLadder] = await Promise.all([
    safe(fetch(`${WEATHER_URL}/weather?lat=${WPS_LAT}&lon=${WPS_LON}`, { headers: { 'X-Pin': aiPin } }).then(r => r.ok ? r.json() : null)),
    safe(fetch(`${CALENDAR_URL}/today`,    { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null)),
    safe(fetch(`${CALENDAR_URL}/tomorrow`, { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null)),
    safe(fetch(`${SPORT_URL}/summary`,     { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null)),
    safe(fetch(`${SPORT_URL}/nrl/ladder`,  { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null)),
  ]);

  const lines = ['=== LIVE CONTEXT (fetched now) ==='];

  // Weather
  if (weather) {
    const w = weather.current || weather;
    const uv = w.uv ?? w.uv_index ?? w.uvi ?? '?';
    const temp = w.temp ?? w.temperature ?? '?';
    const rain = w.rain_chance ?? w.pop ?? '?';
    const desc = w.condition ?? w.description ?? w.weather?.[0]?.description ?? '';
    const peSuitable = weather.pe_suitable !== undefined ? (weather.pe_suitable ? '✅ suitable for outdoor PE' : '❌ not suitable for outdoor PE') : '';
    lines.push(`WEATHER (WPS): ${temp}°C, UV ${uv}, rain ${typeof rain === 'number' ? Math.round(rain * 100) : rain}%, ${desc}. ${peSuitable}`.trim());
  }

  // Calendar
  const fmtEvents = (data, label) => {
    if (!data) return;
    const events = data.events || data.items || [];
    if (events.length === 0) { lines.push(`CALENDAR ${label}: nothing scheduled`); return; }
    lines.push(`CALENDAR ${label}: ` + events.slice(0, 5).map(e => e.summary || e.title || e.name).join(', '));
  };
  fmtEvents(calToday, 'TODAY');
  fmtEvents(calTomorrow, 'TOMORROW');

  // Sport
  if (sport) {
    if (sport.ladder) {
      const top3 = (sport.ladder || []).slice(0, 3).map(t => t.name || t.team).filter(Boolean).join(', ');
      if (top3) lines.push(`AFL LADDER TOP 3: ${top3}`);
    }
    if (sport.round) lines.push(`AFL ROUND: ${JSON.stringify(sport.round).slice(0, 120)}`);
    if (sport.tips_leader) lines.push(`FOOTY TIPS LEADER: ${sport.tips_leader}`);
  }

  // NRL
  if (nrlLadder && nrlLadder.ladder) {
    const nrlTop3 = (nrlLadder.ladder || []).slice(0, 3).map(t => t.team || t.name).filter(Boolean).join(', ');
    if (nrlLadder.season) lines.push('NRL SEASON: ' + nrlLadder.season);
    if (nrlTop3) lines.push('NRL LADDER TOP 3: ' + nrlTop3);
  }

  lines.push('=== END LIVE CONTEXT ===');

  // Only return something meaningful if we got real data
  if (lines.length <= 2) return '';
  return '\n\n' + lines.join('\n');
}

// ── Auto-memory extractor ─────────────────────────────────────────────────────
// Every MEMORY_EXTRACT_INTERVAL assistant turns, extract memorable facts via Haiku
async function maybeExtractMemory(history, userId, pin, aiPin, aiUrl) {
  // Count assistant turns
  const assistantTurns = history.filter(h => h.role === 'assistant').length;
  if (assistantTurns === 0 || assistantTurns % MEMORY_EXTRACT_INTERVAL !== 0) return;

  // Only look at the last 10 messages (the recent conversation)
  const recent = history.slice(-10);
  const convoText = recent.map(h => `${h.role === 'user' ? 'User' : 'Falkor'}: ${h.content}`).join('\n');

  try {
    const resp = await fetch(`${aiUrl}/chat/smart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pin': aiPin },
      body: JSON.stringify({
        message: `Extract memorable facts from this conversation that should be saved for future reference. Focus on: specific dates/events, names, preferences, decisions, and important context about the user's life/work. Return as JSON array of strings like ["fact1", "fact2"]. Return empty array [] if nothing worth saving. Conversation:\n${convoText}`,
        context: [],
        system: 'You are a memory extraction assistant. Extract only genuinely useful, durable facts. Ignore small talk and temporary state. Return valid JSON only.',
        model: 'haiku',
        max_tokens: 300,
      }),
    });

    if (!resp.ok) return;
    const data = await resp.json();
    const raw = (data.reply || data.content || '').trim();

    // Parse facts from response
    const match = raw.match(/\[.*\]/s);
    if (!match) return;
    const facts = JSON.parse(match[0]);
    if (!Array.isArray(facts) || facts.length === 0) return;

    // Save each fact to falkor-brain (fire and forget)
    for (const fact of facts.slice(0, 5)) {
      if (typeof fact !== 'string' || fact.length < 10) continue;
      fetch(`${BRAIN_URL}/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
        body: JSON.stringify({
          text: `[auto-memory for ${userId}] ${fact}`,
          category: 'auto-memory',
          tags: ['auto', userId],
        }),
      }).catch(() => {});
    }
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────

export class FalkorAgent {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.wsCount = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    if (path === '/chat' && request.method === 'POST') {
      const body = await request.json();
      const { model, productContext } = body;
      const text = body.text || body.message || '';
      const userId = request.headers.get('X-User-Id') || body.userId || 'paddy';
      const reply = await this.processChat(text, model || 'groq-fast', null, productContext, userId);
      return corsJson({ reply });
    }

    if (path === '/history' && request.method === 'GET') {
      return corsJson(await this.getHistory());
    }
    if (path === '/history' && request.method === 'DELETE') {
      await this.resetHistory();
      return corsJson({ ok: true });
    }
    if (path === '/memory' && request.method === 'GET') {
      return corsJson(await this.getMemory());
    }
    if (path === '/memory' && request.method === 'POST') {
      const { key, value } = await request.json();
      await this.saveMemory(key, value);
      return corsJson({ ok: true });
    }
    if (path === '/memory' && request.method === 'DELETE') {
      await this.clearMemory();
      return corsJson({ ok: true });
    }
    if (path === '/context/refresh' && request.method === 'POST') {
      // Force-refresh the live context bundle
      await this.state.storage.delete('liveContext');
      await this.state.storage.delete('liveContextTs');
      return corsJson({ ok: true, message: 'Context cache cleared — will refresh on next message' });
    }
    if (path === '/status') {
      const history = await this.getHistory();
      const memory = await this.getMemory();
      const ctxTs = await this.state.storage.get('liveContextTs');
      return corsJson({
        version: '2.12.0',
        activeSessions: this.sessions.size,
        historyLength: history.length,
        memoryKeys: Object.keys(memory).length,
        liveContextAge: ctxTs ? Math.round((Date.now() - ctxTs) / 1000) + 's' : 'not loaded',
      });
    }

    // ── Bridge HTTP endpoints (Phase 81) ─────────────────────────────────────
    if (path === '/bridge/status') {
      const bridges = this.bridges ? [...this.bridges.entries()].map(([id, b]) => ({
        bridgeId: id, hostname: b.hostname, platform: b.platform,
        capabilities: b.capabilities, registeredAt: b.registeredAt,
      })) : [];
      return corsJson({ ok: true, connected: bridges.length > 0, count: bridges.length, bridges });
    }

    if (path === '/bridge/exec' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { command, args = {}, bridge_id } = body;
      if (!command) return corsJson({ error: 'command required' }, 400);
      if (!this.bridges || this.bridges.size === 0)
        return corsJson({ error: 'No bridge connected — run falkor-bridge.js on your PC' }, 503);
      const [bId, bridge] = bridge_id && this.bridges.has(bridge_id)
        ? [bridge_id, this.bridges.get(bridge_id)]
        : this.bridges.entries().next().value;
      const cmdId = 'cmd_' + Date.now();
      bridge.ws.send(JSON.stringify({ type: 'bridge_command', commandId: cmdId, command, args }));
      let result = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        const stored = await this.state.storage.get('bridge_result_' + cmdId);
        if (stored) { result = JSON.parse(stored); break; }
      }
      if (!result) return corsJson({ error: 'timeout waiting for bridge result', commandId: cmdId }, 504);
      return corsJson({ ok: true, commandId: cmdId, bridgeId: bId, result });
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  }

  async handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const wsId = String(++this.wsCount);
    this.sessions.set(wsId, server);

    server.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'chat') {
          const userId = msg.userId || 'paddy';
          await this.processChat(msg.text, msg.model || 'groq-fast', server, msg.productContext, userId);
        } else if (msg.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'history') {
          const history = await this.getHistory();
          server.send(JSON.stringify({ type: 'history', history }));
        } else if (msg.type === 'memory_get') {
          const memory = await this.getMemory();
          server.send(JSON.stringify({ type: 'memory', memory }));
        } else if (msg.type === 'memory_set') {
          await this.saveMemory(msg.key, msg.value);
          server.send(JSON.stringify({ type: 'memory_saved', key: msg.key }));
        } else if (msg.type === 'context_refresh') {
          await this.state.storage.delete('liveContext');
          await this.state.storage.delete('liveContextTs');
          server.send(JSON.stringify({ type: 'context_refreshed' }));
        } else if (msg.type === 'bridge_register') {
          // PC bridge registration (Phase 81)
          const bridgeId = 'bridge_' + Date.now();
          if (!this.bridges) this.bridges = new Map();
          this.bridges.set(bridgeId, {
            ws: server,
            capabilities: msg.capabilities || [],
            platform: msg.platform,
            hostname: msg.hostname,
            home: msg.home,
            registeredAt: new Date().toISOString(),
          });
          server.send(JSON.stringify({
            type: 'bridge_ack',
            bridgeId,
            message: 'Bridge registered. Falkor will route PC commands here.',
          }));
        } else if (msg.type === 'bridge_command') {
          // Command result from bridge (response to earlier command)
          // Store result in DO storage for async retrieval
          const cmdId = msg.commandId;
          if (cmdId && msg.data) {
            await this.state.storage.put(`bridge_result_${cmdId}`, JSON.stringify(msg.data), { expirationTtl: 3600 });
          }
        } else if (msg.type === 'bridge_result') {
          // Result callback from bridge
          const cmdId = msg.commandId;
          if (cmdId && msg.data) {
            await this.state.storage.put(`bridge_result_${cmdId}`, JSON.stringify(msg.data), { expirationTtl: 3600 });
          }

        }
      } catch (err) {
        server.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    server.addEventListener('close', () => { this.sessions.delete(wsId); });
    server.addEventListener('error', () => { this.sessions.delete(wsId); });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Get or refresh live context bundle (cached 10 min) ────────────────────
  async getLiveContext(pin) {
    const now = Date.now();
    const cachedTs = await this.state.storage.get('liveContextTs');
    if (cachedTs && (now - cachedTs) < CONTEXT_TTL_MS) {
      return (await this.state.storage.get('liveContext')) || '';
    }
    // Load fresh
    const ctx = await loadLiveContext(pin, this.aiPin || pin);
    await this.state.storage.put('liveContext', ctx);
    await this.state.storage.put('liveContextTs', now);
    return ctx;
  }

  async processChat(text, model, ws, productContext, userId) {
    const history = await this.getHistory();
    const memory = await this.getMemory();
    const pin = this.env.AGENT_PIN || '';
    // asgard-ai uses per-user PINs (PADDY_PIN etc), not the service AGENT_PIN
    const aiPin = this.env.AI_WORKER_PIN || this.env.AGENT_PIN || '';
    this.aiPin = aiPin; // cache for getLiveContext
    const aiUrl = this.env.AI_WORKER_URL || 'https://asgard-ai.luckdragon.io';
    const userCtx = buildUserContext(userId);

    const memoryLines = Object.entries(memory).map(([k, v]) => `${k}: ${v}`).join('\n');
    const systemExtra = memoryLines ? '\n\nUser facts you remember:\n' + memoryLines : '';

    this.broadcast({ type: 'user_message', text, model });

    // ── 1. Check for action intents FIRST ────────────────────────────────────
    const action = detectAction(text);
    if (action) {
      const actionReply = await executeAction(action, userId, userCtx, pin, this.env);
      if (actionReply) {
        // If it was purely an action (note/remind/task/check_email), respond directly without AI
        if (action.type === 'note' || action.type === 'remind' || action.type === 'task' || action.type === 'check_email') {
          history.push({ role: 'user', content: text, ts: Date.now() });
          history.push({ role: 'assistant', content: actionReply, ts: Date.now() });
          await this.state.storage.put('history', JSON.stringify(history.slice(-200)));
          this.broadcast({ type: 'assistant_reply', text: actionReply, model });
          return actionReply;
        }
        // For email/email_compose, acknowledge and continue to AI for natural language confirmation
        this.broadcast({ type: 'action_taken', action: action.type, message: actionReply });
      }
    }

    // ── 2. Get live context (cached, 10 min TTL) ──────────────────────────────
    // Load in background on first message; subsequent messages use cache
    const liveContext = await this.getLiveContext(pin);

    // ── 3. A2A Intent routing ─────────────────────────────────────────────────
    let pendingAgentCtx = '';
    const intent = routeIntent(text);
    if (intent) {
      if (AGENT_MODEL_OVERRIDES[intent.agent]) model = AGENT_MODEL_OVERRIDES[intent.agent];
      const agentData = await callSubAgent(intent.agent, intent.action, text, pin, aiPin, intent);
      if (agentData) {
        // Special handling for web search: use the answer field prominently
        if (intent.agent === 'web' && agentData.answer) {
          const snippets = (agentData.results || []).slice(0, 3)
            .map(r => `- ${r.title}: ${r.snippet || ''}`.slice(0, 120)).join('\n');
          pendingAgentCtx = `\n\n## Web Search Results for "${text}"\nAnswer: ${agentData.answer}\n${snippets}\n\n(Use these results to answer the user — do not say you cannot search.)`;
        } else if (intent.agent === 'desktop') {
          if (agentData.vision_reply) {
            // Screen vision result — inject the AI description directly
            pendingAgentCtx = '\n\n[SCREEN VISION RESULT]\n' + agentData.vision_reply + '\n\n(The user asked you to describe their screen. The above is what the vision model saw. Present it naturally as your own observation — "On your screen I can see...")';
          } else {
            const cmdId = agentData.id || agentData.cmd_id || '?';
            const cmdText = agentData.command || text;
            const errMsg = agentData.error ? ' Error: ' + agentData.error : '';
            pendingAgentCtx = '\n\n[DESKTOP COMMAND QUEUED] ID:' + cmdId + ' — ' + cmdText + errMsg + '. Tell the user the command has been queued and the local agent will execute it shortly.';
          }
        } else {
          pendingAgentCtx = '\n\nLive data from falkor-' + intent.agent + ':\n' +
            JSON.stringify(agentData, null, 2).slice(0, 1500);
        }
        if (intent.agent === 'sport' || intent.agent === 'kbt') {
          fetch(`${BRAIN_URL}/remember`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
            body: JSON.stringify({
              text: 'Live data from ' + intent.agent + ': ' + JSON.stringify(agentData).slice(0, 500),
              category: intent.agent, tags: [intent.agent, 'live'],
            }),
          }).catch(() => {});
        }
      }
    }

    // ── 4. RAG: fetch relevant context from falkor-brain ─────────────────────
    let ragContext = '';
    try {
      const ragResp = await fetch(`${BRAIN_URL}/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
        body: JSON.stringify({ query: text, top_k: 3, answer: false }),
      });
      if (ragResp.ok) {
        const ragData = await ragResp.json();
        const matches = (ragData.matches || []).filter(m => m.score > 0.5);
        if (matches.length > 0) {
          ragContext = '\n\nRelevant context from memory:\n' +
            matches.map((m, i) => `${i + 1}. [${m.category}] ${m.content}`).join('\n');
        }
      }
    } catch { /* brain unavailable */ }

    if (pendingAgentCtx) ragContext += pendingAgentCtx;

    const productCtxStr = productContext
      ? '\n\nContext: You are embedded in ' + productContext + '. Tailor your answers to this context.'
      : '';

    // ── 5. Build system prompt with live context injected ────────────────────
    const contextHistory = history.slice(-40).map(h => ({ role: h.role, content: h.content }));

    // Time-awareness context (AEST = UTC+10)
    const _nowAEST = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const _dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const _aestHour = _nowAEST.getUTCHours();
    const _aestMin = _nowAEST.getUTCMinutes();
    const _aestDay = _dayNames[_nowAEST.getUTCDay()];
    const _aestDayNum = _nowAEST.getUTCDay();
    const _isSchoolDay = _aestDayNum >= 1 && _aestDayNum <= 5;
    const _isSchoolHours = _isSchoolDay && _aestHour >= 8 && _aestHour < 15;
    const _isTipDeadline = _aestDayNum === 4 && _aestHour >= 17 && _aestHour < 21;
    const _timeHint = _isSchoolHours
      ? `${_aestDay} ${_aestHour}:${String(_aestMin).padStart(2,'0')} AEST — school hours`
      : _isTipDeadline
      ? `${_aestDay} ${_aestHour}:${String(_aestMin).padStart(2,'0')} AEST — tip deadline tonight!`
      : `${_aestDay} ${_aestHour}:${String(_aestMin).padStart(2,'0')} AEST`;
    const _timeContext = `Current time: ${_timeHint}`;
    const _paddyState = getPaddyState();
    const _stateContext = `Paddy's current mode: ${_paddyState.label}.${_paddyState.quiet ? ' Keep replies SHORT — one or two sentences max.' : ''}`;

    const systemPrompt = [
      `You are Falkor — ${userCtx.name}'s personal AI. Built like Jarvis: direct, sharp, occasionally dry. Not a generic assistant — you know ${userCtx.name}'s world.`,
      `## Who you're talking to:`,
      `${userCtx.desc}`,
      _timeContext,
      _stateContext,
      `## Personality rules (non-negotiable):`,
      `- SHORT by default. 1–3 sentences unless the task genuinely demands more. Never pad.`,
      `- No openers. Never start with "Certainly", "Great question", "Of course", "Sure", "Absolutely", "Happy to help", or any variant.`,
      `- Never start a reply with the word "I".`,
      `- Use ${userCtx.name}'s name once per reply — not every sentence.`,
      `- Dry wit when it earns its place. One quip > two paragraphs.`,
      `- Confidence. If you know it, say it. If you don't, one line. No hedging.`,
      `- When you can ACT (send email, set reminder, check scores, run task) — do it and confirm. Don't just explain how.`,
      `- Scan the live context for anything ${userCtx.name} cares about but hasn't asked. Worth mentioning: Essendon results, upcoming tipped horses, weather at WPS school.`,
      `- No bullet points in conversational replies. Use them only for actual lists or multi-step instructions.`,
      `- No emojis. Plain text only — no symbols, icons, or emoji in any reply.`,
      `- Match energy: short question → short answer. Complex task → structured reply.`,
      `- Web search results in context (## Web Search Results)? Use them. Never say you can't search.`,
      `## Engineering rules (ALL projects, non-negotiable):`,
      `- Root-cause before patching. Read the surrounding code and any nearby comment. If code looks like a workaround, identify what it's masking. Don't remove a workaround until the underlying bug is proven gone.`,
      `- Verify the EFFECT of every deploy, not the 200 status. Fetch served output. Run the product's checks.py.`,
      `- Every product has a checks.py at the repo root. Run it post-deploy. Add a check whenever a new bug class is found.`,
      `- Single source of truth for version: const VERSION at top of worker, every other place reads from it.`,
      `- If a session feels like solving the same problem again — STOP and root-cause. Don't keep slapping new patches on top.`,
      `- Full rules: https://github.com/PaddyGallivan/asgard-source/blob/main/docs/ENGINEERING-RULES.md`,
      `## What ${userCtx.name} follows:`,
      `${userCtx.interests.join(' · ')}`,
      systemExtra,
      liveContext,
      ragContext,
      productCtxStr,
    ].filter(Boolean).join('\n');

    // ── 6. Call asgard-ai router (streaming when ws present) ────────────
    let reply = '';
    const msgId = 'msg_' + Date.now();

    if (ws) {
      // ── Streaming path: SSE → WS tokens ──────────────────────────────────
      try {
        const resp = await fetch(`${aiUrl}/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': aiPin },
          body: JSON.stringify({
            messages: [...contextHistory, { role: 'user', content: text }],
            system: systemPrompt,
            model,
            max_tokens: 2048,
          }),
        });
        if (resp.ok) {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let accumulated = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const raw = trimmed.slice(5).trim();
              try {
                const parsed = JSON.parse(raw);
                if (parsed.t) {
                  accumulated += parsed.t;
                  // Broadcast token to all connected WS sessions
                  this.broadcast({ type: 'token', msgId, text: accumulated });
                }
              } catch {}
            }
          }
          reply = accumulated;
        } else {
          const errBody = await resp.text().catch(() => '');
          reply = '[AI error: ' + resp.status + (errBody ? ': ' + errBody.slice(0, 80) : '') + ']';
        }
      } catch (err) {
        reply = '[Stream error: ' + err.message + ']';
      }
    } else {
      // ── Non-streaming path (REST /chat endpoint, widget, etc.) ───────────
      try {
        const resp = await fetch(`${aiUrl}/chat/smart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': aiPin },
          body: JSON.stringify({
            message: text,
            context: contextHistory,
            system: systemPrompt,
            model,
            max_tokens: 2048,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          reply = data.reply || data.content || '';
        } else {
          const errBody = await resp.text().catch(() => '');
          reply = '[AI error: ' + resp.status + (errBody ? ': ' + errBody.slice(0, 100) : '') + ']';
        }
      } catch (err) {
        reply = '[Connection error: ' + err.message + ']';
      }
    }

    // ── 7. Save to history ────────────────────────────────────────────────────
    history.push({ role: 'user', content: text, ts: Date.now() });
    history.push({ role: 'assistant', content: reply, ts: Date.now() });
    await this.state.storage.put('history', JSON.stringify(history.slice(-200)));

    // ── 8. Auto-memory extraction (every 5 turns, fire-and-forget) ────────────
    maybeExtractMemory(history, userId, pin, aiPin, aiUrl).catch(() => {});

    // Final reply broadcast (UI uses msgId to finalize streaming bubble)
    this.broadcast({ type: 'assistant_reply', msgId, text: reply, model });
    return reply;
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const [id, ws] of this.sessions) {
      try { ws.send(payload); } catch { this.sessions.delete(id); }
    }
  }

  async getHistory() {
    const raw = await this.state.storage.get('history');
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }
  async resetHistory() {
    await this.state.storage.delete('history');
    await this.state.storage.delete('liveContext');
    await this.state.storage.delete('liveContextTs');
  }
  async getMemory() {
    const raw = await this.state.storage.get('memory');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  async saveMemory(key, value) {
    const memory = await this.getMemory();
    memory[key] = value;
    await this.state.storage.put('memory', JSON.stringify(memory));
  }
  async clearMemory() { await this.state.storage.delete('memory'); }
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname !== '/health') {
      const pin = request.headers.get('X-Pin') || url.searchParams.get('pin');
      if (!pin || !env.AGENT_PIN || pin !== env.AGENT_PIN) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', version: '2.12.0', worker: 'falkor-agent' });
    }

    // ── /tasks proxy → falkor-workflows via service binding (no 522 loopback) ──
    if (url.pathname === '/tasks') {
      const method = request.method;
      const pin = env.AGENT_PIN || '';
      try {
        const proxyTarget = `https://falkor-workflows.luckdragon.io/tasks`;
        const proxyReq = new Request(proxyTarget, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
          body: method === 'POST' ? request.body : undefined,
        });
        // Use service binding if available (avoids CF loopback 522)
        const r = env.WORKFLOWS_SERVICE
          ? await env.WORKFLOWS_SERVICE.fetch(proxyReq)
          : await fetch(proxyReq);
        const d = await r.json().catch(() => ({}));
        return new Response(JSON.stringify(d), {
          status: r.status,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }


    // ── /home — aggregated live data bundle for Home tab ──────────────────────
    if (url.pathname === '/home' && request.method === 'GET') {
      const pin = env.AGENT_PIN || '';
      const aiPin = env.AI_WORKER_PIN || env.AGENT_PIN || '';
      const aiUrl = env.AI_WORKER_URL || 'https://asgard-ai.luckdragon.io';
      const safe = p => p.catch(() => null);
      try {
        const [weather, sport, nrlLadder, racingToday] = await Promise.all([
          safe(fetch(`${aiUrl}/weather?lat=${WPS_LAT}&lon=${WPS_LON}`, { headers: { 'X-Pin': aiPin } }).then(r => r.ok ? r.json() : null)),
          safe(fetch(`${SPORT_URL}/summary`, { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null)),
          safe(fetch(`${SPORT_URL}/nrl/ladder`, { headers: { 'X-Pin': pin } }).then(r => r.ok ? r.json() : null)),
          safe(fetch(`${SPORT_URL}/racing/comp?pin=${pin}`).then(r => r.ok ? r.json() : null)),
        ]);
        // Find Essendon on AFL ladder
        const ladder = sport?.ladder || [];
        const essendon = ladder.find(t => /essendon|bombers/i.test(t.team)) || null;
        const top5AFL = ladder.slice(0, 5);
        const top4NRL = (nrlLadder?.ladder || []).slice(0, 4);
        return corsJson({
          ok: true,
          ts: Date.now(),
          weather: weather || null,
          afl: {
            round: sport?.round || null,
            summary: sport?.summary || '',
            top5: top5AFL,
            essendon: essendon,
          },
          nrl: {
            top4: top4NRL,
          },
          racing: {
            today: racingToday?.tips || [],
            date: racingToday?.date || null,
          },
        });
      } catch (e) {
        return corsJson({ ok: false, error: e.message }, 502);
      }
    }


    // ── /vision — image analysis via asgard-ai (no DO, stateless) ─────────────
    if (url.pathname === '/vision' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const aiPin = env.AI_WORKER_PIN || env.AGENT_PIN || '';
      const aiUrl = env.AI_WORKER_URL || 'https://asgard-ai.luckdragon.io';
      try {
        const vRes = await fetch(`${aiUrl}/chat/vision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pin': aiPin },
          body: JSON.stringify({
            image_base64: body.image_b64 || body.image_base64,
            image_url: body.image_url,
            image_mime: body.mime_type || body.image_mime || 'image/jpeg',
            message: body.prompt || body.message || 'Describe this image clearly and concisely.',
            model: body.model || 'haiku',
            uid: body.userId || 'paddy',
          })
        });
        const vd = await vRes.json().catch(() => ({}));
        return corsJson(vd, vRes.status);
      } catch (e) {
        return corsJson({ ok: false, error: e.message }, 502);
      }
    }

    const userId = request.headers.get('X-User-Id') || url.searchParams.get('uid') || 'paddy';
    const id = env.FALKOR_AGENT.idFromName(userId);
    const stub = env.FALKOR_AGENT.get(id);
    return stub.fetch(request);
  },
};