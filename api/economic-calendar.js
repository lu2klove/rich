// 국내(국가데이터처 보도계획) + 미국(FRED 공식 API) 두 소스를 합쳐서,
// 투자 참고용 핵심 거시지표의 발표 일정(날짜+시각)을 추출합니다.
//
// 국내 출처: https://mods.go.kr/newsPln.es?mid=a10305000000 (이번 달만 지원, 정식 API 아님 - 스크래핑)
// 미국 출처: https://api.stlouisfed.org/fred (세인트루이스 연은 공식 API, 원하는 달 조회 가능)
//
// 필요 환경변수: FRED_API_KEY
//
// 한계:
// - 국내는 정식 API가 아니라 정부 웹페이지를 읽는 방식이라, 페이지 구조가 바뀌면 깨질 수 있고 이번 달만 지원돼요.
// - 미국(FRED)은 발표 "날짜"만 주고 정확한 "시각"은 안 줘요. 그래서 BLS의 잘 알려진 관행(대부분
//   08:30 AM ET, JOLTS는 10:00 AM ET)을 참고용으로 표시해요 - 실제 시각과 다를 수 있어요.

export const config = { runtime: 'edge' };

// 투자 참고용으로 의미있는 핵심 거시지표만 걸러내는 키워드 화이트리스트
const RELEVANT_KEYWORDS_KR = [
  '소비자물가', 'CPI',
  '생산자물가', 'PPI',
  '수출입동향', '무역수지', '수출동향', '수입동향',
  '국제수지', '경상수지',
  '국민소득', 'GNI', '국내총생산', 'GDP', '국민이전계정', '지역내총생산',
  '고용동향', '실업률', '고용률', '경제활동인구',
  '산업활동동향', '산업생산', '광공업생산', '서비스업동향',
  '소매판매', '설비투자', '건설수주', '건설기성',
  '기업경기실사지수', 'BSI', '소비자심리지수', 'CCSI',
  '통화금융', '통화량', 'M2', '가계신용', '가계대출',
  '국제이전계정', '외환보유액'
];
function isRelevantStat(name, keywords){
  return keywords.some((kw) => name.includes(kw));
}

// 미국은 FRED(세인트루이스 연은) 공식 API로 가져와요.
// release_id를 하드코딩하지 않고, 매번 이름으로 검색해서 안전하게 찾아요.
const US_RELEASE_NAME_KEYWORDS = [
  'Consumer Price Index',
  'Producer Price Index',
  'Employment Situation',
  'Job Openings and Labor Turnover',
  'Employment Cost Index'
];
// FRED는 발표 "시각"은 안 주기 때문에, BLS의 잘 알려진 관행(대부분 08:30 AM ET,
// JOLTS만 10:00 AM ET)을 참고용으로 붙여요. 실제 시각과 다를 수 있어요.
function typicalUsReleaseTime(name){
  if (name.includes('Job Openings')) return '10:00 AM ET (참고)';
  return '08:30 AM ET (참고)';
}

let usReleaseIdCache = null; // 같은 함수 인스턴스가 재사용될 때를 위한 메모리 캐시(있으면 이득, 없어도 무해)

async function findUsReleaseIds(apiKey){
  if (usReleaseIdCache) return usReleaseIdCache;

  const url = `https://api.stlouisfed.org/fred/releases?api_key=${encodeURIComponent(apiKey)}&file_type=json`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FRED releases 목록 조회 실패(HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  const releases = Array.isArray(data.releases) ? data.releases : [];

  const found = [];
  US_RELEASE_NAME_KEYWORDS.forEach((kw) => {
    const match = releases.find((r) => r.name === kw);
    if (match) found.push({ id: match.id, name: match.name });
  });
  usReleaseIdCache = found;
  return found;
}

async function fetchUsEvents(yyyymm, apiKey){
  if (!apiKey) {
    return { error: 'FRED_API_KEY 환경변수가 설정되지 않았어요.' };
  }

  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);
  const lastDay = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
  const fromDate = `${year}-${month}-01`;
  const toDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

  let releaseList;
  try {
    releaseList = await findUsReleaseIds(apiKey);
  } catch (e) {
    return { error: e.message };
  }
  if (releaseList.length === 0) {
    return { events: [], note: 'FRED에서 지표 목록을 찾지 못했어요.' };
  }

  const results = await Promise.all(releaseList.map(async (rel) => {
    const url = `https://api.stlouisfed.org/fred/releases/dates`
      + `?release_id=${rel.id}&api_key=${encodeURIComponent(apiKey)}&file_type=json`
      + `&include_release_dates_with_no_data=true`
      + `&realtime_start=${fromDate}&realtime_end=${toDate}`;
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) return { rel, error: `HTTP ${res.status}` };
      const data = JSON.parse(text);
      const dates = Array.isArray(data.release_dates) ? data.release_dates : [];
      return { rel, dates };
    } catch (e) {
      return { rel, error: e.message };
    }
  }));

  const events = [];
  const errors = [];
  results.forEach((r) => {
    if (r.error) { errors.push(`${r.rel.name}: ${r.error}`); return; }
    (r.dates || []).forEach((d) => {
      events.push({
        date: d.date,
        time: typicalUsReleaseTime(r.rel.name),
        name: r.rel.name,
        agency: 'FRED/BLS',
        country: 'US'
      });
    });
  });

  if (events.length === 0) {
    return { events: [], note: errors.length > 0 ? ('FRED 오류: ' + errors.join(' / ')) : '이번 달 해당 없음' };
  }
  return { events };
}

function stripTags(html){
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchKoreaEvents(yyyymm){
  const now = new Date();
  const currentYyyymm = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0');
  if (yyyymm !== currentYyyymm) {
    return { events: [], note: '국내 일정은 현재 이번 달만 지원돼요' };
  }

  const res = await fetch('https://mods.go.kr/newsPln.es?mid=a10305000000');
  const html = await res.text();
  if (!res.ok) {
    return { error: `국가데이터처 응답 오류(HTTP ${res.status})` };
  }

  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
  const cells = [];
  let m;
  while ((m = tdRegex.exec(html)) !== null) {
    cells.push(stripTags(m[1]));
  }

  const dateRe = /^(\d{2})\.(\d{2})\.\(\s*[월화수목금토일]\s*\)$/;
  const yearNum = yyyymm.slice(0, 4);
  const events = [];

  for (let i = 0; i < cells.length; i++) {
    const dm = cells[i].match(dateRe);
    if (dm && cells[i + 1] != null && cells[i + 2] != null) {
      const mm = dm[1];
      const dd = dm[2];
      const timeStr = cells[i + 1];
      const title = cells[i + 2];
      const dept = cells[i + 3] || '';
      if (isRelevantStat(title, RELEVANT_KEYWORDS_KR)) {
        events.push({
          date: `${yearNum}-${mm}-${dd}`,
          time: timeStr,
          name: title,
          agency: dept,
          country: 'KR'
        });
      }
    }
  }
  return { events };
}

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const yyyymm = searchParams.get('yyyymm');

    if (!yyyymm || !/^\d{6}$/.test(yyyymm)) {
      return Response.json({ error: 'yyyymm 파라미터가 필요해요 (YYYYMM 형식)' }, { status: 400 });
    }

    const fredApiKey = process.env.FRED_API_KEY;
    const [krResult, usResult] = await Promise.all([
      fetchKoreaEvents(yyyymm).catch((e) => ({ error: e.message })),
      fetchUsEvents(yyyymm, fredApiKey).catch((e) => ({ error: e.message }))
    ]);

    const events = [].concat(krResult.events || [], usResult.events || []);
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '') < (b.time || '') ? -1 : 1;
    });

    const notes = [];
    if (krResult.error) notes.push('국내: ' + krResult.error);
    if (krResult.note) notes.push('국내: ' + krResult.note);
    if (usResult.error) notes.push('미국: ' + usResult.error);
    if (usResult.note) notes.push('미국: ' + usResult.note);

    return Response.json({
      yyyymm: yyyymm,
      count: events.length,
      events: events,
      notes: notes.length > 0 ? notes : undefined
    });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
