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

export default async (req) => {
  try {
    const url = new URL(req.url);
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
        results[code] = {
          price: price,
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

// No custom `config.path` — exposed at Netlify's standard default endpoint:
// /.netlify/functions/naver-price
