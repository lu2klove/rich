// KRX(한국거래소) Open API를 통해 파생상품지수(코스피200 변동성지수/VKOSPI)의
// 전일 종가를 가져옵니다. KRX Open API는 T-1(전일) 데이터만 제공하며,
// 다음 영업일 오전 8시에 갱신됩니다(실시간 아님).
//
// 필요 환경변수: KRX_AUTH_KEY (Vercel 프로젝트 설정 > Environment Variables에 등록)
// 참고: https://openapi.krx.co.kr — '파생상품지수 시세정보'(drvprod_dd_trd) 서비스
// 이용신청 및 승인이 되어 있어야 실제 데이터가 응답돼요.

export const config = { runtime: 'edge' };

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function extractRows(data) {
  // KRX Open API 응답은 보통 { OutBlock_1: [...] } 형태지만,
  // 혹시 다른 키로 올 경우까지 대비해 유연하게 찾아요.
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.OutBlock_1)) return data.OutBlock_1;
  const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  return arrKey ? data[arrKey] : null;
}

export default async function handler(request) {
  try {
    const authKey = process.env.KRX_AUTH_KEY;
    if (!authKey) {
      return Response.json(
        { error: 'KRX_AUTH_KEY 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정에서 추가해주세요.' },
        { status: 500 }
      );
    }

    let lastRaw = '';
    let lastStatus = null;

    // 오늘부터 최대 7일 전까지 하루씩 거슬러 올라가며 데이터가 있는 날을 찾아요.
    // (주말/공휴일이거나, 다음날 오전 8시 갱신 전이면 당일 데이터가 아직 없을 수 있어요)
    for (let back = 0; back <= 7; back++) {
      const d = new Date();
      d.setDate(d.getDate() - back);
      const basDd = formatDate(d);

      const apiUrl = `https://data-dbg.krx.co.kr/svc/apis/idx/drvprod_dd_trd?basDd=${basDd}`;
      const res = await fetch(apiUrl, {
        headers: { AUTH_KEY: authKey }
      });
      const rawText = await res.text();
      lastRaw = rawText;
      lastStatus = res.status;

      if (!res.ok) {
        // 401은 키 미승인/오류일 가능성이 높아 바로 중단하고 알려줘요.
        if (res.status === 401) {
          return Response.json(
            { error: 'KRX 인증 실패(401). 인증키가 잘못됐거나, 파생상품지수 서비스 이용승인이 아직 안 됐을 수 있어요.', raw: rawText.slice(0, 300) },
            { status: 401 }
          );
        }
        continue; // 다른 오류면 하루 더 거슬러 올라가서 재시도
      }

      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        continue;
      }

      const rows = extractRows(data);
      if (!rows || rows.length === 0) continue; // 이 날짜엔 데이터 없음(휴장일 등) → 하루 더 거슬러 올라감

      const vkospiRow = rows.find((r) => {
        const name = r.IDX_NM || '';
        return name.includes('변동성');
      });

      if (!vkospiRow) {
        // 데이터는 있는데 변동성지수 행이 없는 경우 — 어떤 지수들이 왔는지 참고용으로 반환
        return Response.json(
          {
            error: '이 날짜 응답에서 변동성지수 항목을 찾지 못했어요.',
            availableNames: rows.map((r) => r.IDX_NM).filter(Boolean),
            basDd: basDd
          },
          { status: 500 }
        );
      }

      const value = parseFloat(String(vkospiRow.CLSPRC_IDX).replace(/,/g, ''));
      if (isNaN(value)) {
        return Response.json({ error: '종가 값을 숫자로 변환하지 못했어요.', raw: JSON.stringify(vkospiRow) }, { status: 500 });
      }

      return Response.json({
        value: value,
        basDd: vkospiRow.BAS_DD || basDd,
        indexName: vkospiRow.IDX_NM,
        change: vkospiRow.CMPPREVDD_IDX != null ? parseFloat(String(vkospiRow.CMPPREVDD_IDX).replace(/,/g, '')) : null,
        fluctRate: vkospiRow.FLUC_RT != null ? parseFloat(String(vkospiRow.FLUC_RT).replace(/,/g, '')) : null
      });
    }

    return Response.json(
      { error: '최근 7일 내 데이터를 찾지 못했어요.', lastStatus: lastStatus, raw: lastRaw.slice(0, 300) },
      { status: 500 }
    );
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
