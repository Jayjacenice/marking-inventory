import * as XLSX from 'xlsx';
import { supabase } from './supabase';
import { supabaseAdmin } from './supabaseAdmin';

export interface CjStockRow {
  skuId: string;
  skuName?: string;
  quantity: number;
}

export interface CjStockSnapshot {
  rows: { sku_id: string; quantity: number; uploaded_at: string }[];
  uploadedAt: string | null;
}

/**
 * BERRIZ 재고 현황 양식 (stock_status_*.xlsx) 파싱.
 * 헤더 자동 매핑:
 *   - "SKU코드" (필수)
 *   - "SKU명"  (옵션)
 *   - "가용재고" (필수)
 *   - "창고" (있으면 필터)
 *   - "제조사" 또는 "비즈파트너" (있으면 필터)
 *
 * 기본 필터:
 *   - 창고 == "CJ 대구 창고"
 *   - 제조사 contains "카카오엔터테인먼트"
 *   - 가용재고 > 0
 * 헤더에 해당 컬럼이 없으면 그 필터는 자동 생략 (전체 인식).
 *
 * 같은 sku_id 가 여러 행으로 나오면 합산.
 */
export function parseCjStockExcel(file: File): Promise<{ rows: CjStockRow[]; stats: { totalRows: number; warehouseSkipped: number; partnerSkipped: number; zeroSkipped: number } }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (rows.length < 2) { reject(new Error('데이터가 없습니다.')); return; }

        const header = (rows[0] || []).map((h: any) => String(h || '').trim());
        const findCol = (...candidates: string[]): number => {
          for (const c of candidates) {
            const idx = header.indexOf(c);
            if (idx !== -1) return idx;
          }
          return -1;
        };

        const skuCol = findCol('SKU코드');
        const nameCol = findCol('SKU명');
        const qtyCol = findCol('가용재고');
        const whCol = findCol('창고');
        const partnerCol = findCol('제조사', '비즈파트너');

        const missing: string[] = [];
        if (skuCol === -1) missing.push('SKU코드');
        if (qtyCol === -1) missing.push('가용재고');
        if (missing.length > 0) {
          reject(new Error(
            `필수 컬럼을 찾을 수 없습니다: ${missing.join(', ')}. ` +
            `BERRIZ 재고 현황 양식인지 확인해주세요.`,
          ));
          return;
        }

        const TARGET_WAREHOUSE = 'CJ 대구 창고';
        const TARGET_PARTNER = '카카오엔터테인먼트';
        const acc: Record<string, { qty: number; name?: string }> = {};
        let totalRows = 0, warehouseSkipped = 0, partnerSkipped = 0, zeroSkipped = 0;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const sku = String(row[skuCol] || '').trim();
          if (!sku) continue;
          totalRows++;

          if (whCol !== -1) {
            const wh = String(row[whCol] || '').trim();
            if (wh !== TARGET_WAREHOUSE) { warehouseSkipped++; continue; }
          }
          if (partnerCol !== -1) {
            const partner = String(row[partnerCol] || '').trim();
            if (!partner.includes(TARGET_PARTNER)) { partnerSkipped++; continue; }
          }
          const qty = Number(row[qtyCol]) || 0;
          if (qty <= 0) { zeroSkipped++; continue; }

          if (!acc[sku]) acc[sku] = { qty: 0, name: nameCol !== -1 ? String(row[nameCol] || '').trim() : undefined };
          acc[sku].qty += qty;
        }

        const result: CjStockRow[] = Object.entries(acc).map(([sku, v]) => ({
          skuId: sku,
          skuName: v.name,
          quantity: v.qty,
        }));
        resolve({
          rows: result,
          stats: { totalRows, warehouseSkipped, partnerSkipped, zeroSkipped },
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 스냅샷 전체 갱신 — Postgres RPC `replace_cj_stock_snapshot` 한 트랜잭션 처리.
 * 미존재 SKU는 사전에 sku 테이블에 자동 등록 (FK 보호).
 */
export async function uploadCjAvailableStock(rows: CjStockRow[]): Promise<{ inserted: number; skuRegistered: number }> {
  // 1) 누락 SKU 자동 등록 (FK 보호) — RPC 진입 전에 처리
  const skuIds = [...new Set(rows.map((r) => r.skuId))];
  let skuRegistered = 0;
  if (skuIds.length > 0) {
    for (let i = 0; i < skuIds.length; i += 500) {
      const batch = skuIds.slice(i, i + 500);
      const { data: existing } = await supabaseAdmin
        .from('sku')
        .select('sku_id')
        .in('sku_id', batch);
      const have = new Set((existing || []).map((s: any) => s.sku_id));
      const missing = rows
        .filter((r) => batch.includes(r.skuId) && !have.has(r.skuId))
        .map((r) => ({ sku_id: r.skuId, sku_name: r.skuName || r.skuId, type: '완제품' }));
      if (missing.length > 0) {
        await supabaseAdmin.from('sku').upsert(missing, { onConflict: 'sku_id', ignoreDuplicates: true });
        skuRegistered += missing.length;
      }
    }
  }

  // 2) RPC 한 트랜잭션 내 truncate + insert (insert 실패 시 자동 rollback)
  const payload = rows.map((r) => ({ sku_id: r.skuId, quantity: r.quantity }));
  const { data, error } = await supabaseAdmin.rpc('replace_cj_stock_snapshot', { p_rows: payload });
  if (error) {
    if (error.message?.includes('does not exist') || error.code === '42883') {
      throw new Error('DB 마이그레이션이 필요합니다. migration_cj_p0_rpc.sql 적용 후 재시도하세요.');
    }
    throw new Error(`CJ 가용재고 저장 실패: ${error.message}`);
  }
  const inserted = (data as { inserted?: number } | null)?.inserted ?? 0;
  return { inserted, skuRegistered };
}

/**
 * CJ 가용재고로 충당 가능한 주문에 대해 한 트랜잭션으로:
 *   (a) 가용재고 차감, (b) online_order.status='CJ대기', (c) activity_log
 * sku_deltas: { sku_id: qty } 양수만.
 */
export async function cjAssignOrdersRpc(args: {
  orderIds: string[];
  skuDeltas: Record<string, number>;
  userId: string;
}): Promise<{ cjAssignedCount: number; skuCount: number; totalQty: number }> {
  const { data, error } = await supabaseAdmin.rpc('cj_assign_orders', {
    p_order_ids: args.orderIds,
    p_sku_deltas: args.skuDeltas,
    p_user_id: args.userId,
  });
  if (error) {
    if (error.message?.includes('does not exist') || error.code === '42883') {
      throw new Error('DB 마이그레이션이 필요합니다. migration_cj_p0_rpc.sql 적용 후 재시도하세요.');
    }
    if (error.code === '23514') {
      throw new Error('CJ 가용재고가 부족해 차감 불가 (CHECK 제약 위반). 스냅샷을 최신화하고 재시도하세요.');
    }
    throw new Error(`CJ 분류 처리 실패: ${error.message}`);
  }
  const r = (data as any) || {};
  return {
    cjAssignedCount: r.cj_assigned_count ?? 0,
    skuCount: r.sku_count ?? 0,
    totalQty: r.total_qty ?? 0,
  };
}

/** 현 스냅샷 전체 조회 (작업지시서 생성 시 사용). */
export async function getCjAvailableStock(): Promise<CjStockSnapshot> {
  const result: { sku_id: string; quantity: number; uploaded_at: string }[] = [];
  let offset = 0;
  let uploadedAt: string | null = null;
  while (true) {
    const { data, error } = await supabase
      .from('cj_available_stock')
      .select('sku_id, quantity, uploaded_at')
      .order('sku_id')
      .range(offset, offset + 999);
    if (error) throw new Error(`CJ 가용재고 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    if (!uploadedAt && data[0]?.uploaded_at) uploadedAt = data[0].uploaded_at;
    result.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return { rows: result, uploadedAt };
}

/** 단순 매핑 — sku_id → quantity (작업지시서 로직 편의용) */
export function toQtyMap(snapshot: CjStockSnapshot): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of snapshot.rows) m[r.sku_id] = r.quantity;
  return m;
}
