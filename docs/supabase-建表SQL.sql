-- ============================================
-- 個人記帳系統 — Supabase 完整建表SQL
-- 整合實測踩坑後學到的規則（schema獨立 + 明確授權）
-- 在Supabase的SQL Editor裡從上到下依序執行即可
-- ============================================

-- 1. 建立獨立schema，避免跟Personal data專案裡其他App（notes等）的表混在一起
create schema if not exists expense_app;

-- 2. 核心資料表
create table expense_app.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'cash',
  currency text not null default 'TWD',
  initial_balance numeric(14,2) not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table expense_app.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null,
  parent_id uuid references expense_app.categories(id) on delete set null,
  icon text,
  color text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 商家（PWA測試版後來加的功能，原設計文件沒有，這裡補上）
create table expense_app.merchants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table expense_app.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references expense_app.accounts(id) on delete restrict,
  category_id uuid references expense_app.categories(id) on delete set null,
  merchant_id uuid references expense_app.merchants(id) on delete set null,
  type text not null,
  amount numeric(14,2) not null,
  transaction_date date not null default current_date,
  note text,
  transfer_to_account_id uuid references expense_app.accounts(id),
  client_generated_id uuid,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index transactions_client_id_unique
  on expense_app.transactions (user_id, client_generated_id)
  where client_generated_id is not null;

create index transactions_user_date_idx on expense_app.transactions (user_id, transaction_date desc);
create index transactions_user_category_idx on expense_app.transactions (user_id, category_id);
create index transactions_user_account_idx on expense_app.transactions (user_id, account_id);

-- 3. 開啟RLS
alter table expense_app.accounts enable row level security;
alter table expense_app.categories enable row level security;
alter table expense_app.merchants enable row level security;
alter table expense_app.transactions enable row level security;

-- 4. RLS政策：只能存取自己的資料
create policy "個人資料只能自己存取" on expense_app.accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "個人資料只能自己存取" on expense_app.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "個人資料只能自己存取" on expense_app.merchants
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "個人資料只能自己存取" on expense_app.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 5. 【實測踩坑學到的關鍵一步】明確授權
-- 光有上面的RLS政策不夠，一定要額外用GRANT明確授權，不然一樣會遇到
-- "permission denied" 或 "Invalid API key" 這類錯誤
-- 注意：這裡授權給 authenticated（登入後的使用者角色），不是anon，
-- 因為記帳系統的使用者一定要先登入才能操作，跟keepalive_ping那種
-- 匿名也能讀的情境不一樣
grant usage on schema expense_app to authenticated;

grant select, insert, update, delete on expense_app.accounts to authenticated;
grant select, insert, update, delete on expense_app.categories to authenticated;
grant select, insert, update, delete on expense_app.merchants to authenticated;
grant select, insert, update, delete on expense_app.transactions to authenticated;

-- ============================================
-- 以上執行完，還有一步「無法用SQL完成」，
-- 需要回Supabase Dashboard手動做：
--
-- Settings → API → 找到「Exposed schemas」
-- 把 expense_app 加進去（預設只暴露public這個schema給API使用）
--
-- 這一步Claude Code沒辦法用程式碼幫你做，
-- 是Dashboard介面設定，需要你自己手動點一次。
-- ============================================
