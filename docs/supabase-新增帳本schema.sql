-- ============================================
-- 個人記帳系統 — 新增「帳本」(ledgers) 功能
-- 目的：同一個帳號底下可以開多本帳(例如「個人」、「家庭共同基金」)，
--       帳戶跟交易彼此隔離；分類、商家維持共用(不分帳本)。
-- 在Supabase的SQL Editor裡從上到下依序執行即可
-- ============================================

-- 1. 建立帳本表
create table expense_app.ledgers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  currency text not null default 'TWD',
  is_archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table expense_app.ledgers enable row level security;

create policy "個人資料只能自己存取" on expense_app.ledgers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on expense_app.ledgers to authenticated;

-- 2. 幫每個目前已經有資料的使用者，建一本預設帳本叫「個人」
insert into expense_app.ledgers (user_id, name)
select distinct user_id, '個人'
from (
  select user_id from expense_app.accounts
  union
  select user_id from expense_app.transactions
) existing_users;

-- 3. 帳戶、交易加上 ledger_id 欄位(分類、商家維持共用，不加這個欄位)
alter table expense_app.accounts add column ledger_id uuid references expense_app.ledgers(id) on delete cascade;
alter table expense_app.transactions add column ledger_id uuid references expense_app.ledgers(id) on delete cascade;

-- 4. 把現有資料backfill到剛剛建立的「個人」帳本
update expense_app.accounts a
set ledger_id = l.id
from expense_app.ledgers l
where l.user_id = a.user_id and l.name = '個人';

update expense_app.transactions t
set ledger_id = l.id
from expense_app.ledgers l
where l.user_id = t.user_id and l.name = '個人';

-- 5. backfill完成後，設成NOT NULL避免以後漏帶ledger_id
alter table expense_app.accounts alter column ledger_id set not null;
alter table expense_app.transactions alter column ledger_id set not null;

-- 6. 加索引，之後依帳本查詢比較快
create index accounts_ledger_idx on expense_app.accounts (ledger_id);
create index transactions_ledger_idx on expense_app.transactions (ledger_id);

-- ============================================
-- 這次不需要額外去Dashboard設定「Exposed schemas」，
-- 因為ledgers表建在同一個expense_app schema底下，已經在之前設定的清單裡了。
-- ============================================
