// 해외종목(야후 파이낸스) 시세를 서버에서 대신 조회합니다.
// 브라우저에서 query1.finance.yahoo.com을 직접 호출하면 CORS 정책에
// 막혀서 "Failed to fetch"가 발생하는데, 서버(서버리스 함수)끼리의
// 통신은 CORS 제약이 없어서 여기서 대신 호출해요.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || '').trim();

    if (!symbol) {
      return Response.json({ error: 'symbol 파라미터가 필요해요' }, { status: 400 });
    }

    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const rawText = await res.text();

    if (!res.ok) {
      return Response.json(
        { error: `야후 파이낸스 응답 오류(HTTP ${res.status})`, raw: rawText.slice(0, 300) },
        { status: res.status }
      );
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return Response.json({ error: '응답을 JSON으로 해석하지 못했어요.', raw: rawText.slice(0, 300) }, { status: 500 });
    }

    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result || !result.meta || result.meta.regularMarketPrice == null) {
      return Response.json({ error: `"${symbol}" 가격 정보를 찾을 수 없어요. 심볼(티커)이 정확한지 확인해주세요.` }, { status: 404 });
    }

    const meta = result.meta;
    const previousClose = meta.previousClose != null ? meta.previousClose
      : (meta.chartPreviousClose != null ? meta.chartPreviousClose : null);

    return Response.json({
      price: meta.regularMarketPrice,
      previousClose: previousClose,
      symbol: meta.symbol || symbol,
      currency: meta.currency || null
    });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}
