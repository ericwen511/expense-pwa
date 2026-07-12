-- ============================================
-- 個人記帳系統 — 出差/旅遊行程功能（第一版：文字記錄，不含拍照）
-- 目的：記錄出差/旅遊行程當中的花費/景點/交通/食宿/記事，
--       行程結束後可以看到一筆總花費。
--       跟記帳系統/財富管家完全獨立的一組表，只有「私人行程的
--       總花費」這一件事會產生一筆記帳系統的一般交易（分類選
--       「旅遊記錄」），其餘完全不互相關聯，之後要整組移除
--       這個功能也不會動到既有資料。
-- 在Supabase的SQL Editor裡從上到下依序執行即可
-- ============================================

-- 1. 行程主檔
create table expense_app.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'personal',  -- business / personal
  start_date date,
  end_date date,
  destination text,
  currency text not null default 'TWD',
  note text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2. 花費（會加總成行程總花費）
create table expense_app.trip_expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(14,2) not null,
  currency text not null default 'TWD',
  category text not null,  -- 交通/住宿/餐飲/景點門票/購物/其他
  expense_date date not null default current_date,
  place text,
  note text,
  created_at timestamptz not null default now()
);

-- 3. 景點
create table expense_app.trip_attractions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  visit_date date,
  address text,
  rating int,  -- 1-5，選填
  note text,
  created_at timestamptz not null default now()
);

-- 4. 交通
create table expense_app.trip_transportation (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,  -- 飛機/高鐵/火車/捷運/計程車/租車/其他
  from_place text,
  to_place text,
  depart_at timestamptz,
  arrive_at timestamptz,
  reference_no text,
  note text,
  created_at timestamptz not null default now()
);

-- 5. 食宿
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

-- 6. 記事
create table expense_app.trip_notes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references expense_app.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_date date,
  content text not null,
  created_at timestamptz not null default now()
);

-- 7. RLS：個人資料只能自己存取（這個功能不做分享，跟帳本分享是分開的事）
alter table expense_app.trips enable row level security;
alter table expense_app.trip_expenses enable row level security;
alter table expense_app.trip_attractions enable row level security;
alter table expense_app.trip_transportation enable row level security;
alter table expense_app.trip_lodging enable row level security;
alter table expense_app.trip_notes enable row level security;

create policy "個人資料只能自己存取" on expense_app.trips
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_expenses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_attractions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_transportation
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_lodging
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "個人資料只能自己存取" on expense_app.trip_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on expense_app.trips to authenticated;
grant select, insert, update, delete on expense_app.trip_expenses to authenticated;
grant select, insert, update, delete on expense_app.trip_attractions to authenticated;
grant select, insert, update, delete on expense_app.trip_transportation to authenticated;
grant select, insert, update, delete on expense_app.trip_lodging to authenticated;
grant select, insert, update, delete on expense_app.trip_notes to authenticated;

create index trip_expenses_trip_idx on expense_app.trip_expenses (trip_id);
create index trip_attractions_trip_idx on expense_app.trip_attractions (trip_id);
create index trip_transportation_trip_idx on expense_app.trip_transportation (trip_id);
create index trip_lodging_trip_idx on expense_app.trip_lodging (trip_id);
create index trip_notes_trip_idx on expense_app.trip_notes (trip_id);

-- ============================================
-- 這幾張新表都建在既有的 expense_app schema 底下，
-- 不需要額外去Dashboard的「Exposed schemas」設定。
--
-- 「旅遊記錄」這個分類要記得手動在App的「管理」畫面新增一個
-- 支出分類（如果還沒有的話），私人行程結束後的總花費才有地方存。
-- ============================================
