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

// (Edge 런타임에서 api.stlouisfed.org로의 외부 연결이 계속 시간초과가 나서,
//  더 전통적인 네트워크 스택을 쓰는 Node.js 런타임으로 바꿨어요.)

async function fetchWithTimeout(url, options, timeoutMs){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timeoutId);
  }
}

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
// 매번 전체 지표 목록을 조회해서 이름으로 찾는 방식은 느려서(목록 조회 자체가 느림),
// 잘 알려진 release_id를 직접 써요. (CPI=10은 검색으로 직접 확인, 나머지는 FRED의
// 공개된 release_id 체계를 참고했어요 - 혹시 틀렸다면 각 항목이 개별적으로 실패 처리되니
// 다른 지표에는 영향 없어요)
const US_RELEASES = [
  { id: 10, name: 'Consumer Price Index', time: '08:30 AM ET (참고)' },
  { id: 46, name: 'Producer Price Index', time: '08:30 AM ET (참고)' },
  { id: 50, name: 'Employment Situation', time: '08:30 AM ET (참고)' },
  { id: 68, name: 'Job Openings and Labor Turnover', time: '10:00 AM ET (참고)' },
  { id: 12, name: 'Employment Cost Index', time: '08:30 AM ET (참고)' }
];

async function fetchUsEvents(yyyymm, apiKey){
  if (!apiKey) {
    return { error: 'FRED_API_KEY 환경변수가 설정되지 않았어요.' };
  }

  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);
  const lastDay = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
  const fromDate = `${year}-${month}-01`;
  const toDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

  const results = await Promise.all(US_RELEASES.map(async (rel) => {
    const url = `https://api.stlouisfed.org/fred/releases/dates`
      + `?release_id=${rel.id}&api_key=${encodeURIComponent(apiKey)}&file_type=json`
      + `&include_release_dates_with_no_data=true`
      + `&realtime_start=${fromDate}&realtime_end=${toDate}`;
    try {
      const res = await fetchWithTimeout(url, {}, 10000);
      const text = await res.text();
      if (!res.ok) return { rel, error: `HTTP ${res.status}: ${text.slice(0,150)}` };
      const data = JSON.parse(text);
      const dates = Array.isArray(data.release_dates) ? data.release_dates : [];
      return { rel, dates, rawSample: dates.slice(0, 3), rawCount: dates.length };
    } catch (e) {
      return { rel, error: (e && e.name === 'AbortError') ? '시간 초과' : (e && e.message) };
    }
  }));

  const events = [];
  const seenKeys = {};
  const errors = [];
  results.forEach((r) => {
    if (r.error) { errors.push(`${r.rel.name}: ${r.error}`); return; }
    (r.dates || []).forEach((d) => {
      // FRED가 실제 요청 범위 밖 날짜나 같은 날짜를 여러 번 줄 수 있어서, 여기서 직접
      // 한 번 더 걸러내요: 요청한 달 범위 안인지 확인 + (날짜+지표명) 중복 제거
      if (!d.date || d.date < fromDate || d.date > toDate) return;
      const key = d.date + '|' + r.rel.name;
      if (seenKeys[key]) return;
      seenKeys[key] = true;
      events.push({
        date: d.date,
        time: r.rel.time,
        name: r.rel.name,
        agency: 'FRED/BLS',
        country: 'US'
      });
    });
  });

  if (events.length === 0) {
    return { events: [], note: errors.length > 0 ? ('FRED 오류: ' + errors.join(' / ')) : '이번 달 해당 없음' };
  }

  // 결과가 비정상적으로 많으면(월간 지표인데 지표당 여러 날짜), 진단용으로 원본 응답 일부를 같이 보여줘요
  if (events.length > US_RELEASES.length * 2) {
    const sampleInfo = results.map((r) => {
      if (r.error) return `${r.rel.name}:err`;
      return `${r.rel.name}:${r.rawCount}건 예시=${JSON.stringify(r.rawSample)}`;
    }).join(' || ');
    return { events: events, note: `[진단] 예상보다 결과가 많아요(${events.length}건). ` + sampleInfo };
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

  const res = await fetchWithTimeout('https://mods.go.kr/newsPln.es?mid=a10305000000', {}, 12000);
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

export default async function handler(req, res) {
  try {
    const yyyymm = req.query && req.query.yyyymm;

    if (!yyyymm || !/^\d{6}$/.test(yyyymm)) {
      res.status(400).json({ error: 'yyyymm 파라미터가 필요해요 (YYYYMM 형식)' });
      return;
    }

    const fredApiKey = process.env.FRED_API_KEY;

    const [krSettled, usSettled] = await Promise.allSettled([
      fetchKoreaEvents(yyyymm),
      fetchUsEvents(yyyymm, fredApiKey)
    ]);
    const krResult = krSettled.status === 'fulfilled' ? krSettled.value : { error: '(국내 처리 중 예외) ' + (krSettled.reason && krSettled.reason.message ? krSettled.reason.message : String(krSettled.reason)) };
    const usResult = usSettled.status === 'fulfilled' ? usSettled.value : { error: '(미국 처리 중 예외) ' + (usSettled.reason && usSettled.reason.message ? usSettled.reason.message : String(usSettled.reason)) };

    const events = [].concat((krResult && krResult.events) || [], (usResult && usResult.events) || []);
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '') < (b.time || '') ? -1 : 1;
    });

    const notes = [];
    if (krResult && krResult.error) notes.push('국내: ' + krResult.error);
    if (krResult && krResult.note) notes.push('국내: ' + krResult.note);
    if (usResult && usResult.error) notes.push('미국: ' + usResult.error);
    if (usResult && usResult.note) notes.push('미국: ' + usResult.note);

    res.status(200).json({
      yyyymm: yyyymm,
      count: events.length,
      events: events,
      notes: notes.length > 0 ? notes : undefined
    });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || '알 수 없는 오류' });
  }
}
