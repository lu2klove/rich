// 공공데이터포털(data.go.kr) - 국가데이터처(구 통계청) 통계정책관리시스템
// 승인통계관리 데이터에서, 지정한 연월(yyyymm)에 공표예정일이 속하는
// 국내 통계 발표 일정을 가져옵니다.
//
// 필요 환경변수: DATA_GO_KR_KEY (공공데이터포털에서 발급받은 "일반 인증키")
// 데이터 출처: data.go.kr, 국가데이터처_통계정책관리시스템 승인통계관리
//
// 한계:
// - 시각(HH:MM)은 없고 날짜(YYYY-MM-DD)만 제공돼요.
// - 국내 통계만 다뤄요 (해외 지표는 포함 안 됨).
// - 원본 데이터가 연 1회 갱신이라, 공표예정일이 비어있거나 최신이 아닐 수 있어요.

export const config = { runtime: 'edge' };

const BASE_PATH = '/api/15086581/v1/uddi:01d5c55c-0586-4b90-a008-9984c7f0ae1e';

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const yyyymm = searchParams.get('yyyymm'); // 예: 202609

    if (!yyyymm || !/^\d{6}$/.test(yyyymm)) {
      return Response.json({ error: 'yyyymm 파라미터가 필요해요 (YYYYMM 형식)' }, { status: 400 });
    }

    const serviceKey = process.env.DATA_GO_KR_KEY;
    if (!serviceKey) {
      return Response.json({ error: 'DATA_GO_KR_KEY 환경변수가 설정되지 않았어요.' }, { status: 500 });
    }

    const year = yyyymm.slice(0, 4);
    const month = yyyymm.slice(4, 6);
    const lastDay = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
    const fromDate = `${year}-${month}-01`;
    const toDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

    // cond[] 필터 문법(한글 필드명 인코딩 이슈 등)을 피하기 위해,
    // 전체 데이터를 한 번에 받아서 이 함수 안에서 직접 날짜 범위로 걸러내요.
    // (전체 약 1,363건 수준이라 한 번에 받아도 부담 없어요)
    const url = `https://api.odcloud.kr${BASE_PATH}`
      + `?page=1&perPage=2000&returnType=JSON`
      + `&serviceKey=${encodeURIComponent(serviceKey)}`;

    const res = await fetch(url);
    const rawText = await res.text();

    if (!res.ok) {
      return Response.json(
        { error: `공공데이터포털 응답 오류(HTTP ${res.status})`, raw: rawText.slice(0, 500) },
        { status: res.status }
      );
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return Response.json({ error: '응답을 JSON으로 해석하지 못했어요.', raw: rawText.slice(0, 500) }, { status: 500 });
    }

    const allRows = Array.isArray(data.data) ? data.data : [];
    const rows = allRows.filter((r) => {
      const d = r['공표예정일'];
      return d && d >= fromDate && d <= toDate;
    });

    const events = rows
      .map((r) => ({
        date: r['공표예정일'],
        name: r['통계명'] || '',
        agency: r['기관명'] || '',
        cycle: r['작성주기'] || ''
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return Response.json({ yyyymm: yyyymm, count: events.length, totalRowsFetched: allRows.length, events: events });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
