-- ============================================
-- 個人財產管理（財富管家擴充功能）
-- 狀態：已執行(2026-07-11)
-- ============================================

-- 資產主檔
create table expense_app.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null,          -- investment / real_estate / precious_metal / crypto / insurance / other
  currency text not null default 'TWD',
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- 資產估值快照：每次更新價值時新增一筆，不覆蓋舊資料，才有辦法畫趨勢圖
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

-- 負債主檔
create table expense_app.liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null,                 -- mortgage / car_loan / credit_card / student_loan / other
  original_principal numeric(14,2),
  interest_rate numeric(5,3),
  monthly_payment numeric(14,2),
  start_date date,
  term_months int,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- 負債餘額快照
create table expense_app.liability_snapshots (
  id uuid primary key default gen_random_uuid(),
  liability_id uuid not null references expense_app.liabilities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  remaining_balance numeric(14,2) not null,
  snapshot_date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (liability_id, snapshot_date)
);

alter table expense_app.assets enable row level security;
alter table expense_app.asset_snapshots enable row level security;
alter table expense_app.liabilities enable row level security;
alter table expense_app.liability_snapshots enable row level security;

create policy "個人資料只能自己存取" on expense_app.assets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.asset_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.liabilities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.liability_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on expense_app.assets to authenticated;
grant select, insert, update, delete on expense_app.asset_snapshots to authenticated;
grant select, insert, update, delete on expense_app.liabilities to authenticated;
grant select, insert, update, delete on expense_app.liability_snapshots to authenticated;

-- 淨資產計算邏輯（不存欄位，用查詢/前端動態算）：
-- 淨資產 = Σ(每項資產最新一筆asset_snapshots.value，只計台幣)
--          + Σ(所有台幣現金/銀行帳戶即時餘額，來自記帳系統accounts+transactions)
--          − Σ(每筆負債最新一筆liability_snapshots.remaining_balance)
