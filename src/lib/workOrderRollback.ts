import { supabase } from './supabase';
import { supabaseAdmin } from './supabaseAdmin';
import { deleteSystemTransactions } from './inventoryTransaction';
import type { WorkOrderStatus, ActionType } from '../types';

export type RollbackStep = '발송' | '입고' | '마킹' | '출고';

interface RollbackResult {
  success: boolean;
  error: string | null;
}

export type ProgressCallback = (current: number, total: number, step: string) => void;

export interface MarkingSession {
  date: string;
  createdAt: string;
  totalQty: number;
  itemCount: number;
}

const STEPS: { step: RollbackStep; label: string }[] = [
  { step: '발송', label: '오프라인 발송' },
  { step: '입고', label: '플레이위즈 입고' },
  { step: '마킹', label: '마킹 작업' },
  { step: '출고', label: '최종 출고' },
];

export function getSteps() {
  return STEPS;
}

/** 현재 상태에서 각 단계의 진행 상태 판별 */
export function getStepStates(status: WorkOrderStatus): Record<RollbackStep, 'done' | 'active' | 'pending'> {
  const map: Record<RollbackStep, 'done' | 'active' | 'pending'> = {
    '발송': 'pending',
    '입고': 'pending',
    '마킹': 'pending',
    '출고': 'pending',
  };

  switch (status) {
    case '출고완료':
      map['발송'] = 'done'; map['입고'] = 'done'; map['마킹'] = 'done'; map['출고'] = 'done';
      break;
    case '마킹완료':
      map['발송'] = 'done'; map['입고'] = 'done'; map['마킹'] = 'done';
      break;
    case '마킹중':
      map['발송'] = 'done'; map['입고'] = 'done'; map['마킹'] = 'active';
      break;
    case '입고확인완료':
      map['발송'] = 'done'; map['입고'] = 'done';
      break;
    case '이관중':
      map['발송'] = 'done';
      break;
    case '취소요청':
    case '수정요청':
      map['발송'] = 'done';
      break;
  }

  return map;
}

/** 현재 상태에서 롤백 가능한 단계 반환 */
export function getRollbackableStep(status: WorkOrderStatus): RollbackStep | null {
  switch (status) {
    case '출고완료': return '출고';
    case '마킹완료':
    case '마킹중': return '마킹';
    case '입고확인완료': return '입고';
    case '이관중': return '발송';
    default: return null;
  }
}

/** 롤백 시 처리 항목 설명 */
export function getRollbackDescription(step: RollbackStep): string[] {
  switch (step) {
    case '발송': return [
      'sent_qty → 0 초기화',
      '오프라인샵 재고 복원',
      '발송 트랜잭션 삭제',
      '상태: 이관중 → 이관준비',
    ];
    case '입고': return [
      'received_qty → 0 초기화',
      '플레이위즈 재고 차감',
      '입고 트랜잭션 삭제',
      '상태: 입고확인완료 → 이관중',
    ];
    case '마킹': return [
      'daily_marking 삭제',
      'marked_qty 차감',
      '구성품 재고 복원 (플레이위즈)',
      '완성품 재고 차감 (플레이위즈)',
      '마킹 트랜잭션 삭제',
      '상태 → 입고확인완료 (전체 삭제 시)',
    ];
    case '출고': return [
      '플레이위즈 재고 복원',
      '출고 트랜잭션 삭제',
      '상태: 출고완료 → 마킹완료',
    ];
  }
}

// ── 헬퍼 ──

async function getWarehouseId(name: string): Promise<string> {
  const { data, error } = await supabase
    .from('warehouse')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  if (error || !data) throw new Error(`창고 '${name}'을 찾을 수 없습니다.`);
  return (data as any).id;
}

/** 마킹 세션(날짜/시점) 목록 조회 */
export async function getMarkingSessions(workOrderId: string): Promise<MarkingSession[]> {
  const { data: logs } = await supabase
    .from('activity_log')
    .select('action_date, created_at, summary')
    .eq('work_order_id', workOrderId)
    .eq('action_type', 'marking_work')
    .order('created_at', { ascending: true });

  return (logs || []).map((l: any) => ({
    date: l.action_date,
    createdAt: l.created_at,
    totalQty: l.summary?.totalQty || 0,
    itemCount: l.summary?.items?.length || 0,
  }));
}

// ── 롤백 실행 함수들 ──

/** 발송 롤백 */
export async function rollbackShipment(
  workOrderId: string, date: string, userId: string, onProgress?: ProgressCallback
): Promise<RollbackResult> {
  try {
    const { data: wo } = await supabase.from('work_order').select('status').eq('id', workOrderId).maybeSingle();
    if ((wo as any)?.status !== '이관중') {
      return { success: false, error: `현재 상태가 '이관중'이 아닙니다 (${(wo as any)?.status}). 발송 롤백 불가.` };
    }

    onProgress?.(1, 4, 'sent_qty 초기화 중...');
    const { data: lines } = await supabase
      .from('work_order_line').select('id').eq('work_order_id', workOrderId);
    for (const line of (lines || []) as any[]) {
      await supabase.from('work_order_line').update({ sent_qty: 0 }).eq('id', line.id);
    }

    onProgress?.(2, 4, '재고 트랜잭션 삭제 중...');
    const offlineWhId = await getWarehouseId('오프라인샵');
    await deleteSystemTransactions({
      warehouseId: offlineWhId,
      memo: `발송확인 (작업지시서 ${date})`,
    });

    onProgress?.(3, 4, '상태 복원 중...');
    await supabase.from('work_order').update({ status: '이관준비' }).eq('id', workOrderId);

    onProgress?.(4, 5, '원본 이력 삭제 중...');
    await supabase.from('activity_log').delete()
      .eq('work_order_id', workOrderId)
      .eq('action_type', 'shipment_confirm');

    onProgress?.(5, 5, '롤백 이력 기록 중...');
    await supabase.from('activity_log').insert({
      user_id: userId,
      action_type: 'rollback_shipment' as ActionType,
      work_order_id: workOrderId,
      action_date: new Date().toISOString().slice(0, 10),
      summary: { items: [], totalQty: 0, workOrderDate: date },
    });

    return { success: true, error: null };
  } catch (e: any) {
    return { success: false, error: e.message || '발송 롤백 실패' };
  }
}

/** 입고 롤백 */
export async function rollbackReceipt(
  workOrderId: string, date: string, userId: string, onProgress?: ProgressCallback
): Promise<RollbackResult> {
  try {
    const { data: wo } = await supabase.from('work_order').select('status').eq('id', workOrderId).maybeSingle();
    if ((wo as any)?.status !== '입고확인완료') {
      return { success: false, error: `현재 상태가 '입고확인완료'가 아닙니다 (${(wo as any)?.status}). 입고 롤백 불가.` };
    }

    onProgress?.(1, 4, 'received_qty 초기화 중...');
    const { data: lines } = await supabase
      .from('work_order_line').select('id').eq('work_order_id', workOrderId);
    for (const line of (lines || []) as any[]) {
      await supabase.from('work_order_line').update({ received_qty: 0 }).eq('id', line.id);
    }

    onProgress?.(2, 4, '재고 트랜잭션 삭제 중...');
    const pwWhId = await getWarehouseId('플레이위즈');
    await deleteSystemTransactions({
      warehouseId: pwWhId,
      memo: `입고확인 (작업지시서 ${date})`,
    });

    onProgress?.(3, 4, '상태 복원 중...');
    await supabase.from('work_order').update({ status: '이관중' }).eq('id', workOrderId);

    onProgress?.(4, 5, '원본 이력 삭제 중...');
    await supabase.from('activity_log').delete()
      .eq('work_order_id', workOrderId)
      .eq('action_type', 'receipt_check');

    onProgress?.(5, 5, '롤백 이력 기록 중...');
    await supabase.from('activity_log').insert({
      user_id: userId,
      action_type: 'rollback_receipt' as ActionType,
      work_order_id: workOrderId,
      action_date: new Date().toISOString().slice(0, 10),
      summary: { items: [], totalQty: 0, workOrderDate: date },
    });

    return { success: true, error: null };
  } catch (e: any) {
    return { success: false, error: e.message || '입고 롤백 실패' };
  }
}

/** 마킹 롤백 — 전체 (기존 유지) */
export async function rollbackMarking(
  workOrderId: string, date: string, userId: string, onProgress?: ProgressCallback
): Promise<RollbackResult> {
  return rollbackMarkingInternal(workOrderId, date, userId, null, onProgress);
}

/** 마킹 롤백 — 특정 날짜만 */
export async function rollbackMarkingByDate(
  workOrderId: string, date: string, userId: string, targetDate: string, onProgress?: ProgressCallback
): Promise<RollbackResult> {
  return rollbackMarkingInternal(workOrderId, date, userId, targetDate, onProgress);
}

/** 마킹 롤백 내부 구현 (targetDate가 null이면 전체, 값이면 해당 날짜만) */
async function rollbackMarkingInternal(
  workOrderId: string, date: string, userId: string, targetDate: string | null, onProgress?: ProgressCallback
): Promise<RollbackResult> {
  try {
    const { data: wo } = await supabase.from('work_order').select('status').eq('id', workOrderId).maybeSingle();
    const status = (wo as any)?.status;
    if (status !== '마킹중' && status !== '마킹완료') {
      return { success: false, error: `현재 상태가 '마킹중/마킹완료'가 아닙니다 (${status}). 마킹 롤백 불가.` };
    }

    const totalSteps = 7;
    onProgress?.(1, totalSteps, '데이터 조회 중...');

    const pwWhId = await getWarehouseId('플레이위즈');

    const { data: lines } = await supabase
      .from('work_order_line')
      .select('id, finished_sku_id, marked_qty, needs_marking')
      .eq('work_order_id', workOrderId);
    const lineIds = (lines || []).map((l: any) => l.id);

    if (lineIds.length === 0) {
      return { success: false, error: '작업지시서 라인을 찾을 수 없습니다.' };
    }

    onProgress?.(2, totalSteps, '마킹 기록 조회 중...');

    // daily_marking 조회 (targetDate 필터 적용)
    let markingQuery = supabaseAdmin
      .from('daily_marking')
      .select('id, work_order_line_id, completed_qty, date')
      .in('work_order_line_id', lineIds);
    if (targetDate) {
      markingQuery = markingQuery.eq('date', targetDate);
    }
    const { data: markings } = await markingQuery;

    if (!markings || markings.length === 0) {
      return { success: false, error: targetDate ? `${targetDate} 날짜에 마킹 기록이 없습니다.` : '마킹 기록이 없습니다.' };
    }

    onProgress?.(3, totalSteps, 'BOM 조회 중...');

    const markingLines = (lines || []).filter((l: any) => l.needs_marking) as any[];
    const finishedSkuIds = [...new Set(markingLines.map((l: any) => l.finished_sku_id))];

    const bomMap: Record<string, { componentSkuId: string; quantity: number }[]> = {};
    if (finishedSkuIds.length > 0) {
      const { data: boms } = await supabaseAdmin
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity')
        .in('finished_sku_id', finishedSkuIds);
      for (const b of (boms || []) as any[]) {
        if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
        bomMap[b.finished_sku_id].push({ componentSkuId: b.component_sku_id, quantity: b.quantity });
      }
    }

    // 라인별 마킹 합계 (대상 범위만)
    const lineMarkingTotals = new Map<string, number>();
    for (const m of (markings as any[])) {
      const current = lineMarkingTotals.get(m.work_order_line_id) || 0;
      lineMarkingTotals.set(m.work_order_line_id, current + m.completed_qty);
    }

    onProgress?.(4, totalSteps, '트랜잭션 삭제 + 재고 역반영 중...');

    // deleteSystemTransactions로 트랜잭션 삭제 + inventory 역반영을 한 번에 처리
    // (수동 inventory 조정 제거 → 이중 복원 버그 방지)
    for (const fSkuId of finishedSkuIds) {
      await deleteSystemTransactions({
        warehouseId: pwWhId,
        memo: `마킹작업 구성품 차감 (${fSkuId})`,
      });
    }
    // 완성품 증가 트랜잭션은 memo가 동일하므로 1회 호출로 전체 삭제
    await deleteSystemTransactions({
      warehouseId: pwWhId,
      memo: '마킹작업 완성품 증가',
    });

    onProgress?.(5, totalSteps, '마킹 기록 삭제 중...');

    // daily_marking 삭제 (대상 범위만)
    const markingIds = (markings as any[]).map((m: any) => m.id);
    if (markingIds.length > 0) {
      // 500건씩 배치 삭제
      for (let i = 0; i < markingIds.length; i += 500) {
        const batch = markingIds.slice(i, i + 500);
        await supabaseAdmin.from('daily_marking').delete().in('id', batch);
      }
    }

    onProgress?.(6, totalSteps, 'marked_qty 업데이트 중...');

    // marked_qty 차감 (해당 범위분만)
    for (const line of (lines || []) as any[]) {
      const rolledBack = lineMarkingTotals.get(line.id) || 0;
      if (rolledBack <= 0) continue;
      const newMarked = Math.max(0, (line.marked_qty || 0) - rolledBack);
      await supabase.from('work_order_line').update({ marked_qty: newMarked }).eq('id', line.id);
    }

    onProgress?.(7, totalSteps, '상태 확인 중...');

    // 남은 마킹 확인 → 상태 결정
    const { data: remainingMarkings } = await supabaseAdmin
      .from('daily_marking')
      .select('id')
      .in('work_order_line_id', lineIds)
      .limit(1);

    const hasRemaining = (remainingMarkings || []).length > 0;

    if (!hasRemaining) {
      // 모든 마킹 삭제됨 → 입고확인완료
      await supabase.from('work_order').update({ status: '입고확인완료' }).eq('id', workOrderId);
    } else if (status === '마킹완료') {
      // 일부만 삭제 + 이전 상태가 마킹완료 → 마킹중으로 변경
      await supabase.from('work_order').update({ status: '마킹중' }).eq('id', workOrderId);
    }
    // 마킹중 상태에서 일부 삭제 → 상태 유지

    // 원본 activity_log 삭제
    if (targetDate) {
      // 해당 날짜의 마킹 로그만 삭제
      await supabase.from('activity_log').delete()
        .eq('work_order_id', workOrderId)
        .eq('action_type', 'marking_work')
        .eq('action_date', targetDate);
    } else {
      // 전체 마킹 로그 삭제
      await supabase.from('activity_log').delete()
        .eq('work_order_id', workOrderId)
        .eq('action_type', 'marking_work');
    }

    // 롤백 activity_log
    await supabase.from('activity_log').insert({
      user_id: userId,
      action_type: 'rollback_marking' as ActionType,
      work_order_id: workOrderId,
      action_date: new Date().toISOString().slice(0, 10),
      summary: {
        items: markingLines
          .filter((l: any) => (lineMarkingTotals.get(l.id) || 0) > 0)
          .map((l: any) => ({
            skuId: l.finished_sku_id,
            skuName: l.finished_sku_id,
            markedQty: lineMarkingTotals.get(l.id) || 0,
          })),
        totalQty: [...lineMarkingTotals.values()].reduce((s, v) => s + v, 0),
        workOrderDate: date,
        targetDate: targetDate || '전체',
      },
    });

    return { success: true, error: null };
  } catch (e: any) {
    return { success: false, error: e.message || '마킹 롤백 실패' };
  }
}

/** 출고 롤백 */
export async function rollbackShipmentOut(
  workOrderId: string, date: string, userId: string, onProgress?: ProgressCallback
): Promise<RollbackResult> {
  try {
    const { data: wo } = await supabase.from('work_order').select('status').eq('id', workOrderId).maybeSingle();
    if ((wo as any)?.status !== '출고완료') {
      return { success: false, error: `현재 상태가 '출고완료'가 아닙니다 (${(wo as any)?.status}). 출고 롤백 불가.` };
    }

    onProgress?.(1, 3, '재고 트랜잭션 삭제 중...');
    const pwWhId = await getWarehouseId('플레이위즈');
    await deleteSystemTransactions({
      warehouseId: pwWhId,
      memo: `출고확인 (작업지시서 ${date})`,
    });

    onProgress?.(2, 3, '상태 복원 중...');
    await supabase.from('work_order').update({ status: '마킹완료' }).eq('id', workOrderId);

    onProgress?.(3, 4, '원본 이력 삭제 중...');
    await supabase.from('activity_log').delete()
      .eq('work_order_id', workOrderId)
      .eq('action_type', 'shipment_out');

    onProgress?.(4, 4, '롤백 이력 기록 중...');
    await supabase.from('activity_log').insert({
      user_id: userId,
      action_type: 'rollback_shipment_out' as ActionType,
      work_order_id: workOrderId,
      action_date: new Date().toISOString().slice(0, 10),
      summary: { items: [], totalQty: 0, workOrderDate: date },
    });

    return { success: true, error: null };
  } catch (e: any) {
    return { success: false, error: e.message || '출고 롤백 실패' };
  }
}

/** 작업지시서 완전 삭제: 역순 롤백 후 물리삭제 */
export async function deleteWorkOrderCompletely(
  workOrderId: string,
  downloadDate: string,
  status: WorkOrderStatus,
  userId: string,
  onProgress?: ProgressCallback
): Promise<RollbackResult> {
  try {
    // 역순 롤백 단계 결정
    const rollbackSteps: RollbackStep[] = [];
    switch (status) {
      case '출고완료':
        rollbackSteps.push('출고', '마킹', '입고', '발송');
        break;
      case '마킹완료':
      case '마킹중':
        rollbackSteps.push('마킹', '입고', '발송');
        break;
      case '입고확인완료':
        rollbackSteps.push('입고', '발송');
        break;
      case '이관중':
      case '취소요청':
      case '수정요청':
        rollbackSteps.push('발송');
        break;
      // 이관준비, 업로드됨 → 롤백 불필요
    }

    const totalPhases = rollbackSteps.length + 2; // +2: 데이터 정리 + 물리삭제
    let phase = 0;

    // 1. 역순 롤백 실행 (상태 체크 우회를 위해 직접 상태 변경 후 롤백)
    for (const step of rollbackSteps) {
      phase++;
      onProgress?.(phase, totalPhases, `${step} 롤백 중...`);

      // 각 롤백 함수는 상태를 체크하므로, 현재 DB 상태를 맞춰줘야 함
      // rollback 함수가 상태를 자동으로 복원하므로 순차 실행
      const result = await executeRollback(step, workOrderId, downloadDate, userId);
      if (!result.success) {
        // 롤백할 데이터가 없는 경우 무시하고 계속 진행
        console.warn(`${step} 롤백 스킵: ${result.error}`);
      }
    }

    // 2. 남은 데이터 정리
    phase++;
    onProgress?.(phase, totalPhases, '데이터 정리 중...');

    const { data: lines } = await supabase
      .from('work_order_line').select('id').eq('work_order_id', workOrderId);
    const lineIds = (lines || []).map((l: any) => l.id);

    if (lineIds.length > 0) {
      // daily_marking 잔여 삭제 (500건 배치)
      for (let i = 0; i < lineIds.length; i += 500) {
        const batch = lineIds.slice(i, i + 500);
        await supabaseAdmin.from('daily_marking').delete().in('work_order_line_id', batch);
      }
    }

    // work_order_line 삭제
    await supabase.from('work_order_line').delete().eq('work_order_id', workOrderId);

    // activity_log 잔여 전체 삭제 (rollback 로그 포함)
    await supabase.from('activity_log').delete().eq('work_order_id', workOrderId);

    // 3. work_order 물리삭제
    phase++;
    onProgress?.(phase, totalPhases, '작업지시서 삭제 중...');
    await supabase.from('work_order').delete().eq('id', workOrderId);

    return { success: true, error: null };
  } catch (e: any) {
    return { success: false, error: e.message || '작업지시서 삭제 실패' };
  }
}

/** 단계에 맞는 롤백 함수 실행 */
export async function executeRollback(
  step: RollbackStep, workOrderId: string, date: string, userId: string,
  onProgress?: ProgressCallback, targetDate?: string
): Promise<RollbackResult> {
  switch (step) {
    case '발송': return rollbackShipment(workOrderId, date, userId, onProgress);
    case '입고': return rollbackReceipt(workOrderId, date, userId, onProgress);
    case '마킹':
      if (targetDate) {
        return rollbackMarkingByDate(workOrderId, date, userId, targetDate, onProgress);
      }
      return rollbackMarking(workOrderId, date, userId, onProgress);
    case '출고': return rollbackShipmentOut(workOrderId, date, userId, onProgress);
  }
}
