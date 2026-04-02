import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction } from '../../lib/inventoryTransaction';
import { rollbackShipmentOut, type ProgressCallback } from '../../lib/workOrderRollback';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Download, FileUp, Trash2, Truck, Info } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
import { TableSkeleton } from '../../components/LoadingSkeleton';
import { notifySlack } from '../../lib/slackNotify';
import type { AppUser } from '../../types';

interface ShipmentOutItem {
  finishedSkuId: string;
  skuName: string;
  barcode: string | null;
  availableQty: number;   // 출고 가능 수량 (마킹완료 / 작업완료)
  shipQty: number;         // 실제 출고 수량 (사용자 입력)
  inventoryQty: number | null; // 플레이위즈 현재 재고 (null=미등록)
  isShortage: boolean;
  needsMarking: boolean;   // true=마킹 완성품, false=단품
}

interface ActiveWorkOrder {
  id: string;
  download_date: string;
  status: string;
}

export default function ShipmentOut({ currentUser }: { currentUser: AppUser }) {
  const isStale = useStaleGuard();
  const [workOrders, setWorkOrders] = useState<ActiveWorkOrder[]>([]);
  const [selectedWo, setSelectedWo] = useState<ActiveWorkOrder | null>(null);
  const [items, setItems] = useState<ShipmentOutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmProgress, setConfirmProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLoadingTimeout(loading, setLoading, setError);
  const [uploadComparison, setUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 단품: 입고 차수 필터
  const [receiptWaves, setReceiptWaves] = useState<{ wave: number; date: string; totalQty: number }[]>([]);
  const [selectedWave, setSelectedWave] = useState<number | null>(null); // null = 전체
  // 마킹: 작업일 필터
  const [markingSessions, setMarkingSessions] = useState<{ date: string; totalQty: number }[]>([]);
  const [selectedMarkingDate, setSelectedMarkingDate] = useState<string | null>(null); // null = 전체

  // 이력 조회
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [historyItems, setHistoryItems] = useState<{ skuName: string; qty: number }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const isToday = selectedDate === today;

  // 이력 삭제
  const [historyWorkOrder, setHistoryWorkOrder] = useState<{ id: string; date: string; status: string } | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rollbackProgress, setRollbackProgress] = useState<{ current: number; total: number; step: string } | null>(null);

  useEffect(() => {
    loadPendingOrders();
  }, []);

  const loadPendingOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .in('status', ['입고확인완료', '마킹중', '마킹완료'])
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      if (isStale()) return;
      const orders = (data || []) as ActiveWorkOrder[];
      setWorkOrders(orders);
      if (orders.length > 0) {
        selectOrder(orders[0]);
      } else {
        setLoading(false);
      }
    } catch (e: any) {
      if (!isStale()) setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
      setLoading(false);
    }
  };

  const selectOrder = async (wo: ActiveWorkOrder) => {
    setSelectedWo(wo);
    setLoading(true);
    setConfirmed(false);
    setError(null);
    setUploadComparison(null);
    setXlsxError(null);
    try {
      // 1단계: work_order_line + warehouse 병렬 조회
      const [linesResult, warehouseResult] = await Promise.all([
        supabase
          .from('work_order_line')
          .select('id, finished_sku_id, ordered_qty, received_qty, marked_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
          .eq('work_order_id', wo.id),
        supabase
          .from('warehouse')
          .select('id')
          .eq('name', '플레이위즈')
          .maybeSingle(),
      ]);
      if (linesResult.error) throw linesResult.error;
      if (warehouseResult.error) throw warehouseResult.error;
      if (isStale()) return;

      const lineList = (linesResult.data || []) as any[];
      const warehouseId = (warehouseResult.data as any)?.id;

      // 2단계: inventory + 이전 출고 이력 + 발송 이력 + 입고 이력 병렬 조회
      const [inventoryResult, outLogResult, shipLogResult, recLogResult, markingLogResult] = await Promise.all([
        supabase
          .from('inventory')
          .select('sku_id, quantity, needs_marking')
          .eq('warehouse_id', warehouseId),
        supabase
          .from('activity_log')
          .select('summary')
          .eq('work_order_id', wo.id)
          .eq('action_type', 'shipment_out'),
        supabase
          .from('activity_log')
          .select('summary')
          .eq('work_order_id', wo.id)
          .eq('action_type', 'shipment_confirm'),
        // 입고 차수 목록
        supabase
          .from('activity_log')
          .select('action_date, summary')
          .eq('work_order_id', wo.id)
          .eq('action_type', 'receipt_check')
          .order('created_at', { ascending: true }),
        // 마킹 세션 목록
        supabase
          .from('activity_log')
          .select('action_date, summary')
          .eq('work_order_id', wo.id)
          .eq('action_type', 'marking_work')
          .order('created_at', { ascending: true }),
      ]);
      if (inventoryResult.error) throw inventoryResult.error;
      if (isStale()) return;

      // 입고 차수 목록 (단품 필터용)
      const waves = ((recLogResult.data || []) as any[]).map((l: any) => ({
        wave: l.summary?.wave || 1,
        date: l.action_date,
        totalQty: (l.summary?.items || []).reduce((s: number, i: any) => s + (i.actualQty || 0), 0),
      }));
      setReceiptWaves(waves);

      // 마킹 세션 목록 (마킹 완성품 필터용)
      const mSessions: { date: string; totalQty: number }[] = [];
      for (const l of ((markingLogResult.data || []) as any[])) {
        const d = l.action_date;
        const q = l.summary?.totalQty || (l.summary?.items || []).reduce((s: number, i: any) => s + (i.completedQty || 0), 0);
        const existing = mSessions.find((s) => s.date === d);
        if (existing) existing.totalQty += q;
        else mSessions.push({ date: d, totalQty: q });
      }
      setMarkingSessions(mSessions);

      // needs_marking별 분리 재고맵
      const invDirect: Record<string, number> = {};   // needs_marking=false (단품)
      const invMarking: Record<string, number> = {};  // needs_marking=true (마킹용)
      const inventoryMap: Record<string, number> = {}; // 합산 (하위호환)
      for (const inv of (inventoryResult.data || []) as any[]) {
        inventoryMap[inv.sku_id] = (inventoryMap[inv.sku_id] || 0) + inv.quantity;
        if (inv.needs_marking) {
          invMarking[inv.sku_id] = (invMarking[inv.sku_id] || 0) + inv.quantity;
        } else {
          invDirect[inv.sku_id] = (invDirect[inv.sku_id] || 0) + inv.quantity;
        }
      }

      // 이전 출고 수량 — needsMarking별 분리
      const prevShippedDirect: Record<string, number> = {};
      const prevShippedMarking: Record<string, number> = {};
      for (const log of (outLogResult.data || []) as any[]) {
        for (const item of (log.summary?.items || []) as any[]) {
          if (!item.skuId || !item.shipQty) continue;
          if (item.needsMarking) {
            prevShippedMarking[item.skuId] = (prevShippedMarking[item.skuId] || 0) + item.shipQty;
          } else {
            prevShippedDirect[item.skuId] = (prevShippedDirect[item.skuId] || 0) + item.shipQty;
          }
        }
      }

      // 발송 이력에서 단품(needsMarking=false) SKU별 발송 수량 합산
      const directShipmentQty: Record<string, number> = {};
      for (const log of (shipLogResult.data || []) as any[]) {
        for (const item of (log.summary?.items || []) as any[]) {
          if (item.needsMarking === false && item.skuId && item.sentQty > 0) {
            directShipmentQty[item.skuId] = (directShipmentQty[item.skuId] || 0) + item.sentQty;
          }
        }
      }

      // 4. 출고 가능 수량 집계 — 단품(입고 차수 필터) + 마킹(작업일 필터) 분리
      const itemMap: Record<string, ShipmentOutItem> = {};

      // SKU 이름 조회용 맵
      const skuNameMap: Record<string, { name: string; barcode: string | null }> = {};
      for (const line of lineList) {
        skuNameMap[line.finished_sku_id] = {
          name: line.finished_sku?.sku_name || line.finished_sku_id,
          barcode: line.finished_sku?.barcode || null,
        };
      }

      // ── A. 단품: 입고 차수 필터 ──
      if (selectedWave !== null) {
        // 특정 차수의 발송 이력에서 단품(needsMarking=false)만 추출
        const targetShipLog = ((shipLogResult.data || []) as any[])
          .find((l: any) => l.summary?.wave === selectedWave);
        if (targetShipLog) {
          for (const item of (targetShipLog.summary?.items || []) as any[]) {
            if (item.needsMarking !== false || !item.skuId || !item.sentQty) continue;
            const info = skuNameMap[item.skuId];
            itemMap[item.skuId] = {
              finishedSkuId: item.skuId, skuName: info?.name || item.skuId, barcode: info?.barcode || null,
              availableQty: item.sentQty, shipQty: 0, inventoryQty: invDirect[item.skuId] || 0,
              isShortage: false, needsMarking: false,
            };
          }
        }
      } else {
        // 전체: needs_marking=false 재고 기준
        for (const [skuId, qty] of Object.entries(invDirect)) {
          if (qty <= 0 || (skuId.startsWith('26UN-') && skuId.includes('_'))) continue;
          const info = skuNameMap[skuId];
          itemMap[skuId] = {
            finishedSkuId: skuId, skuName: info?.name || skuId, barcode: info?.barcode || null,
            availableQty: qty, shipQty: 0, inventoryQty: qty, isShortage: false, needsMarking: false,
          };
        }
      }

      // ── B. 마킹 완성품: 작업일 필터 ──
      if (selectedMarkingDate) {
        // 특정 날짜의 마킹 작업 이력에서 완성품 추출
        const targetMarkingLogs = ((markingLogResult.data || []) as any[])
          .filter((l: any) => l.action_date === selectedMarkingDate);
        for (const log of targetMarkingLogs) {
          for (const item of (log.summary?.items || []) as any[]) {
            const skuId = item.skuId;
            const qty = item.completedQty || 0;
            if (!skuId || qty <= 0) continue;
            if (itemMap[skuId]) { itemMap[skuId].availableQty += qty; continue; }
            const info = skuNameMap[skuId];
            itemMap[skuId] = {
              finishedSkuId: skuId, skuName: info?.name || item.skuName || skuId, barcode: info?.barcode || null,
              availableQty: qty, shipQty: 0, inventoryQty: inventoryMap[skuId] || 0,
              isShortage: false, needsMarking: true,
            };
          }
        }
      } else {
        // 전체: 완제품(26UN-*_*) 재고
        const finishedSkuIds = Object.keys(inventoryMap)
          .filter(skuId => (inventoryMap[skuId] || 0) > 0 && skuId.startsWith('26UN-') && skuId.includes('_'));

        // SKU 이름 배치 조회
        const missingNameSkus = finishedSkuIds.filter(s => !skuNameMap[s]);
        if (missingNameSkus.length > 0) {
          const { data: skuInfos } = await supabase.from('sku').select('sku_id, sku_name, barcode').in('sku_id', missingNameSkus);
          for (const s of (skuInfos || []) as any[]) skuNameMap[s.sku_id] = { name: s.sku_name, barcode: s.barcode };
        }

        for (const skuId of finishedSkuIds) {
          if (itemMap[skuId]) continue;
          const qty = inventoryMap[skuId];
          const info = skuNameMap[skuId];
        itemMap[skuId] = {
          finishedSkuId: skuId,
          skuName: info?.name || skuId,
          barcode: info?.barcode || null,
          availableQty: qty,
          shipQty: 0,
          inventoryQty: qty,
          isShortage: false,
          needsMarking: true,
        };
        }
      }

      // 이전 출고분 차감 후 출고 가능 수량 계산
      const shipmentItems: ShipmentOutItem[] = Object.values(itemMap)
        // 이전 출고 차감은 A/B에서 이미 처리됨 → 추가 차감 불필요
        .filter((item) => item.availableQty > 0);

      setItems(shipmentItems);
    } catch (e: any) {
      if (!isStale()) setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    const newDate = d.toISOString().split('T')[0];
    if (newDate > today) return;
    setSelectedDate(newDate);
    if (newDate === today) {
      setHistoryItems([]);
    } else {
      loadHistory(newDate);
    }
  };

  const loadHistory = async (date: string) => {
    setHistoryLoading(true);
    setHistoryWorkOrder(null);
    try {
      const { data } = await supabase
        .from('activity_log')
        .select('summary, work_order_id')
        .eq('user_id', currentUser.id)
        .eq('action_type', 'shipment_out')
        .eq('action_date', date);
      const items = (data || []).flatMap((d: any) =>
        (d.summary?.items || []).map((i: any) => ({ skuName: i.skuName, qty: i.shipQty || 0 }))
      );
      setHistoryItems(items);

      // work_order 상태 조회 (삭제 가능 여부 판단용)
      const woId = (data || [])[0]?.work_order_id;
      if (woId) {
        const { data: wo } = await supabase
          .from('work_order')
          .select('id, download_date, status')
          .eq('id', woId)
          .maybeSingle();
        if (wo) setHistoryWorkOrder({ id: (wo as any).id, date: (wo as any).download_date, status: (wo as any).status });
      }
    } catch { /* silent */ }
    finally { setHistoryLoading(false); }
  };

  // ── 출고 실적 삭제 ──
  const handleDeleteShipmentOut = async () => {
    if (!historyWorkOrder) return;
    setDeleting(true);
    setRollbackProgress(null);
    setError(null);
    try {
      const onProgress: ProgressCallback = (current, total, step) => {
        setRollbackProgress({ current, total, step });
      };

      const result = await rollbackShipmentOut(
        historyWorkOrder.id,
        historyWorkOrder.date,
        currentUser.id,
        onProgress
      );

      if (!result.success) {
        throw new Error(result.error || '롤백 실패');
      }

      // UI 초기화
      setHistoryItems([]);
      setHistoryWorkOrder(null);
      setShowDeleteModal(false);
      loadPendingOrders();
    } catch (e: any) {
      setError(`삭제 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setDeleting(false);
      setRollbackProgress(null);
    }
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T00:00:00');
    const mm = date.getMonth() + 1;
    const dd = date.getDate();
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    return `${mm}월 ${dd}일 (${dayNames[date.getDay()]})`;
  };

  const handleShipQtyChange = (skuId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.finishedSkuId === skuId ? { ...item, shipQty: Math.max(0, value) } : item
      )
    );
  };

  // ── 엑셀 양식 다운로드 ─────────────────────────
  const handleDownloadTemplate = () => {
    generateTemplate(
      items.map((item) => ({
        skuId: item.finishedSkuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.shipQty,
      })),
      `출고수량_${selectedWo?.download_date || '양식'}.xlsx`
    );
  };

  // ── 엑셀 업로드 → shipQty 적용 + 비교 패널 ────
  const handleExcelUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setXlsxError(null);
    setUploadComparison(null);
    try {
      const result = await parseQtyExcel(
        file,
        items.map((item) => ({ skuId: item.finishedSkuId, skuName: item.skuName, barcode: item.barcode }))
      );

      const matchMap = new Map(result.matched.map((m) => [m.skuId, m.uploadedQty]));
      setItems((prev) =>
        prev.map((item) =>
          matchMap.has(item.finishedSkuId)
            ? { ...item, shipQty: matchMap.get(item.finishedSkuId)! }
            : item
        )
      );

      const rows: ComparisonRow[] = result.matched.map((m) => {
        const item = items.find((i) => i.finishedSkuId === m.skuId);
        return {
          skuId: m.skuId,
          skuName: item?.skuName || m.skuId,
          expected: item?.availableQty ?? 0,
          uploaded: m.uploadedQty,
          diff: m.uploadedQty - (item?.availableQty ?? 0),
        };
      });
      setUploadComparison({ rows, unmatched: result.unmatched });
    } catch (err: any) {
      setXlsxError(err.message || '파일 처리 실패');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleConfirm = async () => {
    if (!selectedWo) return;
    setConfirming(true);
    setConfirmProgress(null);
    setError(null);
    try {
      const BATCH = 10;
      const activeItems = items.filter((i) => i.shipQty > 0);
      const totalSteps = Math.ceil(activeItems.length / BATCH) + 3;
      let step = 1;

      // 1. 상태 업데이트 (마킹완료→출고완료, 마킹중→유지)
      setConfirmProgress({ current: step, total: totalSteps, step: '출고 상태 업데이트 중...' });
      if (selectedWo.status === '마킹완료') {
        const { error: statusErr } = await supabase
          .from('work_order')
          .update({ status: '출고완료' })
          .eq('id', selectedWo.id);
        if (statusErr) throw statusErr;

        // 연결된 온라인 주문도 출고완료로 변경
        await supabase
          .from('online_order')
          .update({ status: '출고완료' })
          .eq('work_order_id', selectedWo.id)
          .in('status', ['발송대기', '이관중', '마킹중']);
      }
      // 마킹중 상태는 유지 (부분 출고)
      step++;

      // 2. 플레이위즈 창고 조회
      setConfirmProgress({ current: step, total: totalSteps, step: '창고 정보 조회 중...' });
      const { data: warehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      step++;

      // 3. 플레이위즈 재고 차감 (배치 병렬)
      if (warehouse) {
        const whId = (warehouse as any).id;
        for (let i = 0; i < activeItems.length; i += BATCH) {
          const batch = activeItems.slice(i, i + BATCH);
          setConfirmProgress({ current: step, total: totalSteps, step: `재고 차감 중... (${Math.min(i + BATCH, activeItems.length)} / ${activeItems.length})` });
          await Promise.all(batch.map(async (item) => {
            // needs_marking별로 재고 차감 (단품은 needs_marking=false에서, 마킹은 true/false 합산에서)
            const nmFilter = item.needsMarking ? true : false;
            const { data: inv } = await supabase
              .from('inventory')
              .select('quantity')
              .eq('warehouse_id', whId)
              .eq('sku_id', item.finishedSkuId)
              .eq('needs_marking', nmFilter)
              .maybeSingle();
            if (inv) {
              await supabase.from('inventory')
                .update({ quantity: Math.max(0, (inv as any).quantity - item.shipQty) })
                .eq('warehouse_id', whId)
                .eq('sku_id', item.finishedSkuId)
                .eq('needs_marking', nmFilter);
            }
            await recordTransaction({
              warehouseId: whId,
              skuId: item.finishedSkuId,
              txType: '출고',
              quantity: item.shipQty,
              source: 'system',
              needsMarking: item.needsMarking,
              memo: `출고확인 (작업지시서 ${selectedWo.download_date})`,
            });
          }));
          step++;
        }
      }

      // Activity log (wave 번호 계산 포함)
      try {
        const { data: existingOutWaves } = await supabase
          .from('activity_log').select('id')
          .eq('work_order_id', selectedWo.id)
          .eq('action_type', 'shipment_out');
        const waveNum = (existingOutWaves || []).length + 1;

        await supabase.from('activity_log').insert({
          user_id: currentUser.id,
          action_type: 'shipment_out',
          work_order_id: selectedWo.id,
          action_date: new Date().toISOString().split('T')[0],
          summary: {
            wave: waveNum,
            items: items.map((i) => ({ skuId: i.finishedSkuId, skuName: i.skuName, shipQty: i.shipQty, needsMarking: i.needsMarking })),
            totalQty: items.reduce((s, i) => s + i.shipQty, 0),
            workOrderDate: selectedWo.download_date,
          },
        });
      } catch (logErr) { console.warn('Activity log failed:', logErr); }

      setConfirmed(true);
      loadPendingOrders();

      // 슬랙 알림
      const shippedItems = items.filter((i) => i.shipQty > 0);
      notifySlack({
        action: '출고확인',
        user: currentUser.name || currentUser.email,
        date: selectedWo.download_date,
        items: shippedItems.map((i) => ({ name: i.skuName, qty: i.shipQty })),
        extra: selectedWo.status === '마킹중' ? '_부분 출고 (마킹 진행 중)_' : undefined,
      }).catch((e) => console.warn('[비동기 후처리 실패]', e));

      // 온라인 주문 상태 업데이트: 마킹중 → 출고완료 (FIFO)
      import('../../lib/onlineOrderSync').then(({ updateOnlineOrderBySkus }) => {
        const skuIds = shippedItems.map((i) => i.finishedSkuId);
        updateOnlineOrderBySkus(skuIds, '출고완료', '마킹중').catch((e) => console.warn('[비동기 후처리 실패]', e));
      });
    } catch (e: any) {
      setError(`출고 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setConfirming(false);
      setConfirmProgress(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-gray-900">출고 확인</h2>
        <TableSkeleton rows={6} />
      </div>
    );
  }

  const noWorkToday = (workOrders.length === 0 && !confirmed) || confirmed;

  if (noWorkToday && isToday) {
    return (
      <div className="space-y-5 max-w-lg">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
          <div className="flex items-center justify-between">
            <button onClick={() => changeDate(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
              <ChevronLeft size={18} />
            </button>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-900">{formatDate(selectedDate)}</p>
              <span className="text-xs text-blue-600 font-medium">오늘</span>
            </div>
            <button disabled className="p-1.5 rounded-lg text-gray-500 opacity-30 cursor-not-allowed">
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-center h-48">
          <div className="text-center">
            {confirmed ? (
              <>
                <Truck size={48} className="mx-auto text-emerald-500 mb-3" />
                <p className="text-gray-700 font-semibold text-lg">출고 완료 처리되었습니다</p>
                <p className="text-sm text-gray-400 mt-1">관리자가 STEP 4 양식을 다운로드하여 BERRIZ에 업로드합니다</p>
              </>
            ) : (
              <>
                <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
                <p className="text-gray-600 font-medium">출고 대기 중인 물량이 없습니다</p>
                <p className="text-sm text-gray-400 mt-1">입고 확인된 작업지시서가 없습니다</p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (noWorkToday && !isToday) {
    return (
      <div className="space-y-5 max-w-lg">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
          <div className="flex items-center justify-between">
            <button onClick={() => changeDate(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
              <ChevronLeft size={18} />
            </button>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-900">{formatDate(selectedDate)}</p>
              <span className="text-xs text-gray-400">이력 조회 (읽기 전용)</span>
            </div>
            <button onClick={() => changeDate(1)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
            <h3 className="font-medium text-gray-700">{formatDate(selectedDate)} 출고 이력</h3>
            <p className="text-xs text-gray-400 mt-0.5">읽기 전용</p>
          </div>
          {historyLoading ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : historyItems.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">이 날짜에 기록된 출고가 없습니다</div>
          ) : (
            <>
              <div className="divide-y divide-gray-50">
                {historyItems.map((h, idx) => (
                  <div key={idx} className="px-5 py-3.5 flex items-center gap-3">
                    <p className="text-sm font-medium text-gray-900 truncate flex-1">{h.skuName}</p>
                    <p className="text-sm font-semibold text-gray-700 flex-shrink-0">{h.qty}개</p>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <p className="text-sm text-gray-600">총 출고:</p>
                <p className="text-sm font-bold text-gray-900">{historyItems.reduce((s, h) => s + h.qty, 0)}개</p>
              </div>
            </>
          )}
          {/* 삭제 버튼 */}
          {historyItems.length > 0 && historyWorkOrder && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100">
              {historyWorkOrder.status === '출고완료' ? (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
                >
                  <Trash2 size={16} />
                  출고 실적 삭제
                </button>
              ) : (
                <p className="text-xs text-red-400 text-center">현재 상태: {historyWorkOrder.status} — 삭제 불가</p>
              )}
            </div>
          )}
          <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
            <button onClick={() => { setSelectedDate(today); setHistoryItems([]); setHistoryWorkOrder(null); }} className="text-sm text-blue-600 font-medium hover:underline">
              오늘 작업으로 돌아가기
            </button>
          </div>
        </div>
        {/* 삭제 확인 모달 */}
        {showDeleteModal && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
              <div className="px-6 py-5 border-b border-gray-100">
                <h3 className="text-lg font-bold text-gray-900">출고 실적 삭제</h3>
                <p className="text-sm text-gray-500 mt-1">이 작업은 되돌릴 수 없습니다</p>
              </div>
              <div className="px-6 py-4 space-y-3">
                <div className="bg-red-50 rounded-lg p-3">
                  <p className="text-sm text-red-700 font-medium">삭제 시 다음이 함께 처리됩니다:</p>
                  <ul className="text-xs text-red-600 mt-2 space-y-1">
                    <li>• 작업지시서 상태 복원 (마킹완료)</li>
                    <li>• 재고 수불부 트랜잭션 삭제 + 재고 복원</li>
                  </ul>
                </div>
                <div className="text-sm text-gray-600">
                  <p>작업지시서: <span className="font-medium">{historyWorkOrder?.date}</span></p>
                  <p>삭제 대상: <span className="font-medium">{historyItems.length}종 / {historyItems.reduce((s, h) => s + h.qty, 0)}개</span></p>
                </div>
                {deleting && rollbackProgress && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                    <p className="text-xs text-red-700 font-medium text-center">{rollbackProgress.step}</p>
                    <div className="w-full bg-red-200 rounded-full h-2 overflow-hidden">
                      <div className="bg-red-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.round((rollbackProgress.current / rollbackProgress.total) * 100)}%` }} />
                    </div>
                    <p className="text-[10px] text-red-500 text-center">{rollbackProgress.current} / {rollbackProgress.total}</p>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
                <button onClick={() => setShowDeleteModal(false)} disabled={deleting} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">취소</button>
                <button onClick={handleDeleteShipmentOut} disabled={deleting} className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50">
                  {deleting ? '삭제 중...' : '삭제 확인'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const isMarkingDone = selectedWo?.status === '마킹완료';
  const isShipmentReady = selectedWo?.status === '마킹중' || selectedWo?.status === '마킹완료';
  const hasShortage = items.some((item) => item.isShortage);
  const markingItems = items.filter((i) => i.needsMarking);
  const directItems = items.filter((i) => !i.needsMarking);
  const totalMarkingQty = markingItems.reduce((s, i) => s + i.shipQty, 0);
  const totalDirectQty = directItems.reduce((s, i) => s + i.shipQty, 0);
  const totalShipQty = totalMarkingQty + totalDirectQty;
  const totalMarkingAvailable = markingItems.reduce((s, i) => s + i.availableQty, 0);
  const totalDirectAvailable = directItems.reduce((s, i) => s + i.availableQty, 0);

  return (
    <div className="space-y-5 max-w-lg">
      {/* 에러 */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800">{error}</p>
            <button onClick={loadPendingOrders} className="text-xs text-red-600 underline mt-1">다시 시도</button>
          </div>
        </div>
      )}

      {/* 날짜 네비게이션 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <button onClick={() => changeDate(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
            <ChevronLeft size={18} />
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold text-gray-900">{formatDate(selectedDate)}</p>
            {isToday ? (
              <span className="text-xs text-emerald-600 font-medium">오늘 — 작업 모드</span>
            ) : (
              <span className="text-xs text-gray-400">이력 조회 (읽기 전용)</span>
            )}
          </div>
          <button onClick={() => changeDate(1)} disabled={isToday} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* 과거 이력 조회 모드 */}
      {!isToday && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
            <h3 className="font-medium text-gray-700">{formatDate(selectedDate)} 출고 이력</h3>
            <p className="text-xs text-gray-400 mt-0.5">읽기 전용</p>
          </div>
          {historyLoading ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : historyItems.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">이 날짜에 기록된 출고가 없습니다</div>
          ) : (
            <>
              <div className="divide-y divide-gray-50">
                {historyItems.map((h, idx) => (
                  <div key={idx} className="px-5 py-3.5 flex items-center gap-3">
                    <p className="text-sm font-medium text-gray-900 truncate flex-1">{h.skuName}</p>
                    <p className="text-sm font-semibold text-gray-700 flex-shrink-0">{h.qty}개</p>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <p className="text-sm text-gray-600">총 출고:</p>
                <p className="text-sm font-bold text-gray-900">{historyItems.reduce((s, h) => s + h.qty, 0)}개</p>
              </div>
            </>
          )}
          {/* 삭제 버튼 */}
          {historyItems.length > 0 && historyWorkOrder && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100">
              {historyWorkOrder.status === '출고완료' ? (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
                >
                  <Trash2 size={16} />
                  출고 실적 삭제
                </button>
              ) : (
                <p className="text-xs text-red-400 text-center">현재 상태: {historyWorkOrder.status} — 삭제 불가</p>
              )}
            </div>
          )}
          <div className="px-5 py-3 bg-emerald-50 border-t border-emerald-100 text-center">
            <button onClick={() => { setSelectedDate(today); setHistoryItems([]); setHistoryWorkOrder(null); }} className="text-sm text-emerald-600 font-medium hover:underline">
              오늘 작업으로 돌아가기
            </button>
          </div>
        </div>
      )}

      {/* 삭제 확인 모달 (메인 뷰) */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">출고 실적 삭제</h3>
              <p className="text-sm text-gray-500 mt-1">이 작업은 되돌릴 수 없습니다</p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="bg-red-50 rounded-lg p-3">
                <p className="text-sm text-red-700 font-medium">삭제 시 다음이 함께 처리됩니다:</p>
                <ul className="text-xs text-red-600 mt-2 space-y-1">
                  <li>• 작업지시서 상태 복원 (마킹완료)</li>
                  <li>• 재고 수불부 트랜잭션 삭제 + 재고 복원</li>
                </ul>
              </div>
              <div className="text-sm text-gray-600">
                <p>작업지시서: <span className="font-medium">{historyWorkOrder?.date}</span></p>
                <p>삭제 대상: <span className="font-medium">{historyItems.length}종 / {historyItems.reduce((s, h) => s + h.qty, 0)}개</span></p>
              </div>
              {deleting && rollbackProgress && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-red-700 font-medium text-center">{rollbackProgress.step}</p>
                  <div className="w-full bg-red-200 rounded-full h-2 overflow-hidden">
                    <div className="bg-red-600 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((rollbackProgress.current / rollbackProgress.total) * 100)}%` }} />
                  </div>
                  <p className="text-[10px] text-red-500 text-center">{rollbackProgress.current} / {rollbackProgress.total}</p>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} disabled={deleting} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">취소</button>
              <button onClick={handleDeleteShipmentOut} disabled={deleting} className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50">
                {deleting ? '삭제 중...' : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 헤더 */}
      {isToday && <><div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-gray-900">출고 확인</h2>
          {selectedWo && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              isMarkingDone
                ? 'bg-green-100 text-green-700'
                : 'bg-amber-100 text-amber-700'
            }`}>
              {isMarkingDone ? '마킹완료' : '마킹중'}
            </span>
          )}
        </div>
        {workOrders.length > 1 && (
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            value={selectedWo?.id}
            onChange={(e) => {
              const wo = workOrders.find((w) => w.id === e.target.value);
              if (wo) selectOrder(wo);
            }}
          >
            {workOrders.map((wo) => (
              <option key={wo.id} value={wo.id}>
                {wo.download_date} ({wo.status === '마킹완료' ? '마킹완료' : '마킹중'})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* STEP 3 확인 안내 */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-xl p-3">
        <Info size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-blue-800">
          관리자에게 <strong>STEP 3 양식</strong>이 BERRIZ에 업로드되었는지 확인 후 진행하세요.
        </p>
      </div>

      {/* 엑셀 버튼 */}
      <div className="flex gap-2">
        <button
          onClick={handleDownloadTemplate}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <Download size={15} />
          양식 다운로드
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-emerald-300 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors"
        >
          <FileUp size={15} />
          엑셀 업로드
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={handleExcelUpload}
        />
      </div>

      {/* 엑셀 파싱 에러 */}
      {xlsxError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{xlsxError}</p>
        </div>
      )}

      {/* 업로드 비교 패널 */}
      {uploadComparison && (
        <ComparisonPanel
          rows={uploadComparison.rows}
          unmatched={uploadComparison.unmatched}
          onClose={() => setUploadComparison(null)}
        />
      )}

      {/* 품목 카드 — 완성품/단품 2컬럼 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900">CJ 물류센터로 보낼 물량</h3>
              <p className="text-sm text-gray-500 mt-0.5">{selectedWo?.download_date} 기준</p>
            </div>
            <div className="flex gap-2">
              {receiptWaves.length > 1 && (
                <select
                  value={selectedWave ?? 'all'}
                  onChange={async (e) => {
                    const val = e.target.value;
                    const wave = val === 'all' ? null : Number(val);
                    setSelectedWave(wave);
                    if (selectedWo) {
                      setItems([]); setUploadComparison(null);
                      setTimeout(() => { if (selectedWo) selectOrder(selectedWo); }, 0);
                    }
                  }}
                  className="text-xs border border-emerald-300 rounded-lg px-2 py-1.5 bg-white text-emerald-700"
                >
                  <option value="all">단품: 전체</option>
                  {receiptWaves.map((w) => (
                    <option key={w.wave} value={w.wave}>
                      단품: {w.wave}차 ({w.date})
                    </option>
                  ))}
                </select>
              )}
              {markingSessions.length > 0 && (
                <select
                  value={selectedMarkingDate ?? 'all'}
                  onChange={async (e) => {
                    const val = e.target.value;
                    setSelectedMarkingDate(val === 'all' ? null : val);
                    if (selectedWo) {
                      setItems([]); setUploadComparison(null);
                      setTimeout(() => { if (selectedWo) selectOrder(selectedWo); }, 0);
                    }
                  }}
                  className="text-xs border border-purple-300 rounded-lg px-2 py-1.5 bg-white text-purple-700"
                >
                  <option value="all">마킹: 전체</option>
                  {markingSessions.map((s) => (
                    <option key={s.date} value={s.date}>
                      마킹: {s.date} ({s.totalQty}개)
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>

        {/* 총 수량 합계 (예정 / 실적) */}
        <div className="px-5 py-3 bg-emerald-50/60 border-b border-gray-100 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-purple-700">마킹 완성품 소계 (예정 / 실적)</span>
            <span className="font-semibold text-purple-800">
              {totalMarkingAvailable}개 / <span className={totalMarkingQty !== totalMarkingAvailable ? 'text-orange-600' : ''}>{totalMarkingQty}개</span>
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-emerald-700">단품 소계 (예정 / 실적)</span>
            <span className="font-semibold text-emerald-800">
              {totalDirectAvailable}개 / <span className={totalDirectQty !== totalDirectAvailable ? 'text-orange-600' : ''}>{totalDirectQty}개</span>
            </span>
          </div>
          <div className="border-t border-emerald-200 pt-1 mt-1 flex items-center justify-between text-sm">
            <span className="font-bold text-gray-800">총 출고 수량 (예정 / 실적)</span>
            <span className="font-bold text-gray-900 text-base">
              {totalMarkingAvailable + totalDirectAvailable}개 / <span className={totalShipQty !== (totalMarkingAvailable + totalDirectAvailable) ? 'text-orange-600' : ''}>{totalShipQty}개</span>
            </span>
          </div>
        </div>

        {hasShortage && (
          <div className="mx-4 mt-4 flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <AlertTriangle size={16} className="text-yellow-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-800">
              일부 품목 재고가 부족합니다. 실제 출고 수량을 직접 입력해주세요.
            </p>
          </div>
        )}

        {/* 2컬럼 헤더 */}
        <div className="grid grid-cols-2 border-b border-gray-100">
          <div className="px-4 py-2.5 border-r border-gray-100 bg-purple-50">
            <p className="text-xs font-semibold text-purple-700">
              마킹 완성품{' '}
              <span className="font-normal text-purple-500">
                ({markingItems.length}종)
              </span>
            </p>
          </div>
          <div className="px-4 py-2.5 bg-emerald-50">
            <p className="text-xs font-semibold text-emerald-700">
              단품{' '}
              <span className="font-normal text-emerald-500">
                ({directItems.length}종)
              </span>
            </p>
          </div>
        </div>

        {/* 2컬럼 아이템 목록 */}
        <div className="grid grid-cols-2">
          {/* 왼쪽: 마킹 완성품 */}
          <div className="border-r border-gray-100 divide-y divide-gray-50">
            {markingItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-gray-400">해당 없음</div>
            ) : (
              markingItems.map((item) => (
                <div
                  key={item.finishedSkuId}
                  className={`px-3 py-3 ${item.isShortage ? 'bg-red-50' : ''}`}
                >
                  <p className="text-xs font-medium text-gray-800 leading-tight truncate">{item.skuName}</p>
                  <p className="text-[10px] text-gray-400 font-mono mt-0.5 truncate">{item.finishedSkuId}</p>
                  <div className="flex items-center justify-between mt-1.5 gap-1">
                    <div>
                      <p className="text-[10px] text-gray-400">마킹완료 {item.availableQty}</p>
                      {item.inventoryQty === null ? (
                        <p className="text-[10px] text-gray-300">재고 미등록</p>
                      ) : item.isShortage ? (
                        <p className="text-[10px] text-red-500">재고 {item.inventoryQty}</p>
                      ) : (
                        <p className="text-[10px] text-gray-400">재고 {item.inventoryQty}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <input
                        type="number"
                        min="0"
                        value={item.shipQty}
                        onChange={(e) => handleShipQtyChange(item.finishedSkuId, Number(e.target.value))}
                        className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-purple-500 ${
                          item.inventoryQty !== null && item.shipQty > item.inventoryQty
                            ? 'border-orange-300 bg-orange-50'
                            : 'border-gray-300'
                        }`}
                      />
                      <span className="text-[10px] text-gray-400">개</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 오른쪽: 단품 */}
          <div className="divide-y divide-gray-50">
            {directItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-gray-400">해당 없음</div>
            ) : (
              directItems.map((item) => (
                <div
                  key={item.finishedSkuId}
                  className={`px-3 py-3 ${item.isShortage ? 'bg-red-50' : ''}`}
                >
                  <p className="text-xs font-medium text-gray-800 leading-tight truncate">{item.skuName}</p>
                  <p className="text-[10px] text-gray-400 font-mono mt-0.5 truncate">{item.finishedSkuId}</p>
                  <div className="flex items-center justify-between mt-1.5 gap-1">
                    <div>
                      <p className="text-[10px] text-gray-400">입고확인 {item.availableQty}</p>
                      {item.inventoryQty === null ? (
                        <p className="text-[10px] text-gray-300">재고 미등록</p>
                      ) : item.isShortage ? (
                        <p className="text-[10px] text-red-500">재고 {item.inventoryQty}</p>
                      ) : (
                        <p className="text-[10px] text-gray-400">재고 {item.inventoryQty}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <input
                        type="number"
                        min="0"
                        value={item.shipQty}
                        onChange={(e) => handleShipQtyChange(item.finishedSkuId, Number(e.target.value))}
                        className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                          item.inventoryQty !== null && item.shipQty > item.inventoryQty
                            ? 'border-orange-300 bg-orange-50'
                            : 'border-gray-300'
                        }`}
                      />
                      <span className="text-[10px] text-gray-400">개</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 진행 표시 */}
      {confirming && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-emerald-700 font-medium text-center">
            {confirmProgress?.step ?? '처리 중...'}
          </p>
          {confirmProgress && (
            <>
              <div className="w-full bg-emerald-200 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-emerald-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((confirmProgress.current / confirmProgress.total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-emerald-500 text-center">
                {confirmProgress.current} / {confirmProgress.total}
                ({Math.round((confirmProgress.current / confirmProgress.total) * 100)}%)
              </p>
            </>
          )}
        </div>
      )}

      <button
        onClick={handleConfirm}
        disabled={confirming || items.length === 0 || !isShipmentReady}
        className="w-full bg-emerald-600 text-white py-3.5 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base"
      >
        <Truck size={20} />
        {confirming ? '처리 중...' : isMarkingDone ? '출고 완료 확인' : '마킹 완료분 출고'}
      </button>
      {!isShipmentReady ? (
        <p className="text-xs text-center text-amber-600">
          마킹 작업이 시작되면 출고할 수 있습니다
        </p>
      ) : !isMarkingDone ? (
        <p className="text-xs text-center text-blue-600">
          마킹 완료된 수량만 출고됩니다
        </p>
      ) : (
        <p className="text-xs text-center text-gray-400">
          버튼 클릭 시 CJ 물류센터로 출고 처리됩니다
        </p>
      )}
      </>}
    </div>
  );
}
