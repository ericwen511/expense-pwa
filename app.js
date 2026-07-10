/* ---------- IndexedDB 基礎層 ---------- */
const DB_NAME = 'expenseTrackerDB';
const DB_VERSION = 2;
let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('transactions')) {
        const store = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('merchants')) {
        db.createObjectStore('merchants', { keyPath: 'id', autoIncrement: true });
      }
    };

    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function txStore(storeName, mode) {
  return dbInstance.transaction(storeName, mode).objectStore(storeName);
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = txStore(storeName, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbAdd(storeName, obj) {
  return new Promise((resolve, reject) => {
    const req = txStore(storeName, 'readwrite').add(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const req = txStore(storeName, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbCount(storeName) {
  return new Promise((resolve, reject) => {
    const req = txStore(storeName, 'readonly').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- 預設資料（僅第一次使用時建立） ---------- */
async function seedDefaultsIfEmpty() {
  const catCount = await dbCount('categories');
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
    for (const c of defaults) await dbAdd('categories', c);
  }

  const accCount = await dbCount('accounts');
  if (accCount === 0) {
    const defaults = [
      { name: '現金', type: 'cash' },
      { name: '銀行帳戶', type: 'bank' },
      { name: '信用卡', type: 'credit_card' }
    ];
    for (const a of defaults) await dbAdd('accounts', a);
  }

  const merchantCount = await dbCount('merchants');
  if (merchantCount === 0) {
    const defaults = ['全聯', '星巴克', '萬家福', '樂家康'];
    for (const name of defaults) await dbAdd('merchants', { name });
  }
}

/* ---------- 全域狀態 ---------- */
let allCategories = [];
let allAccounts = [];
let allTransactions = [];
let allMerchants = [];
let currentTxType = 'expense';

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

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ---------- 金額格式化 ---------- */
function fmtMoney(n) {
  const rounded = Math.round(n);
  return '$' + rounded.toLocaleString('zh-Hant-TW');
}

/* ---------- 讀取所有資料並重繪畫面 ---------- */
async function refreshAll() {
  allCategories = await dbGetAll('categories');
  allAccounts = await dbGetAll('accounts');
  allMerchants = await dbGetAll('merchants');
  allTransactions = await dbGetAll('transactions');
  allTransactions.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));

  renderOverview();
  renderList();
  renderCategoryScreen();
  populateFormSelectors();
  populateFilterSelectors();
}

function categoryName(id) {
  const c = allCategories.find((c) => c.id === id);
  return c ? c.name : '未分類';
}

function accountName(id) {
  const a = allAccounts.find((a) => a.id === id);
  return a ? a.name : '';
}

function merchantName(id) {
  if (!id) return '';
  const m = allMerchants.find((m) => m.id === id);
  return m ? m.name : '';
}

/* ---------- 總覽畫面 ---------- */
function renderOverview() {
  const now = new Date();
  const ym = now.toISOString().slice(0, 7);
  document.getElementById('month-label').textContent =
    now.getFullYear() + '年' + (now.getMonth() + 1) + '月';

  const monthTx = allTransactions.filter((t) => t.date.slice(0, 7) === ym);
  const expense = monthTx.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const income = monthTx.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);

  document.getElementById('sum-expense').textContent = fmtMoney(expense);
  document.getElementById('sum-income').textContent = fmtMoney(income);
  document.getElementById('sum-balance').textContent = fmtMoney(income - expense);

  const list = document.getElementById('overview-list');
  const recent = allTransactions.slice(0, 5);
  list.innerHTML = '';
  document.getElementById('overview-empty').style.display = recent.length ? 'none' : 'block';
  recent.forEach((t) => list.appendChild(buildTxRow(t, false)));
}

/* ---------- 交易列表畫面 ---------- */
function renderList() {
  const keyword = (document.getElementById('search-input').value || '').trim().toLowerCase();
  const accFilter = document.getElementById('filter-account').value;
  const catFilter = document.getElementById('filter-category').value;

  let filtered = allTransactions.filter((t) => {
    if (accFilter && String(t.accountId) !== accFilter) return false;
    if (catFilter && String(t.categoryId) !== catFilter) return false;
    if (keyword) {
      const hay = ((t.note || '') + ' ' + categoryName(t.categoryId) + ' ' + merchantName(t.merchantId)).toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

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

function buildTxRow(t, showDelete) {
  const row = document.createElement('div');
  row.className = 'tx-row';

  const info = document.createElement('div');
  info.className = 'tx-info';
  const mName = merchantName(t.merchantId);
  const title = document.createElement('p');
  title.className = 'tx-title';
  title.textContent = t.note ? t.note : (mName || categoryName(t.categoryId));
  const meta = document.createElement('p');
  meta.className = 'tx-meta';
  meta.textContent = categoryName(t.categoryId) + (mName ? ' · ' + mName : '') + ' · ' + accountName(t.accountId);
  info.appendChild(title);
  info.appendChild(meta);

  const amount = document.createElement('p');
  amount.className = 'tx-amount ' + (t.type === 'expense' ? 'expense' : 'income');
  amount.textContent = (t.type === 'expense' ? '-' : '+') + fmtMoney(t.amount).replace('$', '$');

  row.appendChild(info);
  row.appendChild(amount);

  if (showDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'tx-delete';
    delBtn.textContent = '刪除';
    delBtn.addEventListener('click', async () => {
      await dbDelete('transactions', t.id);
      await refreshAll();
    });
    row.appendChild(delBtn);
  }

  return row;
}

document.getElementById('search-input').addEventListener('input', renderList);
document.getElementById('filter-account').addEventListener('change', renderList);
document.getElementById('filter-category').addEventListener('change', renderList);

/* ---------- 新增交易畫面 ---------- */
function setTxType(type) {
  currentTxType = type;
  document.getElementById('btn-expense').classList.toggle('active', type === 'expense');
  document.getElementById('btn-income').classList.toggle('active', type === 'income');
  populateFormSelectors();
}

document.getElementById('btn-expense').addEventListener('click', () => setTxType('expense'));
document.getElementById('btn-income').addEventListener('click', () => setTxType('income'));

function populateFormSelectors() {
  const catSelect = document.getElementById('tx-category');
  const relevant = allCategories.filter((c) => c.type === currentTxType);
  catSelect.innerHTML = relevant.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');

  const accSelect = document.getElementById('tx-account');
  accSelect.innerHTML = allAccounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');

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

  const record = {
    type: currentTxType,
    amount: amount,
    categoryId: Number(document.getElementById('tx-category').value),
    accountId: Number(document.getElementById('tx-account').value),
    merchantId: document.getElementById('tx-merchant').value ? Number(document.getElementById('tx-merchant').value) : null,
    date: document.getElementById('tx-date').value,
    note: document.getElementById('tx-note').value.trim(),
    createdAt: Date.now()
  };

  await dbAdd('transactions', record);
  e.target.reset();
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  await refreshAll();
  switchTab('overview');
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
    const actions = document.createElement('div');
    actions.className = 'cat-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'delete';
    delBtn.textContent = '刪除';
    delBtn.addEventListener('click', async () => {
      const inUse = allTransactions.some((t) => t.categoryId === c.id);
      if (inUse && !confirm('這個分類已有交易使用，確定要刪除嗎？（交易紀錄會保留但顯示為未分類）')) return;
      await dbDelete('categories', c.id);
      await refreshAll();
    });
    actions.appendChild(delBtn);
    row.appendChild(name);
    row.appendChild(actions);
    (c.type === 'expense' ? expenseList : incomeList).appendChild(row);
  });

  const merchantList = document.getElementById('merchant-list');
  merchantList.innerHTML = '';
  allMerchants.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const name = document.createElement('span');
    name.textContent = m.name;
    const actions = document.createElement('div');
    actions.className = 'cat-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'delete';
    delBtn.textContent = '刪除';
    delBtn.addEventListener('click', async () => {
      const inUse = allTransactions.some((t) => t.merchantId === m.id);
      if (inUse && !confirm('這個商家已有交易使用，確定要刪除嗎？（交易紀錄會保留但顯示為不指定商家）')) return;
      await dbDelete('merchants', m.id);
      await refreshAll();
    });
    actions.appendChild(delBtn);
    row.appendChild(name);
    row.appendChild(actions);
    merchantList.appendChild(row);
  });
}

async function addCategory(type, inputId) {
  const input = document.getElementById(inputId);
  const name = input.value.trim();
  if (!name) return;
  await dbAdd('categories', { name, type });
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
  await dbAdd('merchants', { name });
  input.value = '';
  await refreshAll();
});

/* ---------- 篩選下拉選單 ---------- */
function populateFilterSelectors() {
  const accSel = document.getElementById('filter-account');
  const currentAcc = accSel.value;
  accSel.innerHTML = '<option value="">全部帳戶</option>' +
    allAccounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
  accSel.value = currentAcc;

  const catSel = document.getElementById('filter-category');
  const currentCat = catSel.value;
  catSel.innerHTML = '<option value="">全部分類</option>' +
    allCategories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  catSel.value = currentCat;
}

/* ---------- 離線狀態顯示 ---------- */
function updateOnlineBadge() {
  document.getElementById('offline-badge').style.display = navigator.onLine ? 'none' : 'inline-block';
}
window.addEventListener('online', updateOnlineBadge);
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
(async function init() {
  await openDB();
  await seedDefaultsIfEmpty();
  await refreshAll();
  updateOnlineBadge();
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
})();
