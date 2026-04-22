import { supabaseAdmin } from './supabaseAdmin';

export interface CancelledItem {
  skuId: string;
  cancelQty: number; // 취소될 수량 (ordered_qty - sent_qty)
}

export interface CancelResult {
  skuId: string;
  cancelledOrderIds: string[];
  cancelledQty: number; // 실제 취소된 order들의 quantity 합
  shortfall: number; // 요청한 cancelQty 중 매칭 못한 수량 (보통 0)
}

/**
 * WO의 특정 SKU들에 대해 LIFO(최근 주문 우선) 순으로 online_order 를 status='취소' 처리.
 * 잔량 취소 / 작업종료 후 "실제로 완료되지 않은 주문"을 명시적으로 표시하기 위함.
 *
 * - 기존 WO의 살아있는(= sent_qty로 커버된) 주문은 건드리지 않음
 * - status가 이미 '취소' / '출고완료' 인 주문은 제외
 * - 최신 주문부터 쌓아 cancelQty만큼 채우면 멈춤
 */
export async function cancelOnlineOrdersLIFO(
  workOrderId: string,
  items: CancelledItem[],
): Promise<CancelResult[]> {
  const results: CancelResult[] = [];
  const excludedStatuses = ['취소', '출고완료'];

  for (const item of items) {
    if (item.cancelQty <= 0) {
      results.push({ skuId: item.skuId, cancelledOrderIds: [], cancelledQty: 0, shortfall: 0 });
      continue;
    }

    const { data: candidates } = await supabaseAdmin
      .from('online_order')
      .select('id, quantity, status, order_date, created_at')
      .eq('work_order_id', workOrderId)
      .eq('sku_id', item.skuId)
      .not('status', 'in', `(${excludedStatuses.map((s) => `"${s}"`).join(',')})`)
      .order('order_date', { ascending: false })
      .order('created_at', { ascending: false });

    const pool = (candidates || []) as { id: string; quantity: number }[];
    const toCancel: string[] = [];
    let cumulative = 0;
    for (const o of pool) {
      if (cumulative >= item.cancelQty) break;
      toCancel.push(o.id);
      cumulative += o.quantity || 0;
    }

    if (toCancel.length > 0) {
      // 500개씩 배치 업데이트
      for (let i = 0; i < toCancel.length; i += 500) {
        const batch = toCancel.slice(i, i + 500);
        await supabaseAdmin
          .from('online_order')
          .update({ status: '취소' })
          .in('id', batch);
      }
    }

    results.push({
      skuId: item.skuId,
      cancelledOrderIds: toCancel,
      cancelledQty: cumulative,
      shortfall: Math.max(0, item.cancelQty - cumulative),
    });
  }

  return results;
}
