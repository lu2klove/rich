// 국내(국가데이터처 보도계획) + 미국(BLS 발표일정) 두 소스를 합쳐서,
// 투자 참고용 핵심 거시지표의 발표 일정(날짜+시각)을 추출합니다.
//
// 국내 출처: https://mods.go.kr/newsPln.es?mid=a10305000000 (이번 달만 지원)
// 미국 출처: https://www.bls.gov/schedule/{year}/{month}_sched.htm (원하는 달 지정 가능)
// 둘 다 정식 오픈API가 아니라 정부 웹페이지라, 표/캘린더 내용을 직접 읽어서 파싱해요.
//
// 한계:
// - 정식 API가 아니므로, 정부가 페이지 구조를 바꾸면 파싱이 깨질 수 있어요.
// - 국내는 "이번 달"만 지원돼요. 미국은 원하는 달 조회가 가능해요.

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
// 미국은 BLS 발표만 다루므로, BLS가 실제로 발표하는 지표명 기준으로 화이트리스트를 만들어요.
const RELEVANT_KEYWORDS_US = [
  'Consumer Price Index',
  'Producer Price Index',
  'Employment Situation',
  'Job Openings and Labor Turnover',
  'Employment Cost Index',
  'Real Earnings',
  'Import and Export Price Indexes',
  'Productivity and Costs'
];
function isRelevantStat(name, keywords){
  return keywords.some((kw) => name.includes(kw));
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

async function fetchUsEvents(yyyymm){
  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);
  const url = `https://www.bls.gov/schedule/${year}/${month}_sched.htm`;

  const res = await fetch(url);
  const html = await res.text();
  if (!res.ok) {
    return { error: `BLS 응답 오류(HTTP ${res.status})` };
  }

  // 캘린더 표 부분의 <td> 셀만 추출
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
  const cellsHtml = [];
  let m;
  while ((m = tdRegex.exec(html)) !== null) {
    cellsHtml.push(m[1]);
  }

  const events = [];
  let lastDay = 0;
  let inTargetMonth = false;

  for (let i = 0; i < cellsHtml.length; i++) {
    const rawCell = cellsHtml[i];
    const dayMatch = rawCell.match(/^\s*(\d{1,2})\s*<br/i);
    if (!dayMatch) continue;
    const day = parseInt(dayMatch[1], 10);

    if (day < lastDay) {
      if (!inTargetMonth) {
        inTargetMonth = true; // 이전 달 마지막 날들 다음, 이번 달 1일 시작
      } else {
        break; // 이번 달 다 지나고 다음 달로 넘어감 -> 종료
      }
    }
    lastDay = day;
    if (!inTargetMonth) continue;

    // 셀 안에서 <strong>지표명</strong> 뒤에 오는 텍스트(기간/시각)를 짝지어 추출
    const itemRegex = /<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>([\s\S]*?)(?=<(?:strong|b)>|$)/g;
    let im;
    while ((im = itemRegex.exec(rawCell)) !== null) {
      const title = stripTags(im[1]);
      const rest = stripTags(im[2]);
      if (!title) continue;
      if (isRelevantStat(title, RELEVANT_KEYWORDS_US)) {
        const timeMatch = rest.match(/\d{1,2}:\d{2}\s*[AP]M/i);
        const dd = String(day).padStart(2, '0');
        events.push({
          date: `${year}-${month}-${dd}`,
          time: timeMatch ? timeMatch[0] : '',
          name: title,
          agency: 'BLS',
          country: 'US'
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

    const [krResult, usResult] = await Promise.all([
      fetchKoreaEvents(yyyymm).catch((e) => ({ error: e.message })),
      fetchUsEvents(yyyymm).catch((e) => ({ error: e.message }))
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
