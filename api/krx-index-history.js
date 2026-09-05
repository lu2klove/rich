// 특정 기준일자(basDd)의 VKOSPI, KOSPI, KOSDAQ 종가를 한 번에 가져옵니다.
// 60일 상관관계 백필(backfill)에서 하루씩 반복 호출하는 용도예요.
// (KRX Open API는 날짜 범위 조회를 지원하지 않고 basDd 하나만 받기 때문에
//  프론트엔드에서 날짜를 하루씩 거슬러 올라가며 이 함수를 반복 호출해요)
//
// 필요 환경변수: KRX_AUTH_KEY
// 필요 서비스 승인: 파생상품지수 시세정보(drvprod_dd_trd),
//                 KOSPI 시리즈 일별시세정보(kospi_dd_trd),
//                 KOSDAQ 시리즈 일별시세정보(kosdaq_dd_trd)

export const config = { runtime: 'edge' };

function extractRows(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.OutBlock_1)) return data.OutBlock_1;
  const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  return arrKey ? data[arrKey] : null;
}

async function fetchKrx(apiPath, basDd, authKey) {
  const url = `https://data-dbg.krx.co.kr/svc/apis/idx/${apiPath}?basDd=${basDd}`;
  const res = await fetch(url, { headers: { AUTH_KEY: authKey } });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, raw: text };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, status: 500, raw: text };
  }
  return { ok: true, rows: extractRows(data) || [] };
}

function parseNum(v) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const basDd = searchParams.get('basDd');
    if (!basDd || !/^\d{8}$/.test(basDd)) {
      return Response.json({ error: 'basDd 파라미터가 필요해요 (YYYYMMDD 형식)' }, { status: 400 });
    }

    const authKey = process.env.KRX_AUTH_KEY;
    if (!authKey) {
      return Response.json({ error: 'KRX_AUTH_KEY 환경변수가 설정되지 않았어요.' }, { status: 500 });
    }

    const [drv, kospi, kosdaq] = await Promise.all([
      fetchKrx('drvprod_dd_trd', basDd, authKey),
      fetchKrx('kospi_dd_trd', basDd, authKey),
      fetchKrx('kosdaq_dd_trd', basDd, authKey)
    ]);

    // 인증/승인 문제는 바로 알려줘요 (날짜별로 반복 호출하는 구조라
    // 한 번만 확인해도 충분하지만, 매 호출마다 체크해도 무해해요)
    for (const r of [drv, kospi, kosdaq]) {
      if (!r.ok && r.status === 401) {
        return Response.json(
          { error: 'KRX 인증 실패(401). 인증키 또는 서비스 이용승인을 확인해주세요.', raw: (r.raw || '').slice(0, 300) },
          { status: 401 }
        );
      }
    }

    // 휴장일 등으로 데이터가 없는 날은 "이 날짜엔 데이터 없음"으로 정상 처리(에러 아님)
    const noData = (!drv.ok || drv.rows.length === 0) &&
                   (!kospi.ok || kospi.rows.length === 0) &&
                   (!kosdaq.ok || kosdaq.rows.length === 0);
    if (noData) {
      return Response.json({ basDd: basDd, hasData: false });
    }

    const vkospiRow = drv.ok ? drv.rows.find((r) => (r.IDX_NM || '').includes('변동성')) : null;
    const kospiRow = kospi.ok ? kospi.rows.find((r) => (r.IDX_NM || '').trim() === '코스피') : null;
    const kosdaqRow = kosdaq.ok ? kosdaq.rows.find((r) => (r.IDX_NM || '').trim() === '코스닥') : null;

    const vkospi = vkospiRow ? parseNum(vkospiRow.CLSPRC_IDX) : null;
    const kospiVal = kospiRow ? parseNum(kospiRow.CLSPRC_IDX) : null;
    const kosdaqVal = kosdaqRow ? parseNum(kosdaqRow.CLSPRC_IDX) : null;

    if (vkospi == null && kospiVal == null && kosdaqVal == null) {
      return Response.json({
        basDd: basDd,
        hasData: false,
        debug: {
          drvNames: drv.ok ? drv.rows.map((r) => r.IDX_NM).filter(Boolean) : null,
          kospiNames: kospi.ok ? kospi.rows.map((r) => r.IDX_NM).filter(Boolean) : null,
          kosdaqNames: kosdaq.ok ? kosdaq.rows.map((r) => r.IDX_NM).filter(Boolean) : null
        }
      });
    }

    return Response.json({
      basDd: basDd,
      hasData: true,
      vkospi: vkospi,
      kospi: kospiVal,
      kosdaq: kosdaqVal
    });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
