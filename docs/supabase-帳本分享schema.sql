-- ============================================
-- 個人記帳系統 — 帳本分享（唯讀）功能
-- 目的：帳本擁有者可以用email邀請其他已註冊帳號，
--       讓對方能「看」這本帳本(帳戶+交易+分類+商家+預算+定期定額)，
--       但完全不能新增/編輯/刪除任何資料。
-- 設計重點：
--   1. 不做「邀請/接受」流程 —— 擁有者只要輸入對方email存進
--      ledger_shares，對方只要用那個email登入，RLS就會立刻放行讀取，
--      不需要對方額外按「接受邀請」。
--   2. 讀取權限用email比對(auth.jwt()->>'email')，不需要查auth.users
--      表解析email對應的user_id，避免碰觸Supabase內建的auth schema。
--   3. 寫入權限完全不變，只有資料擁有者(user_id)本人能新增/修改/刪除，
--      這是最終的安全防線 —— 就算前端畫面沒有把按鈕藏乾淨，
--      資料庫這層還是會擋下來，不會真的被寫入。
-- 在Supabase的SQL Editor裡從上到下依序執行即可
-- ============================================

-- 1. 分享紀錄表
create table expense_app.ledger_shares (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references expense_app.ledgers(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  viewer_email text not null,
  created_at timestamptz not null default now(),
  unique (ledger_id, viewer_email)
);

alter table expense_app.ledger_shares enable row level security;

create policy "擁有者可以管理自己的分享紀錄" on expense_app.ledger_shares
  for all using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);

create policy "被分享者可以看到自己被分享的紀錄" on expense_app.ledger_shares
  for select using (lower(viewer_email) = lower(auth.jwt() ->> 'email'));

grant select, insert, update, delete on expense_app.ledger_shares to authenticated;

create index ledger_shares_ledger_idx on expense_app.ledger_shares (ledger_id);
create index ledger_shares_viewer_email_idx on expense_app.ledger_shares (viewer_email);

-- 2. 把 ledgers / accounts / transactions / budgets / recurring_rules
--    這5張「屬於某個帳本」的表，原本「讀寫都只認自己」的單一政策，
--    拆成「讀取：自己或被分享的人都可以」「寫入：只有自己」

-- ledgers
drop policy "個人資料只能自己存取" on expense_app.ledgers;

create policy "可讀取自己的或被分享的帳本" on expense_app.ledgers
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.ledger_id = ledgers.id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.ledgers
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.ledgers
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.ledgers
  for delete using (auth.uid() = user_id);

-- accounts
drop policy "個人資料只能自己存取" on expense_app.accounts;

create policy "可讀取自己的或被分享帳本底下的帳戶" on expense_app.accounts
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.ledger_id = accounts.ledger_id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.accounts
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.accounts
  for delete using (auth.uid() = user_id);

-- transactions
drop policy "個人資料只能自己存取" on expense_app.transactions;

create policy "可讀取自己的或被分享帳本底下的交易" on expense_app.transactions
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.ledger_id = transactions.ledger_id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.transactions
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.transactions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.transactions
  for delete using (auth.uid() = user_id);

-- budgets
drop policy "個人資料只能自己存取" on expense_app.budgets;

create policy "可讀取自己的或被分享帳本底下的預算" on expense_app.budgets
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.ledger_id = budgets.ledger_id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.budgets
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.budgets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.budgets
  for delete using (auth.uid() = user_id);

-- recurring_rules
drop policy "個人資料只能自己存取" on expense_app.recurring_rules;

create policy "可讀取自己的或被分享帳本底下的定期定額規則" on expense_app.recurring_rules
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.ledger_id = recurring_rules.ledger_id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.recurring_rules
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.recurring_rules
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.recurring_rules
  for delete using (auth.uid() = user_id);

-- 3. categories / merchants 是「跟著使用者、不跟著帳本」的表
--    (同一使用者的所有帳本共用同一組分類/商家)。
--    被分享帳本裡的交易，會引用「帳本擁有者」的分類/商家id，
--    所以被分享者也需要能讀到「帳本擁有者」的分類/商家，
--    不然交易列表會顯示不出分類/商家名稱。

-- categories
drop policy "個人資料只能自己存取" on expense_app.categories;

create policy "可讀取自己的或分享帳本擁有者的分類" on expense_app.categories
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.owner_user_id = categories.user_id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.categories
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.categories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.categories
  for delete using (auth.uid() = user_id);

-- merchants
drop policy "個人資料只能自己存取" on expense_app.merchants;

create policy "可讀取自己的或分享帳本擁有者的商家" on expense_app.merchants
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from expense_app.ledger_shares ls
      where ls.owner_user_id = merchants.user_id
      and lower(ls.viewer_email) = lower(auth.jwt() ->> 'email')
    )
  );
create policy "新增只限自己" on expense_app.merchants
  for insert with check (auth.uid() = user_id);
create policy "更新只限自己" on expense_app.merchants
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "刪除只限自己" on expense_app.merchants
  for delete using (auth.uid() = user_id);

-- ============================================
-- 這張新表建在既有的 expense_app schema 底下，
-- 不需要額外去Dashboard的「Exposed schemas」設定。
-- ============================================
