// Supabase Edge Function: get-stock-price
// 伺服器端代理抓取台股(TWSE)/美股(Stooq)股價，避免瀏覽器直接呼叫被CORS擋掉
// 陸股目前不支援，前端會請使用者手動輸入

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { market, symbol } = await req.json();
    if (!market || !symbol) {
      return new Response(JSON.stringify({ error: "缺少 market 或 symbol" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let result;
    if (market === "tw") {
      result = await fetchTwStockPrice(symbol);
    } else if (market === "us") {
      result = await fetchUsStockPrice(symbol);
    } else {
      result = { error: "不支援的市場，目前只支援 tw / us" };
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function fetchTwStockPrice(symbol: string) {
  for (const prefix of ["tse", "otc"]) {
    try {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${prefix}_${symbol}.tw&json=1&delay=0`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const data = await res.json();
      const info = data.msgArray && data.msgArray[0];
      if (info) {
        const priceStr = info.z && info.z !== "-" ? info.z : info.y;
        const price = parseFloat(priceStr);
        if (!isNaN(price) && price > 0) {
          return { price, currency: "TWD", name: info.n || symbol };
        }
      }
    } catch (_e) {
      // 換下一個前綴再試
    }
  }
  return { error: `查不到台股代碼 ${symbol} 的股價` };
}

async function fetchUsStockPrice(symbol: string) {
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetch(url);
    if (!res.ok) return { error: `Stooq 回應失敗 (${res.status})` };
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return { error: `查不到美股代碼 ${symbol} 的股價` };
    const cols = lines[1].split(",");
    // 欄位順序: Symbol,Date,Time,Open,High,Low,Close,Volume
    if (cols[3] === "N/D") return { error: `查不到美股代碼 ${symbol} 的股價` };
    const close = parseFloat(cols[6]);
    if (isNaN(close)) return { error: `查不到美股代碼 ${symbol} 的股價` };
    return { price: close, currency: "USD" };
  } catch (e) {
    return { error: String(e) };
  }
}
