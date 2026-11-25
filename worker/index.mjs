const uuid = /^[a-f0-9-]{36}$/;
const secretPattern = /^[a-f0-9]{64}$/;
const headers = {
  'cache-control':'no-store',
  'permissions-policy':'camera=(self), microphone=(), display-capture=()',
  'referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff'
};

async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2,'0')).join('');
}

function json(data,status=200) {
  return Response.json(data,{status,headers});
}
function message(error,status=400) {
  return json({error},status);
}
const bounded = (value,max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const number = (value,min,max) => Number.isFinite(value) && value >= min && value <= max;

async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new TypeError('JSON 요청이 필요합니다.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 160000) {
      await reader.cancel();
      throw new TypeError('결과 파일이 너무 큽니다.');
    }
    text += decoder.decode(value,{stream:true});
  }
  return JSON.parse(text + decoder.decode());
}

function validConfig(config) {
  return config && bounded(config.title,80) && bounded(config.practice,110) &&
    number(config.font,24,64) && typeof config.collectName === 'boolean' &&
    Array.isArray(config.items) && number(config.items.length,1,10) &&
    config.items.every(item => item && [item.a,item.middle,item.b].every((part,index) =>
      typeof part === 'string' && part.length <= 90 && (index === 1 || part.trim())) &&
      item.a.length + item.middle.length + item.b.length <= 135);
}

function validSession(data,config) {
  return data && uuid.test(data.id) && bounded(data.code,40) && typeof data.name === 'string' &&
    data.name.length <= 60 && (config.collectName ? data.name.trim() : !data.name) &&
    ['completed','partial'].includes(data.state) && number(data.error,0,5000) &&
    Number.isInteger(data.checkPoints) && number(data.checkPoints,3,5) &&
    Array.isArray(data.trials) && number(data.trials.length,1,config.items.length) &&
    (data.state === 'partial' || data.trials.length === config.items.length) &&
    data.trials.every(trial => trial && number(trial.ms,0,60000) && Array.isArray(trial.samples) &&
      trial.samples.length <= 610 && trial.samples.every((sample,i,samples) => Array.isArray(sample) &&
        sample.length === 3 && number(sample[0],samples[i-1]?.[0] ?? 0,trial.ms) &&
        number(sample[1],-2,3) && number(sample[2],-2,3)) &&
      ['a','b'].every(key => Array.isArray(trial[key]) && trial[key].length === 4 &&
        trial[key].every(value => number(value,0,1))));
}

const interval = 250;
const dwell = 160;

function summarize(trial) {
  const inside = ([,x,y],[left,top,right,bottom]) => x >= left && x <= right && y >= top && y <= bottom;
  const totals = {a:0,b:0};
  const first = {a:null,b:null};
  let runZone = '', previous = null, start = 0, accepted = false;
  let stage = '', returns = 0, covered = 0;
  for (const sample of trial.samples) {
    const t = sample[0];
    const gap = previous === null ? Infinity : t-previous;
    const zone = inside(sample,trial.a) ? 'a' : inside(sample,trial.b) ? 'b' : '';
    if (gap <= interval) {
      covered += gap;
      if (zone && zone === runZone) totals[zone] += gap;
    }
    if (zone !== runZone || gap > interval) {
      start = t;
      accepted = false;
    }
    if (zone && !accepted && t-start >= dwell) {
      accepted = true;
      first[zone] ??= start;
      if (zone === 'a' && stage === 'b') returns++;
      if (zone === 'a' || stage === 'a') stage = zone;
    }
    runZone = zone;
    previous = t;
  }
  const coverage = trial.ms ? Math.min(1,covered/trial.ms) : 0;
  const reason = coverage < .55 ? '추적 시간 부족' :
    first.a === null || first.b === null || !stage || !trial.samples.some(([t]) => t >= first.b + dwell)
      ? 'A·B 구간 확인 부족' :
    stage === 'a' && returns === 0 ? 'A에서 B로 이동 확인 부족' : '';
  return {ms:trial.ms,first,totals,coverage,returns:reason ? null : returns,reason};
}

async function handleRequest(request,env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && ['/', '/student'].includes(url.pathname)) {
    return new Response(page,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
  }
  if (!url.pathname.startsWith('/api/')) return message('페이지를 찾을 수 없습니다.',404);
  if (!env.DB) return message('검사 저장소에 연결할 수 없습니다.',503);
  try {
    if (url.pathname === '/api/studies' && request.method === 'POST') {
      const {key,admin,config} = await body(request) ?? {};
      if (!secretPattern.test(admin) || (await hash(admin)) !== env.READING_LAB_ADMIN_SHA256 || !secretPattern.test(key)) {
        return message('교사용 접근 키가 필요합니다.',403);
      }
      if (!validConfig(config)) return message('검사 이름과 문장 설정을 확인하세요.');
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO studies VALUES (?,?,?,?,?)').bind(id,config.title,JSON.stringify(config),await hash(key),new Date().toISOString()).run();
      return json({id},201);
    }
    const [,id,action] = /^\/api\/studies\/([^/]+)(?:\/(submit|report))?$/.exec(url.pathname) ?? [];
    if (!uuid.test(id)) return message('검사 링크를 확인하세요.',404);
    const row = await env.DB.prepare('SELECT config,secret_hash FROM studies WHERE id=?').bind(id).first();
    if (!row) return message('검사를 찾을 수 없습니다.',404);
    const config = JSON.parse(row.config);
    if (!action && request.method === 'GET') return json(config);
    if (action === 'submit' && request.method === 'POST') {
      const session = await body(request);
      if (!validSession(session,config)) return message('참가자 정보 또는 검사 결과 형식을 확인하세요.');
      const {id:sessionId,code,name,state,error,checkPoints,trials} = session;
      const payload = {state,error,checkPoints,trials:trials.map(trial => ({...trial,summary:summarize(trial)}))};
      await env.DB.prepare(
        'INSERT INTO sessions VALUES (?,?,?,?,?,?) ON CONFLICT(study_id,id) DO NOTHING'
      ).bind(id,sessionId,code.trim(),name.trim(),JSON.stringify(payload),new Date().toISOString()).run();
      return json({saved:true});
    }
    if (action === 'report' && request.method === 'GET') {
      const key = request.headers.get('authorization')?.replace(/^Bearer /,'');
      if (!secretPattern.test(key) || await hash(key) !== row.secret_hash) return message('보고서 접근 키를 확인하세요.',403);
      const {results} = await env.DB.prepare(
        'SELECT id,participant,name,payload,created_at FROM sessions WHERE study_id=? ORDER BY created_at'
      ).bind(id).all();
      return json({config,sessions:results.map(({payload,...session}) => ({...session,...JSON.parse(payload)}))});
    }
    return message('요청을 처리할 수 없습니다.',405);
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return message(error.message);
    console.error('Reading lab storage request failed',error);
    return message('저장소 요청에 실패했습니다. 잠시 뒤 다시 시도하세요.',500);
  }
}

const pagesOrigin = 'https://bluwhite.github.io';

export default {
  async fetch(request,env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/studies')) return handleRequest(request,env);

    const origin = request.headers.get('origin');
    const allowed = origin === pagesOrigin;
    if (request.method === 'OPTIONS' && !allowed) return message('허용되지 않은 요청입니다.',403);

    const result = request.method === 'OPTIONS' ? new Response(null,{status:204}) : await handleRequest(request,env);
    const response = new Response(result.body,result);
    response.headers.append('Vary','Origin');
    if (allowed) {
      response.headers.set('Access-Control-Allow-Origin',pagesOrigin);
      response.headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');
      response.headers.set('Access-Control-Max-Age','600');
    }
    return response;
  }
};
