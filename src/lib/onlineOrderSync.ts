import { supabaseAdmin } from './supabaseAdmin';
import type { OnlineOrderStatus } from '../types';

/**
 * 발송된 SKU 목록으로 online_order 상태를 FIFO(오래된 순)로 업데이트
 *
 * @param shippedItems - 발송된 SKU별 수량 [{skuId, qty}]
 * @param newStatus - 변경할 상태
 * @param fromStatus - 현재 상태 필터 (기본: '신규')
 */
export async function updateOnlineOrderStatus(
  shippedItems: { skuId: string; qty: number }[],
  newStatus: OnlineOrderStatus,
  fromStatus: OnlineOrderStatus = '신규',
) {
  let updated = 0;

  for (const item of shippedItems) {
    if (item.qty <= 0) continue;

    // FIFO: 오래된 주문부터 매칭 (order_date 오름차순)
    const { data: orders } = await supabaseAdmin
      .from('online_order')
      .select('id, quantity')
      .eq('sku_id', item.skuId)
      .eq('status', fromStatus)
      .order('order_date', { ascending: true })
      .limit(100);

    if (!orders || orders.length === 0) continue;

    let remaining = item.qty;
    const idsToUpdate: string[] = [];

    for (const order of orders) {
      if (remaining <= 0) break;
      idsToUpdate.push(order.id);
      remaining -= order.quantity;
    }

    if (idsToUpdate.length > 0) {
      const { error } = await supabaseAdmin
        .from('online_order')
        .update({ status: newStatus })
        .in('id', idsToUpdate);
      if (!error) updated += idsToUpdate.length;
    }
  }

  return updated;
}

/**
 * 작업지시서에 연결된 SKU 목록으로 online_order 상태 업데이트
 * (입고/출고 시 사용 — SKU 기준 FIFO)
 */
export async function updateOnlineOrderBySkus(
  skuIds: string[],
  newStatus: OnlineOrderStatus,
  fromStatus: OnlineOrderStatus,
) {
  if (skuIds.length === 0) return 0;

  let updated = 0;
  for (const skuId of skuIds) {
    const { data } = await supabaseAdmin
      .from('online_order')
      .select('id')
      .eq('sku_id', skuId)
      .eq('status', fromStatus)
      .order('order_date', { ascending: true })
      .limit(500);

    if (data && data.length > 0) {
      const { error } = await supabaseAdmin
        .from('online_order')
        .update({ status: newStatus })
        .in('id', data.map((d: any) => d.id));
      if (!error) updated += data.length;
    }
  }
  return updated;
}
