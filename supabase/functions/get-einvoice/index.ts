// Supabase Edge Function: get-einvoice
// 伺服器端代理呼叫財政部電子發票整合服務平台的「載具查詢」API，
// 避免瀏覽器直接呼叫被CORS擋掉，也避免驗證碼直接暴露在對外部API的請求中。
//
// 官方API文件：電子發票應用API規格 v0.5 (einvoice.nat.gov.tw)
// 端點：POST https://api.einvoice.nat.gov.tw/PB2CAPIVAN/invServ/InvServ
// 參數是放在query string上，不是放在request body裡（這是財政部這組API的既有設計）
//
// 本檔案只轉送兩種action：
//   action=list   → 對應官方 carrierInvChk（載具發票表頭清單，含日期區間）
//   action=detail → 對應官方 carrierInvDetail（單張發票品項明細，需要cardEncrypt）

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EINVOICE_BASE = "https://api.einvoice.nat.gov.tw/PB2CAPIVAN/invServ/InvServ";
const CARD_TYPE_MOBILE_BARCODE = "3J0002";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toSlashDate(d: string) {
  // 接受 'yyyy-MM-dd' 或已經是 'yyyy/MM/dd'，統一轉成財政部要求的 'yyyy/MM/dd'
  return d.replaceAll("-", "/");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, cardNo, cardEncrypt } = body;

    if (!action || !cardNo || !cardEncrypt) {
      return new Response(JSON.stringify({ error: "缺少 action、cardNo 或 cardEncrypt" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const params = new URLSearchParams();
    params.set("version", "0.5");
    params.set("cardType", CARD_TYPE_MOBILE_BARCODE);
    params.set("cardNo", cardNo);
    params.set("cardEncrypt", cardEncrypt);
    params.set("timeStamp", String(nowSeconds()));
    params.set("expTimeStamp", "2147483647");
    params.set("UUID", crypto.randomUUID());

    if (action === "list") {
      const { startDate, endDate, onlyWinningInv } = body;
      if (!startDate || !endDate) {
        return new Response(JSON.stringify({ error: "list需要 startDate、endDate" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      params.set("action", "carrierInvChk");
      params.set("startDate", toSlashDate(startDate));
      params.set("endDate", toSlashDate(endDate));
      params.set("onlyWinningInv", onlyWinningInv ? "Y" : "N");
    } else if (action === "detail") {
      const { invNum, invDate, sellerName, amount } = body;
      if (!invNum || !invDate) {
        return new Response(JSON.stringify({ error: "detail需要 invNum、invDate" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      params.set("action", "carrierInvDetail");
      params.set("invNum", invNum);
      params.set("invDate", toSlashDate(invDate));
      if (sellerName) params.set("sellerName", sellerName);
      if (amount !== undefined && amount !== null) params.set("amount", String(amount));
    } else {
      return new Response(JSON.stringify({ error: `不支援的action: ${action}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = `${EINVOICE_BASE}?${params.toString()}`;
    const upstreamRes = await fetch(url, { method: "POST" });
    const text = await upstreamRes.text();

    // 財政部API即使失敗，HTTP狀態碼通常還是200、錯誤資訊在回應內容的code/msg欄位，
    // 這裡把原始回應整段透傳回去，讓前端/開發時可以直接看到真正的錯誤訊息，
    // 不在這一層假設一定是合法JSON或吞掉錯誤細節
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_e) {
      parsed = { rawText: text };
    }

    return new Response(JSON.stringify(parsed), {
      status: upstreamRes.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
