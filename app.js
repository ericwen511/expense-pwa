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
  const { count, error } = await supabaseClient.from(table).select('*', { count: 'exact', head: true });
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

function ledgerStorageKey() {
  return 'expensePwa_currentLedger_' + currentUserId;
}

async function initLedgers() {
  allLedgers = await sbGetAllLedgers();
  if (!allLedgers.length) {
    const inserted = await sbInsert('ledgers', { name: '個人帳本', currency: 'TWD', is_archived: false });
    allLedgers = [inserted];
  }
  const saved = localStorage.getItem(ledgerStorageKey());
  const active = allLedgers.filter((l) => !l.is_archived);
  const found = allLedgers.find((l) => l.id === saved && !l.is_archived);
  currentLedgerId = found ? found.id : (active[0] || allLedgers[0]).id;
  localStorage.setItem(ledgerStorageKey(), currentLedgerId);
}

async function reloadLedgers() {
  allLedgers = await sbGetAllLedgers();
  renderLedgerSelect();
  renderLedgerManagement();
}

function renderLedgerSelect() {
  const sel = document.getElementById('ledger-select');
  const active = allLedgers.filter((l) => !l.is_archived);
  sel.innerHTML = active.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  sel.value = currentLedgerId;
}

async function switchLedger(ledgerId) {
  currentLedgerId = ledgerId;
  localStorage.setItem(ledgerStorageKey(), currentLedgerId);
  await seedAccountsForCurrentLedger();
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
    const row = document.createElement('div');
    row.className = 'account-row' + (l.is_archived ? ' archived' : '');

    const info = document.createElement('div');
    info.className = 'account-info';
    const name = document.createElement('p');
    name.className = 'account-name';
    name.textContent = l.name + (l.is_archived ? '（已封存）' : '') + (l.id === currentLedgerId ? '（使用中）' : '');
    info.appendChild(name);

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
      const activeCount = allLedgers.filter((x) => !x.is_archived).length;
      if (willArchive && activeCount <= 1) {
        alert('至少要保留一本啟用中的帳本');
        return;
      }
      await sbUpdate('ledgers', l.id, { is_archived: willArchive });
      if (willArchive && l.id === currentLedgerId) {
        allLedgers = await sbGetAllLedgers();
        const nextActive = allLedgers.find((x) => !x.is_archived);
        await switchLedger(nextActive.id);
      }
      await reloadLedgers();
    });
    actions.appendChild(toggleBtn);

    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
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
const WEALTH_ASSET_CATEGORY_LABELS = { investment: '投資', real_estate: '不動產', insurance: '保單', other: '其他' };
const WEALTH_LIABILITY_TYPE_LABELS = { mortgage: '房貸', car_loan: '車貸', credit_card: '信用卡', student_loan: '學貸', other: '其他' };
const WEALTH_DONUT_COLORS = { cash: '#6E7C94', investment: '#C9A25D', real_estate: '#8DA37E', insurance: '#B5715A', other: '#5B6478' };

document.getElementById('w-asset-date').value = todayDateStr();
document.getElementById('w-liability-date').value = todayDateStr();

async function loadWealthData() {
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
}

function computeWealthAccountBalance(accountId, initialBalance) {
  let total = initialBalance || 0;
  allWealthTransactions.forEach((t) => {
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
  const activeAccounts = allWealthAccounts.filter((a) => !a.is_archived);
  const twdCash = activeAccounts
    .filter((a) => (a.currency || 'TWD') === 'TWD')
    .reduce((sum, a) => sum + computeWealthAccountBalance(a.id, a.initial_balance), 0);

  const activeAssets = allAssets.filter((a) => !a.is_archived);
  const assetTotalsByCategory = { investment: 0, real_estate: 0, insurance: 0, other: 0 };
  activeAssets.forEach((a) => {
    if ((a.currency || 'TWD') !== 'TWD') return;
    const snap = latestSnapshot(allAssetSnapshots, 'asset_id', a.id);
    const value = snap ? Number(snap.value) : 0;
    assetTotalsByCategory[a.category] = (assetTotalsByCategory[a.category] || 0) + value;
  });

  const activeLiabilities = allLiabilities.filter((l) => !l.is_archived);
  const totalLiabilities = activeLiabilities.reduce((sum, l) => {
    const snap = latestSnapshot(allLiabilitySnapshots, 'liability_id', l.id);
    return sum + (snap ? Number(snap.remaining_balance) : 0);
  }, 0);

  const totalAssets = twdCash + assetTotalsByCategory.investment + assetTotalsByCategory.real_estate
    + assetTotalsByCategory.insurance + assetTotalsByCategory.other;
  const netWorth = totalAssets - totalLiabilities;
  const debtRatio = totalAssets > 0 ? (totalLiabilities / totalAssets) * 100 : 0;

  document.getElementById('w-net-worth').textContent = fmtMoney(netWorth);
  document.getElementById('w-total-assets').textContent = fmtMoney(totalAssets);
  document.getElementById('w-total-liabilities').textContent = fmtMoney(totalLiabilities);
  document.getElementById('w-debt-ratio').textContent = debtRatio.toFixed(1) + '%';

  const donutEntries = [
    { key: 'cash', name: '現金', value: twdCash },
    { key: 'investment', name: '投資', value: assetTotalsByCategory.investment },
    { key: 'real_estate', name: '不動產', value: assetTotalsByCategory.real_estate },
    { key: 'insurance', name: '保單', value: assetTotalsByCategory.insurance },
    { key: 'other', name: '其他', value: assetTotalsByCategory.other }
  ].filter((e) => e.value > 0);
  renderWealthDonut(donutEntries, totalAssets);

  renderWealthAccountList(activeAccounts);
  renderWealthOverviewAssetList(activeAssets);
  renderWealthOverviewLiabilityList(activeLiabilities);
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

  activeAccounts.forEach((a) => {
    const balance = computeWealthAccountBalance(a.id, a.initial_balance);
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
    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value';
    valueEl.textContent = fmtMoney(snap ? Number(snap.value) : 0, a.currency);
    row.appendChild(info);
    row.appendChild(valueEl);
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

    const valueEl = document.createElement('div');
    valueEl.className = 'w-item-value';
    valueEl.textContent = fmtMoney(snap ? Number(snap.value) : 0, a.currency);

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
    row.appendChild(valueEl);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function startEditWealthAsset(a) {
  editingAssetId = a.id;
  document.getElementById('w-asset-name').value = a.name;
  document.getElementById('w-asset-category').value = a.category;
  document.getElementById('w-asset-currency').value = a.currency;
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
  document.getElementById('w-asset-form-submit').textContent = '新增資產';
  document.getElementById('w-asset-form-cancel').style.display = 'none';
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

  let assetId = editingAssetId;
  if (assetId) {
    await sbUpdate('assets', assetId, { name, category, currency });
  } else {
    const inserted = await sbInsert('assets', { name, category, currency, is_archived: false });
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
      editBtn.className = 'tx-edit';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => startEditTransaction(t));
      actions.appendChild(editBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'tx-delete';
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

  const merchantSelect = document.getElementById('tx-merchant');
  const currentMerchant = merchantSelect.value;
  merchantSelect.innerHTML = '<option value="">不指定</option>' +
    allMerchants.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  merchantSelect.value = currentMerchant;
}

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

  allAccounts.forEach((a) => {
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
    actions.className = 'cat-actions';

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

let dataInitialized = false;

async function initAppData() {
  if (dataInitialized) return;
  dataInitialized = true;
  await openDB();
  await seedDefaultsIfEmpty();
  await initLedgers();
  await seedAccountsForCurrentLedger();
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
