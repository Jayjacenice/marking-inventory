import { supabase } from './supabase';
import { supabaseAdmin } from './supabaseAdmin';
import type { TxType, TxSource } from '../types';

export interface RecordTxParams {
  warehouseId: string;
  skuId: string;
  txType: TxType;
  quantity: number;
  source: TxSource;
  txDate?: string;
  memo?: string;
}

/** 재고 변동 1건 기록 */
export async function recordTransaction(params: RecordTxParams): Promise<void> {
  if (params.quantity === 0) return;
  // 마킹 관련 타입은 음수 허용 (롤백/수정 시 역방향 트랜잭션 필요)
  const allowNegative = ['재고조정', '마킹출고', '마킹입고'].includes(params.txType);
  if (params.quantity < 0 && !allowNegative) return;
  const { error } = await supabase.from('inventory_transaction').insert({
    warehouse_id: params.warehouseId,
    sku_id: params.skuId,
    tx_type: params.txType,
    quantity: params.quantity,
    source: params.source,
    tx_date: params.txDate || new Date().toISOString().slice(0, 10),
    memo: params.memo || null,
  });
  if (error) console.error('[inventoryTransaction] insert error:', error);
}

/** 없는 SKU를 sku 테이블에 자동 등록 */
async function ensureSkuExists(
  rows: RecordTxParams[],
  skuNameMap?: Map<string, string>
): Promise<void> {
  const uniqueSkuIds = [...new Set(rows.map((r) => r.skuId))];
  if (uniqueSkuIds.length === 0) return;

  // 500개씩 존재 여부 확인 (admin으로 RLS 우회)
  const existingIds = new Set<string>();
  for (let i = 0; i < uniqueSkuIds.length; i += 500) {
    const batch = uniqueSkuIds.slice(i, i + 500);
    const { data } = await supabaseAdmin.from('sku').select('sku_id').in('sku_id', batch);
    if (data) data.forEach((d) => existingIds.add(d.sku_id));
  }

  const missing = uniqueSkuIds.filter((id) => !existingIds.has(id));
  if (missing.length === 0) return;

  console.log(`[inventoryTransaction] ${missing.length}개 SKU 자동 등록:`, missing);
  const newSkus = missing.map((skuId) => ({
    sku_id: skuId,
    sku_name: skuNameMap?.get(skuId) || skuId,
    type: '완제품',
  }));

  // 500개씩 배치 insert (admin으로 RLS 우회)
  for (let i = 0; i < newSkus.length; i += 500) {
    const batch = newSkus.slice(i, i + 500);
    const { error } = await supabaseAdmin.from('sku').insert(batch);
    if (error) console.error('[inventoryTransaction] sku insert error:', error);
  }
}

export interface ValidationError {
  skuId: string;
  skuName: string;
  reason: string;
}

/** 저장 전 검증: SKU 자동 등록 시도 후 여전히 누락된 SKU 확인 */
export async function validateTransactionBatch(
  rows: RecordTxParams[],
  skuNameMap?: Map<string, string>
): Promise<{ valid: boolean; errors: ValidationError[] }> {
  const validRows = rows.filter((r) => r.quantity > 0);
  if (validRows.length === 0) return { valid: true, errors: [] };

  // 1) 없는 SKU 자동 등록 시도
  await ensureSkuExists(validRows, skuNameMap);

  // 2) 등록 후에도 여전히 누락된 SKU 확인
  const uniqueSkuIds = [...new Set(validRows.map((r) => r.skuId))];
  const existingIds = new Set<string>();
  for (let i = 0; i < uniqueSkuIds.length; i += 500) {
    const batch = uniqueSkuIds.slice(i, i + 500);
    const { data } = await supabaseAdmin.from('sku').select('sku_id').in('sku_id', batch);
    if (data) data.forEach((d) => existingIds.add(d.sku_id));
  }

  const missingSkuIds = uniqueSkuIds.filter((id) => !existingIds.has(id));
  if (missingSkuIds.length === 0) return { valid: true, errors: [] };

  const errors: ValidationError[] = missingSkuIds.map((skuId) => ({
    skuId,
    skuName: skuNameMap?.get(skuId) || skuId,
    reason: 'SKU 자동 등록 실패 (DB 제약 조건 위반 가능)',
  }));

  return { valid: false, errors };
}

/** 재고 변동 여러건 일괄 기록 (CJ 엑셀 업로드용) */
export async function recordTransactionBatch(
  rows: RecordTxParams[],
  skuNameMap?: Map<string, string>,
  onProgress?: (current: number, total: number) => void
): Promise<{ success: number; failed: number }> {
  const valid = rows.filter((r) => r.quantity > 0);
  if (valid.length === 0) return { success: 0, failed: 0 };

  // 1) 없는 SKU 자동 등록
  await ensureSkuExists(valid, skuNameMap);

  const insertRows = valid.map((r) => ({
    warehouse_id: r.warehouseId,
    sku_id: r.skuId,
    tx_type: r.txType,
    quantity: r.quantity,
    source: r.source,
    tx_date: r.txDate || new Date().toISOString().slice(0, 10),
    memo: r.memo || null,
  }));

  // 2) 500건씩 배치 insert
  let success = 0;
  let failed = 0;
  const total = insertRows.length;
  for (let i = 0; i < insertRows.length; i += 500) {
    const batch = insertRows.slice(i, i + 500);
    const { error } = await supabase.from('inventory_transaction').insert(batch);
    if (error) {
      console.error('[inventoryTransaction] batch insert error:', error, '→ 개별 재시도');
      // 3) 배치 실패 시 1건씩 재시도
      for (const row of batch) {
        const { error: singleErr } = await supabase.from('inventory_transaction').insert(row);
        if (singleErr) {
          console.error('[inventoryTransaction] single insert fail:', row.sku_id, singleErr.message);
          failed++;
        } else {
          success++;
        }
        onProgress?.(success + failed, total);
      }
    } else {
      success += batch.length;
    }
    onProgress?.(success + failed, total);
  }

  // 4) inventory 테이블 자동 반영 (트랜잭션 → 현재 재고)
  if (success > 0) {
    await syncInventoryFromTransactions(valid);
  }

  return { success, failed };
}

/** 트랜잭션 기록 후 inventory 테이블에 재고 반영 */
async function syncInventoryFromTransactions(rows: RecordTxParams[]): Promise<void> {
  // SKU별 순변동 집계 (입고/반품 = +, 출고 = -)
  const deltaMap = new Map<string, { warehouseId: string; skuId: string; delta: number }>();
  for (const r of rows) {
    const key = `${r.warehouseId}|${r.skuId}`;
    if (!deltaMap.has(key)) deltaMap.set(key, { warehouseId: r.warehouseId, skuId: r.skuId, delta: 0 });
    const entry = deltaMap.get(key)!;
    switch (r.txType) {
      case '입고': entry.delta += r.quantity; break;
      case '이동입고': entry.delta += r.quantity; break;
      case '출고': entry.delta -= r.quantity; break;
      case '반품': entry.delta += r.quantity; break;
      case '재고조정': entry.delta += r.quantity; break;
      case '마킹출고': entry.delta -= r.quantity; break;
      case '마킹입고': entry.delta += r.quantity; break;
      case '판매': entry.delta -= r.quantity; break;
      case '기초재고': entry.delta += r.quantity; break;
    }
  }

  const entries = [...deltaMap.values()];
  // 500개씩 배치 처리
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const skuIds = batch.map((e) => e.skuId);

    // 현재 inventory 조회
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('warehouse_id, sku_id, quantity')
      .eq('warehouse_id', batch[0].warehouseId)
      .in('sku_id', skuIds);

    const existingMap = new Map(
      (existing || []).map((e) => [`${e.warehouse_id}|${e.sku_id}`, e.quantity as number])
    );

    // upsert 데이터 준비
    const upsertRows = batch.map((e) => {
      const currentQty = existingMap.get(`${e.warehouseId}|${e.skuId}`) || 0;
      return {
        warehouse_id: e.warehouseId,
        sku_id: e.skuId,
        quantity: Math.max(0, currentQty + e.delta),
      };
    });

    const { error } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id' });
    if (error) console.error('[inventoryTransaction] inventory upsert error:', error);
  }
}

/** CJ 엑셀 업로드 데이터 삭제 (유형 + 기간) + inventory 역반영 */
export async function deleteCjTransactions(params: {
  warehouseId: string;
  txType: TxType;
  startDate: string;
  endDate: string;
}): Promise<{ deleted: number; error: string | null }> {
  // 1) 삭제 대상 트랜잭션 조회 (inventory 역반영용)
  const { data: txToDelete, error: fetchErr } = await supabaseAdmin
    .from('inventory_transaction')
    .select('sku_id, tx_type, quantity')
    .eq('source', 'cj_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', params.txType)
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (fetchErr) {
    return { deleted: 0, error: fetchErr.message };
  }

  const deleteCount = txToDelete?.length || 0;
  if (deleteCount === 0) {
    return { deleted: 0, error: null };
  }

  // 2) 트랜잭션 삭제
  const { error } = await supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'cj_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', params.txType)
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (error) {
    return { deleted: 0, error: error.message };
  }

  // 3) inventory 역반영 (삭제된 트랜잭션의 반대 방향)
  const reverseDelta = new Map<string, number>();
  for (const tx of txToDelete || []) {
    const current = reverseDelta.get(tx.sku_id) || 0;
    switch (tx.tx_type as TxType) {
      case '입고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '이동입고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '출고': reverseDelta.set(tx.sku_id, current + tx.quantity); break;
      case '반품': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '재고조정': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '마킹출고': reverseDelta.set(tx.sku_id, current + tx.quantity); break;
      case '마킹입고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '판매': reverseDelta.set(tx.sku_id, current + tx.quantity); break;
      case '기초재고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
    }
  }

  const skuIds = [...reverseDelta.keys()];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [e.sku_id, e.quantity as number])
    );

    const upsertRows = batch.map((skuId) => ({
      warehouse_id: params.warehouseId,
      sku_id: skuId,
      quantity: Math.max(0, (existingMap.get(skuId) || 0) + (reverseDelta.get(skuId) || 0)),
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id' });
    if (upsertErr) console.error('[inventoryTransaction] delete inventory reverse error:', upsertErr);
  }

  return { deleted: deleteCount, error: null };
}

/** system 소스 트랜잭션 삭제 (실적 삭제용) + inventory 역반영 */
export async function deleteSystemTransactions(params: {
  warehouseId: string;
  memo: string; // 정확 일치 (eq) 또는 LIKE 패턴 (memoLike 사용 시)
  memoLike?: string; // LIKE 패턴 (예: '%입고확인%작업지시서 2026-03-31%')
}): Promise<{ deleted: number; error: string | null }> {
  // 1) 삭제 대상 트랜잭션 조회
  let query = supabaseAdmin
    .from('inventory_transaction')
    .select('sku_id, tx_type, quantity')
    .eq('source', 'system')
    .eq('warehouse_id', params.warehouseId);
  if (params.memoLike) {
    query = query.like('memo', params.memoLike);
  } else {
    query = query.eq('memo', params.memo);
  }
  const { data: txToDelete, error: fetchErr } = await query;

  if (fetchErr) {
    return { deleted: 0, error: fetchErr.message };
  }

  const deleteCount = txToDelete?.length || 0;
  if (deleteCount === 0) {
    return { deleted: 0, error: null };
  }

  // 2) 트랜잭션 삭제
  let delQuery = supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'system')
    .eq('warehouse_id', params.warehouseId);
  if (params.memoLike) {
    delQuery = delQuery.like('memo', params.memoLike);
  } else {
    delQuery = delQuery.eq('memo', params.memo);
  }
  const { error } = await delQuery;

  if (error) {
    return { deleted: 0, error: error.message };
  }

  // 3) inventory 역반영 (삭제된 트랜잭션의 반대 방향)
  const reverseDelta = new Map<string, number>();
  for (const tx of txToDelete || []) {
    const current = reverseDelta.get(tx.sku_id) || 0;
    switch (tx.tx_type as TxType) {
      case '입고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '이동입고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '출고': reverseDelta.set(tx.sku_id, current + tx.quantity); break;
      case '반품': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '재고조정': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '마킹출고': reverseDelta.set(tx.sku_id, current + tx.quantity); break;
      case '마킹입고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
      case '판매': reverseDelta.set(tx.sku_id, current + tx.quantity); break;
      case '기초재고': reverseDelta.set(tx.sku_id, current - tx.quantity); break;
    }
  }

  const skuIds = [...reverseDelta.keys()];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [e.sku_id, e.quantity as number])
    );

    const upsertRows = batch.map((skuId) => ({
      warehouse_id: params.warehouseId,
      sku_id: skuId,
      quantity: Math.max(0, (existingMap.get(skuId) || 0) + (reverseDelta.get(skuId) || 0)),
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id' });
    if (upsertErr) console.error('[inventoryTransaction] delete system inventory reverse error:', upsertErr);
  }

  return { deleted: deleteCount, error: null };
}

/** CJ 엑셀 데이터 건수 조회 (삭제 미리보기용) */
export async function countCjTransactions(params: {
  warehouseId: string;
  txType: TxType;
  startDate: string;
  endDate: string;
}): Promise<number> {
  const { count } = await supabaseAdmin
    .from('inventory_transaction')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'cj_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', params.txType)
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);
  return count || 0;
}

/** POS 판매 데이터 삭제 (기간) + inventory 역반영 */
export async function deletePosTransactions(params: {
  warehouseId: string;
  startDate: string;
  endDate: string;
}): Promise<{ deleted: number; error: string | null }> {
  const { data: txToDelete, error: fetchErr } = await supabaseAdmin
    .from('inventory_transaction')
    .select('sku_id, tx_type, quantity')
    .eq('source', 'pos_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', '판매')
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (fetchErr) return { deleted: 0, error: fetchErr.message };
  const deleteCount = txToDelete?.length || 0;
  if (deleteCount === 0) return { deleted: 0, error: null };

  const { error } = await supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'pos_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', '판매')
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (error) return { deleted: 0, error: error.message };

  // inventory 역반영 (판매 삭제 = 재고 복구)
  const reverseDelta = new Map<string, number>();
  for (const tx of txToDelete || []) {
    reverseDelta.set(tx.sku_id, (reverseDelta.get(tx.sku_id) || 0) + tx.quantity);
  }

  const skuIds = [...reverseDelta.keys()];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [e.sku_id, e.quantity as number])
    );

    const upsertRows = batch.map((skuId) => ({
      warehouse_id: params.warehouseId,
      sku_id: skuId,
      quantity: Math.max(0, (existingMap.get(skuId) || 0) + (reverseDelta.get(skuId) || 0)),
    }));

    await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id' });
  }

  return { deleted: deleteCount, error: null };
}

/** POS 판매 데이터 건수 조회 */
export async function countPosTransactions(params: {
  warehouseId: string;
  startDate: string;
  endDate: string;
}): Promise<number> {
  const { count } = await supabaseAdmin
    .from('inventory_transaction')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'pos_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', '판매')
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);
  return count || 0;
}
