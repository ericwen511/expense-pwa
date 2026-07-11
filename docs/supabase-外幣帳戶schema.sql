-- ============================================
-- 個人記帳系統 — 新增「外幣帳戶換匯」支援
-- 轉帳交易的轉出/轉入金額可以不一樣(換匯情境)，
-- 沒有填transfer_to_amount的舊資料/同幣別轉帳，維持轉出=轉入金額
-- 在Supabase的SQL Editor裡執行即可
-- ============================================

alter table expense_app.transactions
  add column transfer_to_amount numeric(14,2);
