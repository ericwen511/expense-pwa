/* ---------- IndexedDB：離線交易佇列（未連上Supabase前暫存） ---------- */
const DB_NAME = 'expenseTrackerDB';
const DB_VERSION = 3;
let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending_transactions')) {
        db.createObjectStore('pending_transactions', { keyPath: 'clientGeneratedId' });
      }
    };

    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbStore(storeName, mode) {
  return dbInstance.transaction(storeName, mode).objectStore(storeName);
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = idbStore(storeName, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const req = idbStore(storeName, 'readwrite').put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const req = idbStore(storeName, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Supabase 資料存取層 ---------- */
let currentUserId = null;

async function sbGetAll(table) {
  const { data, error } = await supabaseClient.from(table).select('*');
  if (error) throw error;
  return data;
}

async function sbGetAllInLedger(table) {
  const { data, error } = await supabaseClient.from(table).select('*').eq('ledger_id', currentLedgerId);
  if (error) throw error;
  return data;
}

async function sbCount(table) {
  const { count, error } = await supabaseClient.from(table).select('*', { count: 'exact', head: true }).eq('user_id', currentUserId);
  if (error) throw error;
  return count || 0;
}

async function sbCountInLedger(table) {
  const { count, error } = await supabaseClient
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('ledger_id', currentLedgerId);
  if (error) throw error;
  return count || 0;
}

async function sbInsert(table, row) {
  const { data, error } = await supabaseClient.from(table).insert({ ...row, user_id: currentUserId }).select().single();
  if (error) throw error;
  return data;
}

async function sbUpdate(table, id, patch) {
  const { data, error } = await supabaseClient.from(table).update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function sbDeleteHard(table, id) {
  const { error } = await supabaseClient.from(table).delete().eq('id', id);
  if (error) throw error;
}

/* 交易表欄位是snake_case，這裡跟畫面用的camelCase互轉 */
function txToRow(t) {
  return {
    type: t.type,
    amount: t.amount,
    category_id: t.categoryId || null,
    account_id: t.accountId,
    merchant_id: t.merchantId || null,
    transfer_to_account_id: t.transferToAccountId || null,
    transfer_to_amount: t.transferToAmount || null,
    transaction_date: t.date,
    note: t.note || null,
    client_generated_id: t.clientGeneratedId,
    ledger_id: t.ledgerId,
    recurring_rule_id: t.recurringRuleId || null
  };
}

function txFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    categoryId: row.category_id,
    accountId: row.account_id,
    merchantId: row.merchant_id,
    transferToAccountId: row.transfer_to_account_id,
    transferToAmount: row.transfer_to_amount ? Number(row.transfer_to_amount) : null,
    date: row.transaction_date,
    note: row.note || '',
    clientGeneratedId: row.client_generated_id,
    ledgerId: row.ledger_id,
    createdAt: row.created_at,
    recurringRuleId: row.recurring_rule_id || null
  };
}

async function sbInsertTransaction(row) {
  const { data, error } = await supabaseClient
    .from('transactions')
    .insert({ ...row, user_id: currentUserId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function sbSoftDeleteTransaction(id) {
  const { error } = await supabaseClient
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

async function sbGetAllTransactions() {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await supabaseClient
      .from('transactions')
      .select('*')
      .eq('ledger_id', currentLedgerId)
      .is('deleted_at', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all.map(txFromRow);
}

/* 財富管家用：跨所有帳本抓取交易，才能算出全部現金/銀行帳戶的即時餘額 */
async function sbGetAllTransactionsAllLedgers() {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await supabaseClient
      .from('transactions')
      .select('*')
      .is('deleted_at', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all.map(txFromRow);
}

async function sbUpsertBudget(yearMonth, amount) {
  const { data, error } = await supabaseClient
    .from('budgets')
    .upsert(
      { user_id: currentUserId, ledger_id: currentLedgerId, year_month: yearMonth, amount, updated_at: new Date().toISOString() },
      { onConflict: 'ledger_id,year_month' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function sbGetAllLedgers() {
  const { data, error } = await supabaseClient.from('ledgers').select('*').order('created_at');
  if (error) throw error;
  return data;
}

async function sbGetLedgerShares() {
  const { data, error } = await supabaseClient.from('ledger_shares').select('*').eq('owner_user_id', currentUserId);
  if (error) throw error;
  return data;
}

async function sbInsertLedgerShare(ledgerId, viewerEmail) {
  const { data, error } = await supabaseClient
    .from('ledger_shares')
    .insert({ ledger_id: ledgerId, owner_user_id: currentUserId, viewer_email: viewerEmail })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* 離線時新增的交易先進本機佇列，恢復連線後再補上傳 */
async function flushPendingQueue() {
  const pending = await idbGetAll('pending_transactions');
  for (const p of pending) {
    try {
      await sbInsertTransaction(txToRow(p));
      await idbDelete('pending_transactions', p.clientGeneratedId);
    } catch (err) {
      if (err && err.code === '23505') {
        // 已經同步過(重試造成的重複)，視為成功並清掉佇列
        await idbDelete('pending_transactions', p.clientGeneratedId);
        continue;
      }
      break;
    }
  }
}

/* ---------- 預設資料（分類/商家：每個帳號只建一次，不分帳本） ---------- */
async function seedDefaultsIfEmpty() {
  const catCount = await sbCount('categories');
  if (catCount === 0) {
    const defaults = [
      { name: '餐飲', type: 'expense' },
      { name: '交通', type: 'expense' },
      { name: '日用品', type: 'expense' },
      { name: '娛樂', type: 'expense' },
      { name: '薪水', type: 'income' },
      { name: '獎金', type: 'income' },
      { name: '投資收益', type: 'income' }
    ];
    for (const c of defaults) await sbInsert('categories', c);
  }

  const merchantCount = await sbCount('merchants');
  if (merchantCount === 0) {
    const defaults = ['全聯', '星巴克', '萬家福', '樂家康'];
    for (const name of defaults) await sbInsert('merchants', { name });
  }
}

/* 帳戶：每本帳本各自的預設資料，新帳本第一次使用時建立 */
async function seedAccountsForCurrentLedger() {
  const accCount = await sbCountInLedger('accounts');
  if (accCount === 0) {
    const defaults = [
      { name: '現金', type: 'cash' },
      { name: '銀行帳戶', type: 'bank' },
      { name: '信用卡', type: 'credit_card' }
    ];
    for (const a of defaults) {
      await sbInsert('accounts', { ...a, initial_balance: 0, is_archived: false, ledger_id: currentLedgerId });
    }
  }
}

/* ---------- 帳本(ledgers)：同一帳號可切換多本互相隔離的帳 ---------- */
let currentLedgerId = null;
let allLedgers = [];
let allLedgerShares = [];

function ledgerStorageKey() {
  return 'expensePwa_currentLedger_' + currentUserId;
}

function isReadOnlyLedger() {
  const l = allLedgers.find((x) => x.id === currentLedgerId);
  return !!l && l.user_id !== currentUserId;
}

function applyReadOnlyMode() {
  const readOnly = isReadOnlyLedger();
  document.body.classList.toggle('ledger-readonly', readOnly);
  document.getElementById('ledger-readonly-badge').style.display = readOnly ? 'inline-block' : 'none';
}

async function initLedgers() {
  allLedgers = await sbGetAllLedgers();
  if (!allLedgers.some((l) => l.user_id === currentUserId)) {
    const inserted = await sbInsert('ledgers', { name: '個人帳本', currency: 'TWD', is_archived: false });
    allLedgers.push(inserted);
  }
  try {
    allLedgerShares = await sbGetLedgerShares();
  } catch (err) {
    allLedgerShares = [];
  }
  const saved = localStorage.getItem(ledgerStorageKey());
  const active = allLedgers.filter((l) => !l.is_archived);
  const found = allLedgers.find((l) => l.id === saved && !l.is_archived);
  const ownActive = active.filter((l) => l.user_id === currentUserId);
  currentLedgerId = found ? found.id : (ownActive[0] || active[0] || allLedgers[0]).id;
  localStorage.setItem(ledgerStorageKey(), currentLedgerId);
  applyReadOnlyMode();
}

async function reloadLedgers() {
  allLedgers = await sbGetAllLedgers();
  try {
    allLedgerShares = await sbGetLedgerShares();
  } catch (err) {
    allLedgerShares = [];
  }
  renderLedgerSelect();
  renderLedgerManagement();
  applyReadOnlyMode();
}

function renderLedgerSelect() {
  const sel = document.getElementById('ledger-select');
  const active = allLedgers.filter((l) => !l.is_archived);
  sel.innerHTML = active.map((l) => `<option value="${l.id}">${l.name}${l.user_id === currentUserId ? '' : '（分享・唯讀）'}</option>`).join('');
  sel.value = currentLedgerId;
}

async function switchLedger(ledgerId) {
  currentLedgerId = ledgerId;
  localStorage.setItem(ledgerStorageKey(), currentLedgerId);
  applyReadOnlyMode();
  if (!isReadOnlyLedger()) {
    await seedAccountsForCurrentLedger();
  }
  await refreshAll();
  renderLedgerSelect();
}

document.getElementById('ledger-select').addEventListener('change', (e) => {
  switchLedger(e.target.value);
});

document.getElementById('ledger-add-btn').addEventListener('click', async () => {
  const name = prompt('新帳本名稱（例如：家庭共同基金）');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const inserted = await sbInsert('ledgers', { name: trimmed, currency: 'TWD', is_archived: false });
  allLedgers.push(inserted);
  await switchLedger(inserted.id);
  renderLedgerManagement();
});

function renderLedgerManagement() {
  const list = document.getElementById('ledger-list');
  list.innerHTML = '';

  allLedgers.forEach((l) => {
    const owned = l.user_id === currentUserId;
    const row = document.createElement('div');
    row.className = 'account-row' + (l.is_archived ? ' archived' : '');

    const info = document.createElement('div');
    info.className = 'account-info';
    const name = document.createElement('p');
    name.className = 'account-name';
    name.textContent = l.name + (l.is_archived ? '（已封存）' : '') + (l.id === currentLedgerId ? '（使用中）' : '') + (owned ? '' : '（分享給你・唯讀）');
    info.appendChild(name);
    row.appendChild(info);

    if (owned) {
      const actions = document.createElement('div');
      actions.className = 'cat-actions';

      const editBtn = document.createElement('button');
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', async () => {
        const newName = prompt('修改帳本名稱', l.name);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed) return;
        await sbUpdate('ledgers', l.id, { name: trimmed });
        await reloadLedgers();
      });
      actions.appendChild(editBtn);

      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = l.is_archived ? '啟用' : '封存';
      toggleBtn.addEventListener('click', async () => {
        const willArchive = !l.is_archived;
        const activeCount = allLedgers.filter((x) => !x.is_archived && x.user_id === currentUserId).length;
        if (willArchive && activeCount <= 1) {
          alert('至少要保留一本啟用中的帳本');
          return;
        }
        await sbUpdate('ledgers', l.id, { is_archived: willArchive });
        if (willArchive && l.id === currentLedgerId) {
          allLedgers = await sbGetAllLedgers();
          const nextActive = allLedgers.find((x) => !x.is_archived && x.user_id === currentUserId);
          await switchLedger(nextActive.id);
        }
        await reloadLedgers();
      });
      actions.appendChild(toggleBtn);

      row.appendChild(actions);
      row.appendChild(buildLedgerShareBox(l));
    }

    list.appendChild(row);
  });
}

function buildLedgerShareBox(l) {
  const box = document.createElement('div');
  box.className = 'ledger-share-box';

  const title = document.createElement('p');
  title.className = 'ledger-share-title';
  title.textContent = '分享給（唯讀）';
  box.appendChild(title);

  const shares = allLedgerShares.filter((s) => s.ledger_id === l.id);
  if (!shares.length) {
    const empty = document.createElement('p');
    empty.className = 'ledger-share-empty';
    empty.textContent = '尚未分享給任何人';
    box.appendChild(empty);
  } else {
    shares.forEach((s) => {
      const shareRow = document.createElement('div');
      shareRow.className = 'ledger-share-row';
      const email = document.createElement('span');
      email.textContent = s.viewer_email;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '移除';
      removeBtn.addEventListener('click', async () => {
        await sbDeleteHard('ledger_shares', s.id);
        allLedgerShares = await sbGetLedgerShares();
        renderLedgerManagement();
      });
      shareRow.appendChild(email);
      shareRow.appendChild(removeBtn);
      box.appendChild(shareRow);
    });
  }

  const inviteRow = document.createElement('div');
  inviteRow.className = 'inline-row';
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = '輸入對方email邀請（對方要已經有帳號）';
  const inviteBtn = document.createElement('button');
  inviteBtn.type = 'button';
  inviteBtn.className = 'ghost-btn';
  inviteBtn.textContent = '邀請';
  inviteBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) return;
    try {
      await sbInsertLedgerShare(l.id, email);
      emailInput.value = '';
      allLedgerShares = await sbGetLedgerShares();
      renderLedgerManagement();
    } catch (err) {
      alert('邀請失敗：' + ((err && err.message) || String(err)));
    }
  });
  inviteRow.appendChild(emailInput);
  inviteRow.appendChild(inviteBtn);
  box.appendChild(inviteRow);

  return box;
}

/* ---------- 全域狀態 ---------- */
let allCategories = [];
let allAccounts = [];
let allTransactions = [];
let allMerchants = [];
let allBudgets = [];
let allRecurringRules = [];
let currentTxType = 'expense';
let calcExpr = '0';

/* ---------- 分頁切換 ---------- */
function switchTab(tab) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-' + tab).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  if (tab === 'add') {
    document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  }
  if (tab === 'trips') {
    loadTrips();
  }
}

document.querySelectorAll('.nav-btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'add' && editingTransactionId) {
      cancelEditTransaction();
    }
    switchTab(btn.dataset.tab);
  });
});

/* ---------- 財富管家 / 記帳 雙模式切換 ---------- */
function switchMode(mode) {
  document.getElementById('ledger-shell').style.display = mode === 'ledger' ? '' : 'none';
  document.getElementById('wealth-shell').style.display = mode === 'wealth' ? '' : 'none';
  if (mode === 'wealth') {
    document.getElementById('wealth-date').textContent = new Date().toLocaleDateString('zh-Hant-TW', { year: 'numeric', month: 'long', day: 'numeric' });
    loadWealthData();
  }
}

document.getElementById('goto-wealth-btn').addEventListener('click', () => switchMode('wealth'));
document.getElementById('goto-ledger-btn').addEventListener('click', () => switchMode('ledger'));

function switchWealthTab(tab) {
  document.querySelectorAll('.w-screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-wealth-' + tab).classList.add('active');
  document.querySelectorAll('.w-nav-btn[data-wtab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.wtab === tab);
  });
}

document.querySelectorAll('.w-nav-btn[data-wtab]').forEach((btn) => {
  btn.addEventListener('click', () => switchWealthTab(btn.dataset.wtab));
});

let allAssets = [];
let allAssetSnapshots = [];
let allLiabilities = [];
let allLiabilitySnapshots = [];
let allWealthAccounts = [];
let allWealthTransactions = [];
const WEALTH_ASSET_CATEGORY_LABELS = { investment: '投資', real_estate: '不動產', precious_metal: '貴金屬', crypto: '加密貨幣', insurance: '保單', other: '其他' };
const WEALTH_LIABILITY_TYPE_LABELS = { mortgage: '房貸', car_loan: '車貸', credit_card: '信用卡', student_loan: '學貸', other: '其他' };
const WEALTH_DONUT_COLORS = { cash: '#6E7C94', investment: '#C9A25D', real_estate: '#8DA37E', precious_metal: '#D6C08A', crypto: '#7C6BAF', insurance: '#B5715A', other: '#5B6478' };

document.getElementById('w-asset-date').value = todayDateStr();
document.getElementById('w-liability-date').value = todayDateStr();

let exchangeRates = null; // { USD: 32.04, CNY: 4.72, EUR: 36.6, JPY: 0.198 } → 台幣/單位
let exchangeRatesFetchedAt = 0;

async function ensureExchangeRates() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (exchangeRates && (Date.now() - exchangeRatesFetchedAt) < ONE_HOUR) return;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data.result === 'success' && data.rates && data.rates.TWD) {
      const twdPerUsd = data.rates.TWD;
      const rates = {};
      ['USD', 'EUR', 'CNY', 'JPY'].forEach((cur) => {
        if (data.rates[cur]) rates[cur] = twdPerUsd / data.rates[cur];
      });
      exchangeRates = rates;
      exchangeRatesFetchedAt = Date.now();
    }
  } catch (err) {
    // 抓不到匯率就沿用舊資料（若有），renderWealthOverview 遇到抓不到的幣別會自動跳過
  }
}

function convertToTWD(amount, currency) {
  const cur = currency || 'TWD';
  if (cur === 'TWD') return amount;
  if (exchangeRates && exchangeRates[cur]) return amount * exchangeRates[cur];
  return null;
}

async function loadWealthData() {
  await ensureExchangeRates();
  try {
    allAssets = await sbGetAll('assets');
    allAssetSnapshots = await sbGetAll('asset_snapshots');
    allLiabilities = await sbGetAll('liabilities');
    allLiabilitySnapshots = await sbGetAll('liability_snapshots');
  } catch (err) {
    allAssets = [];
    allAssetSnapshots = [];
    allLiabilities = [];
    allLiabilitySnapshots = [];
  }
  try {
    allWealthAccounts = await sbGetAll('accounts');
    allWealthTransactions = await sbGetAllTransactionsAllLedgers();
  } catch (err) {
    allWealthAccounts = [];
    allWealthTransactions = [];
  }
  renderWealthAssetsScreen();
  renderWealthLiabilitiesScreen();
  renderWealthOverview();
  renderWealthTrendChart();
}

function computeWealthAccountBalance(accountId, initialBalance, txList) {
  let total = initialBalance || 0;
  (txList || allWealthTransactions).forEach((t) => {
    if (t.type === 'transfer') {
      if (t.accountId === accountId) total -= t.amount;
      if (t.transferToAccountId === accountId) total += (t.transferToAmount || t.amount);
    } else if (t.accountId === accountId) {
      total += (t.type === 'income' ? t.amount : -t.amount);
    }
  });
  return total;
}

function renderWealthOverview() {
  const archivedLedgerIds = new Set(allLedgers.filter((l) => l.is_archived).map((l) => l.id));
  const activeAccounts = allWealthAccounts.filter((a) => !a.is_archived && !archivedLedgerIds.has(a.ledger_id));
  let fxUnavailable = false;
  const twdCash = activeAccounts.reduce((sum, a) => {
    const balance = computeWealthAccountBalance(a.id, a.initial_balance);
    const converted = convertToTWD(balance, a.currency);
    if (converted === null) { fxUnavailable = true; return sum; }
    return sum + converted;
  }, 0);

  const activeAssets = allAssets.filter((a) => !a.is_archived);
  const assetTotalsByCategory = {};
  Object.keys(WEALTH_ASSET_CATEGORY_LABELS).forEach((k) => { assetTotalsByCategory[k] = 0; });
  activeAssets.forEach((a) => {
    const snap = latestSnapshot(allAssetSnapshots, 'asset_id', a.id);
    const rawValue = snap ? Number(snap.value) : 0;
    const converted = convertToTWD(rawValue, a.currency);
    if (converted === null) { fxUnavailable = true; return; }
    assetTotalsByCategory[a.category] = (assetTotalsByCategory[a.category] || 0) + converted;
  });

  const activeLiabilities = allLiabilities.filter((l) => !l.is_archived);
  const totalLiabilities = activeLiabilities.reduce((sum, l) => {
    const snap = latestSnapshot(allLiabilitySnapshots, 'liability_id', l.id);
    return sum + (snap ? Number(snap.remaining_balance) : 0);
  }, 0);

  const totalAssets = twdCash + Object.values(assetTotalsByCategory).reduce((s, v) => s + v, 0);
  const netWorth = totalAssets - totalLiabilities;
  const debtRatio = totalAssets > 0 ? (totalLiabilities / totalAssets) * 100 : 0;

  const fxHint = document.getElementById('w-fx-hint');
  if (fxUnavailable) {
    fxHint.textContent = '部分外幣目前抓不到即時匯率，暫時沒有計入淨資產（稍後會自動重試）';
    fxHint.style.display = 'block';
  } else {
    fxHint.style.display = 'none';
  }

  document.getElementById('w-net-worth').textContent = fmtMoney(netWorth);
  document.getElementById('w-total-assets').textContent = fmtMoney(totalAssets);
  document.getElementById('w-total-liabilities').textContent = fmtMoney(totalLiabilities);
  document.getElementById('w-debt-ratio').textContent = debtRatio.toFixed(1) + '%';

  const donutEntries = [
    { key: 'cash', name: '現金', value: twdCash },
    ...Object.keys(WEALTH_ASSET_CATEGORY_LABELS).map((k) => ({ key: k, name: WEALTH_ASSET_CATEGORY_LABELS[k], value: assetTotalsByCategory[k] }))
  ].filter((e) => e.value > 0);
  renderWealthDonut(donutEntries, totalAssets);

  renderWealthAccountList(activeAccounts);
  renderWealthOverviewAssetList(activeAssets);
  renderWealthOverviewLiabilityList(activeLiabilities);
  renderWealthForeignCurrencySummary(activeAccounts, activeAssets);
}

function renderWealthForeignCurrencySummary(activeAccounts, activeAssets) {
  const container = document.getElementById('w-fx-summary-list');
  if (!container) return;
  container.innerHTML = '';

  const totals = {};
  activeAccounts.forEach((a) => {
    const cur = a.currency || 'TWD';
    if (cur === 'TWD') return;
    totals[cur] = (totals[cur] || 0) + computeWealthAccountBalance(a.id, a.initial_balance);
  });
  activeAssets.forEach((a) => {
    const cur = a.currency || 'TWD';
    if (cur === 'TWD') return;
    const snap = latestSnapshot(allAssetSnapshots, 'asset_id', a.id);
    totals[cur] = (totals[cur] || 0) + (snap ? Number(snap.value) : 0);
  });

  const entries = Object.entries(totals).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '目前沒有外幣部位';
    container.appendChild(hint);
    return;
  }

  entries.forEach(([cur, total]) => {
    const row = document.createElement('div');
    row.className = 'w-legend-item';
    const label = document.createElement('span');
    label.className = 'w-legend-label';
    label.textContent = cur;
    const value = document.createElement('span');
    value.className = 'w-legend-value';
    value.textContent = fmtMoney(total, cur);
    row.appendChild(label);
    row.appendChild(value);
    container.appendChild(row);
  });
}

function renderWealthDonut(entries, total) {
  const donut = document.getElementById('w-donut');
  const legend = document.getElementById('w-legend');
  legend.innerHTML = '';

  if (!total || !entries.length) {
    donut.style.background = 'var(--w-hair)';
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '尚無台幣資產資料';
    legend.appendChild(hint);
    return;
  }

  let cumulative = 0;
  const stops = entries.map((e) => {
    const start = cumulative;
    cumulative += (e.value / total) * 360;
    return `${WEALTH_DONUT_COLORS[e.key]} ${start}deg ${cumulative}deg`;
  });
  donut.style.background = `conic-gradient(${stops.join(', ')})`;

  entries.forEach((e) => {
    const item = document.createElement('div');
    item.className = 'w-legend-item';

    const label = document.createElement('span');
    label.className = 'w-legend-label';
    const dot = document.createElement('span');
    dot.className = 'w-dot';
    dot.style.background = WEALTH_DONUT_COLORS[e.key];
    label.appendChild(dot);
    label.appendChild(document.createTextNode(e.name));

    const value = document.createElement('span');
    value.className = 'w-legend-value';
    const pct = Math.round((e.value / total) * 100);
    value.textContent = `${pct}% · ${fmtMoney(e.value)}`;

    item.appendChild(label);
    item.appendChild(value);
    legend.appendChild(item);
  });
}

function renderWealthAccountList(activeAccounts) {
  const container = document.getElementById('w-account-list');
  container.innerHTML = '';
  if (!activeAccounts.length) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '記帳系統裡還沒有帳戶';
    container.appendChild(hint);
    return;
  }
  const ledgerNameMap = {};
  allLedgers.forEach((l) => { ledgerNameMap[l.id] = l.name; });

  const withBalance = activeAccounts.map((a) => ({ a, balance: computeWealthAccountBalance(a.id, a.initial_balance) }));
  withBalance.sort((x, y) => (x.balance === 0) - (y.balance === 0));

  withBalance.forEach(({ a, balance }) => {
    const row = document.createElement('div');
    row.className = 'w-item-row';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'w-item-name';
    name.textContent = a.name;
    const meta = document.createElement('div');
    meta.className = 'w-item-meta';
    meta.textContent = (ledgerNameMap[a.ledger_id] || '') + ' · ' + (accountTypeLabels[a.type] || a.type);
    info.appendChild(name);
    info.appendChild(meta);

    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value' + (balance < 0 ? ' w-negative' : '');
    valueEl.textContent = fmtMoney(balance, a.currency);

    row.appendChild(info);
    row.appendChild(valueEl);
    container.appendChild(row);
  });
}

/* 依所有資產/負債快照出現過的日期，逐日重建當時的淨資產(現金用交易日期回推、
   資產/負債用當時最新的快照)，不需要額外的每日快照表 */
function buildWealthTrendSeries() {
  const dateSet = new Set();
  allAssetSnapshots.forEach((s) => dateSet.add(s.snapshot_date));
  allLiabilitySnapshots.forEach((s) => dateSet.add(s.snapshot_date));
  const dates = Array.from(dateSet).sort();
  if (!dates.length) return [];

  const archivedLedgerIds = new Set(allLedgers.filter((l) => l.is_archived).map((l) => l.id));
  const activeAssets = allAssets.filter((a) => !a.is_archived);
  const activeLiabilities = allLiabilities.filter((l) => !l.is_archived);
  const activeAccounts = allWealthAccounts.filter((a) => !a.is_archived && !archivedLedgerIds.has(a.ledger_id));

  return dates.map((date) => {
    const assetsTotal = activeAssets.reduce((sum, a) => {
      const snap = latestSnapshot(allAssetSnapshots.filter((s) => s.snapshot_date <= date), 'asset_id', a.id);
      const converted = snap ? convertToTWD(Number(snap.value), a.currency) : 0;
      return sum + (converted || 0);
    }, 0);
    const liabilitiesTotal = activeLiabilities.reduce((sum, l) => {
      const snap = latestSnapshot(allLiabilitySnapshots.filter((s) => s.snapshot_date <= date), 'liability_id', l.id);
      return sum + (snap ? Number(snap.remaining_balance) : 0);
    }, 0);
    const txUpToDate = allWealthTransactions.filter((t) => t.date <= date);
    const cashTotal = activeAccounts.reduce((sum, a) => {
      const balance = computeWealthAccountBalance(a.id, a.initial_balance, txUpToDate);
      const converted = convertToTWD(balance, a.currency);
      return sum + (converted || 0);
    }, 0);
    return { date, netWorth: cashTotal + assetsTotal - liabilitiesTotal };
  });
}

function renderWealthTrendChart() {
  const container = document.getElementById('w-trend-chart');
  container.innerHTML = '';
  const series = buildWealthTrendSeries();

  if (series.length < 2) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '至少要有兩個不同日期的資產/負債快照才能畫趨勢圖';
    container.appendChild(hint);
    return;
  }

  const width = 700, height = 220, padding = 10;
  const values = series.map((s) => s.netWorth);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const points = series.map((s, i) => {
    const x = (i / (series.length - 1)) * (width - padding * 2) + padding;
    const y = height - padding - ((s.netWorth - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = '100%';
  svg.style.display = 'block';

  const defs = document.createElementNS(svgNS, 'defs');
  const grad = document.createElementNS(svgNS, 'linearGradient');
  grad.setAttribute('id', 'w-trend-grad');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS(svgNS, 'stop');
  stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#C9A25D'); stop1.setAttribute('stop-opacity', '0.35');
  const stop2 = document.createElementNS(svgNS, 'stop');
  stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', '#C9A25D'); stop2.setAttribute('stop-opacity', '0');
  grad.appendChild(stop1); grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const fillPoly = document.createElementNS(svgNS, 'polyline');
  fillPoly.setAttribute('points', `${padding},${height - padding} ${points.join(' ')} ${width - padding},${height - padding}`);
  fillPoly.setAttribute('fill', 'url(#w-trend-grad)');
  fillPoly.setAttribute('stroke', 'none');
  svg.appendChild(fillPoly);

  const linePoly = document.createElementNS(svgNS, 'polyline');
  linePoly.setAttribute('points', points.join(' '));
  linePoly.setAttribute('fill', 'none');
  linePoly.setAttribute('stroke', '#C9A25D');
  linePoly.setAttribute('stroke-width', '2.5');
  linePoly.setAttribute('stroke-linecap', 'round');
  linePoly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(linePoly);

  container.appendChild(svg);

  const labels = document.createElement('div');
  labels.className = 'w-trend-labels';
  const firstLabel = document.createElement('span');
  firstLabel.textContent = series[0].date;
  const lastLabel = document.createElement('span');
  lastLabel.textContent = series[series.length - 1].date + '　' + fmtMoney(series[series.length - 1].netWorth);
  labels.appendChild(firstLabel);
  labels.appendChild(lastLabel);
  container.appendChild(labels);
}

/* 有輸入股數+每股成本的投資類資產，算出目前市值跟成本的損益(金額+百分比) */
function buildWealthAssetPnlSub(a, snap) {
  if (!a.shares || !a.cost_per_share || !snap) return null;
  const marketValue = Number(snap.value);
  const costTotal = a.shares * a.cost_per_share;
  if (costTotal <= 0) return null;
  const pnl = marketValue - costTotal;
  const pnlPct = (pnl / costTotal) * 100;
  const sub = document.createElement('div');
  sub.className = 'w-item-sub' + (pnl < 0 ? ' w-negative' : '');
  const sign = pnl >= 0 ? '+' : '';
  sub.textContent = `${a.shares}股 · 損益 ${sign}${fmtMoney(pnl, a.currency)} (${sign}${pnlPct.toFixed(1)}%)`;
  return sub;
}

function renderWealthOverviewAssetList(activeAssets) {
  const container = document.getElementById('w-asset-list');
  container.innerHTML = '';
  if (!activeAssets.length) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '還沒有資產紀錄';
    container.appendChild(hint);
    return;
  }
  activeAssets.forEach((a) => {
    const snap = latestSnapshot(allAssetSnapshots, 'asset_id', a.id);
    const row = document.createElement('div');
    row.className = 'w-item-row';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'w-item-name';
    name.textContent = a.name;
    const meta = document.createElement('div');
    meta.className = 'w-item-meta';
    meta.textContent = (WEALTH_ASSET_CATEGORY_LABELS[a.category] || a.category) + (snap ? ' · 上次更新 ' + snap.snapshot_date : '');
    info.appendChild(name);
    info.appendChild(meta);

    const valueWrap = document.createElement('div');
    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value';
    valueEl.textContent = fmtMoney(snap ? Number(snap.value) : 0, a.currency);
    valueWrap.appendChild(valueEl);
    const pnlSub = buildWealthAssetPnlSub(a, snap);
    if (pnlSub) valueWrap.appendChild(pnlSub);

    row.appendChild(info);
    row.appendChild(valueWrap);
    container.appendChild(row);
  });
}

function renderWealthOverviewLiabilityList(activeLiabilities) {
  const container = document.getElementById('w-liability-list');
  container.innerHTML = '';
  if (!activeLiabilities.length) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '還沒有負債紀錄';
    container.appendChild(hint);
    return;
  }
  activeLiabilities.forEach((l) => {
    const snap = latestSnapshot(allLiabilitySnapshots, 'liability_id', l.id);
    const row = document.createElement('div');
    row.className = 'w-item-row';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'w-item-name';
    name.textContent = l.name;
    const meta = document.createElement('div');
    meta.className = 'w-item-meta';
    meta.textContent = (WEALTH_LIABILITY_TYPE_LABELS[l.type] || l.type) + (snap ? ' · 上次更新 ' + snap.snapshot_date : '');
    info.appendChild(name);
    info.appendChild(meta);
    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value w-negative';
    valueEl.textContent = fmtMoney(snap ? Number(snap.remaining_balance) : 0);
    row.appendChild(info);
    row.appendChild(valueEl);
    container.appendChild(row);
  });
}

function latestSnapshot(snapshots, ownerKey, ownerId) {
  const matches = snapshots.filter((s) => s[ownerKey] === ownerId);
  if (!matches.length) return null;
  return matches.reduce((latest, s) => (s.snapshot_date > latest.snapshot_date ? s : latest), matches[0]);
}

/* ---------- 資產 ---------- */
let editingAssetId = null;

function renderWealthAssetsScreen() {
  const container = document.getElementById('w-assets-full-list');
  container.innerHTML = '';
  const active = allAssets.filter((a) => !a.is_archived);
  if (!active.length) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '還沒有資產紀錄';
    container.appendChild(hint);
    return;
  }
  active.forEach((a) => {
    const snap = latestSnapshot(allAssetSnapshots, 'asset_id', a.id);
    const row = document.createElement('div');
    row.className = 'w-item-row';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'w-item-name';
    name.textContent = a.name;
    const meta = document.createElement('div');
    meta.className = 'w-item-meta';
    meta.textContent = (WEALTH_ASSET_CATEGORY_LABELS[a.category] || a.category) + (snap ? ' · 上次更新 ' + snap.snapshot_date : ' · 尚未輸入價值');
    info.appendChild(name);
    info.appendChild(meta);

    const valueWrap = document.createElement('div');
    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value';
    valueEl.textContent = fmtMoney(snap ? Number(snap.value) : 0, a.currency);
    valueWrap.appendChild(valueEl);
    const pnlSub = buildWealthAssetPnlSub(a, snap);
    if (pnlSub) valueWrap.appendChild(pnlSub);

    const actions = document.createElement('div');
    actions.className = 'w-item-actions';
    const editBtn = document.createElement('button');
    editBtn.textContent = '編輯';
    editBtn.addEventListener('click', () => startEditWealthAsset(a));
    const archiveBtn = document.createElement('button');
    archiveBtn.textContent = '停用';
    archiveBtn.addEventListener('click', async () => {
      await sbUpdate('assets', a.id, { is_archived: true });
      await loadWealthData();
    });
    actions.appendChild(editBtn);
    actions.appendChild(archiveBtn);

    row.appendChild(info);
    row.appendChild(valueWrap);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

const WEALTH_MARKET_CURRENCY = { tw: 'TWD', us: 'USD', cn: 'CNY' };
const WEALTH_MARKET_LABELS = { tw: '台股', us: '美股', cn: '陸股' };

function updateWealthAssetCategoryFields() {
  const isInvestment = document.getElementById('w-asset-category').value === 'investment';
  document.getElementById('w-asset-stock-fields').style.display = isInvestment ? 'block' : 'none';
  if (isInvestment) {
    document.getElementById('w-asset-currency').value = WEALTH_MARKET_CURRENCY[document.getElementById('w-asset-market').value];
  }
}

document.getElementById('w-asset-category').addEventListener('change', updateWealthAssetCategoryFields);
document.getElementById('w-asset-market').addEventListener('change', updateWealthAssetCategoryFields);
updateWealthAssetCategoryFields();

document.getElementById('w-asset-fetch-price-btn').addEventListener('click', async () => {
  const market = document.getElementById('w-asset-market').value;
  const symbol = document.getElementById('w-asset-symbol').value.trim();
  const shares = parseFloat(document.getElementById('w-asset-shares').value);
  const statusEl = document.getElementById('w-asset-fetch-status');

  if (market === 'cn') {
    statusEl.textContent = '陸股目前不支援自動抓取，請手動輸入目前價值';
    return;
  }
  if (!symbol) {
    statusEl.textContent = '請先輸入股票代碼';
    return;
  }
  statusEl.textContent = '查詢中...';
  try {
    const { data, error } = await supabaseClient.functions.invoke('get-stock-price', { body: { market, symbol } });
    if (error) throw error;
    if (data.error) {
      statusEl.textContent = data.error;
      return;
    }
    statusEl.textContent = `${WEALTH_MARKET_LABELS[market]} ${symbol} 最新價格：${fmtMoney(data.price, data.currency)}`;
    if (shares > 0) {
      document.getElementById('w-asset-value').value = Math.round(shares * data.price * 100) / 100;
    }
    document.getElementById('w-asset-currency').value = data.currency;
  } catch (err) {
    statusEl.textContent = '查詢失敗：' + ((err && err.message) || String(err));
  }
});

document.getElementById('w-refresh-stocks-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('w-refresh-stocks-status');
  const btn = document.getElementById('w-refresh-stocks-btn');
  const targets = allAssets.filter((a) => !a.is_archived && a.category === 'investment' && a.stock_symbol && a.market && a.market !== 'cn' && a.shares > 0);

  if (!targets.length) {
    statusEl.textContent = '沒有可以自動更新的股票資產（需要有代碼跟股數）';
    return;
  }

  btn.disabled = true;
  let okCount = 0;
  let failCount = 0;
  const today = todayDateStr();

  for (const a of targets) {
    statusEl.textContent = `更新中... (${okCount + failCount + 1}/${targets.length}) ${a.name}`;
    try {
      const { data, error } = await supabaseClient.functions.invoke('get-stock-price', { body: { market: a.market, symbol: a.stock_symbol } });
      if (error || data.error) throw new Error((data && data.error) || (error && error.message));
      const value = Math.round(a.shares * data.price * 100) / 100;
      try {
        await sbInsert('asset_snapshots', { asset_id: a.id, value, snapshot_date: today });
      } catch (err) {
        if (err.code === '23505') {
          const existing = allAssetSnapshots.find((s) => s.asset_id === a.id && s.snapshot_date === today);
          if (existing) await sbUpdate('asset_snapshots', existing.id, { value });
        } else {
          throw err;
        }
      }
      okCount += 1;
    } catch (err) {
      failCount += 1;
    }
  }

  statusEl.textContent = `已更新 ${okCount} 檔股票` + (failCount ? `，${failCount} 檔查詢失敗` : '');
  btn.disabled = false;
  await loadWealthData();
});

function startEditWealthAsset(a) {
  editingAssetId = a.id;
  document.getElementById('w-asset-name').value = a.name;
  document.getElementById('w-asset-category').value = a.category;
  document.getElementById('w-asset-currency').value = a.currency;
  document.getElementById('w-asset-market').value = a.market || 'tw';
  document.getElementById('w-asset-symbol').value = a.stock_symbol || '';
  document.getElementById('w-asset-shares').value = a.shares || '';
  document.getElementById('w-asset-cost').value = a.cost_per_share || '';
  document.getElementById('w-asset-fetch-status').textContent = '';
  updateWealthAssetCategoryFields();
  const snap = latestSnapshot(allAssetSnapshots, 'asset_id', a.id);
  document.getElementById('w-asset-value').value = snap ? snap.value : '';
  document.getElementById('w-asset-date').value = todayDateStr();
  document.getElementById('w-asset-form-submit').textContent = '更新資產';
  document.getElementById('w-asset-form-cancel').style.display = 'block';
}

function cancelWealthAssetEdit() {
  editingAssetId = null;
  document.getElementById('w-asset-form').reset();
  document.getElementById('w-asset-date').value = todayDateStr();
  document.getElementById('w-asset-fetch-status').textContent = '';
  document.getElementById('w-asset-form-submit').textContent = '新增資產';
  document.getElementById('w-asset-form-cancel').style.display = 'none';
  updateWealthAssetCategoryFields();
}

document.getElementById('w-asset-form-cancel').addEventListener('click', cancelWealthAssetEdit);

document.getElementById('w-asset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('w-asset-name').value.trim();
  const category = document.getElementById('w-asset-category').value;
  const currency = document.getElementById('w-asset-currency').value;
  const value = parseFloat(document.getElementById('w-asset-value').value);
  const date = document.getElementById('w-asset-date').value;
  if (!name || !value || value <= 0 || !date) return;

  const isInvestment = category === 'investment';
  const sharesVal = parseFloat(document.getElementById('w-asset-shares').value);
  const costVal = parseFloat(document.getElementById('w-asset-cost').value);
  const assetFields = {
    name,
    category,
    currency,
    market: isInvestment ? document.getElementById('w-asset-market').value : null,
    stock_symbol: isInvestment ? (document.getElementById('w-asset-symbol').value.trim() || null) : null,
    shares: isInvestment && sharesVal > 0 ? sharesVal : null,
    cost_per_share: isInvestment && costVal > 0 ? costVal : null
  };

  let assetId = editingAssetId;
  if (assetId) {
    await sbUpdate('assets', assetId, assetFields);
  } else {
    const inserted = await sbInsert('assets', { ...assetFields, is_archived: false });
    assetId = inserted.id;
  }

  try {
    await sbInsert('asset_snapshots', { asset_id: assetId, value, snapshot_date: date });
  } catch (err) {
    if (err.code === '23505') {
      const existing = allAssetSnapshots.find((s) => s.asset_id === assetId && s.snapshot_date === date);
      if (existing) await sbUpdate('asset_snapshots', existing.id, { value });
    } else {
      throw err;
    }
  }

  cancelWealthAssetEdit();
  await loadWealthData();
});

/* ---------- 負債 ---------- */
let editingLiabilityId = null;

function renderWealthLiabilitiesScreen() {
  const container = document.getElementById('w-liabilities-full-list');
  container.innerHTML = '';
  const active = allLiabilities.filter((l) => !l.is_archived);
  if (!active.length) {
    const hint = document.createElement('p');
    hint.className = 'w-empty-hint';
    hint.textContent = '還沒有負債紀錄';
    container.appendChild(hint);
    return;
  }
  active.forEach((l) => {
    const snap = latestSnapshot(allLiabilitySnapshots, 'liability_id', l.id);
    const row = document.createElement('div');
    row.className = 'w-item-row';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'w-item-name';
    name.textContent = l.name;
    const meta = document.createElement('div');
    const metaParts = [WEALTH_LIABILITY_TYPE_LABELS[l.type] || l.type];
    if (l.interest_rate) metaParts.push('利率 ' + l.interest_rate + '%');
    if (l.monthly_payment) metaParts.push('每月 ' + fmtMoney(l.monthly_payment));
    meta.className = 'w-item-meta';
    meta.textContent = metaParts.join(' · ');
    info.appendChild(name);
    info.appendChild(meta);

    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value w-negative';
    valueEl.textContent = fmtMoney(snap ? Number(snap.remaining_balance) : 0);

    const actions = document.createElement('div');
    actions.className = 'w-item-actions';
    const editBtn = document.createElement('button');
    editBtn.textContent = '編輯';
    editBtn.addEventListener('click', () => startEditWealthLiability(l));
    const archiveBtn = document.createElement('button');
    archiveBtn.textContent = '停用';
    archiveBtn.addEventListener('click', async () => {
      await sbUpdate('liabilities', l.id, { is_archived: true });
      await loadWealthData();
    });
    actions.appendChild(editBtn);
    actions.appendChild(archiveBtn);

    row.appendChild(info);
    row.appendChild(valueEl);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function startEditWealthLiability(l) {
  editingLiabilityId = l.id;
  document.getElementById('w-liability-name').value = l.name;
  document.getElementById('w-liability-type').value = l.type;
  document.getElementById('w-liability-rate').value = l.interest_rate || '';
  document.getElementById('w-liability-payment').value = l.monthly_payment || '';
  const snap = latestSnapshot(allLiabilitySnapshots, 'liability_id', l.id);
  document.getElementById('w-liability-balance').value = snap ? snap.remaining_balance : '';
  document.getElementById('w-liability-date').value = todayDateStr();
  document.getElementById('w-liability-form-submit').textContent = '更新負債';
  document.getElementById('w-liability-form-cancel').style.display = 'block';
}

function cancelWealthLiabilityEdit() {
  editingLiabilityId = null;
  document.getElementById('w-liability-form').reset();
  document.getElementById('w-liability-date').value = todayDateStr();
  document.getElementById('w-liability-form-submit').textContent = '新增負債';
  document.getElementById('w-liability-form-cancel').style.display = 'none';
}

document.getElementById('w-liability-form-cancel').addEventListener('click', cancelWealthLiabilityEdit);

document.getElementById('w-liability-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('w-liability-name').value.trim();
  const type = document.getElementById('w-liability-type').value;
  const rateVal = document.getElementById('w-liability-rate').value;
  const paymentVal = document.getElementById('w-liability-payment').value;
  const balance = parseFloat(document.getElementById('w-liability-balance').value);
  const date = document.getElementById('w-liability-date').value;
  if (!name || !balance || balance <= 0 || !date) return;

  const fields = {
    name,
    type,
    interest_rate: rateVal ? parseFloat(rateVal) : null,
    monthly_payment: paymentVal ? parseFloat(paymentVal) : null
  };

  let liabilityId = editingLiabilityId;
  if (liabilityId) {
    await sbUpdate('liabilities', liabilityId, fields);
  } else {
    const inserted = await sbInsert('liabilities', { ...fields, is_archived: false });
    liabilityId = inserted.id;
  }

  try {
    await sbInsert('liability_snapshots', { liability_id: liabilityId, remaining_balance: balance, snapshot_date: date });
  } catch (err) {
    if (err.code === '23505') {
      const existing = allLiabilitySnapshots.find((s) => s.liability_id === liabilityId && s.snapshot_date === date);
      if (existing) await sbUpdate('liability_snapshots', existing.id, { remaining_balance: balance });
    } else {
      throw err;
    }
  }

  cancelWealthLiabilityEdit();
  await loadWealthData();
});

/* ---------- 金額格式化 ---------- */
const CURRENCY_PREFIX = { TWD: '$', USD: 'US$', EUR: '€', CNY: 'CN¥', JPY: 'JP¥' };

function fmtMoney(n, currency) {
  const cur = currency || 'TWD';
  const prefix = CURRENCY_PREFIX[cur] || (cur + ' ');
  if (cur === 'TWD') {
    return prefix + Math.round(n).toLocaleString('zh-Hant-TW');
  }
  return prefix + n.toLocaleString('zh-Hant-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function accountCurrency(accountId) {
  const acc = allAccounts.find((a) => a.id === accountId);
  return (acc && acc.currency) || 'TWD';
}

/* 總覽是台幣為主的月度總結，外幣帳戶的交易不計入(避免不同幣別金額直接相加造成誤導)，
   外幣交易要看的話請到「帳戶」看餘額或「列表」查交易紀錄 */
function isTwdTransaction(t) {
  if (t.type === 'transfer') {
    return accountCurrency(t.accountId) === 'TWD' && accountCurrency(t.transferToAccountId) === 'TWD';
  }
  return accountCurrency(t.accountId) === 'TWD';
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/* 依「年、月(1-12)、想要的日」算出實際日期字串，日超過當月天數就用當月最後一天 */
function dateForDayOfMonth(year, month, day) {
  const lastDay = new Date(year, month, 0).getDate();
  const clamped = Math.min(day, lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/* 把 'YYYY-MM-DD' 往後推 n 個月，日用同一個day_of_month(超過當月天數會自動夾在月底) */
function addMonthsToYearMonth(yearMonthDateStr, n) {
  const [y, m] = yearMonthDateStr.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/* ---------- 金額計算機 ---------- */
function evalExpr(expr) {
  const trimmed = expr.replace(/[+\-*/.]+$/, '');
  const tokens = trimmed.match(/(\d+\.?\d*)|[+\-*/]/g);
  if (!tokens || !tokens.length) return 0;

  const pass1 = [parseFloat(tokens[0]) || 0];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const num = parseFloat(tokens[i + 1]) || 0;
    if (op === '*' || op === '/') {
      const prev = pass1.pop();
      pass1.push(op === '*' ? prev * num : (num === 0 ? 0 : prev / num));
    } else {
      pass1.push(op, num);
    }
  }

  let result = pass1[0];
  for (let i = 1; i < pass1.length; i += 2) {
    result = pass1[i] === '+' ? result + pass1[i + 1] : result - pass1[i + 1];
  }
  return result;
}

function updateCalcDisplay() {
  const result = evalExpr(calcExpr);
  document.getElementById('tx-amount-display').textContent = String(result);
  document.getElementById('tx-amount').value = result;
  updateExchangePreview();
}

function resetCalc() {
  calcExpr = '0';
  updateCalcDisplay();
}

document.getElementById('tx-form').addEventListener('click', (e) => {
  const btn = e.target.closest('.calc-btn');
  if (!btn) return;
  const key = btn.dataset.key;

  if (key === 'AC') {
    calcExpr = '0';
  } else if (key === 'DEL') {
    calcExpr = calcExpr.length > 1 ? calcExpr.slice(0, -1) : '0';
  } else if (key === '.') {
    const lastNum = calcExpr.split(/[+\-*/]/).pop();
    if (!lastNum.includes('.')) calcExpr += '.';
  } else if (['+', '-', '*', '/'].includes(key)) {
    if (calcExpr === '0') return;
    if (/[+\-*/]$/.test(calcExpr)) {
      calcExpr = calcExpr.slice(0, -1) + key;
    } else {
      calcExpr += key;
    }
  } else {
    calcExpr = calcExpr === '0' ? key : calcExpr + key;
  }

  updateCalcDisplay();
});

/* ---------- 讀取所有資料並重繪畫面 ---------- */
async function refreshAll() {
  await flushPendingQueue();

  allCategories = await sbGetAll('categories');
  allAccounts = await sbGetAllInLedger('accounts');
  allMerchants = await sbGetAll('merchants');
  try {
    allBudgets = await sbGetAllInLedger('budgets');
  } catch (err) {
    allBudgets = [];
  }
  try {
    allRecurringRules = await sbGetAllInLedger('recurring_rules');
  } catch (err) {
    allRecurringRules = [];
  }

  const pending = (await idbGetAll('pending_transactions'))
    .filter((p) => p.ledgerId === currentLedgerId)
    .map((p) => ({
      ...p,
      id: 'pending-' + p.clientGeneratedId,
      pending: true
    }));

  const synced = await sbGetAllTransactions();
  allTransactions = synced.concat(pending);
  allTransactions.sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));

  let generatedMore = false;
  try {
    generatedMore = await ensureRecurringHorizon();
  } catch (err) {
    generatedMore = false;
  }
  if (generatedMore) {
    const syncedAgain = await sbGetAllTransactions();
    allTransactions = syncedAgain.concat(pending);
    allTransactions.sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
  }

  renderOverview();
  renderList();
  renderCategoryScreen();
  renderAccountsScreen();
  renderLedgerManagement();
  renderRecurringList();
  populateFormSelectors();
  renderFilterChips();
}

function categoryName(id) {
  const c = allCategories.find((c) => c.id === id);
  return c ? c.name : '未分類';
}

function accountName(id) {
  const a = allAccounts.find((a) => a.id === id);
  return a ? a.name : '';
}

/* ---------- 帳戶動態餘額計算 ---------- */
function accountBalance(accountId) {
  const acc = allAccounts.find((a) => a.id === accountId);
  let total = (acc && acc.initial_balance) ? acc.initial_balance : 0;
  allTransactions.forEach((t) => {
    if (t.type === 'transfer') {
      if (t.accountId === accountId) total -= t.amount;
      if (t.transferToAccountId === accountId) total += (t.transferToAmount || t.amount);
    } else if (t.accountId === accountId) {
      total += (t.type === 'income' ? t.amount : -t.amount);
    }
  });
  return total;
}

function merchantName(id) {
  if (!id) return '';
  const m = allMerchants.find((m) => m.id === id);
  return m ? m.name : '';
}

/* ---------- 總覽畫面 ---------- */
let overviewYearMonth = new Date().toISOString().slice(0, 7);

function populateMonthNavSelectors() {
  const yearSel = document.getElementById('year-select');
  if (!yearSel.options.length) {
    const maxYear = new Date().getFullYear() + 10;
    for (let y = 2010; y <= maxYear; y++) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = y + '年';
      yearSel.appendChild(opt);
    }
  }
  const monthSel = document.getElementById('month-select');
  if (!monthSel.options.length) {
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = m + '月';
      monthSel.appendChild(opt);
    }
  }
}

let overviewViewMode = 'month';
let overviewTypeFilter = 'expense';

function renderOverview() {
  populateMonthNavSelectors();
  const [y, m] = overviewYearMonth.split('-');
  document.getElementById('year-select').value = String(Number(y));
  document.getElementById('month-select').value = String(Number(m));
  document.getElementById('month-select').style.display = overviewViewMode === 'year' ? 'none' : 'inline-block';

  const periodTx = (overviewViewMode === 'year'
    ? allTransactions.filter((t) => t.date.slice(0, 4) === y)
    : allTransactions.filter((t) => t.date.slice(0, 7) === overviewYearMonth)
  ).filter(isTwdTransaction);

  const expense = periodTx.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const income = periodTx.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);

  document.getElementById('sum-expense').textContent = fmtMoney(expense);
  document.getElementById('sum-income').textContent = fmtMoney(income);
  document.getElementById('sum-balance').textContent = fmtMoney(income - expense);

  document.getElementById('overview-list-title').textContent = overviewViewMode === 'year' ? '當年交易' : '當月交易';

  const filteredList = periodTx.filter((t) => t.type === overviewTypeFilter);
  const list = document.getElementById('overview-list');
  list.innerHTML = '';
  document.getElementById('overview-empty').style.display = filteredList.length ? 'none' : 'block';
  filteredList.forEach((t) => list.appendChild(buildTxRow(t, false, true)));

  renderCategoryChart(periodTx);
  renderBudget(expense);
}

/* ---------- 每月預算 ---------- */
function renderBudget(expenseTotal) {
  const row = document.getElementById('budget-row');
  const editForm = document.getElementById('budget-edit-form');
  const display = document.getElementById('budget-display');

  if (overviewViewMode !== 'month') {
    row.style.display = 'none';
    return;
  }
  row.style.display = 'block';
  editForm.style.display = 'none';

  const budget = allBudgets.find((b) => b.year_month === overviewYearMonth);
  if (!budget) {
    display.style.display = 'none';
    document.getElementById('budget-edit-toggle').textContent = '設定';
    return;
  }

  display.style.display = 'block';
  document.getElementById('budget-edit-toggle').textContent = '修改';

  const total = Number(budget.amount);
  const remaining = total - expenseTotal;
  const pctUsed = total > 0 ? Math.min(100, (expenseTotal / total) * 100) : 100;
  const isOver = remaining < 0;

  document.getElementById('budget-total').textContent = fmtMoney(total);
  document.getElementById('budget-used').textContent = fmtMoney(expenseTotal);
  const remainingEl = document.getElementById('budget-remaining');
  remainingEl.textContent = fmtMoney(remaining);
  remainingEl.classList.toggle('over-budget', isOver);

  const fillEl = document.getElementById('budget-bar-fill');
  fillEl.style.width = pctUsed + '%';
  fillEl.classList.toggle('over-budget', isOver);
}

document.getElementById('budget-edit-toggle').addEventListener('click', () => {
  const editForm = document.getElementById('budget-edit-form');
  const isOpen = editForm.style.display === 'block';
  if (isOpen) {
    editForm.style.display = 'none';
    return;
  }
  const budget = allBudgets.find((b) => b.year_month === overviewYearMonth);
  document.getElementById('budget-amount-input').value = budget ? budget.amount : '';
  editForm.style.display = 'block';
});

document.getElementById('budget-save-btn').addEventListener('click', async () => {
  const amount = Number(document.getElementById('budget-amount-input').value);
  if (!amount || amount <= 0) return;
  const saved = await sbUpsertBudget(overviewYearMonth, amount);
  const idx = allBudgets.findIndex((b) => b.year_month === overviewYearMonth);
  if (idx >= 0) allBudgets[idx] = saved;
  else allBudgets.push(saved);
  document.getElementById('budget-edit-form').style.display = 'none';
  renderOverview();
});

document.querySelectorAll('#overview-view-mode .chart-toggle-btn[data-view-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    overviewViewMode = btn.dataset.viewMode;
    document.querySelectorAll('#overview-view-mode .chart-toggle-btn[data-view-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.viewMode === overviewViewMode);
    });
    renderOverview();
  });
});

document.getElementById('overview-jump-current').addEventListener('click', () => {
  overviewViewMode = 'month';
  overviewYearMonth = new Date().toISOString().slice(0, 7);
  document.querySelectorAll('#overview-view-mode .chart-toggle-btn[data-view-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.viewMode === overviewViewMode);
  });
  renderOverview();
});

document.querySelectorAll('#overview-type-toggle .type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    overviewTypeFilter = btn.dataset.overviewType;
    document.querySelectorAll('#overview-type-toggle .type-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.overviewType === overviewTypeFilter);
    });
    renderOverview();
  });
});

/* ---------- 分類佔比圖表 ---------- */
let chartType = 'pie';
const CHART_COLORS = ['#0F6E56', '#D85A30', '#E8A33D', '#3B6D11', '#6B5CA5', '#2E86AB', '#C2185B', '#8D6E63', '#607D8B', '#F4A261'];

function renderCategoryChart(monthTx) {
  const expenseTx = monthTx.filter((t) => t.type === 'expense');
  const totals = {};
  expenseTx.forEach((t) => {
    const key = t.categoryId || 'none';
    totals[key] = (totals[key] || 0) + t.amount;
  });

  const entries = Object.entries(totals)
    .map(([catId, amount]) => ({ name: categoryName(catId === 'none' ? null : catId), amount }))
    .sort((a, b) => b.amount - a.amount);

  const container = document.getElementById('category-chart');
  container.innerHTML = '';

  if (!entries.length) {
    container.innerHTML = '<p class="empty-hint" style="margin-top:0;">這個月還沒有支出紀錄</p>';
    return;
  }

  const total = entries.reduce((s, e) => s + e.amount, 0);
  container.appendChild(chartType === 'pie' ? buildPieChart(entries, total) : buildBarChart(entries, total));
}

function buildPieChart(entries, total) {
  const size = 160, r = 60, cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  let offsetDeg = -90;

  const wrap = document.createElement('div');
  wrap.className = 'pie-chart-wrap';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);

  entries.forEach((e, i) => {
    const pct = e.amount / total;
    const dash = pct * circumference;
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r);
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', CHART_COLORS[i % CHART_COLORS.length]);
    circle.setAttribute('stroke-width', 24);
    circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
    circle.setAttribute('transform', `rotate(${offsetDeg} ${cx} ${cy})`);
    svg.appendChild(circle);
    offsetDeg += pct * 360;
  });

  wrap.appendChild(svg);
  wrap.appendChild(buildChartLegend(entries, total));
  return wrap;
}

function buildBarChart(entries, total) {
  const wrap = document.createElement('div');
  wrap.className = 'bar-chart-wrap';
  const max = entries[0].amount;

  entries.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = e.name;

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = (e.amount / max * 100) + '%';
    fill.style.background = CHART_COLORS[i % CHART_COLORS.length];
    track.appendChild(fill);

    const value = document.createElement('span');
    value.className = 'bar-value';
    const pct = Math.round((e.amount / total) * 100);
    value.textContent = `${fmtMoney(e.amount)} (${pct}%)`;

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(value);
    wrap.appendChild(row);
  });

  return wrap;
}

function buildChartLegend(entries, total) {
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  entries.forEach((e, i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = CHART_COLORS[i % CHART_COLORS.length];
    const text = document.createElement('span');
    const pct = Math.round((e.amount / total) * 100);
    text.textContent = `${e.name} ${pct}% (${fmtMoney(e.amount)})`;
    item.appendChild(dot);
    item.appendChild(text);
    legend.appendChild(item);
  });
  return legend;
}

document.getElementById('chart-pie-btn').addEventListener('click', () => {
  chartType = 'pie';
  document.getElementById('chart-pie-btn').classList.add('active');
  document.getElementById('chart-bar-btn').classList.remove('active');
  renderOverview();
});
document.getElementById('chart-bar-btn').addEventListener('click', () => {
  chartType = 'bar';
  document.getElementById('chart-bar-btn').classList.add('active');
  document.getElementById('chart-pie-btn').classList.remove('active');
  renderOverview();
});

function applyYearMonthSelectors() {
  const y = document.getElementById('year-select').value;
  const m = document.getElementById('month-select').value.padStart(2, '0');
  const next = `${y}-${m}`;
  if (next < '2010-01') return;
  overviewYearMonth = next;
  renderOverview();
}
document.getElementById('year-select').addEventListener('change', applyYearMonthSelectors);
document.getElementById('month-select').addEventListener('change', applyYearMonthSelectors);

/* ---------- 交易列表畫面 ---------- */
let listTypeFilter = 'expense';

document.querySelectorAll('#list-type-toggle .type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    listTypeFilter = btn.dataset.listType;
    document.querySelectorAll('#list-type-toggle .type-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.listType === listTypeFilter);
    });
    renderList();
  });
});

function renderList() {
  const keyword = (document.getElementById('search-input').value || '').trim().toLowerCase();

  let filtered = allTransactions.filter((t) => {
    if (t.type !== listTypeFilter) return false;
    if (filterState.merchantIds.length && !filterState.merchantIds.includes(t.merchantId)) return false;
    if (filterState.accountIds.length) {
      const matchesAccount = t.type === 'transfer'
        ? (filterState.accountIds.includes(t.accountId) || filterState.accountIds.includes(t.transferToAccountId))
        : filterState.accountIds.includes(t.accountId);
      if (!matchesAccount) return false;
    }
    if (filterState.categoryIds.length && !filterState.categoryIds.includes(t.categoryId)) return false;
    if (filterState.amountMin !== null && t.amount < filterState.amountMin) return false;
    if (filterState.amountMax !== null && t.amount > filterState.amountMax) return false;
    if (filterState.dateFrom && t.date < filterState.dateFrom) return false;
    if (filterState.dateTo && t.date > filterState.dateTo) return false;
    if (keyword) {
      const hay = ((t.note || '') + ' ' + categoryName(t.categoryId) + ' ' + merchantName(t.merchantId)).toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const total = filtered.reduce((s, t) => s + t.amount, 0);
  document.getElementById('list-total-amount').textContent = fmtMoney(total);

  const container = document.getElementById('full-list');
  container.innerHTML = '';
  document.getElementById('list-empty').style.display = filtered.length ? 'none' : 'block';

  let lastDate = null;
  filtered.forEach((t) => {
    if (t.date !== lastDate) {
      const label = document.createElement('p');
      label.className = 'date-group-label';
      label.textContent = t.date;
      container.appendChild(label);
      lastDate = t.date;
    }
    container.appendChild(buildTxRow(t, true));
  });
}

function buildTxRow(t, showDelete, showDate) {
  const row = document.createElement('div');
  row.className = 'tx-row';

  const info = document.createElement('div');
  info.className = 'tx-info';
  const mName = merchantName(t.merchantId);
  const title = document.createElement('p');
  title.className = 'tx-title';
  if (t.type === 'transfer') {
    title.textContent = '從 ' + accountName(t.accountId) + ' 轉到 ' + accountName(t.transferToAccountId);
  } else {
    title.textContent = categoryName(t.categoryId) + (mName ? ' · ' + mName : '') + ' · ' + accountName(t.accountId);
  }

  const metaParts = [];
  if (showDate) metaParts.push(t.date.slice(5).replace('-', '/'));
  if (t.type === 'transfer' && t.transferToAmount) {
    metaParts.push('匯入 ' + fmtMoney(t.transferToAmount, accountCurrency(t.transferToAccountId)));
  }
  if (t.note) metaParts.push(t.note);
  if (t.pending) metaParts.push('待同步');

  info.appendChild(title);
  if (metaParts.length) {
    const meta = document.createElement('p');
    meta.className = 'tx-meta';
    meta.textContent = metaParts.join(' · ');
    info.appendChild(meta);
  }

  const isFuture = t.date > todayDateStr();
  const amount = document.createElement('p');
  amount.className = 'tx-amount ' + (t.type === 'expense' ? 'expense' : t.type === 'income' ? 'income' : 'transfer') + (isFuture ? ' future' : '');
  amount.textContent = (t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '') + fmtMoney(t.amount, accountCurrency(t.accountId));
  if (isFuture) row.classList.add('tx-row-future');

  row.appendChild(info);
  row.appendChild(amount);

  if (showDelete) {
    const actions = document.createElement('div');
    actions.className = 'tx-actions';

    if (!t.pending) {
      const editBtn = document.createElement('button');
      editBtn.className = 'tx-edit edit-control';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => startEditTransaction(t));
      actions.appendChild(editBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'tx-delete edit-control';
    delBtn.textContent = '刪除';
    delBtn.addEventListener('click', async () => {
      if (t.pending) {
        await idbDelete('pending_transactions', t.clientGeneratedId);
      } else {
        await sbSoftDeleteTransaction(t.id);
      }
      await refreshAll();
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
  }

  if (!t.pending) {
    row.classList.add('tx-row-clickable');
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tx-actions')) return;
      startEditTransaction(t);
    });
  }

  return row;
}

document.getElementById('search-input').addEventListener('input', renderList);

/* ---------- 新增交易畫面 ---------- */
function setTxType(type) {
  currentTxType = type;
  document.getElementById('btn-expense').classList.toggle('active', type === 'expense');
  document.getElementById('btn-income').classList.toggle('active', type === 'income');
  document.getElementById('btn-transfer').classList.toggle('active', type === 'transfer');

  const isTransfer = type === 'transfer';
  document.getElementById('tx-category-row').style.display = isTransfer ? 'none' : 'block';
  document.getElementById('tx-merchant-row').style.display = isTransfer ? 'none' : 'block';
  document.getElementById('transfer-to-row').style.display = isTransfer ? 'block' : 'none';
  document.getElementById('tx-category').required = !isTransfer;
  document.getElementById('tx-account-label').textContent = isTransfer ? '轉出帳戶' : '帳戶';

  populateFormSelectors();
  updateTransferExchangeRow();
}

/* 匯率一律採台灣銀行慣用的「1單位外幣＝多少台幣」報價方式(例如美金匯率31.5)。
   台幣換外幣要除以匯率，外幣換台幣要乘以匯率；兩邊都不是台幣時退回單純相乘 */
function computeTransferToAmount(amount, rate, fromCurrency, toCurrency) {
  if (fromCurrency === 'TWD' && toCurrency !== 'TWD') return amount / rate;
  if (toCurrency === 'TWD' && fromCurrency !== 'TWD') return amount * rate;
  return amount * rate;
}

function updateTransferExchangeRow() {
  const row = document.getElementById('tx-exchange-rate-row');
  if (currentTxType !== 'transfer') {
    row.style.display = 'none';
    return;
  }
  const fromCurrency = accountCurrency(document.getElementById('tx-account').value);
  const toCurrency = accountCurrency(document.getElementById('tx-transfer-to').value);
  if (fromCurrency !== toCurrency) {
    row.style.display = 'block';
    const label = document.getElementById('tx-exchange-rate-label');
    const foreign = fromCurrency === 'TWD' ? toCurrency : (toCurrency === 'TWD' ? fromCurrency : null);
    label.textContent = foreign
      ? `匯率（1${foreign}兌換多少台幣，例如1美金=31.5台幣就輸入31.5）`
      : `匯率（1${fromCurrency}兌換多少${toCurrency}）`;
    updateExchangePreview();
  } else {
    row.style.display = 'none';
    document.getElementById('tx-exchange-rate').value = '';
    document.getElementById('tx-exchange-preview').textContent = '';
  }
}

function updateExchangePreview() {
  const row = document.getElementById('tx-exchange-rate-row');
  if (row.style.display === 'none') return;
  const rate = parseFloat(document.getElementById('tx-exchange-rate').value);
  const amount = parseFloat(document.getElementById('tx-amount').value) || 0;
  const fromCurrency = accountCurrency(document.getElementById('tx-account').value);
  const toCurrency = accountCurrency(document.getElementById('tx-transfer-to').value);
  const preview = document.getElementById('tx-exchange-preview');
  preview.textContent = (rate > 0 && amount > 0)
    ? `匯入約 ${fmtMoney(computeTransferToAmount(amount, rate, fromCurrency, toCurrency), toCurrency)}`
    : '';
}

document.getElementById('tx-account').addEventListener('change', updateTransferExchangeRow);
document.getElementById('tx-transfer-to').addEventListener('change', updateTransferExchangeRow);
document.getElementById('tx-exchange-rate').addEventListener('input', updateExchangePreview);

document.getElementById('btn-expense').addEventListener('click', () => setTxType('expense'));
document.getElementById('btn-income').addEventListener('click', () => setTxType('income'));
document.getElementById('btn-transfer').addEventListener('click', () => setTxType('transfer'));

function populateFormSelectors() {
  const catSelect = document.getElementById('tx-category');
  const relevant = allCategories.filter((c) => c.type === currentTxType);
  catSelect.innerHTML = relevant.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');

  const activeAccounts = allAccounts.filter((a) => !a.is_archived);
  const accOptions = activeAccounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');

  const accSelect = document.getElementById('tx-account');
  accSelect.innerHTML = accOptions;
  const cashAccount = activeAccounts.find((a) => a.name === '現金');
  if (cashAccount) accSelect.value = cashAccount.id;

  const transferToSelect = document.getElementById('tx-transfer-to');
  transferToSelect.innerHTML = accOptions;

  const merchantHidden = document.getElementById('tx-merchant');
  const merchantInput = document.getElementById('tx-merchant-input');
  const merchantDatalist = document.getElementById('tx-merchant-datalist');
  const currentMerchantId = merchantHidden.value;
  merchantDatalist.innerHTML = allMerchants.map((m) => `<option value="${m.name}">`).join('');
  const currentMerchant = allMerchants.find((m) => m.id === currentMerchantId);
  merchantInput.value = currentMerchant ? currentMerchant.name : '';
  merchantHidden.value = currentMerchant ? currentMerchant.id : '';
}

document.getElementById('tx-merchant-input').addEventListener('input', () => {
  const typed = document.getElementById('tx-merchant-input').value.trim();
  const match = allMerchants.find((m) => m.name === typed);
  document.getElementById('tx-merchant').value = match ? match.id : '';
});

document.getElementById('btn-quick-add-cat').addEventListener('click', () => {
  switchTab('categories');
});

document.getElementById('btn-quick-add-merchant').addEventListener('click', () => {
  switchTab('categories');
});

document.getElementById('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('tx-amount').value);
  if (!amount || amount <= 0) return;

  const accountId = document.getElementById('tx-account').value;
  let record;

  if (currentTxType === 'transfer') {
    const transferToAccountId = document.getElementById('tx-transfer-to').value;
    if (accountId === transferToAccountId) {
      alert('轉出帳戶跟轉入帳戶不能相同');
      return;
    }
    let transferToAmount = null;
    if (document.getElementById('tx-exchange-rate-row').style.display !== 'none') {
      const rate = parseFloat(document.getElementById('tx-exchange-rate').value);
      if (!rate || rate <= 0) {
        alert('請輸入匯率');
        return;
      }
      const fromCurrency = accountCurrency(accountId);
      const toCurrency = accountCurrency(transferToAccountId);
      transferToAmount = Math.round(computeTransferToAmount(amount, rate, fromCurrency, toCurrency) * 100) / 100;
    }
    record = {
      type: 'transfer',
      amount: amount,
      categoryId: null,
      accountId: accountId,
      transferToAccountId: transferToAccountId,
      transferToAmount: transferToAmount,
      merchantId: null,
      date: document.getElementById('tx-date').value,
      note: document.getElementById('tx-note').value.trim()
    };
  } else {
    record = {
      type: currentTxType,
      amount: amount,
      categoryId: document.getElementById('tx-category').value,
      accountId: accountId,
      merchantId: document.getElementById('tx-merchant').value || null,
      date: document.getElementById('tx-date').value,
      note: document.getElementById('tx-note').value.trim()
    };
  }

  const applyFuture = document.getElementById('tx-recurring-apply-future').checked;
  const makeRecurring = !editingTransactionId && document.getElementById('tx-recurring-checkbox').checked;
  const recurringEndDate = document.getElementById('tx-recurring-end-date').value || null;

  if (editingTransactionId) {
    const row = txToRow(record);
    delete row.client_generated_id;
    delete row.ledger_id;
    delete row.recurring_rule_id;
    await sbUpdate('transactions', editingTransactionId, row);

    if (editingRecurringRuleId && applyFuture) {
      try {
        const ruleFields = {
          type: record.type,
          amount: record.amount,
          category_id: record.categoryId || null,
          account_id: record.accountId,
          transfer_to_account_id: record.transferToAccountId || null,
          merchant_id: record.merchantId || null,
          note: record.note || null
        };
        await sbUpdate('recurring_rules', editingRecurringRuleId, ruleFields);
        const today = todayDateStr();
        const futureOnes = allTransactions.filter((t) =>
          t.recurringRuleId === editingRecurringRuleId && t.date > today && t.id !== editingTransactionId
        );
        for (const t of futureOnes) {
          await sbUpdate('transactions', t.id, ruleFields);
        }
      } catch (err) {
        /* 套用到未來月份失敗不影響這筆本身已經存檔成功 */
      }
    }
  } else {
    record.clientGeneratedId = crypto.randomUUID();
    record.ledgerId = currentLedgerId;
    let insertedRow = null;
    try {
      insertedRow = await sbInsertTransaction(txToRow(record));
    } catch (err) {
      await idbPut('pending_transactions', { ...record, createdAt: new Date().toISOString() });
    }

    if (insertedRow && makeRecurring) {
      try {
        const day = Number(record.date.split('-')[2]);
        const rule = await sbInsert('recurring_rules', {
          ledger_id: currentLedgerId,
          type: record.type,
          amount: record.amount,
          category_id: record.categoryId || null,
          account_id: record.accountId,
          transfer_to_account_id: record.transferToAccountId || null,
          merchant_id: record.merchantId || null,
          note: record.note || null,
          day_of_month: day,
          start_date: record.date,
          end_date: recurringEndDate,
          is_active: true
        });
        await sbUpdate('transactions', insertedRow.id, { recurring_rule_id: rule.id });
        await generateRecurringOccurrences(rule, record.date);
      } catch (err) {
        /* 定期定額規則建立失敗不影響這筆交易本身已經存檔成功 */
      }
    }
  }

  cancelEditTransaction();
  await refreshAll();
  switchTab('overview');
});

document.getElementById('tx-recurring-checkbox').addEventListener('change', (e) => {
  document.getElementById('tx-recurring-options').style.display = e.target.checked ? 'block' : 'none';
});

let editingTransactionId = null;
let editingRecurringRuleId = null;

/* 帳戶如果已經停用，新增交易的下拉選單裡不會有它；編輯舊交易時要補回去，
   不然存檔會被悄悄改成別的帳戶 */
function ensureAccountOption(selectEl, accountId) {
  if (!accountId) return;
  const exists = [...selectEl.options].some((o) => o.value === accountId);
  if (!exists) {
    const acc = allAccounts.find((a) => a.id === accountId);
    if (acc) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.name + '（已停用）';
      selectEl.appendChild(opt);
    }
  }
}

function startEditTransaction(t) {
  editingTransactionId = t.id;
  editingRecurringRuleId = t.recurringRuleId || null;
  switchTab('add');
  setTxType(t.type);
  calcExpr = String(t.amount);
  updateCalcDisplay();
  document.getElementById('tx-date').value = t.date;
  document.getElementById('tx-note').value = t.note || '';
  if (t.type === 'transfer') {
    ensureAccountOption(document.getElementById('tx-account'), t.accountId);
    ensureAccountOption(document.getElementById('tx-transfer-to'), t.transferToAccountId);
    document.getElementById('tx-account').value = t.accountId;
    document.getElementById('tx-transfer-to').value = t.transferToAccountId;
    updateTransferExchangeRow();
    if (t.transferToAmount) {
      const fromCurrency = accountCurrency(t.accountId);
      const impliedRate = fromCurrency === 'TWD' ? (t.amount / t.transferToAmount) : (t.transferToAmount / t.amount);
      document.getElementById('tx-exchange-rate').value = Math.round(impliedRate * 10000) / 10000;
      updateExchangePreview();
    }
  } else {
    document.getElementById('tx-category').value = t.categoryId;
    ensureAccountOption(document.getElementById('tx-account'), t.accountId);
    document.getElementById('tx-account').value = t.accountId;
    const editMerchant = allMerchants.find((m) => m.id === t.merchantId);
    document.getElementById('tx-merchant-input').value = editMerchant ? editMerchant.name : '';
    document.getElementById('tx-merchant').value = t.merchantId || '';
  }
  document.getElementById('tx-form-submit').textContent = '更新交易';
  document.getElementById('tx-form-cancel').style.display = 'block';
  document.getElementById('tx-form-delete').style.display = 'block';
  document.getElementById('tx-recurring-label').style.display = 'none';
  document.getElementById('tx-recurring-options').style.display = 'none';
  if (editingRecurringRuleId) {
    document.getElementById('tx-recurring-locked-hint').style.display = 'block';
    document.getElementById('tx-recurring-apply-future-row').style.display = 'flex';
  } else {
    document.getElementById('tx-recurring-locked-hint').style.display = 'none';
    document.getElementById('tx-recurring-apply-future-row').style.display = 'none';
  }
  document.getElementById('tx-recurring-apply-future').checked = false;
}

function cancelEditTransaction() {
  editingTransactionId = null;
  editingRecurringRuleId = null;
  document.getElementById('tx-form').reset();
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  resetCalc();
  setTxType('expense');
  document.getElementById('tx-form-submit').textContent = '儲存';
  document.getElementById('tx-form-cancel').style.display = 'none';
  document.getElementById('tx-form-delete').style.display = 'none';
  document.getElementById('tx-recurring-label').style.display = 'flex';
  document.getElementById('tx-recurring-options').style.display = 'none';
  document.getElementById('tx-recurring-locked-hint').style.display = 'none';
  document.getElementById('tx-recurring-apply-future-row').style.display = 'none';
}

document.getElementById('tx-form-delete').addEventListener('click', async () => {
  if (!editingTransactionId) return;
  await sbSoftDeleteTransaction(editingTransactionId);
  cancelEditTransaction();
  await refreshAll();
  switchTab('overview');
});

/* ---------- 定期定額交易 ---------- */

/* 從 afterDateStr 的下個月開始，每月產生一筆規則裡設定的交易，直到「今天起12個月」或結束日期(取較早者) */
async function generateRecurringOccurrences(rule, afterDateStr) {
  const today = todayDateStr();
  const horizonYM = addMonthsToYearMonth(today, 12);
  let horizon = dateForDayOfMonth(horizonYM.year, horizonYM.month, rule.day_of_month);
  if (rule.end_date && rule.end_date < horizon) horizon = rule.end_date;

  const [ay, am] = afterDateStr.split('-').map(Number);
  let inserted = false;
  let offset = 1;
  while (true) {
    const total = ay * 12 + (am - 1) + offset;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const d = dateForDayOfMonth(year, month, rule.day_of_month);
    if (d > horizon) break;
    const row = {
      type: rule.type,
      amount: Number(rule.amount),
      category_id: rule.category_id,
      account_id: rule.account_id,
      merchant_id: rule.merchant_id,
      transfer_to_account_id: rule.transfer_to_account_id,
      transaction_date: d,
      note: rule.note,
      client_generated_id: crypto.randomUUID(),
      ledger_id: rule.ledger_id,
      recurring_rule_id: rule.id
    };
    try {
      await sbInsertTransaction(row);
      inserted = true;
    } catch (err) {
      /* 單筆失敗就跳過，不中斷其餘月份的產生 */
    }
    offset++;
  }
  return inserted;
}

/* 幫每個還在生效中的定期定額規則，把交易補到「今天起12個月」的範圍 */
async function ensureRecurringHorizon() {
  const today = todayDateStr();
  const activeRules = allRecurringRules.filter((r) => r.is_active && (!r.end_date || r.end_date >= today));
  let generatedAny = false;
  for (const rule of activeRules) {
    const existing = allTransactions.filter((t) => t.recurringRuleId === rule.id);
    let baseline;
    if (existing.length) {
      baseline = existing.reduce((max, t) => (t.date > max ? t.date : max), existing[0].date);
    } else {
      const prev = addMonthsToYearMonth(rule.start_date, -1);
      baseline = `${prev.year}-${String(prev.month).padStart(2, '0')}-01`;
    }
    const didInsert = await generateRecurringOccurrences(rule, baseline);
    if (didInsert) generatedAny = true;
  }
  return generatedAny;
}

function renderRecurringList() {
  const container = document.getElementById('recurring-list');
  if (!container) return;
  container.innerHTML = '';
  const active = allRecurringRules.filter((r) => r.is_active);
  if (!active.length) {
    container.innerHTML = '<p class="empty-hint" style="margin:8px 0;">目前沒有設定定期定額交易</p>';
    return;
  }
  active.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'account-row';

    const info = document.createElement('div');
    info.className = 'account-info';

    const name = document.createElement('p');
    name.className = 'account-name';
    name.textContent = rule.type === 'transfer'
      ? `從 ${accountName(rule.account_id)} 轉到 ${accountName(rule.transfer_to_account_id)}`
      : `${categoryName(rule.category_id)} · ${accountName(rule.account_id)}`;

    const meta = document.createElement('p');
    meta.className = 'account-meta';
    meta.textContent = `每月${rule.day_of_month}號` + (rule.end_date ? `，至${rule.end_date}` : '，無限期') + (rule.note ? ' · ' + rule.note : '');

    info.appendChild(name);
    info.appendChild(meta);

    const amountEl = document.createElement('p');
    amountEl.className = 'account-balance';
    amountEl.textContent = (rule.type === 'expense' ? '-' : rule.type === 'income' ? '+' : '') + fmtMoney(rule.amount, accountCurrency(rule.account_id));

    const actions = document.createElement('div');
    actions.className = 'cat-actions';
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', async () => {
      await stopRecurringRule(rule);
      await refreshAll();
    });
    actions.appendChild(stopBtn);

    row.appendChild(info);
    row.appendChild(amountEl);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

async function stopRecurringRule(rule) {
  const today = todayDateStr();
  await sbUpdate('recurring_rules', rule.id, { is_active: false, end_date: today });
  const future = allTransactions.filter((t) => t.recurringRuleId === rule.id && t.date > today);
  for (const t of future) {
    await sbSoftDeleteTransaction(t.id);
  }
}

document.getElementById('tx-form-cancel').addEventListener('click', cancelEditTransaction);

/* ---------- 帳戶管理畫面 ---------- */
const accountTypeLabels = { cash: '現金', bank: '銀行帳戶', credit_card: '信用卡', other: '其他' };
let editingAccountId = null;

function renderAccountsScreen() {
  const list = document.getElementById('account-list');
  list.innerHTML = '';

  const sortedAccounts = allAccounts.slice().sort((a, b) => (a.is_archived === b.is_archived ? 0 : a.is_archived ? 1 : -1));
  sortedAccounts.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'account-row' + (a.is_archived ? ' archived' : '');

    const info = document.createElement('div');
    info.className = 'account-info';
    const name = document.createElement('p');
    name.className = 'account-name';
    name.textContent = a.name + (a.is_archived ? '（已停用）' : '');
    const meta = document.createElement('p');
    meta.className = 'account-meta';
    meta.textContent = (accountTypeLabels[a.type] || a.type) + (a.currency && a.currency !== 'TWD' ? ' · ' + a.currency : '');
    info.appendChild(name);
    info.appendChild(meta);

    const balance = document.createElement('p');
    balance.className = 'account-balance';
    balance.textContent = fmtMoney(accountBalance(a.id), a.currency);

    const actions = document.createElement('div');
    actions.className = 'cat-actions edit-control';

    const editBtn = document.createElement('button');
    editBtn.textContent = '編輯';
    editBtn.addEventListener('click', () => startEditAccount(a));
    actions.appendChild(editBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = a.is_archived ? '啟用' : '停用';
    toggleBtn.addEventListener('click', async () => {
      await sbUpdate('accounts', a.id, { is_archived: !a.is_archived });
      await refreshAll();
    });
    actions.appendChild(toggleBtn);

    row.appendChild(info);
    row.appendChild(balance);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function startEditAccount(a) {
  editingAccountId = a.id;
  document.getElementById('acc-name').value = a.name;
  document.getElementById('acc-type').value = a.type;
  document.getElementById('acc-currency').value = a.currency || 'TWD';
  document.getElementById('acc-initial').value = a.initial_balance || 0;
  document.getElementById('account-form-submit').textContent = '更新帳戶';
  document.getElementById('account-form-cancel').style.display = 'inline-block';
}

function cancelEditAccount() {
  editingAccountId = null;
  document.getElementById('account-form').reset();
  document.getElementById('account-form-submit').textContent = '新增帳戶';
  document.getElementById('account-form-cancel').style.display = 'none';
}

document.getElementById('account-form-cancel').addEventListener('click', cancelEditAccount);

document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('acc-name').value.trim();
  if (!name) return;
  const type = document.getElementById('acc-type').value;
  const currency = document.getElementById('acc-currency').value;
  const initial_balance = parseFloat(document.getElementById('acc-initial').value) || 0;

  if (editingAccountId) {
    await sbUpdate('accounts', editingAccountId, { name, type, currency, initial_balance });
  } else {
    await sbInsert('accounts', { name, type, currency, initial_balance, is_archived: false, ledger_id: currentLedgerId });
  }
  cancelEditAccount();
  await refreshAll();
});

/* ---------- 分類管理畫面 ---------- */
function renderCategoryScreen() {
  const expenseList = document.getElementById('expense-cat-list');
  const incomeList = document.getElementById('income-cat-list');
  expenseList.innerHTML = '';
  incomeList.innerHTML = '';

  allCategories.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const name = document.createElement('span');
    name.textContent = c.name;
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'cat-more-btn';
    moreBtn.textContent = '⋯';
    moreBtn.addEventListener('click', () => openActionSheet('category', c));
    row.appendChild(name);
    row.appendChild(moreBtn);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openActionSheet('category', c);
    });
    (c.type === 'expense' ? expenseList : incomeList).appendChild(row);
  });

  const merchantList = document.getElementById('merchant-list');
  merchantList.innerHTML = '';
  allMerchants.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const name = document.createElement('span');
    name.textContent = m.name;
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'cat-more-btn';
    moreBtn.textContent = '⋯';
    moreBtn.addEventListener('click', () => openActionSheet('merchant', m));
    row.appendChild(name);
    row.appendChild(moreBtn);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openActionSheet('merchant', m);
    });
    merchantList.appendChild(row);
  });
}

/* ---------- 長按操作選單（編輯／刪除） ---------- */
let actionSheetTarget = null;

function openActionSheet(kind, item) {
  actionSheetTarget = { kind, item };
  document.getElementById('action-sheet-title').textContent = item.name;
  document.getElementById('action-sheet-overlay').style.display = 'flex';
}

function closeActionSheet() {
  actionSheetTarget = null;
  document.getElementById('action-sheet-overlay').style.display = 'none';
}

document.getElementById('action-sheet-cancel').addEventListener('click', closeActionSheet);
document.getElementById('action-sheet-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'action-sheet-overlay') closeActionSheet();
});

document.getElementById('action-sheet-edit').addEventListener('click', async () => {
  const { kind, item } = actionSheetTarget;
  closeActionSheet();
  const newName = prompt('修改名稱', item.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) return;
  await sbUpdate(kind === 'category' ? 'categories' : 'merchants', item.id, { name: trimmed });
  await refreshAll();
});

document.getElementById('action-sheet-delete').addEventListener('click', async () => {
  const { kind, item } = actionSheetTarget;
  closeActionSheet();
  if (kind === 'category') {
    const inUse = allTransactions.some((t) => t.categoryId === item.id);
    if (inUse && !confirm('這個分類已有交易使用，確定要刪除嗎？（交易紀錄會保留但顯示為未分類）')) return;
    await sbDeleteHard('categories', item.id);
  } else {
    const inUse = allTransactions.some((t) => t.merchantId === item.id);
    if (inUse && !confirm('這個商家已有交易使用，確定要刪除嗎？（交易紀錄會保留但顯示為不指定商家）')) return;
    await sbDeleteHard('merchants', item.id);
  }
  await refreshAll();
});

async function addCategory(type, inputId) {
  const input = document.getElementById(inputId);
  const name = input.value.trim();
  if (!name) return;
  await sbInsert('categories', { name, type });
  input.value = '';
  await refreshAll();
}

document.getElementById('add-expense-cat-btn').addEventListener('click', () =>
  addCategory('expense', 'new-expense-cat')
);
document.getElementById('add-income-cat-btn').addEventListener('click', () =>
  addCategory('income', 'new-income-cat')
);

document.getElementById('add-merchant-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-merchant');
  const name = input.value.trim();
  if (!name) return;
  await sbInsert('merchants', { name });
  input.value = '';
  await refreshAll();
});

/* ---------- 資料備份：JSON匯出入 / CSV匯出 ---------- */
function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('export-json-btn').addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    accounts: allAccounts,
    categories: allCategories,
    merchants: allMerchants,
    transactions: allTransactions.filter((t) => !t.pending)
  };
  downloadFile(
    '記帳備份_' + new Date().toISOString().slice(0, 10) + '.json',
    JSON.stringify(payload, null, 2),
    'application/json'
  );
});

document.getElementById('export-csv-btn').addEventListener('click', () => {
  const header = ['日期', '類型', '金額', '分類', '帳戶', '商家', '備註'];
  const rows = allTransactions
    .filter((t) => !t.pending)
    .map((t) => [
      t.date,
      t.type === 'expense' ? '支出' : t.type === 'income' ? '收入' : '轉帳',
      t.amount,
      t.type === 'transfer' ? '' : categoryName(t.categoryId),
      t.type === 'transfer' ? (accountName(t.accountId) + '→' + accountName(t.transferToAccountId)) : accountName(t.accountId),
      merchantName(t.merchantId),
      (t.note || '').replace(/"/g, '""')
    ]);
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
  const bom = String.fromCharCode(0xFEFF);
  downloadFile('記帳明細_' + new Date().toISOString().slice(0, 10) + '.csv', bom + csv, 'text/csv;charset=utf-8');
});

document.getElementById('import-json-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  if (!confirm('匯入會把備份裡的帳戶/分類/商家/交易新增到目前帳號，確定要匯入嗎？')) return;

  const statusEl = document.getElementById('import-status');
  statusEl.style.display = 'block';
  const setStatus = (text) => { statusEl.textContent = text; };

  try {
    setStatus('讀取檔案中...');
    const data = JSON.parse(await file.text());

    let setupFailed = 0;
    const setupFailedSamples = [];
    function recordSetupError(kind, err) {
      setupFailed++;
      if (setupFailedSamples.length < 5) setupFailedSamples.push(`${kind}: ${(err && err.message) || err}`);
    }

    setStatus('建立帳戶中...');
    const accountIdMap = {};
    for (const a of (data.accounts || [])) {
      const existing = allAccounts.find((x) => x.name === a.name);
      if (existing) {
        accountIdMap[a.id] = existing.id;
        continue;
      }
      try {
        const inserted = await sbInsert('accounts', {
          name: a.name,
          type: a.type,
          initial_balance: a.initial_balance || 0,
          is_archived: !!a.is_archived,
          ledger_id: currentLedgerId
        });
        accountIdMap[a.id] = inserted.id;
      } catch (err) {
        recordSetupError('帳戶 ' + a.name, err);
      }
    }

    setStatus('建立分類中...');
    const categoryIdMap = {};
    for (const c of (data.categories || [])) {
      const existing = allCategories.find((x) => x.name === c.name && x.type === c.type);
      if (existing) {
        categoryIdMap[c.id] = existing.id;
        continue;
      }
      try {
        const inserted = await sbInsert('categories', { name: c.name, type: c.type });
        categoryIdMap[c.id] = inserted.id;
      } catch (err) {
        recordSetupError('分類 ' + c.name, err);
      }
    }

    setStatus('建立商家中...');
    const merchantIdMap = {};
    for (const m of (data.merchants || [])) {
      const existing = allMerchants.find((x) => x.name === m.name);
      if (existing) {
        merchantIdMap[m.id] = existing.id;
        continue;
      }
      try {
        const inserted = await sbInsert('merchants', { name: m.name });
        merchantIdMap[m.id] = inserted.id;
      } catch (err) {
        recordSetupError('商家 ' + m.name, err);
      }
    }

    const txList = data.transactions || [];
    let done = 0;
    let failed = 0;
    let skippedNoAccount = 0;
    const failedSamples = [];
    for (const t of txList) {
      const row = txToRow({
        type: t.type,
        amount: t.amount,
        categoryId: t.categoryId ? (categoryIdMap[t.categoryId] || null) : null,
        accountId: accountIdMap[t.accountId] || null,
        merchantId: t.merchantId ? (merchantIdMap[t.merchantId] || null) : null,
        transferToAccountId: t.transferToAccountId ? (accountIdMap[t.transferToAccountId] || null) : null,
        date: t.date,
        note: t.note || '',
        clientGeneratedId: t.clientGeneratedId || crypto.randomUUID(),
        ledgerId: currentLedgerId
      });
      done++;
      if (!row.account_id) {
        skippedNoAccount++;
      } else {
        try {
          await sbInsertTransaction(row);
        } catch (err) {
          if (!(err && err.code === '23505')) {
            failed++;
            if (failedSamples.length < 5) failedSamples.push((err && err.message) || String(err));
          }
        }
      }
      if (done % 5 === 0 || done === txList.length) {
        setStatus(`匯入交易中... ${done}/${txList.length}（失敗 ${failed} 筆）`);
      }
    }

    setStatus('整理畫面中...');
    await refreshAll();
    statusEl.style.display = 'none';
    let summary = `匯入完成！共處理 ${txList.length} 筆交易`;
    if (failed) summary += `，其中 ${failed} 筆失敗：\n` + failedSamples.join('\n');
    if (skippedNoAccount) summary += `\n另有 ${skippedNoAccount} 筆因缺少帳戶資訊而略過`;
    if (setupFailed) summary += `\n帳戶/分類/商家建立失敗 ${setupFailed} 筆：\n` + setupFailedSamples.join('\n');
    alert(summary);
  } catch (err) {
    statusEl.style.display = 'none';
    alert('匯入失敗：' + err.message);
  }
});

/* ---------- 進階篩選 ---------- */
let filterState = { merchantIds: [], accountIds: [], categoryIds: [], amountMin: null, amountMax: null, dateFrom: null, dateTo: null };

document.getElementById('toggle-advanced-filter').addEventListener('click', () => {
  const panel = document.getElementById('advanced-filter-panel');
  const btn = document.getElementById('toggle-advanced-filter');
  const isOpen = panel.style.display === 'block';
  panel.style.display = isOpen ? 'none' : 'block';
  btn.textContent = isOpen ? '進階篩選 ▾' : '進階篩選 ▴';
});

function toggleFilterValue(arr, value) {
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(value);
}

function renderFilterChips() {
  const merchWrap = document.getElementById('filter-merchant-chips');
  merchWrap.innerHTML = '';
  allMerchants.forEach((m) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn' + (filterState.merchantIds.includes(m.id) ? ' active' : '');
    chip.textContent = m.name;
    chip.addEventListener('click', () => {
      toggleFilterValue(filterState.merchantIds, m.id);
      renderFilterChips();
      renderList();
    });
    merchWrap.appendChild(chip);
  });

  const accWrap = document.getElementById('filter-account-chips');
  accWrap.innerHTML = '';
  allAccounts.forEach((a) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn' + (filterState.accountIds.includes(a.id) ? ' active' : '');
    chip.textContent = a.name;
    chip.addEventListener('click', () => {
      toggleFilterValue(filterState.accountIds, a.id);
      renderFilterChips();
      renderList();
    });
    accWrap.appendChild(chip);
  });

  const catWrap = document.getElementById('filter-category-chips');
  catWrap.innerHTML = '';
  allCategories.forEach((c) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn' + (filterState.categoryIds.includes(c.id) ? ' active' : '');
    chip.textContent = c.name;
    chip.addEventListener('click', () => {
      toggleFilterValue(filterState.categoryIds, c.id);
      renderFilterChips();
      renderList();
    });
    catWrap.appendChild(chip);
  });

  renderPresetChips();
}

document.getElementById('filter-amount-min').addEventListener('input', (e) => {
  filterState.amountMin = e.target.value === '' ? null : parseFloat(e.target.value);
  renderList();
});
document.getElementById('filter-amount-max').addEventListener('input', (e) => {
  filterState.amountMax = e.target.value === '' ? null : parseFloat(e.target.value);
  renderList();
});
document.getElementById('filter-date-from').addEventListener('change', (e) => {
  filterState.dateFrom = e.target.value || null;
  renderList();
});
document.getElementById('filter-date-to').addEventListener('change', (e) => {
  filterState.dateTo = e.target.value || null;
  renderList();
});

document.getElementById('filter-clear-btn').addEventListener('click', () => {
  filterState = { merchantIds: [], accountIds: [], categoryIds: [], amountMin: null, amountMax: null, dateFrom: null, dateTo: null };
  document.getElementById('filter-amount-min').value = '';
  document.getElementById('filter-amount-max').value = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value = '';
  renderFilterChips();
  renderList();
});

/* 常用篩選組合：只是畫面上的方便功能，存在本機localStorage即可，不需要另建Supabase表 */
function presetStorageKey() {
  return 'expensePwa_filterPresets_' + currentUserId;
}

function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(presetStorageKey()) || '[]');
  } catch (e) {
    return [];
  }
}

function savePresets(presets) {
  localStorage.setItem(presetStorageKey(), JSON.stringify(presets));
}

function renderPresetChips() {
  const wrap = document.getElementById('filter-preset-list');
  wrap.innerHTML = '';
  loadPresets().forEach((preset, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip-btn preset-chip';

    const label = document.createElement('span');
    label.textContent = preset.name;
    label.addEventListener('click', () => {
      filterState = {
        merchantIds: preset.merchantIds || [],
        accountIds: preset.accountIds || [],
        categoryIds: preset.categoryIds || [],
        amountMin: preset.amountMin ?? null,
        amountMax: preset.amountMax ?? null,
        dateFrom: preset.dateFrom ?? null,
        dateTo: preset.dateTo ?? null
      };
      document.getElementById('filter-amount-min').value = filterState.amountMin ?? '';
      document.getElementById('filter-amount-max').value = filterState.amountMax ?? '';
      document.getElementById('filter-date-from').value = filterState.dateFrom ?? '';
      document.getElementById('filter-date-to').value = filterState.dateTo ?? '';
      renderFilterChips();
      renderList();
    });

    const removeBtn = document.createElement('span');
    removeBtn.className = 'preset-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const presets = loadPresets();
      presets.splice(idx, 1);
      savePresets(presets);
      renderPresetChips();
    });

    chip.appendChild(label);
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

document.getElementById('filter-save-preset-btn').addEventListener('click', () => {
  const nameInput = document.getElementById('filter-preset-name');
  const name = nameInput.value.trim();
  if (!name) return;
  const presets = loadPresets();
  presets.push({ name, ...filterState });
  savePresets(presets);
  nameInput.value = '';
  renderPresetChips();
});

/* ---------- 登入驗證 ---------- */
function showAuthScreen() {
  document.getElementById('screen-auth').style.display = 'block';
  document.getElementById('screen-reset-password').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('bottom-nav').style.display = 'none';
  document.getElementById('logout-btn').style.display = 'none';
  document.getElementById('ledger-bar').style.display = 'none';
}

function showAppShell() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('screen-reset-password').style.display = 'none';
  document.getElementById('app-shell').style.display = 'block';
  document.getElementById('bottom-nav').style.display = 'flex';
  document.getElementById('logout-btn').style.display = 'inline-block';
  document.getElementById('ledger-bar').style.display = 'flex';
}

function showResetPasswordScreen() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('bottom-nav').style.display = 'none';
  document.getElementById('logout-btn').style.display = 'none';
  document.getElementById('ledger-bar').style.display = 'none';
  document.getElementById('screen-reset-password').style.display = 'block';
}

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  el.textContent = message;
  el.style.display = 'block';
}

function clearAuthError() {
  document.getElementById('auth-error').style.display = 'none';
}

document.getElementById('auth-login-btn').addEventListener('click', async () => {
  clearAuthError();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { showAuthError('請輸入Email和密碼'); return; }
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) showAuthError(error.message);
});

document.getElementById('auth-signup-btn').addEventListener('click', async () => {
  clearAuthError();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { showAuthError('請輸入Email和密碼'); return; }
  if (password.length < 6) { showAuthError('密碼至少需要6碼'); return; }
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) { showAuthError(error.message); return; }
  if (!data.session) {
    showAuthError('註冊成功！請check信箱收確認信，點擊確認連結後再回來登入。');
  }
});

document.getElementById('auth-forgot-btn').addEventListener('click', async () => {
  clearAuthError();
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { showAuthError('請先在Email欄位輸入你的信箱'); return; }
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin
  });
  if (error) { showAuthError(error.message); return; }
  showAuthError('重設密碼信已寄出，請check信箱並點擊連結設定新密碼。');
});

document.getElementById('reset-submit-btn').addEventListener('click', async () => {
  const errorEl = document.getElementById('reset-error');
  errorEl.style.display = 'none';
  const newPassword = document.getElementById('reset-new-password').value;
  if (newPassword.length < 6) {
    errorEl.textContent = '密碼至少需要6碼';
    errorEl.style.display = 'block';
    return;
  }
  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
  if (error) {
    errorEl.textContent = error.message;
    errorEl.style.display = 'block';
    return;
  }
  document.getElementById('reset-new-password').value = '';
  document.getElementById('screen-reset-password').style.display = 'none';
  showAppShell();
  initAppData();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
});

/* ---------- 出差/旅遊行程 ---------- */
let allTrips = [];
let currentTripId = null;
let editingTripId = null;
let tripExpenses = [];
let tripAttractions = [];
let tripTransportation = [];
let tripLodging = [];
let tripNotes = [];

async function loadTrips() {
  const { data, error } = await supabaseClient.from('trips').select('*').order('start_date', { ascending: false });
  allTrips = error ? [] : data;
  renderTripList();
}

function renderTripList() {
  const container = document.getElementById('trip-list');
  container.innerHTML = '';
  const active = allTrips.filter((t) => !t.is_archived);
  if (!active.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '還沒有行程紀錄，新增一筆開始記錄';
    container.appendChild(hint);
    return;
  }
  active.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.style.cursor = 'pointer';

    const info = document.createElement('div');
    info.className = 'account-info';
    const name = document.createElement('p');
    name.className = 'account-name';
    name.textContent = t.name;
    const meta = document.createElement('p');
    meta.className = 'account-meta trip-list-meta';
    const typeLabel = t.type === 'business' ? '出差' : '私人旅遊';
    const dateRange = [t.start_date, t.end_date].filter(Boolean).join(' ~ ');
    meta.textContent = [typeLabel, dateRange, t.destination].filter(Boolean).join(' · ');
    info.appendChild(name);
    info.appendChild(meta);

    row.appendChild(info);
    row.addEventListener('click', () => openTrip(t.id));
    container.appendChild(row);
  });
}

document.getElementById('trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('trip-name').value.trim();
  if (!name) return;
  const fields = {
    name,
    type: document.getElementById('trip-type').value,
    start_date: document.getElementById('trip-start-date').value || null,
    end_date: document.getElementById('trip-end-date').value || null,
    destination: document.getElementById('trip-destination').value.trim() || null,
    currency: document.getElementById('trip-currency').value,
    note: document.getElementById('trip-note').value.trim() || null
  };
  if (editingTripId) {
    await sbUpdate('trips', editingTripId, fields);
  } else {
    await sbInsert('trips', { ...fields, is_archived: false });
  }
  cancelEditTrip();
  await loadTrips();
});

function cancelEditTrip() {
  editingTripId = null;
  document.getElementById('trip-form').reset();
  document.getElementById('trip-form-submit').textContent = '新增行程';
  document.getElementById('trip-form-title').textContent = '新增行程';
  document.getElementById('trip-form-cancel').style.display = 'none';
}
document.getElementById('trip-form-cancel').addEventListener('click', cancelEditTrip);

async function openTrip(tripId) {
  currentTripId = tripId;
  cancelEditTripExpense();
  cancelEditTripAttraction();
  cancelEditTripTransportation();
  cancelEditTripLodging();
  cancelEditTripNote();
  document.getElementById('trip-list-view').style.display = 'none';
  document.getElementById('trip-detail-view').style.display = 'block';
  await loadTripSubData();
  renderTripDetail();
  switchTripSubTab('expenses');
}

document.getElementById('trip-back-btn').addEventListener('click', () => {
  currentTripId = null;
  document.getElementById('trip-detail-view').style.display = 'none';
  document.getElementById('trip-list-view').style.display = 'block';
});

async function loadTripSubData() {
  const [ex, att, trans, lodge, notes] = await Promise.all([
    supabaseClient.from('trip_expenses').select('*').eq('trip_id', currentTripId).order('expense_date'),
    supabaseClient.from('trip_attractions').select('*').eq('trip_id', currentTripId).order('visit_date'),
    supabaseClient.from('trip_transportation').select('*').eq('trip_id', currentTripId).order('depart_at'),
    supabaseClient.from('trip_lodging').select('*').eq('trip_id', currentTripId).order('check_in'),
    supabaseClient.from('trip_notes').select('*').eq('trip_id', currentTripId).order('note_date')
  ]);
  tripExpenses = ex.error ? [] : ex.data;
  tripAttractions = att.error ? [] : att.data;
  tripTransportation = trans.error ? [] : trans.data;
  tripLodging = lodge.error ? [] : lodge.data;
  tripNotes = notes.error ? [] : notes.data;
}

function renderTripDetail() {
  const t = allTrips.find((x) => x.id === currentTripId);
  if (!t) return;
  document.getElementById('trip-detail-name').textContent = t.name;
  const typeLabel = t.type === 'business' ? '出差' : '私人旅遊';
  const dateRange = [t.start_date, t.end_date].filter(Boolean).join(' ~ ');
  document.getElementById('trip-detail-meta').textContent = [typeLabel, dateRange, t.destination].filter(Boolean).join(' · ');

  const totals = {};
  tripExpenses.forEach((e) => { totals[e.currency] = (totals[e.currency] || 0) + Number(e.amount); });
  const totalText = Object.entries(totals).map(([cur, amt]) => fmtMoney(amt, cur)).join('　') || '尚無花費紀錄';
  document.getElementById('trip-detail-total').textContent = '總花費：' + totalText;

  document.getElementById('trip-settle-btn').style.display = (t.type === 'personal' && tripExpenses.length > 0) ? 'block' : 'none';
  document.getElementById('trip-settle-status').textContent = '';

  renderTripExpenses();
  renderTripAttractions();
  renderTripTransportation();
  renderTripLodging();
  renderTripNotes();
}

const TRIP_SUBTABS = ['expenses', 'attractions', 'transportation', 'lodging', 'notes'];

function switchTripSubTab(sub) {
  const showAll = sub === 'all';
  TRIP_SUBTABS.forEach((s) => {
    document.getElementById('trip-subtab-' + s).style.display = (showAll || s === sub) ? 'block' : 'none';
    document.querySelector('#trip-subtab-' + s + ' form').style.display = showAll ? 'none' : '';
    document.querySelector('#trip-subtab-' + s + ' .trip-subtab-heading').style.display = showAll ? 'block' : 'none';
  });
  document.querySelectorAll('#trip-subtab-toggle .type-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.subtab === sub);
  });
}
document.querySelectorAll('#trip-subtab-toggle .type-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTripSubTab(btn.dataset.subtab));
});

function buildTripSubRow(nameText, metaText, onDelete, onEdit) {
  const row = document.createElement('div');
  row.className = 'account-row';
  const info = document.createElement('div');
  info.className = 'account-info';
  const name = document.createElement('p');
  name.className = 'account-name';
  name.textContent = nameText;
  const meta = document.createElement('p');
  meta.className = 'account-meta';
  meta.textContent = metaText;
  info.appendChild(name);
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'cat-actions';

  if (onEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '編輯';
    editBtn.addEventListener('click', onEdit);
    actions.appendChild(editBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.textContent = '刪';
  delBtn.addEventListener('click', onDelete);
  actions.appendChild(delBtn);

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

function tripDateTimeToISO(dateStr, timeStr) {
  if (!dateStr) return null;
  const t = timeStr && /^[0-2][0-9]:[0-5][0-9]$/.test(timeStr) ? timeStr : '00:00';
  return new Date(`${dateStr}T${t}:00`).toISOString();
}
function isoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isoToTimeInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatTripDateTime24(iso) {
  if (!iso) return '';
  return `${isoToDateInput(iso)} ${isoToTimeInput(iso)}`;
}

let editingTripExpenseId = null;

function renderTripExpenses() {
  const container = document.getElementById('trip-expense-list');
  container.innerHTML = '';
  if (!tripExpenses.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '還沒有花費紀錄';
    container.appendChild(hint);
    return;
  }
  tripExpenses.forEach((e) => {
    const row = buildTripSubRow(
      e.category + '　' + fmtMoney(e.amount, e.currency) + (e.place ? '・' + e.place : ''),
      [e.expense_date, e.note].filter(Boolean).join('・'),
      async () => { await sbDeleteHard('trip_expenses', e.id); await loadTripSubData(); renderTripDetail(); },
      () => startEditTripExpense(e)
    );
    container.appendChild(row);
  });
}

function startEditTripExpense(e) {
  editingTripExpenseId = e.id;
  document.getElementById('trip-expense-amount').value = e.amount;
  document.getElementById('trip-expense-currency').value = e.currency;
  document.getElementById('trip-expense-category').value = e.category;
  document.getElementById('trip-expense-date').value = e.expense_date || '';
  document.getElementById('trip-expense-place').value = e.place || '';
  document.getElementById('trip-expense-note').value = e.note || '';
  document.getElementById('trip-expense-submit').textContent = '更新花費';
  document.getElementById('trip-expense-cancel').style.display = 'inline-block';
}

function cancelEditTripExpense() {
  editingTripExpenseId = null;
  document.getElementById('trip-expense-form').reset();
  document.getElementById('trip-expense-submit').textContent = '新增花費';
  document.getElementById('trip-expense-cancel').style.display = 'none';
}
document.getElementById('trip-expense-cancel').addEventListener('click', cancelEditTripExpense);

document.getElementById('trip-expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('trip-expense-amount').value);
  if (!amount || amount <= 0) return;
  const fields = {
    amount,
    currency: document.getElementById('trip-expense-currency').value,
    category: document.getElementById('trip-expense-category').value,
    expense_date: document.getElementById('trip-expense-date').value || todayDateStr(),
    place: document.getElementById('trip-expense-place').value.trim() || null,
    note: document.getElementById('trip-expense-note').value.trim() || null
  };
  if (editingTripExpenseId) {
    await sbUpdate('trip_expenses', editingTripExpenseId, fields);
  } else {
    await sbInsert('trip_expenses', { trip_id: currentTripId, ...fields });
  }
  cancelEditTripExpense();
  await loadTripSubData();
  renderTripDetail();
});

let editingTripAttractionId = null;

function renderTripAttractions() {
  const container = document.getElementById('trip-attraction-list');
  container.innerHTML = '';
  if (!tripAttractions.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '還沒有景點紀錄';
    container.appendChild(hint);
    return;
  }
  tripAttractions.forEach((a) => {
    const row = buildTripSubRow(
      a.name + (a.rating ? '　' + '★'.repeat(a.rating) : ''),
      [a.visit_date, a.address, a.note].filter(Boolean).join('・'),
      async () => { await sbDeleteHard('trip_attractions', a.id); await loadTripSubData(); renderTripDetail(); },
      () => startEditTripAttraction(a)
    );
    container.appendChild(row);
  });
}

function startEditTripAttraction(a) {
  editingTripAttractionId = a.id;
  document.getElementById('trip-attraction-name').value = a.name;
  document.getElementById('trip-attraction-date').value = a.visit_date || '';
  document.getElementById('trip-attraction-address').value = a.address || '';
  document.getElementById('trip-attraction-rating').value = a.rating || '';
  document.getElementById('trip-attraction-note').value = a.note || '';
  document.getElementById('trip-attraction-submit').textContent = '更新景點';
  document.getElementById('trip-attraction-cancel').style.display = 'inline-block';
}

function cancelEditTripAttraction() {
  editingTripAttractionId = null;
  document.getElementById('trip-attraction-form').reset();
  document.getElementById('trip-attraction-submit').textContent = '新增景點';
  document.getElementById('trip-attraction-cancel').style.display = 'none';
}
document.getElementById('trip-attraction-cancel').addEventListener('click', cancelEditTripAttraction);

document.getElementById('trip-attraction-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('trip-attraction-name').value.trim();
  if (!name) return;
  const ratingVal = parseInt(document.getElementById('trip-attraction-rating').value, 10);
  const fields = {
    name,
    visit_date: document.getElementById('trip-attraction-date').value || null,
    address: document.getElementById('trip-attraction-address').value.trim() || null,
    rating: ratingVal >= 1 && ratingVal <= 5 ? ratingVal : null,
    note: document.getElementById('trip-attraction-note').value.trim() || null
  };
  if (editingTripAttractionId) {
    await sbUpdate('trip_attractions', editingTripAttractionId, fields);
  } else {
    await sbInsert('trip_attractions', { trip_id: currentTripId, ...fields });
  }
  cancelEditTripAttraction();
  await loadTripSubData();
  renderTripDetail();
});

let editingTripTransportationId = null;

function renderTripTransportation() {
  const container = document.getElementById('trip-transportation-list');
  container.innerHTML = '';
  if (!tripTransportation.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '還沒有交通紀錄';
    container.appendChild(hint);
    return;
  }
  tripTransportation.forEach((tr) => {
    const timeText = [formatTripDateTime24(tr.depart_at), formatTripDateTime24(tr.arrive_at)].filter(Boolean).join(' → ');
    const row = buildTripSubRow(
      tr.mode + ((tr.from_place || tr.to_place) ? '　' + (tr.from_place || '') + ' → ' + (tr.to_place || '') : ''),
      [timeText, tr.reference_no, tr.note].filter(Boolean).join('・'),
      async () => { await sbDeleteHard('trip_transportation', tr.id); await loadTripSubData(); renderTripDetail(); },
      () => startEditTripTransportation(tr)
    );
    container.appendChild(row);
  });
}

function startEditTripTransportation(tr) {
  editingTripTransportationId = tr.id;
  document.getElementById('trip-transportation-mode').value = tr.mode;
  document.getElementById('trip-transportation-from').value = tr.from_place || '';
  document.getElementById('trip-transportation-to').value = tr.to_place || '';
  document.getElementById('trip-transportation-depart-date').value = isoToDateInput(tr.depart_at);
  document.getElementById('trip-transportation-depart-time').value = isoToTimeInput(tr.depart_at);
  document.getElementById('trip-transportation-arrive-date').value = isoToDateInput(tr.arrive_at);
  document.getElementById('trip-transportation-arrive-time').value = isoToTimeInput(tr.arrive_at);
  document.getElementById('trip-transportation-ref').value = tr.reference_no || '';
  document.getElementById('trip-transportation-note').value = tr.note || '';
  document.getElementById('trip-transportation-submit').textContent = '更新交通紀錄';
  document.getElementById('trip-transportation-cancel').style.display = 'inline-block';
}

function cancelEditTripTransportation() {
  editingTripTransportationId = null;
  document.getElementById('trip-transportation-form').reset();
  document.getElementById('trip-transportation-submit').textContent = '新增交通紀錄';
  document.getElementById('trip-transportation-cancel').style.display = 'none';
}
document.getElementById('trip-transportation-cancel').addEventListener('click', cancelEditTripTransportation);

document.getElementById('trip-transportation-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {
    mode: document.getElementById('trip-transportation-mode').value,
    from_place: document.getElementById('trip-transportation-from').value.trim() || null,
    to_place: document.getElementById('trip-transportation-to').value.trim() || null,
    depart_at: tripDateTimeToISO(document.getElementById('trip-transportation-depart-date').value, document.getElementById('trip-transportation-depart-time').value),
    arrive_at: tripDateTimeToISO(document.getElementById('trip-transportation-arrive-date').value, document.getElementById('trip-transportation-arrive-time').value),
    reference_no: document.getElementById('trip-transportation-ref').value.trim() || null,
    note: document.getElementById('trip-transportation-note').value.trim() || null
  };
  if (editingTripTransportationId) {
    await sbUpdate('trip_transportation', editingTripTransportationId, fields);
  } else {
    await sbInsert('trip_transportation', { trip_id: currentTripId, ...fields });
  }
  cancelEditTripTransportation();
  await loadTripSubData();
  renderTripDetail();
});

let editingTripLodgingId = null;

function renderTripLodging() {
  const container = document.getElementById('trip-lodging-list');
  container.innerHTML = '';
  if (!tripLodging.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '還沒有食宿紀錄';
    container.appendChild(hint);
    return;
  }
  tripLodging.forEach((l) => {
    const stayRange = [l.check_in, l.check_out].filter(Boolean).join(' ~ ');
    const row = buildTripSubRow(
      l.name,
      [stayRange, l.address, l.reference_no, l.note].filter(Boolean).join('・'),
      async () => { await sbDeleteHard('trip_lodging', l.id); await loadTripSubData(); renderTripDetail(); },
      () => startEditTripLodging(l)
    );
    container.appendChild(row);
  });
}

function startEditTripLodging(l) {
  editingTripLodgingId = l.id;
  document.getElementById('trip-lodging-name').value = l.name;
  document.getElementById('trip-lodging-checkin').value = l.check_in || '';
  document.getElementById('trip-lodging-checkout').value = l.check_out || '';
  document.getElementById('trip-lodging-address').value = l.address || '';
  document.getElementById('trip-lodging-ref').value = l.reference_no || '';
  document.getElementById('trip-lodging-note').value = l.note || '';
  document.getElementById('trip-lodging-submit').textContent = '更新食宿';
  document.getElementById('trip-lodging-cancel').style.display = 'inline-block';
}

function cancelEditTripLodging() {
  editingTripLodgingId = null;
  document.getElementById('trip-lodging-form').reset();
  document.getElementById('trip-lodging-submit').textContent = '新增食宿';
  document.getElementById('trip-lodging-cancel').style.display = 'none';
}
document.getElementById('trip-lodging-cancel').addEventListener('click', cancelEditTripLodging);

document.getElementById('trip-lodging-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('trip-lodging-name').value.trim();
  if (!name) return;
  const fields = {
    name,
    check_in: document.getElementById('trip-lodging-checkin').value || null,
    check_out: document.getElementById('trip-lodging-checkout').value || null,
    address: document.getElementById('trip-lodging-address').value.trim() || null,
    reference_no: document.getElementById('trip-lodging-ref').value.trim() || null,
    note: document.getElementById('trip-lodging-note').value.trim() || null
  };
  if (editingTripLodgingId) {
    await sbUpdate('trip_lodging', editingTripLodgingId, fields);
  } else {
    await sbInsert('trip_lodging', { trip_id: currentTripId, ...fields });
  }
  cancelEditTripLodging();
  await loadTripSubData();
  renderTripDetail();
});

let editingTripNoteId = null;

function renderTripNotes() {
  const container = document.getElementById('trip-note-list');
  container.innerHTML = '';
  if (!tripNotes.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '還沒有記事';
    container.appendChild(hint);
    return;
  }
  tripNotes.forEach((n) => {
    const row = buildTripSubRow(
      n.content,
      n.note_date || '（未指定日期）',
      async () => { await sbDeleteHard('trip_notes', n.id); await loadTripSubData(); renderTripDetail(); },
      () => startEditTripNote(n)
    );
    container.appendChild(row);
  });
}

function startEditTripNote(n) {
  editingTripNoteId = n.id;
  document.getElementById('trip-note-date').value = n.note_date || '';
  document.getElementById('trip-note-content').value = n.content;
  document.getElementById('trip-note-submit').textContent = '更新記事';
  document.getElementById('trip-note-cancel').style.display = 'inline-block';
}

function cancelEditTripNote() {
  editingTripNoteId = null;
  document.getElementById('trip-note-form').reset();
  document.getElementById('trip-note-submit').textContent = '新增記事';
  document.getElementById('trip-note-cancel').style.display = 'none';
}
document.getElementById('trip-note-cancel').addEventListener('click', cancelEditTripNote);

document.getElementById('trip-note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = document.getElementById('trip-note-content').value.trim();
  if (!content) return;
  const fields = {
    note_date: document.getElementById('trip-note-date').value || null,
    content
  };
  if (editingTripNoteId) {
    await sbUpdate('trip_notes', editingTripNoteId, fields);
  } else {
    await sbInsert('trip_notes', { trip_id: currentTripId, ...fields });
  }
  cancelEditTripNote();
  await loadTripSubData();
  renderTripDetail();
});

document.getElementById('trip-edit-btn').addEventListener('click', () => {
  const t = allTrips.find((x) => x.id === currentTripId);
  if (!t) return;
  editingTripId = t.id;
  document.getElementById('trip-name').value = t.name;
  document.getElementById('trip-type').value = t.type;
  document.getElementById('trip-start-date').value = t.start_date || '';
  document.getElementById('trip-end-date').value = t.end_date || '';
  document.getElementById('trip-destination').value = t.destination || '';
  document.getElementById('trip-currency').value = t.currency;
  document.getElementById('trip-note').value = t.note || '';
  document.getElementById('trip-form-submit').textContent = '更新行程';
  document.getElementById('trip-form-title').textContent = '編輯行程';
  document.getElementById('trip-form-cancel').style.display = 'inline-block';
  currentTripId = null;
  document.getElementById('trip-detail-view').style.display = 'none';
  document.getElementById('trip-list-view').style.display = 'block';
});

document.getElementById('trip-delete-btn').addEventListener('click', async () => {
  const t = allTrips.find((x) => x.id === currentTripId);
  if (!t) return;
  if (!confirm(`確定要刪除「${t.name}」這個行程嗎？裡面所有花費/景點/交通/食宿/記事都會一併刪除，無法復原。`)) return;
  await sbDeleteHard('trips', t.id);
  currentTripId = null;
  document.getElementById('trip-detail-view').style.display = 'none';
  document.getElementById('trip-list-view').style.display = 'block';
  await loadTrips();
});

document.getElementById('trip-settle-btn').addEventListener('click', async () => {
  const t = allTrips.find((x) => x.id === currentTripId);
  if (!t) return;
  const statusEl = document.getElementById('trip-settle-status');

  const totals = {};
  tripExpenses.forEach((e) => { totals[e.currency] = (totals[e.currency] || 0) + Number(e.amount); });
  const primaryTotal = totals[t.currency] || 0;
  if (primaryTotal <= 0) {
    statusEl.textContent = `沒有${t.currency}幣別的花費可以結算，行程幣別設定跟花費幣別對不上時請先確認`;
    return;
  }
  const otherCurrencies = Object.keys(totals).filter((c) => c !== t.currency && totals[c] > 0);

  const marker = `[行程結算:${t.id}]`;
  const alreadySettled = allTransactions.some((tx) => (tx.note || '').includes(marker));
  if (alreadySettled) {
    if (!confirm('這個行程之前已經結算過一次了，確定要再記一筆嗎？（可能會重複計算）')) return;
  }

  const cashAccount = allAccounts.find((a) => !a.is_archived && a.name === '現金') || allAccounts.find((a) => !a.is_archived);
  if (!cashAccount) {
    statusEl.textContent = '目前帳本沒有可用的帳戶，請先到「帳戶」新增一個';
    return;
  }
  let category = allCategories.find((c) => c.type === 'expense' && c.name === '旅遊記錄');
  if (!category) {
    category = await sbInsert('categories', { name: '旅遊記錄', type: 'expense' });
    allCategories.push(category);
  }

  let note = `${marker} ${t.name} 總花費`;
  if (otherCurrencies.length) {
    note += `（另有 ${otherCurrencies.map((c) => fmtMoney(totals[c], c)).join('、')} 未併入，請自行處理）`;
  }

  await sbInsertTransaction({
    type: 'expense',
    amount: primaryTotal,
    category_id: category.id,
    account_id: cashAccount.id,
    merchant_id: null,
    transfer_to_account_id: null,
    transaction_date: todayDateStr(),
    note,
    client_generated_id: crypto.randomUUID(),
    ledger_id: currentLedgerId,
    recurring_rule_id: null
  });

  const ledgerName = (allLedgers.find((l) => l.id === currentLedgerId) || {}).name || '';
  statusEl.textContent = `已記一筆 ${fmtMoney(primaryTotal, t.currency)} 到「${ledgerName}」帳本的旅遊記錄分類` + (otherCurrencies.length ? '（其他幣別花費請自行處理）' : '');
  await refreshAll();
});

let dataInitialized = false;

async function initAppData() {
  if (dataInitialized) return;
  dataInitialized = true;
  await openDB();
  await seedDefaultsIfEmpty();
  await initLedgers();
  if (!isReadOnlyLedger()) {
    await seedAccountsForCurrentLedger();
  }
  renderLedgerSelect();
  await refreshAll();
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
}

supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    showResetPasswordScreen();
    return;
  }
  if (session) {
    currentUserId = session.user.id;
    showAppShell();
    initAppData();
  } else {
    currentUserId = null;
    dataInitialized = false;
    showAuthScreen();
  }
});

/* ---------- 離線狀態顯示 ---------- */
function updateOnlineBadge() {
  document.getElementById('offline-badge').style.display = navigator.onLine ? 'none' : 'inline-block';
}
window.addEventListener('online', () => {
  updateOnlineBadge();
  if (dataInitialized) refreshAll();
});
window.addEventListener('offline', updateOnlineBadge);

/* ---------- Service Worker 註冊 ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker 註冊失敗:', err);
    });
  });
}

/* ---------- 初始化 ---------- */
updateOnlineBadge();
