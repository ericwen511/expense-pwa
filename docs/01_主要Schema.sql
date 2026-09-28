-- ============================================================
-- 財智管家 FinPilot — 主要 Schema（現況完整版，合併自 docs/ 底下歷次 migration）
--
-- 用途：在一個全新的 Supabase 專案上，從上到下依序執行這一份檔案，
-- 就能得到跟正式站現在完全一樣的資料庫結構——不需要再去找散落的
-- 8 個歷史 migration 檔案、也不需要理解它們的先後順序。
--
-- 這份檔案是「現況快照」，不是「migration歷史」：
--   - 舊 migration 裡「先建欄位、backfill 舊資料、再設 NOT NULL」
--     這類只有在「既有資料庫上加欄位」才需要的步驟，這裡已經省略，
--     欄位直接寫進 CREATE TABLE。
--   - 舊 migration 裡「drop policy 再 create 新的」這類只有在
--     「既有政策上修改」才需要的步驟，這裡也已經省略，直接列出
--     最終版本的政策。
--   - 歷史 migration 檔案本身不用刪除，繼續留著當作「這個資料庫
--     是怎麼演變過來的」歷史紀錄即可，但重建一個新環境時只需要
--     跑這一份檔案。
--
-- 執行完這份檔案後，還有一個步驟「無法用SQL完成」，必須自己到
-- Supabase Dashboard手動點一次，詳見檔案最下方的說明。
-- ============================================================

-- ============================================================
-- 0. Schema
-- ============================================================
create schema if not exists expense_app;

-- ============================================================
-- 1. 資料表定義（依外鍵相依順序排列）
-- ============================================================

-- 1.1 帳本：同一帳號底下可以開多本帳(個人/家庭共同基金等)，
--     帳戶跟交易彼此隔離；分類、商家是「跟著使用者」不跟著帳本，全部帳本共用。
create table expense_app.ledgers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  currency text not null default 'TWD',
  is_archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 1.2 帳戶（現金/銀行/信用卡/外幣帳戶等）
create table expense_app.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  name text not null,
  type text not null default 'cash',        -- cash / bank / credit_card / other
  currency text not null default 'TWD',     -- TWD / USD / EUR / CNY / JPY
  initial_balance numeric(14,2) not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- 1.3 分類（跨帳本共用，不分帳本）
create table expense_app.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null,                       -- expense / income
  parent_id uuid references expense_app.categories(id) on delete set null,  -- 子分類欄位，目前UI尚未使用階層功能，保留供未來擴充
  icon text,
  color text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 1.4 商家（跨帳本共用，不分帳本）
create table expense_app.merchants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- 1.5 定期定額交易規則（每月固定發生一次，例如房租、薪水）
--     順序上要放在 transactions 之前，因為 transactions.recurring_rule_id 會參照它
create table expense_app.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  type text not null,                       -- expense / income / transfer
  amount numeric(14,2) not null,
  category_id uuid references expense_app.categories(id) on delete set null,
  account_id uuid not null references expense_app.accounts(id) on delete cascade,
  transfer_to_account_id uuid references expense_app.accounts(id) on delete cascade,
  merchant_id uuid references expense_app.merchants(id) on delete set null,
  note text,
  day_of_month int not null,
  start_date date not null,
  end_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 1.6 交易紀錄（支出/收入/轉帳）
create table expense_app.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  account_id uuid not null references expense_app.accounts(id) on delete restrict,
  category_id uuid references expense_app.categories(id) on delete set null,
  merchant_id uuid references expense_app.merchants(id) on delete set null,
  type text not null,                       -- expense / income / transfer
  amount numeric(14,2) not null,
  transaction_date date not null default current_date,
  note text,
  transfer_to_account_id uuid references expense_app.accounts(id),
  transfer_to_amount numeric(14,2),         -- 轉出/轉入金額不同時使用(換匯轉帳)，同幣別轉帳留空即可
  recurring_rule_id uuid references expense_app.recurring_rules(id) on delete set null,
  client_generated_id uuid,
  deleted_at timestamptz,                   -- 軟刪除欄位(交易用軟刪除，其餘表都是硬刪除)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1.7 每月預算（單一總預算，不分類別）
create table expense_app.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  year_month text not null,                 -- 格式 'YYYY-MM'
  amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, year_month)
);

-- 1.8 帳本分享（唯讀）：擁有者用email邀請他人查看整本帳本
create table expense_app.ledger_shares (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  viewer_email text not null,
  created_at timestamptz not null default now(),
  unique (ledger_id, viewer_email)
);

-- 1.9 財富管家：資產（investment/real_estate/precious_metal/crypto/insurance/other）
create table expense_app.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null,                   -- investment / real_estate / precious_metal / crypto / insurance / other
  currency text not null default 'TWD',
  is_archived boolean not null default false,
  market text,                              -- us / tw / cn，只有 category=investment 才會用到
  stock_symbol text,
  shares numeric(14,4),
  cost_per_share numeric(14,4),
  created_at timestamptz not null default now()
);

-- 1.10 資產估值快照：每次更新價值時新增一筆，不覆蓋舊資料，才能畫趨勢圖
create table expense_app.asset_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references expense_app.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  value numeric(14,2) not null,
  snapshot_date date not null default current_date,
  note text,
  created_at timestamptz not null default now(),
  unique (asset_id, snapshot_date)
);

-- 1.11 財富管家：負債（mortgage/car_loan/credit_card/student_loan/other）
create table expense_app.liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null,
  original_principal numeric(14,2),
  interest_rate numeric(5,3),
  monthly_payment numeric(14,2),
  start_date date,
  term_months int,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- 1.12 負債餘額快照
create table expense_app.liability_snapshots (
  id uuid primary key default gen_random_uuid(),
  liability_id uuid not null references expense_app.liabilities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  remaining_balance numeric(14,2) not null,
  snapshot_date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (liability_id, snapshot_date)
);

-- 1.13 出差/旅遊行程（跟記帳/財富管家完全獨立的一組表，見02文件「出差旅遊行程」章節說明）
create table expense_app.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'personal',    -- business / personal
  start_date date,
  end_date date,
  destination text,
  currency text not null default 'TWD',
  note text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table expense_app.trip_expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(14,2) not null,
  currency text not null default 'TWD',
  category text not null,                   -- 交通/住宿/餐飲/景點門票/購物/其他
  expense_date date not null default current_date,
  place text,
  note text,
  created_at timestamptz not null default now()
);

create table expense_app.trip_attractions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  visit_date date,
  address text,
  rating int,
  note text,
  created_at timestamptz not null default now()
);

create table expense_app.trip_transportation (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,                       -- 飛機/高鐵/火車/捷運/計程車/租車/其他
  from_place text,
  to_place text,
  depart_at timestamptz,
  arrive_at timestamptz,
  reference_no text,
  note text,
  created_at timestamptz not null default now()
);

create table expense_app.trip_lodging (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  check_in date,
  check_out date,
  address text,
  reference_no text,
  note text,
  created_at timestamptz not null default now()
);

create table expense_app.trip_notes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_date date,
  content text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. 索引
-- ============================================================
create unique index transactions_client_id_unique
  on expense_app.transactions (user_id, client_generated_id)
  where client_generated_id is not null;

create index transactions_user_date_idx on expense_app.transactions (user_id, transaction_date desc);
create index transactions_user_category_idx on expense_app.transactions (user_id, category_id);
create index transactions_user_account_idx on expense_app.transactions (user_id, account_id);
create index transactions_ledger_idx on expense_app.transactions (ledger_id);
create index transactions_recurring_rule_idx on expense_app.transactions (recurring_rule_id);

create index accounts_ledger_idx on expense_app.accounts (ledger_id);

create index ledger_shares_ledger_idx on expense_app.ledger_shares (ledger_id);
create index ledger_shares_viewer_email_idx on expense_app.ledger_shares (viewer_email);

create index trip_expenses_trip_idx on expense_app.trip_expenses (trip_id);
create index trip_attractions_trip_idx on expense_app.trip_attractions (trip_id);
create index trip_transportation_trip_idx on expense_app.trip_transportation (trip_id);
create index trip_lodging_trip_idx on expense_app.trip_lodging (trip_id);
create index trip_notes_trip_idx on expense_app.trip_notes (trip_id);

-- ============================================================
-- 3. 開啟 RLS（每一張表都要開，是踩過的坑：漏開一張就等於整張表對外公開）
-- ============================================================
alter table expense_app.ledgers enable row level security;
alter table expense_app.accounts enable row level security;
alter table expense_app.categories enable row level security;
alter table expense_app.merchants enable row level security;
alter table expense_app.recurring_rules enable row level security;
alter table expense_app.transactions enable row level security;
alter table expense_app.budgets enable row level security;
alter table expense_app.ledger_shares enable row level security;
alter table expense_app.assets enable row level security;
alter table expense_app.asset_snapshots enable row level security;
alter table expense_app.liabilities enable row level security;
alter table expense_app.liability_snapshots enable row level security;
alter table expense_app.trips enable row level security;
alter table expense_app.trip_expenses enable row level security;
alter table expense_app.trip_attractions enable row level security;
alter table expense_app.trip_transportation enable row level security;
alter table expense_app.trip_lodging enable row level security;
alter table expense_app.trip_notes enable row level security;

-- ============================================================
-- 4. RLS 政策（現況最終版）
-- ============================================================

-- 4.1 帳本相關 5 張表：ledgers / accounts / transactions / budgets / recurring_rules
--     讀取：自己的，或是自己被分享(ledger_shares)的帳本底下的資料都可以看
--     寫入(新增/更新/刪除)：永遠只認 user_id 本人，被分享者完全不能寫
create policy "可讀取自己的或被分享的帳本" on expense_app.ledgers
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.ledger_id = ledgers.id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.ledgers for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.ledgers for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.ledgers for delete using (auth.uid() = user_id);

create policy "可讀取自己的或被分享帳本底下的帳戶" on expense_app.accounts
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.ledger_id = accounts.ledger_id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.accounts for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.accounts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.accounts for delete using (auth.uid() = user_id);

create policy "可讀取自己的或被分享帳本底下的交易" on expense_app.transactions
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.ledger_id = transactions.ledger_id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.transactions for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.transactions for delete using (auth.uid() = user_id);

create policy "可讀取自己的或被分享帳本底下的預算" on expense_app.budgets
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.ledger_id = budgets.ledger_id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.budgets for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.budgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.budgets for delete using (auth.uid() = user_id);

create policy "可讀取自己的或被分享帳本底下的定期定額規則" on expense_app.recurring_rules
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.ledger_id = recurring_rules.ledger_id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.recurring_rules for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.recurring_rules for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.recurring_rules for delete using (auth.uid() = user_id);

-- 4.2 categories / merchants：跟著使用者、不跟著帳本，被分享者要能讀到「帳本擁有者」的分類/商家
--     (否則被分享帳本裡的交易，畫面上顯示不出分類/商家名稱)
create policy "可讀取自己的或分享帳本擁有者的分類" on expense_app.categories
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.owner_user_id = categories.user_id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.categories for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.categories for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.categories for delete using (auth.uid() = user_id);

create policy "可讀取自己的或分享帳本擁有者的商家" on expense_app.merchants
  for select using (
    auth.uid() = user_id
    or exists (select 1 from expense_app.ledger_shares ls where ls.owner_user_id = merchants.user_id and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email'))
  );
create policy "新增只限自己" on expense_app.merchants for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.merchants for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.merchants for delete using (auth.uid() = user_id);

-- 4.3 ledger_shares 本身
create policy "擁有者可以管理自己的分享紀錄" on expense_app.ledger_shares
  for all using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);
create policy "被分享者可以看到自己被分享的紀錄" on expense_app.ledger_shares
  for select using (lower(viewer_email) = lower(auth.jwt() ->> 'email'));

-- 4.4 財富管家（資產/負債）：不做分享，永遠只認自己
create policy "個人資料只能自己存取" on expense_app.assets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.asset_snapshots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.liabilities for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.liability_snapshots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 4.5 出差/旅遊行程：不做分享，永遠只認自己
create policy "個人資料只能自己存取" on expense_app.trips for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_expenses for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_attractions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_transportation for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_lodging for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 5. 授權（GRANT）——【全專案踩過最多次的坑，共6次】
-- 光有 RLS 政策不夠！沒有這一段，一律會遇到
-- "permission denied for schema expense_app" 或 "Invalid API key" 之類的錯誤，
-- 而且錯誤訊息完全看不出來是漏了 GRANT，很容易誤以為是 RLS 政策寫錯。
-- 每新增一張表，都要記得幫它補上對應的 GRANT，這裡列出目前全部的表。
-- ============================================================
grant usage on schema expense_app to authenticated;

grant select, insert, update, delete on expense_app.ledgers to authenticated;
grant select, insert, update, delete on expense_app.accounts to authenticated;
grant select, insert, update, delete on expense_app.categories to authenticated;
grant select, insert, update, delete on expense_app.merchants to authenticated;
grant select, insert, update, delete on expense_app.recurring_rules to authenticated;
grant select, insert, update, delete on expense_app.transactions to authenticated;
grant select, insert, update, delete on expense_app.budgets to authenticated;
grant select, insert, update, delete on expense_app.ledger_shares to authenticated;
grant select, insert, update, delete on expense_app.assets to authenticated;
grant select, insert, update, delete on expense_app.asset_snapshots to authenticated;
grant select, insert, update, delete on expense_app.liabilities to authenticated;
grant select, insert, update, delete on expense_app.liability_snapshots to authenticated;
grant select, insert, update, delete on expense_app.trips to authenticated;
grant select, insert, update, delete on expense_app.trip_expenses to authenticated;
grant select, insert, update, delete on expense_app.trip_attractions to authenticated;
grant select, insert, update, delete on expense_app.trip_transportation to authenticated;
grant select, insert, update, delete on expense_app.trip_lodging to authenticated;
grant select, insert, update, delete on expense_app.trip_notes to authenticated;

-- ============================================================
-- 6.【無法用SQL完成、一定要手動做的最後一步】
--
-- 到 Supabase Dashboard → Settings → API → 找到「Exposed schemas」，
-- 把 expense_app 加進去（預設只暴露 public 這個schema給API使用，
-- 我們的表都建在 expense_app 底下，不加這一步，前端呼叫一律會
-- 收到 404 或「schema must be one of the following: public」錯誤）。
--
-- 這一步是Dashboard介面設定，任何AI都沒辦法用程式碼/SQL幫你做，
-- 一定要自己手動點一次。詳細操作流程見 03_環境建置SOP.md。
-- ============================================================
