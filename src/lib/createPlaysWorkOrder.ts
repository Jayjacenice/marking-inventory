import { supabaseAdmin } from './supabaseAdmin';
import { supabase } from './supabase';
import { getWarehouseId } from './warehouseStore';
import { getLedgerInventory } from './ledgerInventory';

export interface PossibleOrder {
  orderId: string;
  orderNumber: string;
  skuId: string;
  skuName: string;
  quantity: number;
  needsMarking: boolean;
  components: { skuId: string; skuName: string; qty: number }[]; // BOM 전개 결과 (단품은 자기 자신 1개)
}

export interface ImpossibleOrder {
  orderId: string;
  orderNumber: string;
  skuId: string;
  skuName: string;
  quantity: number;
  needsMarking: boolean;
  missingComponents: { skuId: string; needed: number; available: number }[];
}

export interface PlaysAnalysisResult {
  possibleOrders: PossibleOrder[];
  impossibleOrders: ImpossibleOrder[];
  consumedBySkuId: Record<string, number>; // 가능 주문으로 차감될 수량
  availableBefore: Record<string, number>; // 예약 차감 후 가용 재고 (차감 전)
  reservedBySku: Record<string, number>;
}

const ACTIVE_STATUSES = ['이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료'];
const CANDIDATE_STATUSES = ['신규', '재고부족', '취소'];

/** 플레이위즈 재고 기반으로 처리 가능한 주문을 분석. 실행은 하지 않음. */
export async function analyzePlaysBasedOrders(): Promise<PlaysAnalysisResult> {
  const pwWhId = await getWarehouseId('플레이위즈');
  if (!pwWhId) throw new Error('플레이위즈 창고를 찾을 수 없습니다.');

  // 1) 후보 주문 수집
  //    - status: 신규 / 재고부족 / 취소
  //    - work_order_id IS NULL (신규/재고부족) 또는 status='취소'(WO에 붙어있어도 재할당 대상)
  //    페이지네이션
  const candidates: any[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('online_order')
      .select('id, order_number, sku_id, sku_name, quantity, needs_marking, status, work_order_id, order_date')
      .in('status', CANDIDATE_STATUSES)
      .order('order_date', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`주문 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    candidates.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  const eligible = candidates.filter((o) =>
    o.work_order_id == null || o.status === '취소',
  );
  if (eligible.length === 0) {
    return {
      possibleOrders: [],
      impossibleOrders: [],
      consumedBySkuId: {},
      availableBefore: {},
      reservedBySku: {},
    };
  }

  // 2) 플레이위즈 수불부 기반 재고
  const ledgerInv = await getLedgerInventory(pwWhId);

  // 3) 진행중 WO 예약분 차감
  //    - 단품 라인(needs_marking=false): ordered_qty - sent_qty
  //    - 마킹 라인(needs_marking=true): BOM 전개 후 (received_qty - marked_qty) 소모 예정
  const { data: activeWos } = await supabase
    .from('work_order')
    .select('id')
    .in('status', ACTIVE_STATUSES);
  const activeWoIds = (activeWos || []).map((w: any) => w.id);

  const reservedBySku: Record<string, number> = {};
  if (activeWoIds.length > 0) {
    const { data: lines } = await supabase
      .from('work_order_line')
      .select('finished_sku_id, ordered_qty, sent_qty, received_qty, marked_qty, needs_marking')
      .in('work_order_id', activeWoIds);

    const nonMarkingPending: Record<string, number> = {};
    const markingPendingByFinished: Record<string, number> = {};
    for (const l of (lines || []) as any[]) {
      if (l.needs_marking) {
        const pending = Math.max(0, (l.received_qty || 0) - (l.marked_qty || 0));
        if (pending > 0) {
          markingPendingByFinished[l.finished_sku_id] =
            (markingPendingByFinished[l.finished_sku_id] || 0) + pending;
        }
      } else {
        const pending = Math.max(0, (l.ordered_qty || 0) - (l.sent_qty || 0));
        if (pending > 0) {
          nonMarkingPending[l.finished_sku_id] =
            (nonMarkingPending[l.finished_sku_id] || 0) + pending;
        }
      }
    }

    // 단품은 자기 자신 소모
    for (const [skuId, qty] of Object.entries(nonMarkingPending)) {
      reservedBySku[skuId] = (reservedBySku[skuId] || 0) + qty;
    }

    // 마킹은 BOM 전개 후 구성품 소모
    const markingFinishedIds = Object.keys(markingPendingByFinished);
    if (markingFinishedIds.length > 0) {
      for (let i = 0; i < markingFinishedIds.length; i += 500) {
        const { data: boms } = await supabase
          .from('bom')
          .select('finished_sku_id, component_sku_id, quantity')
          .in('finished_sku_id', markingFinishedIds.slice(i, i + 500));
        for (const b of (boms || []) as any[]) {
          const pending = markingPendingByFinished[b.finished_sku_id] || 0;
          reservedBySku[b.component_sku_id] =
            (reservedBySku[b.component_sku_id] || 0) + pending * (b.quantity || 1);
        }
      }
    }
  }

  // 4) 가용 재고 = 수불부 - 예약
  const availableBefore: Record<string, number> = {};
  const allSkuIds = new Set([...Object.keys(ledgerInv), ...Object.keys(reservedBySku)]);
  for (const skuId of allSkuIds) {
    availableBefore[skuId] = (ledgerInv[skuId] || 0) - (reservedBySku[skuId] || 0);
  }

  // 5) 후보 주문의 BOM 조회 (마킹 완제품)
  const finishedSkuIds = [...new Set(eligible.map((o) => o.sku_id))];
  const bomMap: Record<string, { skuId: string; skuName: string; qty: number }[]> = {};
  if (finishedSkuIds.length > 0) {
    for (let i = 0; i < finishedSkuIds.length; i += 500) {
      const { data: boms } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component_sku:sku!bom_component_sku_id_fkey(sku_name)')
        .in('finished_sku_id', finishedSkuIds.slice(i, i + 500));
      for (const b of (boms || []) as any[]) {
        if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
        bomMap[b.finished_sku_id].push({
          skuId: b.component_sku_id,
          skuName: b.component_sku?.sku_name || b.component_sku_id,
          qty: b.quantity || 1,
        });
      }
    }
  }

  // 6) FIFO 배분 (오래된 주문부터)
  const possibleOrders: PossibleOrder[] = [];
  const impossibleOrders: ImpossibleOrder[] = [];
  const consumedBySkuId: Record<string, number> = {};
  const workingPool = { ...availableBefore };

  for (const o of eligible) {
    // BOM 구성 (마킹 완제품이면 BOM, 아니면 단품 자기 자신)
    let components: { skuId: string; skuName: string; qty: number }[];
    const isMarking = o.needs_marking === true;
    if (isMarking) {
      components = bomMap[o.sku_id];
      if (!components || components.length === 0) {
        // BOM 미등록 → 패턴 추정 (OrderUpload 기존 로직과 동일)
        const base = o.sku_id.split('_')[0];
        const mkSku = base.replace('26UN-', '26MK-');
        components = [
          { skuId: base, skuName: base, qty: 1 },
          { skuId: mkSku, skuName: mkSku, qty: 1 },
        ];
      }
    } else {
      components = [{ skuId: o.sku_id, skuName: o.sku_name || o.sku_id, qty: 1 }];
    }

    // 완결 매칭 검증 — 모든 구성품이 가용해야 함
    let canMake = true;
    const missing: { skuId: string; needed: number; available: number }[] = [];
    for (const c of components) {
      const needed = c.qty * o.quantity;
      const available = workingPool[c.skuId] || 0;
      if (available < needed) {
        canMake = false;
        missing.push({ skuId: c.skuId, needed, available });
      }
    }

    if (canMake) {
      // 재고 차감 (다음 주문의 평가에 반영)
      for (const c of components) {
        const consume = c.qty * o.quantity;
        workingPool[c.skuId] = (workingPool[c.skuId] || 0) - consume;
        consumedBySkuId[c.skuId] = (consumedBySkuId[c.skuId] || 0) + consume;
      }
      possibleOrders.push({
        orderId: o.id,
        orderNumber: o.order_number,
        skuId: o.sku_id,
        skuName: o.sku_name || o.sku_id,
        quantity: o.quantity,
        needsMarking: !!o.needs_marking,
        components,
      });
    } else {
      impossibleOrders.push({
        orderId: o.id,
        orderNumber: o.order_number,
        skuId: o.sku_id,
        skuName: o.sku_name || o.sku_id,
        quantity: o.quantity,
        needsMarking: !!o.needs_marking,
        missingComponents: missing,
      });
    }
  }

  return {
    possibleOrders,
    impossibleOrders,
    consumedBySkuId,
    availableBefore,
    reservedBySku,
  };
}

/** 분석 결과로 새 WO를 생성. 이관·입고 단계 스킵, tx 생성 없음. */
export async function createPlaysWorkOrder(
  possibleOrders: PossibleOrder[],
  currentUserId: string,
): Promise<{ workOrderId: string; lineCount: number; orderCount: number; totalQty: number }> {
  if (possibleOrders.length === 0) {
    throw new Error('생성할 주문이 없습니다.');
  }

  const today = new Date().toISOString().slice(0, 10);

  // SKU별 합산 (work_order_line 단위)
  const skuMap: Record<string, { qty: number; needsMarking: boolean; skuName: string }> = {};
  for (const p of possibleOrders) {
    const key = p.skuId;
    if (!skuMap[key]) skuMap[key] = { qty: 0, needsMarking: p.needsMarking, skuName: p.skuName };
    skuMap[key].qty += p.quantity;
  }

  const hasMarking = Object.values(skuMap).some((v) => v.needsMarking);
  const initialStatus = hasMarking ? '마킹중' : '입고확인완료';

  // WO 생성
  const { data: wo, error: woErr } = await supabaseAdmin
    .from('work_order')
    .insert({ download_date: today, status: initialStatus })
    .select('id')
    .single();
  if (woErr || !wo) throw woErr || new Error('작업지시서 생성 실패');
  const woId = wo.id;

  // SKU 자동 등록 (누락 대비)
  const skuIds = Object.keys(skuMap);
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100).map((s) => ({
      sku_id: s,
      sku_name: skuMap[s].skuName || s,
      type: '완제품',
    }));
    await supabaseAdmin.from('sku').upsert(batch, { onConflict: 'sku_id', ignoreDuplicates: true });
  }

  // work_order_line insert — 이관·입고 스킵이므로 sent_qty = received_qty = ordered_qty
  const lines = Object.entries(skuMap).map(([skuId, v]) => ({
    work_order_id: woId,
    finished_sku_id: skuId,
    ordered_qty: v.qty,
    sent_qty: v.qty,
    received_qty: v.qty,
    marked_qty: 0,
    needs_marking: v.needsMarking,
  }));
  for (let i = 0; i < lines.length; i += 100) {
    const { error } = await supabaseAdmin
      .from('work_order_line')
      .insert(lines.slice(i, i + 100));
    if (error) throw error;
  }

  // online_order 재할당
  const orderIds = possibleOrders.map((p) => p.orderId);
  const newOrderStatus = hasMarking ? '마킹중' : '입고확인완료';
  for (let i = 0; i < orderIds.length; i += 100) {
    const batch = orderIds.slice(i, i + 100);
    const { error } = await supabaseAdmin
      .from('online_order')
      .update({ work_order_id: woId, status: newOrderStatus })
      .in('id', batch);
    if (error) throw error;
  }

  // activity_log
  await supabase.from('activity_log').insert({
    user_id: currentUserId,
    action_type: 'work_order_create_from_plays',
    work_order_id: woId,
    action_date: today,
    summary: {
      lines: lines.length,
      orders: possibleOrders.length,
      totalQty: possibleOrders.reduce((s, p) => s + p.quantity, 0),
      initialStatus,
      reason: '플레이위즈 재고 기반 보완 작업지시서',
    },
  });

  return {
    workOrderId: woId,
    lineCount: lines.length,
    orderCount: possibleOrders.length,
    totalQty: possibleOrders.reduce((s, p) => s + p.quantity, 0),
  };
}
