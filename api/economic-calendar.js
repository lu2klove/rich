// 국가데이터처(구 통계청) "보도계획" 페이지를 읽어와서,
// 투자 참고용 핵심 거시지표의 발표 일정(날짜+시각)을 추출합니다.
//
// 출처: https://mods.go.kr/newsPln.es?mid=a10305000000
// 이 페이지는 정식 오픈API가 아니라 정부 웹페이지라, 표 내용을 직접 읽어서 파싱해요.
// 페이지가 기본적으로 "이번 달"만 보여주는 구조라, 우선 이번 달만 지원해요.
//
// 한계:
// - 정식 API가 아니므로, 정부가 페이지 구조를 바꾸면 파싱이 깨질 수 있어요.
// - 현재는 "이번 달"만 지원돼요 (다른 달 파라미터는 추후 확인 필요).

export const config = { runtime: 'edge' };

// 투자 참고용으로 의미있는 핵심 거시지표만 걸러내는 키워드 화이트리스트
const RELEVANT_KEYWORDS = [
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
function isRelevantStat(name){
  return RELEVANT_KEYWORDS.some((kw) => name.includes(kw));
}

function stripTags(html){
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const yyyymm = searchParams.get('yyyymm');

    if (!yyyymm || !/^\d{6}$/.test(yyyymm)) {
      return Response.json({ error: 'yyyymm 파라미터가 필요해요 (YYYYMM 형식)' }, { status: 400 });
    }

    const now = new Date();
    const currentYyyymm = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0');
    if (yyyymm !== currentYyyymm) {
      // 이 페이지는 기본적으로 "이번 달"만 보여줘요. 다른 달 조회 방법은 추후 지원 예정.
      return Response.json({ yyyymm: yyyymm, count: 0, events: [], note: '현재는 이번 달만 지원돼요' });
    }

    const res = await fetch('https://mods.go.kr/newsPln.es?mid=a10305000000');
    const html = await res.text();

    if (!res.ok) {
      return Response.json(
        { error: `국가데이터처 응답 오류(HTTP ${res.status})`, raw: html.slice(0, 500) },
        { status: res.status }
      );
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
        if (isRelevantStat(title)) {
          events.push({
            date: `${yearNum}-${mm}-${dd}`,
            time: timeStr,
            name: title,
            agency: dept,
            cycle: ''
          });
        }
      }
    }

    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '') < (b.time || '') ? -1 : 1;
    });

    return Response.json({ yyyymm: yyyymm, count: events.length, totalCellsParsed: cells.length, events: events });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
