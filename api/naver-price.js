// Server-side call to Naver Finance's public real-time quote JSON API,
// plus Naver's stock search/autocomplete API for resolving a Korean
// company name to its 6-digit code. Both undocumented but publicly
// accessible (no key/auth needed) — running here avoids browser CORS.

async function resolveNameToCode(name) {
  const searchUrl = 'https://m.stock.naver.com/front-api/search/autoComplete?query='
    + encodeURIComponent(name) + '&target=stock';
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://finance.naver.com/'
    }
  });
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`검색 API 오류: HTTP ${res.status}`);
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error('검색 응답이 JSON 형식이 아니에요');
  }
  let items = null;
  if (data && data.result && Array.isArray(data.result.items)) items = data.result.items;
  else if (data && Array.isArray(data.items)) items = data.items;
  else if (Array.isArray(data)) items = data;

  if (!items || items.length === 0) {
    throw new Error('"' + name + '"에 해당하는 종목을 찾지 못했어요');
  }
  const best = items[0];
  const code = best.code || best.itemCode || best.symbolCode;
  if (!code) {
    throw new Error('검색 결과에서 종목코드를 찾지 못했어요');
  }
  return { code: code, name: best.name || best.stockName || name, typeName: best.typeName || null };
}

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const req = request;
  try {
    const url = new URL(req.url);
    const indexParam = url.searchParams.get('index'); // kospi | kosdaq | nasdaq | snp500

    if (indexParam) {
      return await handleIndexRequest(indexParam);
    }

    const codesParam = url.searchParams.get('codes') || url.searchParams.get('code');
    const nameParam = url.searchParams.get('name');

    let codes = [];
    let resolvedNames = {};

    if (nameParam) {
      const resolved = await resolveNameToCode(nameParam);
      codes = [resolved.code];
      resolvedNames[resolved.code] = resolved;
    } else if (codesParam) {
      codes = codesParam.split(',').map((c) => c.trim()).filter(Boolean);
    } else {
      return Response.json({ error: '종목코드(codes) 또는 종목명(name)이 필요해요' }, { status: 400 });
    }

    const apiUrl = 'https://polling.finance.naver.com/api/realtime/domestic/stock/'
      + codes.map(encodeURIComponent).join(',');

    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://finance.naver.com/'
      }
    });
    const rawText = await res.text();

    if (!res.ok) {
      return Response.json(
        { error: `네이버 API 오류: HTTP ${res.status}`, raw: rawText.slice(0, 300) },
        { status: 502 }
      );
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return Response.json(
        { error: '응답이 JSON 형식이 아니에요', raw: rawText.slice(0, 300) },
        { status: 500 }
      );
    }

    const list = data && Array.isArray(data.datas) ? data.datas : null;
    if (!list) {
      return Response.json(
        { error: '응답 구조를 인식하지 못했어요', raw: JSON.stringify(data).slice(0, 500) },
        { status: 500 }
      );
    }

    const results = {};
    list.forEach((item) => {
      const code = item.itemCode || item.code || item.symbolCode;
      const priceRaw = item.closePrice;
      const price = priceRaw != null ? Math.round(parseFloat(String(priceRaw).replace(/,/g, ''))) : null;
      if (code && price != null && !isNaN(price)) {
        const changeRaw = item.compareToPreviousClosePrice;
        const change = changeRaw != null ? parseFloat(String(changeRaw).replace(/,/g, '')) : null;
        const previousClose = (change != null && !isNaN(change)) ? Math.round(price - change) : null;
        results[code] = {
          price: price,
          previousClose: previousClose,
          name: (resolvedNames[code] && resolvedNames[code].name) || item.stockName || item.itemName || null,
          date: item.localTradedAt || null,
          marketStatus: item.marketStatus || null
        };
      }
    });

    if (Object.keys(results).length === 0) {
      return Response.json(
        { error: '가격 데이터를 찾지 못했어요', raw: JSON.stringify(list).slice(0, 500) },
        { status: 500 }
      );
    }

    return Response.json({ results: results, resolvedCode: nameParam ? codes[0] : null });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
};

// 코스피/코스닥: Naver's dedicated domestic index endpoint (same shape as stocks).
// 나스닥/S&P500: no confirmed Naver endpoint, so proxied through Yahoo Finance
// here (server-side), which avoids the browser CORS issue just as effectively.
async function handleIndexRequest(indexKey) {
  const NAVER_DOMESTIC = { kospi: 'KOSPI', kosdaq: 'KOSDAQ', vkospi: 'VKOSPI' };
  const YAHOO_WORLD = {
    nasdaq: '^IXIC', snp500: '^GSPC', wti: 'CL=F', us10y: '^TNX', us30y: '^TYX',
    fx: 'KRW=X', sox: '^SOX', dow: '^DJI', btc: 'BTC-USD', vix: '^VIX', gold: 'GC=F',
    mkt_kospi: '^KS11', mkt_kosdaq: '^KQ11', mkt_dow: '^DJI', mkt_snp500: '^GSPC', mkt_nasdaq: '^IXIC'
  };

  try {
    if (NAVER_DOMESTIC[indexKey]) {
      const apiUrl = 'https://polling.finance.naver.com/api/realtime/domestic/index/' + NAVER_DOMESTIC[indexKey];
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://finance.naver.com/'
        }
      });
      const rawText = await res.text();
      if (!res.ok) {
        return Response.json({ error: `네이버 지수 API 오류: HTTP ${res.status}`, raw: rawText.slice(0, 300) }, { status: 502 });
      }
      let data;
      try { data = JSON.parse(rawText); } catch (e) {
        return Response.json({ error: '응답이 JSON 형식이 아니에요', raw: rawText.slice(0, 300) }, { status: 500 });
      }
      const list = data && Array.isArray(data.datas) ? data.datas : null;
      const item = list && list[0];
      if (!item) {
        return Response.json({ error: '지수 데이터를 찾지 못했어요', raw: JSON.stringify(data).slice(0, 500) }, { status: 500 });
      }
      const priceRaw = item.closePrice;
      const price = priceRaw != null ? parseFloat(String(priceRaw).replace(/,/g, '')) : null;
      if (price == null || isNaN(price)) {
        return Response.json({ error: '지수 데이터를 찾지 못했어요', raw: JSON.stringify(item).slice(0, 500) }, { status: 500 });
      }
      var changeRaw = item.compareToPreviousClosePrice;
      var change = changeRaw != null ? parseFloat(String(changeRaw).replace(/,/g, '')) : null;
      var prevClose = (change != null && !isNaN(change)) ? (price - change) : null;
      return Response.json({ price: price, previousClose: prevClose, source: 'naver' });
    }

    if (YAHOO_WORLD[indexKey]) {
      const apiUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(YAHOO_WORLD[indexKey]);
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const rawText = await res.text();
      if (!res.ok) {
        return Response.json({ error: `야후 API 오류: HTTP ${res.status}`, raw: rawText.slice(0, 300) }, { status: 502 });
      }
      let data;
      try { data = JSON.parse(rawText); } catch (e) {
        return Response.json({ error: '응답이 JSON 형식이 아니에요', raw: rawText.slice(0, 300) }, { status: 500 });
      }
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const meta = result && result.meta;
      if (!meta || meta.regularMarketPrice == null) {
        return Response.json({ error: '지수 데이터를 찾지 못했어요', raw: JSON.stringify(data).slice(0, 500) }, { status: 500 });
      }
      const prevClose = meta.previousClose != null ? meta.previousClose
        : (meta.chartPreviousClose != null ? meta.chartPreviousClose : null);
      return Response.json({
        price: meta.regularMarketPrice,
        previousClose: prevClose,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh != null ? meta.fiftyTwoWeekHigh : null,
        source: 'yahoo'
      });
    }

    return Response.json({ error: '알 수 없는 지수예요: ' + indexKey }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message || '알 수 없는 오류' }, { status: 500 });
  }
}

// No custom routing config needed — a file at /api/naver-price.js
// is automatically exposed at /api/naver-price by Vercel.
