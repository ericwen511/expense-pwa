-- ============================================
-- 財富管家 — 資產表加上股票持股欄位
-- 只有分類=investment(投資)時會用到，其他分類維持null
-- ============================================

alter table expense_app.assets
  add column market text,              -- us / tw / cn
  add column stock_symbol text,
  add column shares numeric(14,4),
  add column cost_per_share numeric(14,4);
