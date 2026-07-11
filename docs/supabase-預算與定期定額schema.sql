-- ============================================
-- 個人記帳系統 — 新增「每月預算」與「定期定額交易」功能
-- 在Supabase的SQL Editor裡從上到下依序執行即可
-- ============================================

-- 1. 每月預算（先做單一總預算，不分類別）
create table expense_app.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  year_month text not null,
  amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, year_month)
);

alter table expense_app.budgets enable row level security;

create policy "個人資料只能自己存取" on expense_app.budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on expense_app.budgets to authenticated;

-- 2. 定期定額交易規則（每月固定發生一次，例如房租、薪水）
create table expense_app.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  type text not null,
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

alter table expense_app.recurring_rules enable row level security;

create policy "個人資料只能自己存取" on expense_app.recurring_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on expense_app.recurring_rules to authenticated;

-- 3. 交易表加上「屬於哪個定期定額規則」的關聯欄位
alter table expense_app.transactions
  add column recurring_rule_id uuid references expense_app.recurring_rules(id) on delete set null;

create index transactions_recurring_rule_idx on expense_app.transactions (recurring_rule_id);

-- ============================================
-- 這兩張新表都建在既有的 expense_app schema 底下，
-- 不需要額外去Dashboard的「Exposed schemas」設定。
-- ============================================
