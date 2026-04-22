import { supabaseAdmin } from './supabaseAdmin';
import type { TxType } from '../types';

// 수불부 공식의 부호 규칙. StockLedger.tsx와 동일해야 함.
function txSign(type: TxType): number {
  switch (type) {
    case '입고':
    case '이동입고':
    case '반품':
    case '재고조정':
    case '마킹입고':
    case '기초재고':
      return 1;
    case '출고':
    case '판매':
    case '마킹출고':
      return -1;
    default:
      return 0;
  }
}

/**
 * 재고수불부 공식 기반 현재 재고 계산.
 * inventory_transaction을 누적 집계해 SKU별 잔량을 돌려준다.
 * inventory 테이블의 Math.max 클램핑·비원자 upsert drift의 영향 없음.
 *
 * @param warehouseId 창고 id
 * @param asOfDate 기준일 (YYYY-MM-DD). 생략 시 오늘 (누적 전체).
 * @param needsMarking 생략 시 true/false 모두 합산
 */
export async function getLedgerInventory(
  warehouseId: string,
  asOfDate?: string,
  needsMarking?: boolean,
): Promise<Record<string, number>> {
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const result: Record<string, number> = {};
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    let q = supabaseAdmin
      .from('inventory_transaction')
      .select('sku_id, tx_type, quantity, needs_marking')
      .eq('warehouse_id', warehouseId)
      .lte('tx_date', asOf)
      .range(offset, offset + PAGE - 1);
    if (needsMarking !== undefined) q = q.eq('needs_marking', needsMarking);
    const { data, error } = await q;
    if (error) throw new Error(`inventory_transaction 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const tx of data as { sku_id: string; tx_type: TxType; quantity: number }[]) {
      const sign = txSign(tx.tx_type);
      if (sign === 0) continue;
      result[tx.sku_id] = (result[tx.sku_id] || 0) + sign * tx.quantity;
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return result;
}
