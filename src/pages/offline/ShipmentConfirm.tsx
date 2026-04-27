import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouseId } from '../../lib/warehouseStore';
import { recordTransaction, deleteSystemTransactions } from '../../lib/inventoryTransaction';
import { getLedgerInventory } from '../../lib/ledgerInventory';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Edit3, FileUp, Trash2, Truck, XCircle } from 'lucide-react';
import { generateTemplate, parseQtyExcel, buildMatchKey } from '../../lib/excelUtils';
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
  needsMarking: boolean; // true=마킹 작업 예정 (BOM 전개), false=단순 출고
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

interface ShipmentSource {
  woId: string;
  woDate: string;
  woStatus: string;
  availableQty: number;
}

interface MergedShipmentItem {
  mergeKey: string;           // 내부 식별자: `${skuId}::m` 또는 `${skuId}::d`
  skuId: string;
  skuName: string;
  barcode: string | null;
  orderedQty: number;
  sentQty: number;
  inventoryQty: number;
  isShortage: boolean;
  isMarking: boolean;
  needsMarking: boolean;
  checked: boolean;
  sources: ShipmentSource[];
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
  useLoadingTimeout(loading, setLoading, setError);
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

  // 전체 발송대기 통합 뷰
  const [mergedExpanded, setMergedExpanded] = useState(false);
  const [mergedItems, setMergedItems] = useState<MergedShipmentItem[]>([]);
  const [mergedLoading, setMergedLoading] = useState(false);
  const [mergedConfirming, setMergedConfirming] = useState(false);
  const [mergedConfirmProgress, setMergedConfirmProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [mergedUploadComparison, setMergedUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [showMergedConfirmModal, setShowMergedConfirmModal] = useState(false);
  const mergedFileInputRef = useRef<HTMLInputElement>(null);

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

      // 오프라인 재고 조회 (수불부 누적 기반 — inventory 테이블 drift 회피)
      const offWhId = await getWarehouseId('오프라인샵');
      const offlineInvMap: Record<string, number> = offWhId
        ? await getLedgerInventory(offWhId, undefined, false)
        : {};

      // BOM 상세 (구성품 SKU 매핑)
      const bomDetailMap: Record<string, { compSkuId: string; qty: number }[]> = {};
      if (markingSkuArr.length > 0) {
        const { data: bomDetailData } = await supabase.from('bom')
          .select('finished_sku_id, component_sku_id, quantity')
          .in('finished_sku_id', markingSkuArr);
        for (const b of (bomDetailData || []) as any[]) {
          if (!bomDetailMap[b.finished_sku_id]) bomDetailMap[b.finished_sku_id] = [];
          bomDetailMap[b.finished_sku_id].push({ compSkuId: b.component_sku_id, qty: b.quantity || 1 });
        }
      }

      // 유니폼 관련 SKU 판별 (오프라인 매장에서 발송 대상)
      const isUniformRelated = (skuId: string) =>
        skuId?.startsWith('26UN-') || skuId?.startsWith('26MK-');

      // BOM 전개 후 잔량 계산 헬퍼 (유니폼만 + 재고 있는 것만 카운트)
      const enrichWo = (wo: any): ActiveWorkOrder => {
        const lines = wo.work_order_line || [];
        const lineCount = lines.length;
        const detail: Record<string, number> = wo.sent_detail || {};

        // 구성품 레벨로 전개 후, 재고 있는 것만 잔량 계산
        // sent_detail 이중 차감 방지: 마킹 BOM에서 소비한 sent 수량 추적
        const sentConsumed: Record<string, number> = {};
        let totalShippable = 0;

        // 1패스: 마킹 라인 (BOM 전개) — sent_detail 먼저 소비
        for (const l of lines) {
          if (!l.needs_marking || !bomDetailMap[l.finished_sku_id]) continue;
          const ordQty = l.ordered_qty || 0;
          for (const comp of bomDetailMap[l.finished_sku_id]) {
            const totalSent = detail[comp.compSkuId] || 0;
            const alreadyConsumed = sentConsumed[comp.compSkuId] || 0;
            const availableSent = Math.max(0, totalSent - alreadyConsumed);
            const subtracted = Math.min(comp.qty * ordQty, availableSent);
            sentConsumed[comp.compSkuId] = alreadyConsumed + subtracted;
            const needed = comp.qty * ordQty - subtracted;
            const available = offlineInvMap[comp.compSkuId] || 0;
            totalShippable += Math.max(0, Math.min(needed, available));
          }
        }

        // 2패스: 단순출고 라인 — 남은 sent_detail만 차감
        for (const l of lines) {
          if (l.needs_marking) continue;
          if (!isUniformRelated(l.finished_sku_id)) continue;
          const ordQty = l.ordered_qty || 0;
          const totalSent = detail[l.finished_sku_id] || 0;
          const alreadyConsumed = sentConsumed[l.finished_sku_id] || 0;
          const subtracted = Math.min(ordQty, Math.max(0, totalSent - alreadyConsumed));
          const needed = ordQty - subtracted;
          const available = offlineInvMap[l.finished_sku_id] || 0;
          totalShippable += Math.max(0, Math.min(needed, available));
        }
        // 비유니폼 단품 (26AC, 26AP 등)은 오프라인 발송 대상 아님 → skip

        return { id: wo.id, download_date: wo.download_date, status: wo.status, lineCount, remainingQty: totalShippable };
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
        getWarehouseId('오프라인샵'),
      ]);
      if (linesResult.error) throw linesResult.error;
      if (isStale()) return;

      const lines = linesResult.data;
      const offlineWarehouseId = warehouseResult;

      // 2단계: BOM + inventory 병렬 조회 (각각 lines, warehouse 결과 필요)
      const markingSkuIds = ((lines || []) as any[])
        .filter((l: any) => l.needs_marking)
        .map((l: any) => l.finished_sku_id as string);

      const [bomResult, ledgerInv] = await Promise.all([
        supabase.from('bom')
          .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name, barcode)')
          .in('finished_sku_id', markingSkuIds.length > 0 ? markingSkuIds : ['__none__']),
        // 수불부 누적 기반 (inventory 테이블 drift 회피)
        offlineWarehouseId
          ? getLedgerInventory(offlineWarehouseId, undefined, false)
          : Promise.resolve({} as Record<string, number>),
      ]);
      if (bomResult.error) throw bomResult.error;
      if (isStale()) return;

      const bomData = bomResult.data;
      const inventoryMap: Record<string, number> = ledgerInv;

      const componentMap: Record<
        string,
        { lineId: string; skuId: string; skuName: string; barcode: string | null; needed: number; isMarking: boolean; needsMarking: boolean }
      > = {};

      const isAdditionalShipment = wo.status !== '이관준비';

      // sent_detail 조회 (구성품 레벨 발송 이력)
      const { data: woSentData } = await supabase
        .from('work_order').select('sent_detail').eq('id', wo.id).single();
      const sentDetail: Record<string, number> = (woSentData as any)?.sent_detail || {};

      // 1차: 전체 주문 수량으로 componentMap 빌드
      // 마킹용과 단순출고용을 분리 키(::m / ::d)로 구분하여 동일 SKU가 양쪽에 존재해도 각각 표시
      for (const line of (lines || []) as any[]) {
        if (line.needs_marking) {
          const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          for (const bom of boms as any[]) {
            const key = `${bom.component_sku_id}::m`;
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
                needsMarking: true,
              };
            }
            componentMap[key].needed += bom.quantity * (line.ordered_qty || 0);
          }
        } else {
          // 비유니폼 단품 (악세서리 등)은 오프라인 발송 대상 아님 → skip
          const skuId = line.finished_sku_id as string;
          if (!skuId?.startsWith('26UN-') && !skuId?.startsWith('26MK-')) continue;

          const key = `${line.finished_sku_id}::d`;
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
              needsMarking: false,
            };
          }
          componentMap[key].needed += (line.ordered_qty || 0);
        }
      }

      // 2차: sent_detail에서 이미 발송된 수량 차감 (추가 발송 시)
      // sent_detail은 물리적 SKU 기준이므로 마킹용(::m) 먼저 차감 후 단순출고(::d) 차감
      if (isAdditionalShipment) {
        const skuGroups: Record<string, string[]> = {};
        for (const key of Object.keys(componentMap)) {
          const skuId = componentMap[key].skuId;
          if (!skuGroups[skuId]) skuGroups[skuId] = [];
          skuGroups[skuId].push(key);
        }
        for (const [skuId, keys] of Object.entries(skuGroups)) {
          let remaining = sentDetail[skuId] || 0;
          if (remaining <= 0) continue;
          // 마킹용(::m) 먼저 차감
          const sorted = keys.sort((a, _b) => (a.endsWith('::m') ? -1 : 1));
          for (const key of sorted) {
            const subtract = Math.min(remaining, componentMap[key].needed);
            componentMap[key].needed -= subtract;
            remaining -= subtract;
          }
        }
        // 잔량 0인 구성품 제거
        for (const key of Object.keys(componentMap)) {
          if (componentMap[key].needed <= 0) delete componentMap[key];
        }
      }

      const shipmentItems: ShipmentItem[] = Object.values(componentMap)
        .filter((c) => (inventoryMap[c.skuId] || 0) > 0) // 재고 0이면 목록에서 제외
        .map((c) => {
          const inv = inventoryMap[c.skuId] || 0;
          const qty = Math.min(c.needed, inv); // 재고만큼만 발송 가능
          return {
            lineId: c.lineId,
            skuId: c.skuId,
            skuName: c.skuName,
            barcode: c.barcode,
            orderedQty: c.needed,
            sentQty: qty,
            inventoryQty: inv,
            isShortage: inv < c.needed,
            isMarking: c.isMarking,
            needsMarking: c.needsMarking,
            checked: true,
          };
        });

      setItems(shipmentItems);
      // 아코디언 캐시에 저장
      setWoItemsCache((prev) => ({ ...prev, [wo.id]: shipmentItems }));
      // 헤더 잔량을 실제 발송 가능 수량으로 갱신 (enrichWo 근사치 → 정확한 값)
      const actualShippable = shipmentItems.reduce((s, i) => s + i.sentQty, 0);
      setWorkOrders((prev) => prev.map((w) => w.id === wo.id ? { ...w, remainingQty: actualShippable } : w));
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

  // ── 아이템 카드 렌더 헬퍼 ──
  const colorMap: Record<string, { checkbox: string; ring: string; border: string }> = {
    blue:   { checkbox: 'text-blue-600 focus:ring-blue-500', ring: 'focus:ring-blue-500', border: 'border-gray-300' },
    purple: { checkbox: 'text-purple-600 focus:ring-purple-500', ring: 'focus:ring-purple-500', border: 'border-gray-300' },
    teal:   { checkbox: 'text-teal-600 focus:ring-teal-500', ring: 'focus:ring-teal-500', border: 'border-gray-300' },
    orange: { checkbox: 'text-orange-600 focus:ring-orange-500', ring: 'focus:ring-orange-500', border: 'border-gray-300' },
  };

  const renderItemCard = (item: ShipmentItem, color: string) => {
    const c = colorMap[color] || colorMap.blue;
    return (
      <div key={item.skuId} className={`px-3 py-3 ${item.isShortage ? 'bg-red-50' : ''} ${!item.checked ? 'opacity-40' : ''}`}>
        <div className="flex items-start gap-1.5">
          <input
            type="checkbox"
            checked={item.checked}
            onChange={() => toggleCheck(item.skuId)}
            className={`w-3.5 h-3.5 mt-0.5 rounded border-gray-300 ${c.checkbox} flex-shrink-0`}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-800 leading-snug">{item.skuName}</p>
            <p className="text-[11px] text-gray-400 font-mono mt-0.5">{item.skuId}</p>
          </div>
        </div>
        <div className="flex items-center justify-between mt-1.5 gap-1 ml-5">
          <div>
            <p className="text-[10px] text-gray-400">주문 {item.orderedQty}</p>
            <p className={`text-[10px] ${item.isShortage ? 'text-red-500' : 'text-gray-400'}`}>재고 {item.inventoryQty}</p>
          </div>
          <div className="flex items-center gap-0.5">
            <input
              type="number"
              min="0"
              value={item.sentQty}
              onChange={(e) => handleSentChange(item.skuId, Number(e.target.value))}
              disabled={!item.checked}
              className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 ${c.ring} disabled:bg-gray-100 ${
                item.sentQty > item.inventoryQty ? 'border-orange-300 bg-orange-50' : c.border
              }`}
            />
            <span className="text-[10px] text-gray-400">개</span>
          </div>
        </div>
      </div>
    );
  };

  // ── 통합 뷰 아이템 카드 렌더 헬퍼 ──
  const renderMergedItemCard = (item: MergedShipmentItem, color: string) => {
    const ringColor = color === 'blue' ? 'blue' : color === 'purple' ? 'purple' : color === 'teal' ? 'teal' : 'orange';
    return (
      <div key={item.mergeKey} className={`px-3 py-2.5 ${item.isShortage ? 'bg-red-50' : ''}`}>
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={item.checked}
            onChange={() => toggleMergedCheck(item.mergeKey)}
            className={`mt-1 w-4 h-4 rounded border-gray-300 text-${ringColor}-600`}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">{item.skuName}</p>
            <p className="text-xs text-gray-400 truncate">{item.skuId}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500">주문 {item.orderedQty}</span>
              <span className="text-xs text-gray-400">|</span>
              <span className={`text-xs ${item.isShortage ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                재고 {item.inventoryQty}
              </span>
            </div>
            {item.sources.length > 1 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {item.sources.map((src) => (
                  <span key={src.woId} className="text-[10px] bg-gray-100 text-gray-500 px-1 rounded">
                    {src.woDate.slice(5)} ({src.availableQty})
                  </span>
                ))}
              </div>
            )}
            <div className="mt-1.5">
              <input
                type="number"
                min={0}
                value={item.sentQty}
                onChange={(e) => handleMergedSentChange(item.mergeKey, parseInt(e.target.value) || 0)}
                className={`w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-${ringColor}-400 focus:border-${ringColor}-400`}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

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
      // 1) 삭제 대상 차수의 발송 수량 조회 (activity_log에서)
      const { data: targetLog } = await supabase
        .from('activity_log')
        .select('summary')
        .eq('work_order_id', historyWorkOrder.id)
        .eq('action_type', 'shipment_confirm')
        .eq('action_date', selectedDate)
        .limit(1)
        .maybeSingle();
      const deletedItems: { skuId: string; sentQty: number }[] =
        (targetLog as any)?.summary?.items || [];

      // 다른 차수의 발송이 남아있는지 확인
      const { data: otherWaves } = await supabase
        .from('activity_log')
        .select('id')
        .eq('work_order_id', historyWorkOrder.id)
        .eq('action_type', 'shipment_confirm')
        .neq('action_date', selectedDate);
      const hasOtherWaves = (otherWaves || []).length > 0;

      // 1-1) work_order_line.sent_qty 차감 (삭제 차수 수량만)
      const { data: lines } = await supabase
        .from('work_order_line')
        .select('id, sent_qty')
        .eq('work_order_id', historyWorkOrder.id);
      if (hasOtherWaves && deletedItems.length > 0) {
        // 다른 차수 존재 → sent_detail에서 삭제분만 차감
        const { data: woData } = await supabase
          .from('work_order').select('sent_detail').eq('id', historyWorkOrder.id).single();
        const detail: Record<string, number> = (woData as any)?.sent_detail || {};
        for (const item of deletedItems) {
          detail[item.skuId] = Math.max(0, (detail[item.skuId] || 0) - item.sentQty);
        }
        await supabase.from('work_order').update({ sent_detail: detail }).eq('id', historyWorkOrder.id);
      } else {
        // 유일한 차수 → sent_qty 0 초기화, sent_detail 초기화
        for (const line of (lines || []) as any[]) {
          await supabase.from('work_order_line').update({ sent_qty: 0 }).eq('id', line.id);
        }
        await supabase.from('work_order').update({ sent_detail: {} }).eq('id', historyWorkOrder.id);
      }

      // 2) work_order.status 복원 (다른 차수 없으면 이관준비, 있으면 유지)
      if (!hasOtherWaves) {
        await supabase
          .from('work_order')
          .update({ status: '이관준비' })
          .eq('id', historyWorkOrder.id);
      }

      // 3) inventory_transaction 삭제 + inventory 역반영
      const offWhId2 = await getWarehouseId('오프라인샵');
      if (offWhId2) {
        await deleteSystemTransactions({
          warehouseId: offWhId2,
          memo: `발송확인 (작업지시서 ${historyWorkOrder.date})`,
        });
      }

      // 4) activity_log: 원본 shipment_confirm 로그 삭제 + 삭제 이력 기록
      await supabase.from('activity_log').delete()
        .eq('work_order_id', historyWorkOrder.id)
        .eq('action_type', 'shipment_confirm')
        .eq('action_date', selectedDate);
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
        needsMarking: item.needsMarking,
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
        items.map((item) => ({ skuId: item.skuId, skuName: item.skuName, barcode: item.barcode, needsMarking: item.needsMarking }))
      );
      // matchKey로 매칭 (구분 컬럼이 있으면 마킹/단순 분리, 없으면 SKU 기준 폴백)
      const matchMap = new Map(result.matched.map((m) => [m.matchKey, m.uploadedQty]));
      setItems((prev) =>
        prev.map((item) => {
          const key = buildMatchKey(item.skuId, item.needsMarking);
          return matchMap.has(key) ? { ...item, sentQty: matchMap.get(key)!, checked: matchMap.get(key)! > 0 }
            : matchMap.has(item.skuId) ? { ...item, sentQty: matchMap.get(item.skuId)!, checked: matchMap.get(item.skuId)! > 0 }
            : item;
        })
      );
      const rows: ComparisonRow[] = result.matched.map((m) => {
        const item = items.find((i) => {
          const key = buildMatchKey(i.skuId, i.needsMarking);
          return m.matchKey === key || m.matchKey === i.skuId;
        });
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

  // ── 전체 발송대기 통합 뷰 ──
  const buildMergedItems = async () => {
    setMergedLoading(true);
    setError(null);
    try {
      // 날짜순 정렬 (오름차순)
      const sorted = [...workOrders].sort((a, b) => a.download_date.localeCompare(b.download_date));

      // 캐시에 없는 WO를 병렬 선조회
      const uncached = sorted.filter((wo) => !woItemsCache[wo.id]);
      if (uncached.length > 0) {
        await Promise.all(uncached.map((wo) => selectOrder(wo)));
      }

      // 최신 캐시 읽기 (selectOrder가 setState를 사용하므로 직접 참조)
      // setState는 비동기이므로 woItemsCache를 직접 읽을 수 없음 → 콜백에서 처리
      setWoItemsCache((currentCache) => {
        const mergedMap: Record<string, MergedShipmentItem> = {};

        for (const wo of sorted) {
          const woItems = currentCache[wo.id];
          if (!woItems) continue;
          for (const item of woItems) {
            // 마킹/단순출고 분리 키: 동일 SKU도 needsMarking이 다르면 별도 항목
            const mergeKey = `${item.skuId}::${item.needsMarking ? 'm' : 'd'}`;
            if (!mergedMap[mergeKey]) {
              mergedMap[mergeKey] = {
                mergeKey,
                skuId: item.skuId,
                skuName: item.skuName,
                barcode: item.barcode,
                orderedQty: 0,
                sentQty: 0,
                inventoryQty: item.inventoryQty,
                isShortage: false,
                isMarking: item.isMarking,
                needsMarking: item.needsMarking,
                checked: true,
                sources: [],
              };
            }
            mergedMap[mergeKey].orderedQty += item.orderedQty;
            mergedMap[mergeKey].sources.push({
              woId: wo.id,
              woDate: wo.download_date,
              woStatus: wo.status || '이관준비',
              availableQty: item.orderedQty,
            });
          }
        }

        // sentQty = min(orderedQty, inventoryQty), 재고 0이면 제외
        const merged = Object.values(mergedMap)
          .filter((m) => m.inventoryQty > 0)
          .map((m) => ({
            ...m,
            sentQty: Math.min(m.orderedQty, m.inventoryQty),
            isShortage: m.inventoryQty < m.orderedQty,
          }));

        setMergedItems(merged);
        return currentCache; // 캐시는 변경 없이 반환
      });
    } catch (e: any) {
      setError(`통합 뷰 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setMergedLoading(false);
    }
  };

  const toggleMergedAccordion = async () => {
    if (mergedExpanded) {
      setMergedExpanded(false);
      return;
    }
    setMergedExpanded(true);
    // 개별 WO 아코디언 접기
    setExpandedWoIds(new Set());
    setSelectedWo(null);
    await buildMergedItems();
  };

  // 통합 뷰 체크박스 (mergeKey 기준으로 개별 항목 식별)
  const toggleMergedCheck = (key: string) => {
    setMergedItems((prev) =>
      prev.map((item) =>
        item.mergeKey === key ? { ...item, checked: !item.checked } : item
      )
    );
  };
  const toggleMergedAll = (checked: boolean) => {
    setMergedItems((prev) => prev.map((item) => ({ ...item, checked })));
  };
  const mergedCheckedItems = mergedItems.filter((i) => i.checked);
  const mergedAllChecked = mergedItems.length > 0 && mergedItems.every((i) => i.checked);
  const mergedCheckedUniformQty = mergedCheckedItems.filter((i) => !i.isMarking).reduce((s, i) => s + i.sentQty, 0);
  const mergedCheckedMarkingQty = mergedCheckedItems.filter((i) => i.isMarking).reduce((s, i) => s + i.sentQty, 0);
  const mergedCheckedTotalQty = mergedCheckedUniformQty + mergedCheckedMarkingQty;
  const mergedHasShortage = mergedItems.some((i) => i.isShortage);

  // 통합 뷰 수량 변경 (mergeKey 기준)
  const handleMergedSentChange = (key: string, value: number) => {
    setMergedItems((prev) =>
      prev.map((item) =>
        item.mergeKey === key ? { ...item, sentQty: Math.max(0, value) } : item
      )
    );
  };

  // 통합 뷰 엑셀 다운로드
  const handleMergedDownloadTemplate = () => {
    generateTemplate(
      mergedItems.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.sentQty,
        needsMarking: item.needsMarking,
      })),
      `전체발송수량_${today}.xlsx`
    );
  };

  // 통합 뷰 엑셀 업로드
  const handleMergedExcelUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMergedUploadComparison(null);
    try {
      const result = await parseQtyExcel(
        file,
        mergedItems.map((item) => ({ skuId: item.skuId, skuName: item.skuName, barcode: item.barcode, needsMarking: item.needsMarking }))
      );
      const matchMap = new Map(result.matched.map((m) => [m.matchKey, m.uploadedQty]));
      setMergedItems((prev) =>
        prev.map((item) => {
          const key = buildMatchKey(item.skuId, item.needsMarking);
          return matchMap.has(key) ? { ...item, sentQty: matchMap.get(key)!, checked: matchMap.get(key)! > 0 }
            : matchMap.has(item.skuId) ? { ...item, sentQty: matchMap.get(item.skuId)!, checked: matchMap.get(item.skuId)! > 0 }
            : item;
        })
      );
      const rows: ComparisonRow[] = result.matched.map((m) => {
        const item = mergedItems.find((i) => {
          const key = buildMatchKey(i.skuId, i.needsMarking);
          return m.matchKey === key || m.matchKey === i.skuId;
        });
        return {
          skuId: m.skuId,
          skuName: item?.skuName || m.skuId,
          expected: item?.orderedQty ?? 0,
          uploaded: m.uploadedQty,
          diff: m.uploadedQty - (item?.orderedQty ?? 0),
        };
      });
      setMergedUploadComparison({ rows, unmatched: result.unmatched });
    } catch (err: any) {
      setError(err.message || '파일 처리 실패');
    }
    if (mergedFileInputRef.current) mergedFileInputRef.current.value = '';
  };

  // 통합 뷰 발송 확인 클릭
  const handleMergedConfirmClick = () => {
    const checked = mergedItems.filter((i) => i.checked && i.sentQty > 0);
    if (checked.length === 0) {
      setError('발송할 품목을 선택해주세요.');
      return;
    }
    setShowMergedConfirmModal(true);
  };

  // 통합 뷰 발송 확인 실행 — 날짜순 차감 핵심 로직
  const handleMergedConfirm = async () => {
    setShowMergedConfirmModal(false);
    setMergedConfirming(true);
    setMergedConfirmProgress(null);
    setError(null);

    try {
      const finalItems = mergedItems.map((item) => ({
        ...item,
        sentQty: item.checked ? item.sentQty : 0,
      }));

      // Step A: sentQty를 WO별로 분배 (날짜순 — sources는 이미 오름차순)
      const woAllocation: Record<string, Record<string, number>> = {};
      for (const item of finalItems) {
        if (item.sentQty <= 0) continue;
        let remaining = item.sentQty;
        for (const src of item.sources) {
          if (remaining <= 0) break;
          const alloc = Math.min(src.availableQty, remaining);
          if (alloc > 0) {
            if (!woAllocation[src.woId]) woAllocation[src.woId] = {};
            woAllocation[src.woId][item.skuId] = (woAllocation[src.woId][item.skuId] || 0) + alloc;
            remaining -= alloc;
          }
        }
      }

      const affectedWoIds = Object.keys(woAllocation);
      const totalSteps = affectedWoIds.length * 3 + 2; // sent_detail + lines + inventory + activity
      let stepNum = 1;

      // Step B: WO별 sent_detail 업데이트 + status 전이
      for (const woId of affectedWoIds) {
        setMergedConfirmProgress({ current: stepNum, total: totalSteps, step: `WO 상태 업데이트 중...` });
        const skuAlloc = woAllocation[woId];

        // sent_detail fresh 조회
        const { data: woData } = await supabase
          .from('work_order').select('sent_detail, status').eq('id', woId).single();
        const prevDetail: Record<string, number> = (woData as any)?.sent_detail || {};
        const woStatus: string = (woData as any)?.status || '이관준비';
        const newDetail: Record<string, number> = { ...prevDetail };
        for (const [skuId, qty] of Object.entries(skuAlloc)) {
          newDetail[skuId] = (newDetail[skuId] || 0) + qty;
        }

        if (woStatus === '이관준비') {
          await supabase.from('work_order')
            .update({ status: '이관중', sent_detail: newDetail })
            .eq('id', woId);
          // 연결된 온라인 주문도 이관중으로 변경
          await supabase.from('online_order')
            .update({ status: '이관중' })
            .eq('work_order_id', woId)
            .eq('status', '발송대기');
        } else {
          await supabase.from('work_order')
            .update({ sent_detail: newDetail })
            .eq('id', woId);
        }
        stepNum++;
      }

      // Step C: WO별 라인 sent_qty 비례배분
      for (const woId of affectedWoIds) {
        setMergedConfirmProgress({ current: stepNum, total: totalSteps, step: `라인 처리 중...` });
        const skuAlloc = woAllocation[woId];

        // 핵심: sent_qty 누적 여부. 이 WO에 대한 이전 발송이 있었는지 확인
        const woObj = workOrders.find((w) => w.id === woId);
        const hadPriorShipment = woObj?.status !== '이관준비';

        const { data: lines } = await supabase
          .from('work_order_line')
          .select('id, finished_sku_id, ordered_qty, sent_qty, needs_marking')
          .eq('work_order_id', woId);
        const lineList = (lines || []) as any[];

        const confirmMarkingSkuIds = lineList
          .filter((l) => l.needs_marking)
          .map((l) => l.finished_sku_id as string);
        const { data: confirmBomData } = await supabase
          .from('bom')
          .select('finished_sku_id, component_sku_id, quantity')
          .in('finished_sku_id', confirmMarkingSkuIds.length > 0 ? confirmMarkingSkuIds : ['__none__']);

        const lineSentQtyMap: Record<string, number> = {};
        const consumedFromSentMap: Record<string, number> = {};

        for (const line of lineList) {
          if (!line.needs_marking) {
            const maxQty = hadPriorShipment
              ? Math.max(0, (line.ordered_qty || 0) - (line.sent_qty || 0))
              : line.ordered_qty || 0;
            const qty = Math.min(skuAlloc[line.finished_sku_id] || 0, maxQty);
            lineSentQtyMap[line.id] = qty;
            consumedFromSentMap[line.finished_sku_id] = (consumedFromSentMap[line.finished_sku_id] || 0) + qty;
          }
        }

        const markingLines = lineList.filter((l: any) => l.needs_marking);
        const compToLines: Record<string, { lineId: string; effectiveQty: number }[]> = {};
        for (const line of markingLines) {
          const boms = (confirmBomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          const uniformComp = boms.find((b: any) => !b.component_sku_id?.includes('MK'));
          const compId = uniformComp?.component_sku_id || boms[0]?.component_sku_id;
          if (!compId) { lineSentQtyMap[line.id] = 0; continue; }
          if (!compToLines[compId]) compToLines[compId] = [];
          const effectiveQty = hadPriorShipment
            ? Math.max(0, (line.ordered_qty || 0) - (line.sent_qty || 0))
            : line.ordered_qty;
          compToLines[compId].push({ lineId: line.id, effectiveQty });
        }

        for (const [compId, entries] of Object.entries(compToLines)) {
          const rawCompSent = skuAlloc[compId] || 0;
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
              lineSentQtyMap[entries[i].lineId] = totalCompSent - distributed;
            } else {
              const share = Math.round(totalCompSent * entries[i].effectiveQty / totalEffective);
              lineSentQtyMap[entries[i].lineId] = share;
              distributed += share;
            }
          }
        }

        // 라인 sent_qty 업데이트
        const BATCH = 10;
        for (let i = 0; i < lineList.length; i += BATCH) {
          const batch = lineList.slice(i, i + BATCH);
          await Promise.all(batch.map((line: any) => {
            const thisTimeSent = lineSentQtyMap[line.id] ?? 0;
            const rawSentQty = hadPriorShipment
              ? (line.sent_qty || 0) + thisTimeSent
              : thisTimeSent;
            const newSentQty = Math.min(rawSentQty, line.ordered_qty || rawSentQty);
            return supabase.from('work_order_line').update({ sent_qty: newSentQty }).eq('id', line.id);
          }));
        }
        stepNum++;
      }

      // Step D: 재고 차감 — WO별로 분리 기록 (롤백 시 WO 단위 복원 가능)
      setMergedConfirmProgress({ current: stepNum, total: totalSteps, step: '재고 차감 중...' });
      // SKU별 총 발송량 합산 (재고 차감은 1회)
      const totalSentBySku: Record<string, number> = {};
      for (const item of finalItems) {
        if (item.sentQty > 0) {
          totalSentBySku[item.skuId] = (totalSentBySku[item.skuId] || 0) + item.sentQty;
        }
      }

      const whId = await getWarehouseId('오프라인샵');
      if (whId) {
        // 재고 차감은 SKU별 총량으로 1회
        const skuEntries = Object.entries(totalSentBySku);
        const BATCH = 10;
        for (let i = 0; i < skuEntries.length; i += BATCH) {
          const batch = skuEntries.slice(i, i + BATCH);
          await Promise.all(batch.map(async ([skuId, qty]) => {
            const { data: inv } = await supabase
              .from('inventory').select('quantity')
              .eq('warehouse_id', whId).eq('sku_id', skuId).eq('needs_marking', false).maybeSingle();
            const newQty = Math.max(0, ((inv as any)?.quantity || 0) - qty);
            await supabase.from('inventory').upsert(
              { warehouse_id: whId, sku_id: skuId, needs_marking: false, quantity: newQty },
              { onConflict: 'warehouse_id,sku_id,needs_marking' }
            );
          }));
        }
        // 트랜잭션 기록은 WO별로 분리 (memo에 작업지시서 날짜 포함 → 롤백 가능)
        for (const woId of affectedWoIds) {
          const woDate = workOrders.find((w) => w.id === woId)?.download_date || '';
          const woSkuAlloc = woAllocation[woId] || {};
          const entries = Object.entries(woSkuAlloc).filter(([, q]) => q > 0);
          for (let i = 0; i < entries.length; i += BATCH) {
            const batch = entries.slice(i, i + BATCH);
            await Promise.all(batch.map(([skuId, qty]) =>
              recordTransaction({
                warehouseId: whId,
                skuId,
                txType: '출고',
                quantity: qty,
                source: 'system',
                memo: `발송확인 (작업지시서 ${woDate})`,
              })
            ));
          }
        }
      }
      stepNum++;

      // Step E: activity_log 기록 (영향받은 WO별로 기록)
      setMergedConfirmProgress({ current: stepNum, total: totalSteps, step: '이력 기록 중...' });
      for (const woId of affectedWoIds) {
        try {
          const { data: existingWaves } = await supabase
            .from('activity_log').select('id')
            .eq('work_order_id', woId).eq('action_type', 'shipment_confirm');
          const waveNum = (existingWaves || []).length + 1;
          const woDate = workOrders.find((w) => w.id === woId)?.download_date || '';
          const woSkuItems = Object.entries(woAllocation[woId] || {}).map(([skuId, qty]) => {
            const item = mergedItems.find((i) => i.skuId === skuId);
            return { skuId, skuName: item?.skuName || skuId, sentQty: qty, needsMarking: item?.needsMarking ?? false };
          });

          await supabase.from('activity_log').insert({
            user_id: currentUser.id,
            action_type: 'shipment_confirm',
            work_order_id: woId,
            action_date: today,
            summary: {
              wave: waveNum,
              mergedShipment: true,
              items: woSkuItems,
              totalQty: woSkuItems.reduce((s, i) => s + i.sentQty, 0),
              workOrderDate: woDate,
            },
          });
        } catch (logErr) { console.warn('Activity log failed:', logErr); }
      }

      // Step F: 완료 후 초기화
      setWoItemsCache({});
      setMergedItems([]);
      setMergedExpanded(false);
      setConfirmed(true);
      setConfirmedWoId(null);
      setConfirmedWoDate(null);
      loadPendingOrders();

      // 슬랙 알림
      notifySlack({
        action: '발송확인',
        user: currentUser.name || currentUser.email,
        date: `전체 (${affectedWoIds.length}건)`,
        items: finalItems.filter((i) => i.sentQty > 0).map((i) => ({ name: i.skuName, qty: i.sentQty })),
      }).catch((e) => console.warn('[비동기 후처리 실패]', e));

      // 온라인 주문 상태 업데이트: 신규 → 이관중 (FIFO)
      import('../../lib/onlineOrderSync').then(({ updateOnlineOrderStatus }) => {
        updateOnlineOrderStatus(
          finalItems.filter((i) => i.sentQty > 0).map((i) => ({ skuId: i.skuId, qty: i.sentQty })),
          '이관중',
          '신규',
        ).catch((e) => console.warn('[비동기 후처리 실패]', e));
      });
    } catch (e: any) {
      setError(`전체 발송 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setMergedConfirming(false);
      setMergedConfirmProgress(null);
    }
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
      for (const item of finalItems) sentMap[item.skuId] = (sentMap[item.skuId] || 0) + item.sentQty;

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

      const offWhId3 = await getWarehouseId('오프라인샵');

      if (offWhId3) {
        const whId = offWhId3;
        const activeItems = finalItems.filter((item) => item.sentQty > 0);
        for (let i = 0; i < activeItems.length; i += BATCH) {
          const batch = activeItems.slice(i, i + BATCH);
          setConfirmProgress({ current: batchStep, total: totalBatches, step: `재고 차감 중... (${Math.min(i + BATCH, activeItems.length)} / ${activeItems.length})` });
          await Promise.all(batch.map(async (item) => {
            const { data: inv } = await supabase
              .from('inventory')
              .select('quantity')
              .eq('warehouse_id', whId)
              .eq('sku_id', item.skuId)
              .eq('needs_marking', false)
              .maybeSingle();
            const newQty = Math.max(0, ((inv as any)?.quantity || 0) - item.sentQty);
            await supabase.from('inventory').upsert(
              { warehouse_id: whId, sku_id: item.skuId, needs_marking: false, quantity: newQty },
              { onConflict: 'warehouse_id,sku_id,needs_marking' }
            );
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
            items: finalItems.filter((i) => i.sentQty > 0).map((i) => ({ skuId: i.skuId, skuName: i.skuName, sentQty: i.sentQty, needsMarking: i.needsMarking ?? false })),
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
      }).catch((e) => console.warn('[비동기 후처리 실패]', e));

      // 온라인 주문 상태 업데이트: 신규 → 이관중 (FIFO)
      import('../../lib/onlineOrderSync').then(({ updateOnlineOrderStatus }) => {
        updateOnlineOrderStatus(
          finalItems.filter((i) => i.sentQty > 0).map((i) => ({ skuId: i.skuId, qty: i.sentQty })),
          '이관중',
          '신규',
        ).catch((e) => console.warn('[비동기 후처리 실패]', e));
      });
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

  if (loading && items.length === 0 && workOrders.length === 0) {
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
              발송 기록이 없는 상태입니다
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

  // 5개 섹션 분류
  const markingUniform = items.filter((i) => i.needsMarking && !i.isMarking);   // 마킹 작업 예정 - 유니폼
  const markingMarking = items.filter((i) => i.needsMarking && i.isMarking);    // 마킹 작업 예정 - 마킹
  const directUniform = items.filter((i) => !i.needsMarking && !i.isMarking);   // 단순 출고 - 유니폼
  const directMarking = items.filter((i) => !i.needsMarking && i.isMarking);    // 단순 출고 - 마킹

  return (
    <div className="space-y-5 max-w-3xl">
      {/* 데이터 갱신 중 표시 */}
      {loading && (items.length > 0 || workOrders.length > 0) && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-blue-700">데이터 갱신 중...</span>
        </div>
      )}
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

      {/* 전체 발송대기 통합 뷰 — 아코디언 */}
      {workOrders.length > 1 && (
        <div className="bg-white rounded-xl shadow-sm border border-indigo-200 overflow-hidden">
          {/* 아코디언 헤더 */}
          <button
            onClick={toggleMergedAccordion}
            className={`w-full flex items-center justify-between px-5 py-3.5 transition-colors ${
              mergedExpanded ? 'bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-indigo-100' : 'bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100'
            }`}
          >
            <div className="flex items-center gap-3">
              {mergedExpanded ? <ChevronUp size={18} className="text-indigo-600" /> : <ChevronDown size={18} className="text-indigo-400" />}
              <div className="flex items-center gap-2">
                <Truck size={18} className="text-indigo-600" />
                <span className="text-sm font-semibold text-indigo-800">전체 발송대기</span>
                <span className="text-xs text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded">통합</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-indigo-600">작업지시서 {workOrders.length}건</p>
              <p className="text-sm font-bold text-indigo-900">
                잔량 {workOrders.reduce((s, wo) => s + (wo.remainingQty || 0), 0).toLocaleString()}개
              </p>
            </div>
          </button>

          {/* 아코디언 본문 */}
          {mergedExpanded && (
            <div className="px-5 py-4 space-y-4">
              {mergedLoading ? (
                <TwoColumnSkeleton />
              ) : mergedItems.length > 0 ? (
                <>
                  {/* 엑셀 버튼 */}
                  <div className="flex gap-2">
                    <button
                      onClick={handleMergedDownloadTemplate}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <Download size={15} />
                      양식 다운로드
                    </button>
                    <button
                      onClick={() => mergedFileInputRef.current?.click()}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-blue-300 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
                    >
                      <FileUp size={15} />
                      엑셀 업로드
                    </button>
                    <input
                      ref={mergedFileInputRef}
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={handleMergedExcelUpload}
                    />
                  </div>

                  {/* 비교 패널 */}
                  {mergedUploadComparison && (
                    <ComparisonPanel
                      rows={mergedUploadComparison.rows}
                      unmatched={mergedUploadComparison.unmatched}
                      onClose={() => setMergedUploadComparison(null)}
                    />
                  )}

                  {/* 품목 카드 */}
                  <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                    <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-gray-900">전체 발송대기 물량 (통합)</h3>
                        <p className="text-sm text-gray-500 mt-0.5">모든 작업지시서 합산</p>
                      </div>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={mergedAllChecked}
                          onChange={(e) => toggleMergedAll(e.target.checked)}
                          className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-xs text-gray-500">전체</span>
                      </label>
                    </div>

                    {/* 총 수량 합계 — 5구분 요약 */}
                    <div className="px-5 py-3 bg-indigo-50/60 border-b border-gray-100 space-y-1">
                      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                        <span className="font-semibold text-gray-700">마킹 작업 예정</span>
                        <span>{mergedCheckedItems.filter(i => i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
                      </div>
                      <div className="flex items-center justify-between text-sm pl-3">
                        <span className="text-blue-700">유니폼</span>
                        <span className="font-semibold text-blue-800">{mergedCheckedItems.filter(i => i.needsMarking && !i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
                      </div>
                      <div className="flex items-center justify-between text-sm pl-3">
                        <span className="text-purple-700">마킹</span>
                        <span className="font-semibold text-purple-800">{mergedCheckedItems.filter(i => i.needsMarking && i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-gray-500 mt-2 mb-1">
                        <span className="font-semibold text-gray-700">단순 출고</span>
                        <span>{mergedCheckedItems.filter(i => !i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
                      </div>
                      <div className="flex items-center justify-between text-sm pl-3">
                        <span className="text-teal-700">유니폼</span>
                        <span className="font-semibold text-teal-800">{mergedCheckedItems.filter(i => !i.needsMarking && !i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
                      </div>
                      <div className="flex items-center justify-between text-sm pl-3">
                        <span className="text-orange-700">마킹</span>
                        <span className="font-semibold text-orange-800">{mergedCheckedItems.filter(i => !i.needsMarking && i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
                      </div>
                      <div className="border-t border-indigo-200 pt-1 mt-1 flex items-center justify-between text-sm">
                        <span className="font-bold text-gray-800">총 발송 수량 ({mergedCheckedItems.length}종)</span>
                        <span className="font-bold text-gray-900 text-base">{mergedCheckedTotalQty}개</span>
                      </div>
                    </div>

                    {mergedHasShortage && (
                      <div className="mx-4 mt-4 flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                        <AlertTriangle size={16} className="text-yellow-600 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-yellow-800">
                          일부 품목 재고가 부족합니다. 실제 발송 수량을 직접 입력해주세요.
                        </p>
                      </div>
                    )}

                    {/* ── 섹션 1: 마킹 작업 예정 ── */}
                    {(mergedItems.filter(i => i.needsMarking).length > 0) && (
                      <>
                        <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100">
                          <p className="text-xs font-bold text-indigo-700">
                            마킹 작업 예정
                            <span className="font-normal text-indigo-500 ml-1">
                              ({mergedItems.filter(i => i.needsMarking).length}종 / {mergedCheckedItems.filter(i => i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개)
                            </span>
                          </p>
                        </div>
                        <div className="grid grid-cols-2 border-b border-gray-100">
                          <div className="px-4 py-1.5 border-r border-gray-100 bg-blue-50/70">
                            <p className="text-[11px] font-semibold text-blue-600">유니폼 ({mergedItems.filter(i => i.needsMarking && !i.isMarking).length}종)</p>
                          </div>
                          <div className="px-4 py-1.5 bg-purple-50/70">
                            <p className="text-[11px] font-semibold text-purple-600">마킹 ({mergedItems.filter(i => i.needsMarking && i.isMarking).length}종)</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2">
                          <div className="border-r border-gray-100 divide-y divide-gray-50">
                            {mergedItems.filter(i => i.needsMarking && !i.isMarking).map((item) => renderMergedItemCard(item, 'blue'))}
                          </div>
                          <div className="divide-y divide-gray-50">
                            {mergedItems.filter(i => i.needsMarking && i.isMarking).map((item) => renderMergedItemCard(item, 'purple'))}
                          </div>
                        </div>
                      </>
                    )}

                    {/* ── 섹션 2: 단순 출고 ── */}
                    {(mergedItems.filter(i => !i.needsMarking).length > 0) && (
                      <>
                        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 border-t border-gray-200">
                          <p className="text-xs font-bold text-gray-700">
                            단순 출고 (마킹 없음)
                            <span className="font-normal text-gray-500 ml-1">
                              ({mergedItems.filter(i => !i.needsMarking).length}종 / {mergedCheckedItems.filter(i => !i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개)
                            </span>
                          </p>
                        </div>
                        <div className="grid grid-cols-2 border-b border-gray-100">
                          <div className="px-4 py-1.5 border-r border-gray-100 bg-teal-50/70">
                            <p className="text-[11px] font-semibold text-teal-600">유니폼 ({mergedItems.filter(i => !i.needsMarking && !i.isMarking).length}종)</p>
                          </div>
                          <div className="px-4 py-1.5 bg-orange-50/70">
                            <p className="text-[11px] font-semibold text-orange-600">마킹 ({mergedItems.filter(i => !i.needsMarking && i.isMarking).length}종)</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2">
                          <div className="border-r border-gray-100 divide-y divide-gray-50">
                            {mergedItems.filter(i => !i.needsMarking && !i.isMarking).map((item) => renderMergedItemCard(item, 'teal'))}
                          </div>
                          <div className="divide-y divide-gray-50">
                            {mergedItems.filter(i => !i.needsMarking && i.isMarking).map((item) => renderMergedItemCard(item, 'orange'))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* 발송 확인 버튼 */}
                  <button
                    onClick={handleMergedConfirmClick}
                    disabled={mergedConfirming || mergedCheckedItems.length === 0}
                    className="w-full py-3.5 rounded-xl text-white font-semibold text-base bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                  >
                    {mergedConfirming ? '처리 중...' : `전체 발송 완료 확인 (${mergedCheckedItems.length}종)`}
                  </button>

                  {/* 통합 진행 바 */}
                  {mergedConfirmProgress && (
                    <div className="space-y-2">
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-indigo-600 h-2 rounded-full transition-all"
                          style={{ width: `${(mergedConfirmProgress.current / mergedConfirmProgress.total) * 100}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-500 text-center">{mergedConfirmProgress.step}</p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-500 text-center py-4">품목을 불러오는 중...</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 작업지시서 1건일 때 요약 배너 (아코디언 불필요) */}
      {workOrders.length === 1 && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-200 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Truck size={20} className="text-blue-600" />
              <span className="text-sm font-semibold text-blue-800">전체 발송 대기</span>
            </div>
            <div className="text-right">
              <p className="text-xs text-blue-600">작업지시서 1건</p>
              <p className="text-lg font-bold text-blue-900">
                잔량 {(workOrders[0].remainingQty || 0).toLocaleString()}개
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

        {/* 총 수량 합계 (체크된 품목만) — 5구분 요약 */}
        <div className="px-5 py-3 bg-blue-50/60 border-b border-gray-100 space-y-1">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span className="font-semibold text-gray-700">마킹 작업 예정</span>
            <span>{checkedItems.filter(i => i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
          </div>
          <div className="flex items-center justify-between text-sm pl-3">
            <span className="text-blue-700">유니폼</span>
            <span className="font-semibold text-blue-800">{checkedItems.filter(i => i.needsMarking && !i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
          </div>
          <div className="flex items-center justify-between text-sm pl-3">
            <span className="text-purple-700">마킹</span>
            <span className="font-semibold text-purple-800">{checkedItems.filter(i => i.needsMarking && i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 mt-2 mb-1">
            <span className="font-semibold text-gray-700">단순 출고</span>
            <span>{checkedItems.filter(i => !i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
          </div>
          <div className="flex items-center justify-between text-sm pl-3">
            <span className="text-teal-700">유니폼</span>
            <span className="font-semibold text-teal-800">{checkedItems.filter(i => !i.needsMarking && !i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
          </div>
          <div className="flex items-center justify-between text-sm pl-3">
            <span className="text-orange-700">마킹</span>
            <span className="font-semibold text-orange-800">{checkedItems.filter(i => !i.needsMarking && i.isMarking).reduce((s, i) => s + i.sentQty, 0)}개</span>
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

        {/* ── 섹션 1: 마킹 작업 예정 (유니폼 + 마킹 2컬럼) ── */}
        {(markingUniform.length > 0 || markingMarking.length > 0) && (
          <>
            <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100">
              <p className="text-xs font-bold text-indigo-700">
                마킹 작업 예정
                <span className="font-normal text-indigo-500 ml-1">
                  ({markingUniform.length + markingMarking.length}종 / {checkedItems.filter(i => i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개)
                </span>
              </p>
            </div>
            <div className="grid grid-cols-2 border-b border-gray-100">
              <div className="px-4 py-1.5 border-r border-gray-100 bg-blue-50/70">
                <p className="text-[11px] font-semibold text-blue-600">유니폼 ({markingUniform.length}종)</p>
              </div>
              <div className="px-4 py-1.5 bg-purple-50/70">
                <p className="text-[11px] font-semibold text-purple-600">마킹 ({markingMarking.length}종)</p>
              </div>
            </div>
            <div className="grid grid-cols-2">
              <div className="border-r border-gray-100 divide-y divide-gray-50">
                {markingUniform.map((item) => renderItemCard(item, 'blue'))}
              </div>
              <div className="divide-y divide-gray-50">
                {markingMarking.map((item) => renderItemCard(item, 'purple'))}
              </div>
            </div>
          </>
        )}

        {/* ── 섹션 2: 단순 출고 (유니폼 + 마킹 2컬럼) ── */}
        {(directUniform.length > 0 || directMarking.length > 0) && (
          <>
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 border-t border-gray-200">
              <p className="text-xs font-bold text-gray-700">
                단순 출고 (마킹 없음)
                <span className="font-normal text-gray-500 ml-1">
                  ({directUniform.length + directMarking.length}종 / {checkedItems.filter(i => !i.needsMarking).reduce((s, i) => s + i.sentQty, 0)}개)
                </span>
              </p>
            </div>
            <div className="grid grid-cols-2 border-b border-gray-100">
              <div className="px-4 py-1.5 border-r border-gray-100 bg-teal-50/70">
                <p className="text-[11px] font-semibold text-teal-600">유니폼 ({directUniform.length}종)</p>
              </div>
              <div className="px-4 py-1.5 bg-orange-50/70">
                <p className="text-[11px] font-semibold text-orange-600">마킹 ({directMarking.length}종)</p>
              </div>
            </div>
            <div className="grid grid-cols-2">
              <div className="border-r border-gray-100 divide-y divide-gray-50">
                {directUniform.map((item) => renderItemCard(item, 'teal'))}
              </div>
              <div className="divide-y divide-gray-50">
                {directMarking.map((item) => renderItemCard(item, 'orange'))}
              </div>
            </div>
          </>
        )}
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

      {/* ── 통합 발송 확인 모달 ── */}
      {showMergedConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">전체 발송 확인</h3>
            <div className="bg-indigo-50 rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">발송 품목</span>
                <span className="font-semibold text-gray-900">{mergedCheckedItems.length}종</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">유니폼</span>
                <span className="font-semibold text-blue-700">{mergedCheckedUniformQty}개</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">마킹</span>
                <span className="font-semibold text-purple-700">{mergedCheckedMarkingQty}개</span>
              </div>
              <div className="border-t border-indigo-200 pt-2 flex justify-between text-sm">
                <span className="font-bold text-gray-800">총 발송 수량</span>
                <span className="font-bold text-gray-900">{mergedCheckedTotalQty}개</span>
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-800">
                작업지시서 {Object.keys(mergedItems.reduce<Record<string, boolean>>((acc, item) => {
                  item.sources.forEach(s => { acc[s.woId] = true; });
                  return acc;
                }, {})).length}건에 걸쳐 날짜 순서대로 차감됩니다
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowMergedConfirmModal(false)}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={handleMergedConfirm}
                className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
              >
                전체 발송 확인
              </button>
            </div>
          </div>
        </div>
      )}

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
