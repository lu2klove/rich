// Server-side call to Naver Finance's public (undocumented) daily-chart
// XML endpoint, for a single domestic stock's historical daily close/volume.
// Used by the "종목 위험 검증" (stock risk) engine, which needs ~300
// trading days of history to compute 52-week highs, moving averages,
// and relative-strength vs the market. Running here avoids browser CORS.

export const config = { runtime: 'edge' };

function parseChartXml(xmlText) {
  const items = [];
  const itemRegex = /<item\s+data=["']([^"']+)["']\s*\/>/g;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const parts = match[1].split('|');
    // 날짜|시가|고가|저가|종가|거래량
    if (parts.length < 6) continue;
    const dateRaw = parts[0];
    const close = parseFloat(parts[4]);
    const volume = parseFloat(parts[5]);
    if (!dateRaw || dateRaw.length !== 8 || isNaN(close)) continue;
    const date = dateRaw.slice(0, 4) + '-' + dateRaw.slice(4, 6) + '-' + dateRaw.slice(6, 8);
    items.push({ date, close, volume: isNaN(volume) ? null : volume });
  }
  return items;
}

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const count = searchParams.get('count') || '300';

    if (!code || !/^\d{6}$/.test(code)) {
      return Response.json({ error: '6자리 종목코드(code)가 필요해요' }, { status: 400 });
    }

    const apiUrl = 'https://fchart.stock.naver.com/sise.nhn?symbol=' + encodeURIComponent(code)
      + '&timeframe=day&count=' + encodeURIComponent(count) + '&requestType=0';

    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://finance.naver.com/'
      }
    });
    const rawText = await res.text();

    if (!res.ok) {
      return Response.json(
        { error: `네이버 차트 API 오류: HTTP ${res.status}`, raw: rawText.slice(0, 300) },
        { status: 502 }
      );
    }

    const history = parseChartXml(rawText);
    if (history.length === 0) {
      return Response.json(
        { error: '시세 데이터를 찾지 못했어요 (종목코드를 확인해주세요)', raw: rawText.slice(0, 300) },
        { status: 500 }
      );
    }

    return Response.json({ code, count: history.length, history });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
