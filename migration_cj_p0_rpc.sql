-- ============================================================================
-- P0: CJ 가용재고 분리·차감 + 스냅샷 갱신을 단일 트랜잭션으로 보호
--   목적: 코드리뷰어 C-01/C-02/C-03 (트랜잭션 비원자성) 해소
--   적용: Supabase SQL Editor 에서 1회 실행
--   전제: migration_cj_available_stock.sql 이미 적용됨
-- ============================================================================

-- 1) cj_assign_orders
--    한 트랜잭션 내에서:
--      (a) cj_available_stock 차감 (CHECK 위반 시 자동 rollback)
--      (b) online_order.status='CJ대기' 일괄 update
--      (c) activity_log insert
create or replace function cj_assign_orders(
  p_order_ids  uuid[],
  p_sku_deltas jsonb,   -- { "sku_id": qty, ... }  양수만
  p_user_id    uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sku           text;
  v_delta         int;
  v_sku_count     int := 0;
  v_total_qty     int := 0;
  v_assigned      int := 0;
  v_expected      int := coalesce(array_length(p_order_ids, 1), 0);
begin
  -- (a) 가용재고 차감 — CHECK (quantity >= 0) 위반 시 SQLSTATE 23514 → 자동 rollback
  for v_sku, v_delta in
    select key, (value::text)::int from jsonb_each(p_sku_deltas)
  loop
    if v_delta is null or v_delta <= 0 then
      continue;
    end if;
    update cj_available_stock
      set quantity = quantity - v_delta
      where sku_id = v_sku;
    if not found then
      raise exception 'cj_available_stock 에 sku_id=% 행이 없습니다', v_sku
        using errcode = 'P0001';
    end if;
    v_sku_count := v_sku_count + 1;
    v_total_qty := v_total_qty + v_delta;
  end loop;

  -- (b) online_order 상태 일괄 변경
  if v_expected > 0 then
    update online_order
      set status = 'CJ대기'
      where id = any(p_order_ids);
    get diagnostics v_assigned = row_count;
    if v_assigned <> v_expected then
      raise exception 'online_order 업데이트 매칭 불일치: 기대 %, 실제 %', v_expected, v_assigned
        using errcode = 'P0001';
    end if;
  end if;

  -- (c) activity_log
  insert into activity_log (user_id, action_type, action_date, summary)
  values (
    p_user_id,
    'order_reclassify',
    current_date,
    jsonb_build_object(
      'reason', 'CJ 가용재고 충당 → CJ대기 (RPC)',
      'count', v_assigned,
      'totalQty', v_total_qty,
      'skuCount', v_sku_count
    )
  );

  return jsonb_build_object(
    'cj_assigned_count', v_assigned,
    'sku_count', v_sku_count,
    'total_qty', v_total_qty
  );
end;
$$;

grant execute on function cj_assign_orders(uuid[], jsonb, uuid) to authenticated, service_role;

comment on function cj_assign_orders(uuid[], jsonb, uuid) is
  '작업지시서 생성 시 CJ 가용재고로 충당 가능한 주문을 한 트랜잭션으로 처리: 가용재고 차감 + 주문 상태 CJ대기 + activity_log';


-- 2) replace_cj_stock_snapshot
--    truncate + bulk insert 를 한 트랜잭션 내에서 실행 (insert 실패 시 자동 rollback)
create or replace function replace_cj_stock_snapshot(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted int;
begin
  -- Supabase 의 session-level safe-updates 가드 회피를 위해 WHERE 절 명시 (where true)
  delete from cj_available_stock where true;

  insert into cj_available_stock (sku_id, quantity, uploaded_at)
  select x.sku_id, x.quantity, now()
  from jsonb_to_recordset(p_rows) as x(sku_id text, quantity int)
  where x.sku_id is not null and x.quantity is not null and x.quantity > 0;

  get diagnostics v_inserted = row_count;
  return jsonb_build_object('inserted', v_inserted);
end;
$$;

grant execute on function replace_cj_stock_snapshot(jsonb) to authenticated, service_role;

comment on function replace_cj_stock_snapshot(jsonb) is
  'CJ 가용재고 스냅샷 전체 갱신 (truncate + bulk insert) 한 트랜잭션 처리';


-- 3) RLS 정책 좁힘 (코드리뷰어 보안 권고): 일반 authenticated 유저의 write 차단
--    프론트는 supabaseAdmin 또는 위 RPC 만 사용하므로 영향 없음
drop policy if exists "auth_write_cj_available_stock" on cj_available_stock;
create policy "auth_read_only_cj_available_stock"
  on cj_available_stock for select using (auth.role() = 'authenticated');
