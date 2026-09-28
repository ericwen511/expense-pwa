# 03 環境建置 SOP

給任何AI（或任何人）在**完全空白的帳號**上，從零建立這個專案運作環境用。跟著下面步驟依序做，做完就等於有一套跟正式站一樣的環境。

適用情境：換一個全新的 Supabase／Vercel／GitHub 帳號重建這個專案；或是把這個專案複製一份成另一個獨立的App。

---

## 需要準備的帳號／服務

| 服務 | 用途 | 費用 |
|---|---|---|
| GitHub | 放程式碼、觸發自動部署 | 免費 |
| Supabase | 資料庫、使用者驗證、Edge Function | 免費方案即可 |
| Vercel | 網站託管 | 免費方案即可 |

---

## 步驟 1：程式碼放到 GitHub

把整個專案資料夾（`index.html`、`app.js`、`styles.css`、`manifest.json`、`icons/`、`supabase-client.js`、`supabase/`、`docs/`、`.github/`）推到一個新的 GitHub repo。

程式碼本身就是最終規格，這裡不重複列檔案清單——直接看 repo 內容即可。

---

## 步驟 2：建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 建立新專案，選一個機房地區（原專案用新加坡）。
2. 進入專案的 **SQL Editor**，貼上 `docs/01_主要Schema.sql` 整份內容，從上到下執行一次。
3. **【關鍵手動步驟，任何AI都無法用程式碼完成】**：
   左側選單 **Settings → API** → 找到 **「Exposed schemas」** 欄位，把 `expense_app` 加進去（預設只有 `public`）。
   不做這一步，前端呼叫一律會收到 404 或 `schema must be one of the following: public` 錯誤。
4. 同一頁面複製 **Project URL** 與 **anon / publishable key**，下一步要用。
5.（建議）**Authentication → Providers → Email** → 視情況決定是否關閉「Confirm email」：
   - 關閉：註冊後立即可用，不用等確認信——適合只有家人/熟人使用的場景。
   - 開啟：需先收信驗證才能登入——適合對外開放註冊的場景，但要注意 Supabase 內建信箱服務的**寄信頻率限制很低**（免費/預設方案每小時只能寄幾封），短時間多次註冊測試很容易撞到 `email rate limit exceeded`，屆時要嘛關閉此設定、要嘛額外接自訂SMTP（如Resend、SendGrid）。

---

## 步驟 3：前端接上 Supabase

編輯 `supabase-client.js`（不要外流這個檔案的實際內容，因為裡面有專案專屬的URL和金鑰）：

```js
const SUPABASE_URL = '你的Project URL';
const SUPABASE_ANON_KEY = '你的anon/publishable key';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'expense_app' }   // 一定要指定，不然預設查 public schema 會找不到任何表
});
```

`index.html` 已經用 `<script src="https://unpkg.com/@supabase/supabase-js@2"></script>` 載入了 Supabase JS SDK，不需要額外安裝套件、也沒有 npm build 流程。

---

## 步驟 4：部署股票報價 Edge Function（財富管家的股票功能需要）

**原因**：瀏覽器直接呼叫台股(TWSE)或美股(Yahoo Finance)股價API會被CORS擋掉，一定要透過伺服器端代理（Edge Function對外部API呼叫沒有CORS限制）。

程式碼已經在 `supabase/functions/get-stock-price/index.ts`。部署方式擇一：

- **透過 Supabase Dashboard**：Edge Functions → Create a function → 名稱填 `get-stock-price` → 把該檔案內容整段貼進去 → Deploy。（正式站目前就是用這個方式部署的）
- **透過 Supabase CLI**：`supabase functions deploy get-stock-price`（需要先 `supabase login` 並 link 專案）。

部署完成後不需要額外設定 CORS 或環境變數，函式本身已經處理好 `Access-Control-Allow-Origin` 標頭。

**已知限制**：目前只支援台股(`market: 'tw'`)、美股(`market: 'us'`)，陸股沒有找到穩定資料源，前端遇到陸股會提示使用者手動輸入市值。美股資料源原本用 Stooq，後來因為該服務端點下架/被反爬蟲擋住，已改用 Yahoo Finance 的 `query1.finance.yahoo.com/v8/finance/chart/{symbol}`——如果未來這個端點也失效，需要重新找美股資料源。

---

## 步驟 5：部署到 Vercel

1. Vercel → New Project → 選剛才那個 GitHub repo。
2. Framework Preset 選 **「Other」**（純靜態網站，沒有 build 指令、沒有 `vercel.json`）。
3. 部署完成後會拿到一個 `*.vercel.app` 網址，之後 `git push` 到 GitHub 會自動觸發重新部署。

**已知問題**：Vercel 的 GitHub webhook 偶爾會漏接——commit 已經 push 到 GitHub，但 Vercel 完全沒有觸發新的部署（不是建置失敗，是根本沒開始跑，Vercel Dashboard 的 Deployments 列表也看不出異常）。確認方式：

```bash
curl -s https://你的網址.vercel.app | grep "某段你剛改的程式碼特徵字串"
```

比看 Dashboard 更快知道是否真的更新了。如果發現沒更新，補推一次空白 commit 即可重新觸發：

```bash
git commit --allow-empty -m "trigger redeploy"
git push
```

**建議習慣**：每次改完程式碼並 push 之後，都主動 curl 一次正式站驗證，不要只看到「git push 顯示成功」就假設已經上線。

---

## 步驟 6：設定 GitHub Actions 保活機制

Supabase 免費方案的專案，超過一段時間沒有流量會自動暫停。`.github/workflows/keep-alive.yml` 每 3 天會呼叫一次 Supabase 的 Auth 健康檢查端點保持專案活躍。

這個 workflow 需要兩個 GitHub Secrets（Repo → Settings → Secrets and variables → Actions → New repository secret）：

| Secret 名稱 | 值 |
|---|---|
| `SUPABASE_URL` | 步驟2複製的 Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | 步驟2複製的 anon/publishable key |

設定好之後，可以到 Actions 分頁手動點一次 **Run workflow** 確認會成功（回應狀態碼應該是 200 系列）。

---

## 步驟 7：PWA 安裝相關檢查

- `icons/icon-192.png`、`icons/icon-512.png` 兩個尺寸的圖示要存在（`manifest.json` 已經指定這兩個檔名）。
- `manifest.json` 裡**不要**設定 `"orientation"` 欄位——曾經設過 `"portrait"`，會導致已安裝的PWA在平板橫向使用時畫面被壓縮成一小格。
- Android／桌面 Chrome：瀏覽器會自動偵測manifest並跳出安裝提示。
- iPhone：**只有Safari**支援「加入主畫面」，Chrome-for-iOS拿不到這個能力——這是Apple的系統限制，不是網站設定問題，測試時要提醒使用者務必用Safari開啟。

---

## 完成後驗收清單

- [ ] 可以在登入畫面完成「建立新帳號」並直接（或收信驗證後）登入
- [ ] 登入後可以新增帳戶、分類、商家、交易，總覽畫面數字正確
- [ ] 財富管家可以新增資產並輸入股票代碼，按「更新所有股價」能正確抓到台股/美股報價
- [ ] 可以建立第二本帳本、切換帳本
- [ ] 用另一個帳號的Email測試「帳本分享（唯讀）」，被分享者能看到資料但看不到編輯/刪除按鈕
- [ ] 手機Safari（iOS）／Chrome（Android）都能成功「加入主畫面」
- [ ] GitHub Actions 的 keep-alive workflow 手動觸發一次成功
- [ ] Push 一次小改動到GitHub，用curl驗證Vercel正式站確實更新

全部勾選完，就代表環境重建成功。
