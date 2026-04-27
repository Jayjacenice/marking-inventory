-- ============================================================================
-- CJ 창고 가용재고 스냅샷 + online_order.status 'CJ대기' 추가
--   목적: 작업지시서 생성 시 CJ 가용재고로 충당 가능한 주문은 매장 이관 미포함,
--         online_order.status='CJ대기'로 분리해 추적
--   적용: Supabase SQL Editor 에서 1회 실행
-- ============================================================================

-- 1) CJ 가용재고 스냅샷 테이블 (수불부와 무관, 사용자가 BERRIZ 양식으로 업로드)
create table if not exists cj_available_stock (
  sku_id text primary key references sku(sku_id) on delete cascade,
  quantity int not null default 0 check (quantity >= 0),
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_cj_available_stock_uploaded_at
  on cj_available_stock(uploaded_at);

-- 인증된 사용자 읽기/쓰기 (RLS)
alter table cj_available_stock enable row level security;

create policy "auth_read_cj_available_stock"
  on cj_available_stock for select using (auth.role() = 'authenticated');

create policy "auth_write_cj_available_stock"
  on cj_available_stock for all using (auth.role() = 'authenticated');

create policy "service_all_cj_available_stock"
  on cj_available_stock for all using (auth.jwt()->>'role' = 'service_role');

-- 2) online_order.status check 제약 갱신: 'CJ대기' 추가
--    (기존 enum 또는 check 제약이 있으면 재정의 필요)
alter table online_order
  drop constraint if exists online_order_status_check;

alter table online_order
  add constraint online_order_status_check
  check (status in (
    '신규', '발송대기', '이관중', '입고확인완료', '마킹중', '마킹완료',
    '출고완료', '재고부족', '하자재발송', '취소', 'CJ대기'
  ));

comment on column online_order.status is
  'CJ대기 = 작업지시서 생성 시 CJ창고에 가용재고가 있어 매장 이관 미포함, CJ에서 직접 출고 위임된 상태';
