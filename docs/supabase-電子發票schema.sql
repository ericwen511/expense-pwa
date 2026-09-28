-- ============================================
-- 個人記帳系統 — 電子發票（財政部載具）品項明細同步
-- 目的：從財政部電子發票整合服務平台，用手機條碼載具+驗證碼，
--       同步發票清單與完整品項明細(商品名稱/數量/單價)，純顯示用途，
--       不做商店/品項對應記帳分類，也不做自動記一筆到記帳系統。
--       跟記帳系統/財富管家/出差行程完全獨立的一組表。
-- 在Supabase的SQL Editor裡從上到下依序執行即可
-- ============================================

-- 1. 載具設定（載具號碼＋驗證碼，一個帳號通常只會存一組）
create table expense_app.einvoice_carriers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_no text not null,               -- 例如 /J1E5QO2
  card_encrypt text not null,          -- 財政部官網(einvoice.nat.gov.tw)設定的驗證碼，不是載具號碼本身
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, card_no)
);

-- 2. 同步下來的發票，品項明細直接用JSONB陣列存(不拆成獨立表)，
--    因為只是要顯示明細，不需要對品項另外做關聯查詢
create table expense_app.einvoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  inv_num text not null,               -- 發票號碼，例如 AB12345678
  inv_date date not null,
  seller_name text,
  seller_ban text,
  amount numeric(14,2),
  inv_status text,
  items jsonb not null default '[]'::jsonb,   -- [{description, quantity, unitPrice, amount}, ...]
  synced_at timestamptz not null default now(),
  unique (user_id, inv_num, inv_date)   -- 避免重複同步造成同一張發票存兩筆
);

alter table expense_app.einvoice_carriers enable row level security;
alter table expense_app.einvoices enable row level security;

create policy "個人資料只能自己存取" on expense_app.einvoice_carriers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.einvoices
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on expense_app.einvoice_carriers to authenticated;
grant select, insert, update, delete on expense_app.einvoices to authenticated;

create index einvoices_user_date_idx on expense_app.einvoices (user_id, inv_date desc);

-- ============================================
-- 這兩張新表都建在既有的 expense_app schema 底下，
-- 不需要額外去Dashboard的「Exposed schemas」設定。
--
-- 驗證碼是你自己在 einvoice.nat.gov.tw 用這個手機條碼載具登入後，
-- 在「載具設定」裡設定的一組密碼(不是載具號碼本身)，要先設定過
-- 這個功能才會抓得到完整品項明細；如果只有載具號碼、沒設定驗證碼，
-- 明細查詢API會失敗。
-- ============================================
