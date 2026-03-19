import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction, deleteSystemTransactions } from '../../lib/inventoryTransaction';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Edit3, FileUp, Trash2, Truck, XCircle } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
import { TwoColumnSkeleton } from '../../components/LoadingSkeleton';
import { notifySlack } from '../../lib/slackNotify';
import type { AppUser } from '../../types';

interface ShipmentItem {
  lineId: string;
  skuId: string;
  skuName: string;
  barcode: string | null;
  orderedQty: number;
  sentQty: number;
  inventoryQty: number;
  isShortage: boolean;
  isMarking: boolean;
  checked: boolean;
}

interface ActiveWorkOrder {
  id: string;
  download_date: string;
  status?: string;
  lineCount?: number;
  remainingQty?: number;
}

interface HistoryEntry {
  skuName: string;
  qty: number;
  workOrderDate?: string;
}

export default function ShipmentConfirm({ currentUser }: { currentUser: AppUser }) {
  const isStale = useStaleGuard();
  const [workOrders, setWorkOrders] = useState<ActiveWorkOrder[]>([]);
  const [selectedWo, setSelectedWo] = useState<ActiveWorkOrder | null>(null);
  const [items, setItems] = useState<ShipmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmProgress, setConfirmProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedWoId, setConfirmedWoId] = useState<string | null>(null);
  const [confirmedWoDate, setConfirmedWoDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadComparison, setUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 확인 모달
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // 취소/수정 요청
  const [cancelRequesting, setCancelRequesting] = useState(false);
  const [modifyRequesting, setModifyRequesting] = useState(false);
  const [showModifyForm, setShowModifyForm] = useState(false);
  const [modifyItems, setModifyItems] = useState<{ skuId: string; skuName: string; originalQty: number; newQty: number }[]>([]);
  const [modifyReason, setModifyReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [requestSent, setRequestSent] = useState<'cancel' | 'modify' | null>(null);

  // 최근 발송 완료 건 (취소/수정 가능)
  const [recentShipped, setRecentShipped] = useState<ActiveWorkOrder[]>([]);
  const [selectedRecent, setSelectedRecent] = useState<ActiveWorkOrder | null>(null);

  // 이력 조회
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const isToday = selectedDate === today;

  // 아코디언 통합 뷰
  const [expandedWoIds, setExpandedWoIds] = useState<Set<string>>(new Set());
  const [woItemsCache, setWoItemsCache] = useState<Record<string, ShipmentItem[]>>({});
  const [woLoadingId, setWoLoadingId] = useState<string | null>(null);

  // 이력 삭제
  const [historyWorkOrder, setHistoryWorkOrder] = useState<{ id: string; date: string; status: string } | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadPendingOrders();
  }, []);

  const loadPendingOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      // 이관준비 (발송 대기) + 잔량 있는 진행중 건 (추가 발송 가능)
      const [pendResult, progressResult, recentResult] = await Promise.all([
        supabase
          .from('work_order')
          .select('id, download_date, status, sent_detail, work_order_line(ordered_qty, sent_qty, needs_marking, finished_sku_id)')
          .eq('status', '이관준비')
          .order('uploaded_at', { ascending: false }),
        // 이관중 ~ 마킹완료까지 잔량 체크 (입고/마킹 진행 중에도 추가 발송 가능)
        supabase
          .from('work_order')
          .select('id, download_date, status, sent_detail, work_order_line(ordered_qty, sent_qty, needs_marking, finished_sku_id)')
          .in('status', ['이관중', '입고확인완료', '마킹중', '마킹완료'])
          .order('uploaded_at', { ascending: false }),
        supabase
          .from('work_order')
          .select('id, download_date, status')
          .in('status', ['취소요청', '수정요청'])
          .order('uploaded_at', { ascending: false }),
      ]);
      if (pendResult.error) throw pendResult.error;
      if (progressResult.error) throw progressResult.error;
      if (recentResult.error) throw recentResult.error;
      if (isStale()) return;

      // BOM 전개 후 잔량 계산을 위해 모든 작업지시서의 마킹 SKU에 대한 BOM 조회
      const allWoData = [...((pendResult.data || []) as any[]), ...((progressResult.data || []) as any[])];
      const allMarkingSkuIds = new Set<string>();
      for (const wo of allWoData) {
        for (const l of (wo.work_order_line || [])) {
          if (l.needs_marking) allMarkingSkuIds.add(l.finished_sku_id);
        }
      }
      const markingSkuArr = [...allMarkingSkuIds];
      let bomMap: Record<string, number> = {}; // finished_sku_id → BOM 구성품 수 (유니폼+마킹)
      if (markingSkuArr.length > 0) {
        const { data: bomData } = await supabase.from('bom')
          .select('finished_sku_id, quantity')
          .in('finished_sku_id', markingSkuArr);
        // finished_sku_id당 구성품 quantity 합계
        for (const b of (bomData || []) as any[]) {
          bomMap[b.finished_sku_id] = (bomMap[b.finished_sku_id] || 0) + (b.quantity || 1);
        }
      }

      // BOM 전개 후 잔량 계산 헬퍼 (sent_detail 기반)
      const enrichWo = (wo: any): ActiveWorkOrder => {
        const lines = wo.work_order_line || [];
        const lineCount = lines.length;
        const detail: Record<string, number> = wo.sent_detail || {};

        // 1. BOM 전개 후 총 주문량 계산
        let totalOrdered = 0;
        for (const l of lines) {
          if (l.needs_marking && bomMap[l.finished_sku_id]) {
            totalOrdered += (l.ordered_qty || 0) * bomMap[l.finished_sku_id];
          } else {
            totalOrdered += (l.ordered_qty || 0);
          }
        }

        // 2. sent_detail 합계 = 이미 발송된 구성품 수량
        const totalSent = Object.values(detail).reduce((s: number, v: any) => s + (v || 0), 0);

        const remainingQty = Math.max(0, totalOrdered - totalSent);
        return { id: wo.id, download_date: wo.download_date, status: wo.status, lineCount, remainingQty };
      };

      // 잔량 있는 건 필터 (enrichWo에서 계산된 remainingQty > 0)
      const allProgress = ((progressResult.data || []) as any[]).map(enrichWo);
      const withRemaining = allProgress.filter((wo) => (wo.remainingQty || 0) > 0);

      // 잔량 없는 이관중 건 = 최근 발송 완료 건
      const done = allProgress.filter((wo) => (wo.remainingQty || 0) <= 0 && wo.status === '이관중');

      // 발송 대기 = 이관준비 + 잔량 있는 진행중 건
      const pendOrders = ((pendResult.data || []) as any[]).map(enrichWo);
      const orders = [...pendOrders, ...withRemaining];
      setWorkOrders(orders);
      setRecentShipped([
        ...(done as ActiveWorkOrder[]),
        ...((recentResult.data || []) as ActiveWorkOrder[]),
      ]);

      // 1건이면 자동 펼침
      if (orders.length === 1) {
        setExpandedWoIds(new Set([orders[0].id]));
        selectOrder(orders[0]);
      } else if (orders.length > 0) {
        // 여러 건이면 첫 번째 선택만 (펼침은 사용자가)
        setSelectedWo(orders[0]);
        setLoading(false);
      } else {
        setLoading(false);
      }
    } catch (e: any) {
      if (!isStale()) setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
      setLoading(false);
    }
  };

  // 아코디언 토글
  const toggleAccordion = async (wo: ActiveWorkOrder) => {
    const newSet = new Set(expandedWoIds);
    if (newSet.has(wo.id)) {
      newSet.delete(wo.id);
      setExpandedWoIds(newSet);
      return;
    }
    newSet.add(wo.id);
    setExpandedWoIds(newSet);

    // 캐시에 있으면 즉시 표시
    if (woItemsCache[wo.id]) {
      setSelectedWo(wo);
      setItems(woItemsCache[wo.id]);
      return;
    }

    // 없으면 로드
    setWoLoadingId(wo.id);
    await selectOrder(wo);
    setWoLoadingId(null);
  };

  const selectOrder = async (wo: ActiveWorkOrder) => {
    setSelectedWo(wo);
    setLoading(true);
    setConfirmed(false);
    setError(null);
    setUploadComparison(null);
    setXlsxError(null);
    try {
      // 1단계: lines + warehouse 병렬 조회
      const [linesResult, warehouseResult] = await Promise.all([
        supabase.from('work_order_line')
          .select('id, finished_sku_id, ordered_qty, sent_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
          .eq('work_order_id', wo.id),
        supabase.from('warehouse').select('id').eq('name', '오프라인샵').maybeSingle(),
      ]);
      if (linesResult.error) throw linesResult.error;
      if (warehouseResult.error) throw warehouseResult.error;
      if (isStale()) return;

      const lines = linesResult.data;
      const offlineWarehouseId = (warehouseResult.data as any)?.id;

      // 2단계: BOM + inventory 병렬 조회 (각각 lines, warehouse 결과 필요)
      const markingSkuIds = ((lines || []) as any[])
        .filter((l: any) => l.needs_marking)
        .map((l: any) => l.finished_sku_id as string);

      const [bomResult, invResult] = await Promise.all([
        supabase.from('bom')
          .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name, barcode)')
          .in('finished_sku_id', markingSkuIds.length > 0 ? markingSkuIds : ['__none__']),
        supabase.from('inventory').select('sku_id, quantity').eq('warehouse_id', offlineWarehouseId),
      ]);
      if (bomResult.error) throw bomResult.error;
      if (invResult.error) throw invResult.error;
      if (isStale()) return;

      const bomData = bomResult.data;
      const inventoryData = invResult.data;

      const inventoryMap: Record<string, number> = {};
      for (const inv of (inventoryData || []) as any[]) {
        inventoryMap[inv.sku_id] = inv.quantity;
      }

      const componentMap: Record<
        string,
        { lineId: string; skuId: string; skuName: string; barcode: string | null; needed: number; isMarking: boolean }
      > = {};

      const isAdditionalShipment = wo.status !== '이관준비';

      // sent_detail 조회 (구성품 레벨 발송 이력)
      const { data: woSentData } = await supabase
        .from('work_order').select('sent_detail').eq('id', wo.id).single();
      const sentDetail: Record<string, number> = (woSentData as any)?.sent_detail || {};

      // 1차: 전체 주문 수량으로 componentMap 빌드
      for (const line of (lines || []) as any[]) {
        if (line.needs_marking) {
          const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          for (const bom of boms as any[]) {
            const key = bom.component_sku_id;
            if (!componentMap[key]) {
              componentMap[key] = {
                lineId: line.id,
                skuId: bom.component_sku_id,
                skuName: bom.component?.sku_name || bom.component_sku_id,
                barcode: bom.component?.barcode || null,
                needed: 0,
                isMarking:
                  bom.component_sku_id?.includes('MK') ||
                  bom.component?.sku_name?.includes('마킹') ||
                  false,
              };
            }
            componentMap[key].needed += bom.quantity * (line.ordered_qty || 0);
          }
        } else {
          const key = line.finished_sku_id;
          if (!componentMap[key]) {
            componentMap[key] = {
              lineId: line.id,
              skuId: line.finished_sku_id,
              skuName: line.finished_sku?.sku_name || line.finished_sku_id,
              barcode: line.finished_sku?.barcode || null,
              needed: 0,
              isMarking:
                line.finished_sku_id?.includes('MK') ||
                line.finished_sku?.sku_name?.includes('마킹') ||
                false,
            };
          }
          componentMap[key].needed += (line.ordered_qty || 0);
        }
      }

      // 2차: sent_detail에서 이미 발송된 수량 차감 (추가 발송 시)
      if (isAdditionalShipment) {
        for (const key of Object.keys(componentMap)) {
          componentMap[key].needed = Math.max(0, componentMap[key].needed - (sentDetail[key] || 0));
        }
        // 잔량 0인 구성품 제거
        for (const key of Object.keys(componentMap)) {
          if (componentMap[key].needed <= 0) delete componentMap[key];
        }
      }

      const shipmentItems: ShipmentItem[] = Object.values(componentMap).map((c) => ({
        lineId: c.lineId,
        skuId: c.skuId,
        skuName: c.skuName,
        barcode: c.barcode,
        orderedQty: c.needed,
        sentQty: c.needed,
        inventoryQty: inventoryMap[c.skuId] || 0,
        isShortage: (inventoryMap[c.skuId] || 0) < c.needed,
        isMarking: c.isMarking,
        checked: true,
      }));

      setItems(shipmentItems);
      // 아코디언 캐시에 저장
      setWoItemsCache((prev) => ({ ...prev, [wo.id]: shipmentItems }));
    } catch (e: any) {
      if (!isStale()) setError(`발주 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  // ── 체크박스 ──
  const toggleCheck = (skuId: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.skuId === skuId ? { ...item, checked: !item.checked } : item
      )
    );
  };

  const toggleAll = (checked: boolean) => {
    setItems((prev) => prev.map((item) => ({ ...item, checked })));
  };

  const checkedItems = items.filter((i) => i.checked);
  const allChecked = items.length > 0 && items.every((i) => i.checked);

  // ── 날짜 이동 ──
  const changeDate = (offset: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    const newDate = d.toISOString().split('T')[0];
    if (newDate > today) return;
    setSelectedDate(newDate);
    if (newDate === today) { setHistoryItems([]); } else { loadHistory(newDate); }
  };

  const loadHistory = async (date: string) => {
    setHistoryLoading(true);
    setHistoryWorkOrder(null);
    try {
      const { data } = await supabase
        .from('activity_log')
        .select('summary, work_order_id')
        .eq('user_id', currentUser.id)
        .eq('action_type', 'shipment_confirm')
        .eq('action_date', date);
      const entries: HistoryEntry[] = (data || []).flatMap((d: any) =>
        (d.summary?.items || []).map((i: any) => ({
          skuName: i.skuName,
          qty: i.sentQty || 0,
          workOrderDate: d.summary?.workOrderDate,
        }))
      );
      setHistoryItems(entries);

      // 해당 날짜 발송의 work_order 상태 조회 (삭제 가능 여부 판단용)
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

  // ── 발송 실적 삭제 ──
  const handleDeleteShipment = async () => {
    if (!historyWorkOrder) return;
    setDeleting(true);
    setError(null);
    try {
      // 1) work_order_line.sent_qty → 0 초기화
      const { data: lines } = await supabase
        .from('work_order_line')
        .select('id')
        .eq('work_order_id', historyWorkOrder.id);
      for (const line of (lines || []) as any[]) {
        await supabase
          .from('work_order_line')
          .update({ sent_qty: 0 })
          .eq('id', line.id);
      }

      // 2) work_order.status → '이관준비' 복원
      await supabase
        .from('work_order')
        .update({ status: '이관준비' })
        .eq('id', historyWorkOrder.id);

      // 3) inventory_transaction 삭제 + inventory 역반영
      const { data: warehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .maybeSingle();
      if (warehouse) {
        await deleteSystemTransactions({
          warehouseId: (warehouse as any).id,
          memo: `발송확인 (작업지시서 ${historyWorkOrder.date})`,
        });
      }

      // 4) activity_log에 삭제 이력 기록
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'delete_shipment',
        work_order_id: historyWorkOrder.id,
        action_date: today,
        summary: {
          items: historyItems.map((h) => ({ skuName: h.skuName, sentQty: h.qty })),
          totalQty: historyItems.reduce((s, h) => s + h.qty, 0),
          workOrderDate: historyWorkOrder.date,
          deletedDate: selectedDate,
        },
      });

      // 5) UI 초기화
      setHistoryItems([]);
      setHistoryWorkOrder(null);
      setShowDeleteModal(false);
      loadPendingOrders();
    } catch (e: any) {
      setError(`삭제 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T00:00:00');
    const mm = date.getMonth() + 1;
    const dd = date.getDate();
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    return `${mm}월 ${dd}일 (${dayNames[date.getDay()]})`;
  };

  const handleSentChange = (skuId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.skuId === skuId ? { ...item, sentQty: Math.max(0, value) } : item
      )
    );
  };

  // ── 엑셀 ──
  const handleDownloadTemplate = () => {
    generateTemplate(
      items.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.sentQty,
      })),
      `발송수량_${selectedWo?.download_date || '양식'}.xlsx`
    );
  };

  const handleExcelUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setXlsxError(null);
    setUploadComparison(null);
    try {
      const result = await parseQtyExcel(
        file,
        items.map((item) => ({ skuId: item.skuId, skuName: item.skuName, barcode: item.barcode }))
      );
      const matchMap = new Map(result.matched.map((m) => [m.skuId, m.uploadedQty]));
      setItems((prev) =>
        prev.map((item) =>
          matchMap.has(item.skuId) ? { ...item, sentQty: matchMap.get(item.skuId)!, checked: matchMap.get(item.skuId)! > 0 } : item
        )
      );
      const rows: ComparisonRow[] = result.matched.map((m) => {
        const item = items.find((i) => i.skuId === m.skuId);
        return {
          skuId: m.skuId,
          skuName: item?.skuName || m.skuId,
          expected: item?.orderedQty ?? 0,
          uploaded: m.uploadedQty,
          diff: m.uploadedQty - (item?.orderedQty ?? 0),
        };
      });
      setUploadComparison({ rows, unmatched: result.unmatched });
    } catch (err: any) {
      setXlsxError(err.message || '파일 처리 실패');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── 발송 확인 (확인 모달 → 실행) ──
  const handleConfirmClick = () => {
    if (checkedItems.length === 0) {
      setError('발송할 품목을 선택해주세요.');
      return;
    }
    setShowConfirmModal(true);
  };

  const handleConfirm = async () => {
    if (!selectedWo) return;
    setShowConfirmModal(false);
    setConfirming(true);
    setConfirmProgress(null);
    setError(null);
    try {
      // 체크 안 된 품목은 sentQty=0 처리
      const finalItems = items.map((item) => ({
        ...item,
        sentQty: item.checked ? item.sentQty : 0,
      }));
      const sentMap: Record<string, number> = {};
      for (const item of finalItems) sentMap[item.skuId] = item.sentQty;

      const isAdditional = selectedWo.status !== '이관준비';

      setConfirmProgress({ current: 1, total: 4, step: '발송 상태 업데이트 중...' });

      // sent_detail JSONB에 구성품별 발송 수량 머지 (정확한 추적)
      const { data: woData } = await supabase
        .from('work_order').select('sent_detail').eq('id', selectedWo.id).single();
      const prevDetail: Record<string, number> = (woData as any)?.sent_detail || {};
      const newDetail: Record<string, number> = { ...prevDetail };
      for (const [skuId, qty] of Object.entries(sentMap)) {
        newDetail[skuId] = (newDetail[skuId] || 0) + qty;
      }

      // 이관준비 → 이관중 전이 + sent_detail 저장
      if (!isAdditional) {
        const { error: statusErr } = await supabase
          .from('work_order')
          .update({ status: '이관중', sent_detail: newDetail })
          .eq('id', selectedWo.id);
        if (statusErr) throw statusErr;
      } else {
        const { error: detailErr } = await supabase
          .from('work_order')
          .update({ sent_detail: newDetail })
          .eq('id', selectedWo.id);
        if (detailErr) throw detailErr;
      }

      setConfirmProgress({ current: 2, total: 4, step: '데이터 조회 중...' });
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, sent_qty, needs_marking')
        .eq('work_order_id', selectedWo.id);
      if (linesErr) throw linesErr;

      const lineList = (lines || []) as any[];
      const confirmMarkingSkuIds = lineList
        .filter((l) => l.needs_marking)
        .map((l) => l.finished_sku_id as string);
      const { data: confirmBomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity')
        .in('finished_sku_id', confirmMarkingSkuIds.length > 0 ? confirmMarkingSkuIds : ['__none__']);
      if (bomErr) throw bomErr;

      // 라인별 실제 발송 수량 계산 — 구성품별 비례배분
      // 같은 component_sku_id를 사용하는 여러 라인이 있으므로,
      // sentMap[component]를 각 라인의 effectiveQty 비율로 분배
      const lineSentQtyMap: Record<string, number> = {};

      // needs_marking=false: finished_sku_id가 곧 skuId → 직접 매핑
      // ordered_qty(또는 잔량)까지만 할당하여 BOM 구성품과 겹치는 수량 방지
      const consumedFromSentMap: Record<string, number> = {};
      for (const line of lineList) {
        if (!line.needs_marking) {
          const maxQty = isAdditional
            ? Math.max(0, (line.ordered_qty || 0) - (line.sent_qty || 0))
            : line.ordered_qty || 0;
          const qty = Math.min(sentMap[line.finished_sku_id] || 0, maxQty);
          lineSentQtyMap[line.id] = qty;
          // 이 SKU에서 소비한 수량 기록 (BOM 비례배분에서 차감용)
          consumedFromSentMap[line.finished_sku_id] = (consumedFromSentMap[line.finished_sku_id] || 0) + qty;
        }
      }

      // needs_marking=true: 구성품별 비례배분
      // 1단계: 각 유니폼 구성품별로 사용하는 라인과 수량 집계
      const markingLines = lineList.filter((l: any) => l.needs_marking);
      const compToLines: Record<string, { lineId: string; effectiveQty: number }[]> = {};
      for (const line of markingLines) {
        const boms = (confirmBomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
        const uniformComp = boms.find((b: any) => !b.component_sku_id?.includes('MK'));
        const compId = uniformComp?.component_sku_id || boms[0]?.component_sku_id;
        if (!compId) { lineSentQtyMap[line.id] = 0; continue; }
        if (!compToLines[compId]) compToLines[compId] = [];
        const effectiveQty = isAdditional
          ? Math.max(0, (line.ordered_qty || 0) - (line.sent_qty || 0))
          : line.ordered_qty;
        compToLines[compId].push({ lineId: line.id, effectiveQty });
      }

      // 2단계: 구성품별 발송량을 라인 비율로 분배
      // needs_marking=false에서 이미 소비한 수량을 차감하여 이중 카운트 방지
      for (const [compId, entries] of Object.entries(compToLines)) {
        const rawCompSent = sentMap[compId] || 0;
        const alreadyConsumed = consumedFromSentMap[compId] || 0;
        const totalCompSent = Math.max(0, rawCompSent - alreadyConsumed);
        const totalEffective = entries.reduce((s, e) => s + e.effectiveQty, 0);
        if (totalEffective === 0) {
          entries.forEach(e => { lineSentQtyMap[e.lineId] = 0; });
          continue;
        }
        let distributed = 0;
        for (let i = 0; i < entries.length; i++) {
          if (i === entries.length - 1) {
            // 마지막 라인: 반올림 오차 보정
            lineSentQtyMap[entries[i].lineId] = totalCompSent - distributed;
          } else {
            const share = Math.round(totalCompSent * entries[i].effectiveQty / totalEffective);
            lineSentQtyMap[entries[i].lineId] = share;
            distributed += share;
          }
        }
      }

      // 라인 sent_qty 업데이트 — 실제 발송 수량 반영 (10건씩 배치 병렬)
      const BATCH = 10;
      const totalBatches = Math.ceil(lineList.length / BATCH) + Math.ceil(finalItems.length / BATCH) + 2;
      let batchStep = 3;

      for (let i = 0; i < lineList.length; i += BATCH) {
        const batch = lineList.slice(i, i + BATCH);
        setConfirmProgress({ current: batchStep, total: totalBatches, step: `라인 처리 중... (${Math.min(i + BATCH, lineList.length)} / ${lineList.length})` });
        await Promise.all(batch.map((line: any) => {
          const thisTimeSent = lineSentQtyMap[line.id] ?? 0;
          // 추가 발송: 기존 sent_qty + 이번 발송량, 첫 발송: 이번 발송량
          // ordered_qty를 초과하지 않도록 cap 처리
          const rawSentQty = isAdditional
            ? (line.sent_qty || 0) + thisTimeSent
            : thisTimeSent;
          const newSentQty = Math.min(rawSentQty, line.ordered_qty || rawSentQty);
          return supabase.from('work_order_line').update({ sent_qty: newSentQty }).eq('id', line.id);
        }));
        batchStep++;
      }

      const { data: warehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .maybeSingle();

      if (warehouse) {
        const whId = (warehouse as any).id;
        const activeItems = finalItems.filter((item) => item.sentQty > 0);
        for (let i = 0; i < activeItems.length; i += BATCH) {
          const batch = activeItems.slice(i, i + BATCH);
          setConfirmProgress({ current: batchStep, total: totalBatches, step: `재고 차감 중... (${Math.min(i + BATCH, activeItems.length)} / ${activeItems.length})` });
          await Promise.all(batch.map(async (item) => {
            const { data: inv } = await supabase
              .from('inventory')
              .select('id, quantity')
              .eq('warehouse_id', whId)
              .eq('sku_id', item.skuId)
              .maybeSingle();
            if (inv) {
              await supabase
                .from('inventory')
                .update({ quantity: Math.max(0, (inv as any).quantity - item.sentQty) })
                .eq('id', (inv as any).id);
            }
            await recordTransaction({
              warehouseId: whId,
              skuId: item.skuId,
              txType: '출고',
              quantity: item.sentQty,
              source: 'system',
              memo: `발송확인 (작업지시서 ${selectedWo.download_date})`,
            });
          }));
          batchStep++;
        }
      }

      // Activity log — 차수(wave) 번호 계산 후 저장
      try {
        const { data: existingWaves } = await supabase
          .from('activity_log')
          .select('id')
          .eq('work_order_id', selectedWo.id)
          .eq('action_type', 'shipment_confirm');
        const waveNum = (existingWaves || []).length + 1;

        await supabase.from('activity_log').insert({
          user_id: currentUser.id,
          action_type: 'shipment_confirm',
          work_order_id: selectedWo.id,
          action_date: new Date().toISOString().split('T')[0],
          summary: {
            wave: waveNum,
            items: finalItems.filter((i) => i.sentQty > 0).map((i) => ({ skuId: i.skuId, skuName: i.skuName, sentQty: i.sentQty })),
            totalQty: finalItems.reduce((s, i) => s + i.sentQty, 0),
            workOrderDate: selectedWo.download_date,
          },
        });
      } catch (logErr) { console.warn('Activity log failed:', logErr); }

      setConfirmedWoId(selectedWo.id);
      setConfirmedWoDate(selectedWo.download_date);
      setConfirmed(true);
      loadPendingOrders();

      // 슬랙 알림 (실패해도 무시)
      notifySlack({
        action: '발송확인',
        user: currentUser.name || currentUser.email,
        date: selectedWo.download_date,
        items: finalItems.filter((i) => i.sentQty > 0).map((i) => ({ name: i.skuName, qty: i.sentQty })),
      }).catch(() => {});
    } catch (e: any) {
      setError(`발송 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setConfirming(false);
      setConfirmProgress(null);
    }
  };

  // ── 취소 요청 ──
  const handleCancelRequest = async () => {
    const woId = confirmedWoId || selectedRecent?.id;
    const woDate = confirmedWoDate || selectedRecent?.download_date;
    if (!woId || !cancelReason.trim()) return;
    setCancelRequesting(true);
    setError(null);
    try {
      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: '취소요청' })
        .eq('id', woId);
      if (statusErr) throw statusErr;

      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'shipment_cancel_request',
        work_order_id: woId,
        action_date: today,
        summary: {
          items: [],
          totalQty: 0,
          workOrderDate: woDate,
          reason: cancelReason.trim(),
        },
      });

      setRequestSent('cancel');
      setShowCancelConfirm(false);
      setCancelReason('');
      loadPendingOrders();
    } catch (e: any) {
      setError(`취소 요청 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setCancelRequesting(false);
    }
  };

  // ── 수정 요청 ──
  const openModifyForm = async (woId: string) => {
    setError(null);
    try {
      // 기존 발송 데이터 조회
      const { data: logs } = await supabase
        .from('activity_log')
        .select('summary')
        .eq('work_order_id', woId)
        .eq('action_type', 'shipment_confirm')
        .order('created_at', { ascending: false })
        .limit(1);

      const logItems = (logs?.[0] as any)?.summary?.items || [];
      setModifyItems(
        logItems.map((i: any) => ({
          skuId: i.skuId,
          skuName: i.skuName,
          originalQty: i.sentQty || 0,
          newQty: i.sentQty || 0,
        }))
      );
      setModifyReason('');
      setShowModifyForm(true);
    } catch (e: any) {
      setError(`데이터 조회 실패: ${e.message}`);
    }
  };

  const handleModifyRequest = async () => {
    const woId = confirmedWoId || selectedRecent?.id;
    const woDate = confirmedWoDate || selectedRecent?.download_date;
    if (!woId || !modifyReason.trim()) return;
    setModifyRequesting(true);
    setError(null);
    try {
      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: '수정요청' })
        .eq('id', woId);
      if (statusErr) throw statusErr;

      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'shipment_modify_request',
        work_order_id: woId,
        action_date: today,
        summary: {
          items: modifyItems.map((i) => ({
            skuId: i.skuId,
            skuName: i.skuName,
            originalQty: i.originalQty,
            newQty: i.newQty,
          })),
          totalQty: modifyItems.reduce((s, i) => s + i.newQty, 0),
          workOrderDate: woDate,
          reason: modifyReason.trim(),
        },
      });

      setRequestSent('modify');
      setShowModifyForm(false);
      setModifyReason('');
      loadPendingOrders();
    } catch (e: any) {
      setError(`수정 요청 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setModifyRequesting(false);
    }
  };

  // ── 렌더링 ──

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-gray-900">발송 확인</h2>
        <TwoColumnSkeleton />
      </div>
    );
  }

  const noWorkToday = (workOrders.length === 0 && !confirmed) || confirmed;

  // ── 날짜 네비게이션 컴포넌트 ──
  const DateNav = () => (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
      <div className="flex items-center justify-between">
        <button onClick={() => changeDate(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
          <ChevronLeft size={18} />
        </button>
        <div className="text-center">
          <p className="text-sm font-semibold text-gray-900">{formatDate(selectedDate)}</p>
          {isToday ? (
            <span className="text-xs text-blue-600 font-medium">오늘</span>
          ) : (
            <span className="text-xs text-gray-400">이력 조회 (읽기 전용)</span>
          )}
        </div>
        <button onClick={() => changeDate(1)} disabled={isToday} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed">
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );

  // ── 이력 패널 ──
  const HistoryPanel = () => (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
        <h3 className="font-medium text-gray-700">{formatDate(selectedDate)} 발송 이력</h3>
        <p className="text-xs text-gray-400 mt-0.5">읽기 전용</p>
      </div>
      {historyLoading ? (
        <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : historyItems.length === 0 ? (
        <div className="px-5 py-8 text-center text-gray-400 text-sm">이 날짜에 기록된 발송이 없습니다</div>
      ) : (
        <>
          {/* 작업지시서 날짜 표시 */}
          {historyItems[0]?.workOrderDate && (
            <div className="px-5 py-2 bg-blue-50/50 border-b border-gray-100">
              <p className="text-xs text-blue-600">작업지시서: {historyItems[0].workOrderDate}</p>
            </div>
          )}
          <div className="divide-y divide-gray-50">
            {historyItems.map((h, idx) => (
              <div key={idx} className="px-5 py-3.5 flex items-center gap-3">
                <p className="text-sm font-medium text-gray-900 flex-1">{h.skuName}</p>
                <p className="text-sm font-semibold text-gray-700 flex-shrink-0">{h.qty}개</p>
              </div>
            ))}
          </div>
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
            <p className="text-sm text-gray-600">총 발송:</p>
            <p className="text-sm font-bold text-gray-900">{historyItems.reduce((s, h) => s + h.qty, 0)}개</p>
          </div>
        </>
      )}
      {/* 삭제 버튼 영역 */}
      {historyItems.length > 0 && historyWorkOrder && (
        <div className="px-5 py-3 bg-red-50 border-t border-red-100">
          {historyWorkOrder.status !== '이관준비' ? (
            <button
              onClick={() => setShowDeleteModal(true)}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
            >
              <Trash2 size={16} />
              발송 실적 삭제
            </button>
          ) : (
            <p className="text-xs text-red-400 text-center">
              {historyWorkOrder.status === '입고확인완료' || historyWorkOrder.status === '마킹중' || historyWorkOrder.status === '마킹완료' || historyWorkOrder.status === '출고완료'
                ? '입고확인 완료 — 삭제 불가'
                : `현재 상태: ${historyWorkOrder.status} — 삭제 불가`}
            </p>
          )}
        </div>
      )}
      <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
        <button onClick={() => { setSelectedDate(today); setHistoryItems([]); setHistoryWorkOrder(null); }} className="text-sm text-blue-600 font-medium hover:underline">
          오늘 작업으로 돌아가기
        </button>
      </div>
    </div>
  );

  // ── 삭제 확인 모달 ──
  const DeleteConfirmModal = () => {
    if (!showDeleteModal) return null;
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
          <div className="px-6 py-5 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-900">발송 실적 삭제</h3>
            <p className="text-sm text-gray-500 mt-1">이 작업은 되돌릴 수 없습니다</p>
          </div>
          <div className="px-6 py-4 space-y-3">
            <div className="bg-red-50 rounded-lg p-3">
              <p className="text-sm text-red-700 font-medium">삭제 시 다음이 함께 처리됩니다:</p>
              <ul className="text-xs text-red-600 mt-2 space-y-1">
                <li>• 발송 수량 초기화 (sent_qty → 0)</li>
                <li>• 작업지시서 상태 복원 (이관준비)</li>
                <li>• 재고 수불부 트랜잭션 삭제 + 재고 복원</li>
              </ul>
            </div>
            <div className="text-sm text-gray-600">
              <p>작업지시서: <span className="font-medium">{historyWorkOrder?.date}</span></p>
              <p>삭제 대상: <span className="font-medium">{historyItems.length}종 / {historyItems.reduce((s, h) => s + h.qty, 0)}개</span></p>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
            <button
              onClick={() => setShowDeleteModal(false)}
              disabled={deleting}
              className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              onClick={handleDeleteShipment}
              disabled={deleting}
              className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {deleting ? '삭제 중...' : '삭제 확인'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── 최근 발송 건 (취소/수정 가능) 패널 ──
  const RecentShippedPanel = () => {
    if (recentShipped.length === 0) return null;
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 bg-orange-50">
          <h3 className="font-medium text-orange-800">최근 발송 건</h3>
          <p className="text-xs text-orange-600 mt-0.5">취소 또는 수정 요청 가능</p>
        </div>
        <div className="divide-y divide-gray-50">
          {recentShipped.map((wo) => {
            const isPending = wo.status === '취소요청' || wo.status === '수정요청';
            return (
              <div key={wo.id} className="px-5 py-3.5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-gray-900">작업지시서: {wo.download_date}</p>
                  {isPending ? (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      wo.status === '취소요청' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {wo.status} (대기 중)
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">이관중</span>
                  )}
                </div>
                {!isPending && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setSelectedRecent(wo);
                        setConfirmedWoId(wo.id);
                        setConfirmedWoDate(wo.download_date);
                        setShowCancelConfirm(true);
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-red-300 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <XCircle size={13} />
                      취소 요청
                    </button>
                    <button
                      onClick={() => {
                        setSelectedRecent(wo);
                        setConfirmedWoId(wo.id);
                        setConfirmedWoDate(wo.download_date);
                        openModifyForm(wo.id);
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-yellow-400 rounded-lg text-yellow-700 hover:bg-yellow-50 transition-colors"
                    >
                      <Edit3 size={13} />
                      수정 요청
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── 이력 전용 화면 (과거 날짜) ──
  if (!isToday) {
    return (
      <div className="space-y-5 max-w-3xl">
        <DateNav />
        <HistoryPanel />
      </div>
    );
  }

  // ── 발송 대기 없음 + 오늘 ──
  if (noWorkToday && isToday) {
    return (
      <div className="space-y-5 max-w-3xl">
        <DateNav />

        {/* 발송 완료 메시지 + 취소/수정 버튼 */}
        <div className="flex items-center justify-center h-32">
          <div className="text-center">
            {confirmed ? (
              <>
                <Truck size={48} className="mx-auto text-blue-500 mb-3" />
                <p className="text-gray-700 font-semibold text-lg">발송 완료 처리되었습니다</p>
                <p className="text-sm text-gray-400 mt-1">플레이위즈에서 입고 확인을 진행해주세요</p>
                {requestSent === null && confirmedWoId && (
                  <div className="flex gap-2 mt-4 justify-center">
                    <button
                      onClick={() => setShowCancelConfirm(true)}
                      className="flex items-center gap-1 px-3 py-2 text-sm border border-red-300 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <XCircle size={15} />
                      발송 취소 요청
                    </button>
                    <button
                      onClick={() => openModifyForm(confirmedWoId)}
                      className="flex items-center gap-1 px-3 py-2 text-sm border border-yellow-400 rounded-lg text-yellow-700 hover:bg-yellow-50 transition-colors"
                    >
                      <Edit3 size={15} />
                      수량 수정 요청
                    </button>
                  </div>
                )}
                {requestSent && (
                  <div className={`mt-4 px-4 py-2 rounded-lg text-sm ${
                    requestSent === 'cancel' ? 'bg-red-50 text-red-700' : 'bg-yellow-50 text-yellow-700'
                  }`}>
                    {requestSent === 'cancel' ? '취소 요청이 관리자에게 전달되었습니다' : '수정 요청이 관리자에게 전달되었습니다'}
                  </div>
                )}
              </>
            ) : (
              <>
                <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
                <p className="text-gray-600 font-medium">발송 대기 중인 물량이 없습니다</p>
                <p className="text-sm text-gray-400 mt-1">관리자가 작업지시서를 등록하면 표시됩니다</p>
              </>
            )}
          </div>
        </div>

        {/* 최근 발송 건 (취소/수정 가능) */}
        <RecentShippedPanel />

        {/* 취소 확인 모달 */}
        {showCancelConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
              <h3 className="text-lg font-bold text-gray-900">발송 취소 요청</h3>
              <p className="text-sm text-gray-600">관리자 승인 후 취소가 처리됩니다.</p>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="취소 사유를 입력하세요"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
                rows={3}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowCancelConfirm(false); setCancelReason(''); }}
                  className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  닫기
                </button>
                <button
                  onClick={handleCancelRequest}
                  disabled={cancelRequesting || !cancelReason.trim()}
                  className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  {cancelRequesting ? '처리 중...' : '취소 요청'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 수정 요청 모달 */}
        {showModifyForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              <h3 className="text-lg font-bold text-gray-900">발송 수량 수정 요청</h3>
              <p className="text-sm text-gray-600">수정할 수량을 입력하세요. 관리자 승인 후 반영됩니다.</p>
              <div className="space-y-2">
                {modifyItems.map((item, idx) => (
                  <div key={item.skuId} className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2">
                    <p className="text-sm font-medium text-gray-800 flex-1">{item.skuName}</p>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-xs text-gray-400">{item.originalQty} →</span>
                      <input
                        type="number"
                        min="0"
                        value={item.newQty}
                        onChange={(e) => {
                          const val = Math.max(0, Number(e.target.value));
                          setModifyItems((prev) => prev.map((m, i) => i === idx ? { ...m, newQty: val } : m));
                        }}
                        className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-yellow-500 ${
                          item.newQty !== item.originalQty ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                        }`}
                      />
                      <span className="text-xs text-gray-400">개</span>
                    </div>
                  </div>
                ))}
              </div>
              <textarea
                value={modifyReason}
                onChange={(e) => setModifyReason(e.target.value)}
                placeholder="수정 사유를 입력하세요"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"
                rows={3}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowModifyForm(false); setModifyReason(''); }}
                  className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  닫기
                </button>
                <button
                  onClick={handleModifyRequest}
                  disabled={modifyRequesting || !modifyReason.trim()}
                  className="flex-1 py-2.5 bg-yellow-500 text-white rounded-xl text-sm font-semibold hover:bg-yellow-600 disabled:opacity-50"
                >
                  {modifyRequesting ? '처리 중...' : '수정 요청'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 발송 작업 모드 ──
  const hasShortage = items.some((item) => item.isShortage);
  const checkedUniformQty = checkedItems.filter((i) => !i.isMarking).reduce((s, i) => s + i.sentQty, 0);
  const checkedMarkingQty = checkedItems.filter((i) => i.isMarking).reduce((s, i) => s + i.sentQty, 0);
  const checkedTotalQty = checkedUniformQty + checkedMarkingQty;

  return (
    <div className="space-y-5 max-w-3xl">
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

      <DateNav />

      {/* 헤더 */}
      <h2 className="text-xl font-bold text-gray-900">발송 확인</h2>

      {/* 전체 발송 대기 요약 */}
      {workOrders.length > 0 && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-200 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Truck size={20} className="text-blue-600" />
              <span className="text-sm font-semibold text-blue-800">전체 발송 대기</span>
            </div>
            <div className="text-right">
              <p className="text-xs text-blue-600">작업지시서 {workOrders.length}건</p>
              <p className="text-lg font-bold text-blue-900">
                잔량 {workOrders.reduce((s, wo) => s + (wo.remainingQty || 0), 0).toLocaleString()}개
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 작업지시서별 아코디언 */}
      {workOrders.map((wo) => {
        const isExpanded = expandedWoIds.has(wo.id);
        const isLoadingThis = woLoadingId === wo.id;
        const cachedItems = woItemsCache[wo.id];
        const isActive = selectedWo?.id === wo.id;

        return (
          <div key={wo.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {/* 아코디언 헤더 */}
            <button
              onClick={() => toggleAccordion(wo)}
              className={`w-full flex items-center justify-between px-5 py-3.5 transition-colors ${
                isExpanded ? 'bg-blue-50 border-b border-blue-100' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                {isExpanded ? <ChevronUp size={18} className="text-blue-600" /> : <ChevronDown size={18} className="text-gray-400" />}
                <div className="text-left">
                  <p className="text-sm font-semibold text-gray-900">
                    {wo.download_date}
                    {wo.status !== '이관준비' && <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">추가 발송</span>}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{wo.lineCount || 0}라인</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-blue-700">잔량 {(wo.remainingQty || 0).toLocaleString()}개</p>
              </div>
            </button>

            {/* 아코디언 본문 */}
            {isExpanded && (
              <div className="px-5 py-4 space-y-4">
                {isLoadingThis ? (
                  <TwoColumnSkeleton />
                ) : cachedItems || isActive ? (
                  <>
                    {/* 엑셀 버튼 */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          if (!isActive) { setSelectedWo(wo); setItems(cachedItems || []); }
                          handleDownloadTemplate();
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        <Download size={15} />
                        양식 다운로드
                      </button>
                      <button
                        onClick={() => {
                          if (!isActive) { setSelectedWo(wo); setItems(cachedItems || []); }
                          fileInputRef.current?.click();
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 text-sm border border-blue-300 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
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
                  </>
                ) : null}
              </div>
            )}
          </div>
        );
      })}

      {/* 선택된 작업지시서의 상세 — 아코디언이 펼쳐진 경우에만 */}
      {selectedWo && expandedWoIds.has(selectedWo.id) && (<>

      {xlsxError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{xlsxError}</p>
        </div>
      )}

      {uploadComparison && (
        <ComparisonPanel
          rows={uploadComparison.rows}
          unmatched={uploadComparison.unmatched}
          onClose={() => setUploadComparison(null)}
        />
      )}

      {/* 추가 발송 안내 */}
      {selectedWo?.status !== '이관준비' && selectedWo && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <span className="text-amber-600 text-lg">🔄</span>
          <div>
            <p className="text-sm font-medium text-amber-800">추가 발송 모드</p>
            <p className="text-xs text-amber-600">이전에 발송하지 못한 잔량만 표시됩니다. 발송 확인 시 기존 수량에 누적 합산됩니다.</p>
          </div>
        </div>
      )}

      {/* 품목 카드 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
          <div>
            <h3 className="font-medium text-gray-900">
              {selectedWo?.status !== '이관준비' ? '추가 발송 물량 (잔량)' : '제작센터(플레이위즈)로 보낼 물량'}
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">{selectedWo?.download_date} 기준</p>
          </div>
          {/* 전체 선택/해제 */}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => toggleAll(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-500">전체</span>
          </label>
        </div>

        {/* 총 수량 합계 (체크된 품목만) */}
        <div className="px-5 py-3 bg-blue-50/60 border-b border-gray-100 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-blue-700">유니폼 소계</span>
            <span className="font-semibold text-blue-800">{checkedUniformQty}개</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-purple-700">마킹 소계</span>
            <span className="font-semibold text-purple-800">{checkedMarkingQty}개</span>
          </div>
          <div className="border-t border-blue-200 pt-1 mt-1 flex items-center justify-between text-sm">
            <span className="font-bold text-gray-800">총 발송 수량 ({checkedItems.length}종)</span>
            <span className="font-bold text-gray-900 text-base">{checkedTotalQty}개</span>
          </div>
        </div>

        {hasShortage && (
          <div className="mx-4 mt-4 flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <AlertTriangle size={16} className="text-yellow-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-800">
              일부 품목 재고가 부족합니다. 실제 발송 수량을 직접 입력해주세요.
            </p>
          </div>
        )}

        {/* 2컬럼 헤더 */}
        <div className="grid grid-cols-2 border-b border-gray-100">
          <div className="px-4 py-2.5 border-r border-gray-100 bg-blue-50">
            <p className="text-xs font-semibold text-blue-700">
              유니폼 단품 <span className="font-normal text-blue-500">({items.filter((i) => !i.isMarking).length}종)</span>
            </p>
          </div>
          <div className="px-4 py-2.5 bg-purple-50">
            <p className="text-xs font-semibold text-purple-700">
              마킹 단품 <span className="font-normal text-purple-500">({items.filter((i) => i.isMarking).length}종)</span>
            </p>
          </div>
        </div>

        {/* 2컬럼 아이템 (체크박스 포함) */}
        <div className="grid grid-cols-2">
          {/* 왼쪽: 유니폼 */}
          <div className="border-r border-gray-100 divide-y divide-gray-50">
            {items.filter((item) => !item.isMarking).map((item) => (
              <div key={item.skuId} className={`px-3 py-3 ${item.isShortage ? 'bg-red-50' : ''} ${!item.checked ? 'opacity-40' : ''}`}>
                <div className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() => toggleCheck(item.skuId)}
                    className="w-3.5 h-3.5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 leading-snug">{item.skuName}</p>
                    <p className="text-[11px] text-gray-400 font-mono mt-0.5">{item.skuId}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1.5 gap-1 ml-5">
                  <div>
                    <p className="text-[10px] text-gray-400">주문 {item.orderedQty}</p>
                    {item.isShortage ? (
                      <p className="text-[10px] text-red-500">재고 {item.inventoryQty}</p>
                    ) : (
                      <p className="text-[10px] text-gray-400">재고 {item.inventoryQty}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <input
                      type="number"
                      min="0"
                      value={item.sentQty}
                      onChange={(e) => handleSentChange(item.skuId, Number(e.target.value))}
                      disabled={!item.checked}
                      className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 ${
                        item.sentQty > item.inventoryQty ? 'border-orange-300 bg-orange-50' : 'border-gray-300'
                      }`}
                    />
                    <span className="text-[10px] text-gray-400">개</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 오른쪽: 마킹 */}
          <div className="divide-y divide-gray-50">
            {items.filter((item) => item.isMarking).map((item) => (
              <div key={item.skuId} className={`px-3 py-3 ${item.isShortage ? 'bg-red-50' : ''} ${!item.checked ? 'opacity-40' : ''}`}>
                <div className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() => toggleCheck(item.skuId)}
                    className="w-3.5 h-3.5 mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 leading-snug">{item.skuName}</p>
                    <p className="text-[11px] text-gray-400 font-mono mt-0.5">{item.skuId}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1.5 gap-1 ml-5">
                  <div>
                    <p className="text-[10px] text-gray-400">주문 {item.orderedQty}</p>
                    {item.isShortage ? (
                      <p className="text-[10px] text-red-500">재고 {item.inventoryQty}</p>
                    ) : (
                      <p className="text-[10px] text-gray-400">재고 {item.inventoryQty}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <input
                      type="number"
                      min="0"
                      value={item.sentQty}
                      onChange={(e) => handleSentChange(item.skuId, Number(e.target.value))}
                      disabled={!item.checked}
                      className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:bg-gray-100 ${
                        item.sentQty > item.inventoryQty ? 'border-orange-300 bg-orange-50' : 'border-gray-300'
                      }`}
                    />
                    <span className="text-[10px] text-gray-400">개</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 진행 표시 */}
      {confirming && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-blue-700 font-medium text-center">
            {confirmProgress?.step ?? '처리 중...'}
          </p>
          {confirmProgress && (
            <>
              <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((confirmProgress.current / confirmProgress.total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-blue-500 text-center">
                {confirmProgress.current} / {confirmProgress.total}
                ({Math.round((confirmProgress.current / confirmProgress.total) * 100)}%)
              </p>
            </>
          )}
        </div>
      )}

      <button
        onClick={handleConfirmClick}
        disabled={confirming || checkedItems.length === 0}
        className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base"
      >
        <Truck size={20} />
        {confirming ? '처리 중...' : `발송 완료 확인 (${checkedItems.length}종)`}
      </button>
      <p className="text-xs text-center text-gray-400">
        버튼 클릭 시 발송 내역을 최종 확인하는 팝업이 표시됩니다
      </p>

      {/* ── 확인 모달 ── */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">발송 확인</h3>
            <div className="bg-blue-50 rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">발송 품목</span>
                <span className="font-semibold text-gray-900">{checkedItems.length}종</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">유니폼</span>
                <span className="font-semibold text-blue-700">{checkedUniformQty}개</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">마킹</span>
                <span className="font-semibold text-purple-700">{checkedMarkingQty}개</span>
              </div>
              <div className="border-t border-blue-200 pt-2 flex justify-between text-sm">
                <span className="font-bold text-gray-800">총 발송 수량</span>
                <span className="font-bold text-gray-900">{checkedTotalQty}개</span>
              </div>
            </div>
            {items.some((i) => !i.checked) && (
              <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <AlertTriangle size={14} className="text-yellow-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-800">
                  미선택 품목 {items.filter((i) => !i.checked).length}종은 발송 수량 0으로 처리됩니다
                </p>
              </div>
            )}
            <p className="text-sm text-gray-500 text-center">발송 후에도 취소/수정 요청이 가능합니다</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={handleConfirm}
                className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700"
              >
                발송 확인
              </button>
            </div>
          </div>
        </div>
      )}

      </>)}

      {/* ── 취소 확인 모달 ── */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">발송 취소 요청</h3>
            <p className="text-sm text-gray-600">관리자 승인 후 취소가 처리됩니다.</p>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="취소 사유를 입력하세요"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
              rows={3}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowCancelConfirm(false); setCancelReason(''); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                닫기
              </button>
              <button
                onClick={handleCancelRequest}
                disabled={cancelRequesting || !cancelReason.trim()}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {cancelRequesting ? '처리 중...' : '취소 요청'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 수정 요청 모달 ── */}
      {showModifyForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-900">발송 수량 수정 요청</h3>
            <p className="text-sm text-gray-600">수정할 수량을 입력하세요. 관리자 승인 후 반영됩니다.</p>
            <div className="space-y-2">
              {modifyItems.map((item, idx) => (
                <div key={item.skuId} className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-sm font-medium text-gray-800 flex-1">{item.skuName}</p>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-xs text-gray-400">{item.originalQty} →</span>
                    <input
                      type="number"
                      min="0"
                      value={item.newQty}
                      onChange={(e) => {
                        const val = Math.max(0, Number(e.target.value));
                        setModifyItems((prev) => prev.map((m, i) => i === idx ? { ...m, newQty: val } : m));
                      }}
                      className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-yellow-500 ${
                        item.newQty !== item.originalQty ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                      }`}
                    />
                    <span className="text-xs text-gray-400">개</span>
                  </div>
                </div>
              ))}
            </div>
            <textarea
              value={modifyReason}
              onChange={(e) => setModifyReason(e.target.value)}
              placeholder="수정 사유를 입력하세요"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"
              rows={3}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowModifyForm(false); setModifyReason(''); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                닫기
              </button>
              <button
                onClick={handleModifyRequest}
                disabled={modifyRequesting || !modifyReason.trim()}
                className="flex-1 py-2.5 bg-yellow-500 text-white rounded-xl text-sm font-semibold hover:bg-yellow-600 disabled:opacity-50"
              >
                {modifyRequesting ? '처리 중...' : '수정 요청'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 삭제 확인 모달 ── */}
      <DeleteConfirmModal />
    </div>
  );
}
