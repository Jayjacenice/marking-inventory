import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../../lib/supabase';
import { recordTransactionBatch, deleteSystemTransactions } from '../../lib/inventoryTransaction';
import type { RecordTxParams } from '../../lib/inventoryTransaction';
import type { ProgressCallback } from '../../lib/workOrderRollback';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
import { TableSkeleton } from '../../components/LoadingSkeleton';
import { notifySlack } from '../../lib/slackNotify';
import type { AppUser } from '../../types';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  Eye,
  FileUp,
  Hammer,
  Trash2,
} from 'lucide-react';

// ── 인터페이스 ──────────────────────────────────

interface MarkingItem {
  lineId: string;
  finishedSkuId: string;
  skuName: string;
  barcode: string | null;
  remainingQty: number;   // 아직 마킹 안 된 수량
  todayQty: number;       // 오늘 완료할 수량 (입력값)
  markedQty: number;      // 누적 완료 수량
  orderedQty: number;     // 주문 수량
  sentQty: number;        // 발송(출고) 수량
  isCarryOver: boolean;   // 이월 작업건 여부
}

interface OverprocessedItem {
  finishedSkuId: string;
  skuName: string;
  orderedQty: number;
  markedQty: number;
  sentQty: number;
  overQty: number;        // 과처리 수량 = marked - ordered
  resolvedQty: number;    // 출고로 해소된 수량
  unresolvedQty: number;  // 미해소 수량
}

interface OverprocessWarning {
  skuName: string;
  orderedQty: number;
  newMarkedQty: number;   // 저장 후 예상 마킹 완료 수량
  overQty: number;        // 과처리 수량
}

interface UnavailableItem {
  lineId: string;
  finishedSkuId: string;
  skuName: string;
  orderedQty: number;
  receivedQty: number;
  markedQty: number;
  reason: string; // "미입고" | "유니폼 재고 부족" | "마킹자재 재고 부족"
}

interface ActiveOrder {
  id: string;
  download_date: string;
}

interface HistoryItem {
  lineId: string;
  skuName: string;
  completedQty: number;
}

interface MarkingSource {
  woId: string;
  woDate: string;
  lineId: string;
  availableQty: number;
}

interface MergedMarkingItem {
  finishedSkuId: string;
  skuName: string;
  barcode: string | null;
  remainingQty: number;
  todayQty: number;
  markedQty: number;
  orderedQty: number;
  sentQty: number;
  isCarryOver: boolean;
  sources: MarkingSource[];
}

// ── 컴포넌트 ────────────────────────────────────

export default function MarkingWork({ currentUser }: { currentUser: AppUser }) {
  const isStale = useStaleGuard();
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<ActiveOrder | null>(null);
  const [items, setItems] = useState<MarkingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 엑셀 관련
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadComparison, setUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [xlsxError, setXlsxError] = useState<string | null>(null);

  // 날짜 관리
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // 모든 라인 ID (이력 조회용)
  const [allLineIds, setAllLineIds] = useState<string[]>([]);

  // BOM 맵: finishedSkuId → [{ componentSkuId, quantity }]
  const [bomMap, setBomMap] = useState<Record<string, { componentSkuId: string; quantity: number }[]>>({});

  // 작업 불가 리스트
  const [unavailableItems, setUnavailableItems] = useState<UnavailableItem[]>([]);

  // 초과 마킹 후 작업불가 알림
  const [unavailableAlert, setUnavailableAlert] = useState<{ skuName: string; reason: string; needed: number; available: number }[]>([]);
  const [showUnavailable, setShowUnavailable] = useState(false);

  // 내일 날짜 계산
  const tomorrowDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  })();
  const isToday = selectedDate === today;
  const isTomorrow = selectedDate === tomorrowDate;

  // 과처리 관련
  const [overprocessedItems, setOverprocessedItems] = useState<OverprocessedItem[]>([]);
  const [showOverprocessed, setShowOverprocessed] = useState(false);
  const [showOverprocessWarning, setShowOverprocessWarning] = useState(false);
  const [overprocessWarnings, setOverprocessWarnings] = useState<OverprocessWarning[]>([]);
  const [pendingSaveType, setPendingSaveType] = useState<'single' | 'merged' | null>(null);

  // 이력 삭제
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePreview, setDeletePreview] = useState<{ lineId: string; skuName: string; qty: number }[]>([]);
  const [rollbackProgress, setRollbackProgress] = useState<{current:number;total:number;step:string}|null>(null);

  // 아코디언 뷰
  const [expandedWoIds, setExpandedWoIds] = useState<Set<string>>(new Set());
  const [woItemsCache, setWoItemsCache] = useState<Record<string, { items: MarkingItem[]; unavailable: UnavailableItem[] }>>({});
  const [woLoadingId, setWoLoadingId] = useState<string | null>(null);

  // 전체 통합 뷰
  const [mergedExpanded, setMergedExpanded] = useState(false);
  const [mergedItems, setMergedItems] = useState<MergedMarkingItem[]>([]);
  const [mergedLoading, setMergedLoading] = useState(false);
  const [mergedSaving, setMergedSaving] = useState(false);
  const [mergedSaveProgress, setMergedSaveProgress] = useState<{current:number;total:number;step:string}|null>(null);
  const [mergedSaved, setMergedSaved] = useState(false);
  const mergedFileInputRef = useRef<HTMLInputElement>(null);
  const [mergedUploadComparison, setMergedUploadComparison] = useState<{rows: ComparisonRow[]; unmatched: string[]}|null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  // ── 작업지시서 목록 로드 ──

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date')
        .in('status', ['입고확인완료', '마킹중'])
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      if (isStale()) return;
      const list = (data || []) as ActiveOrder[];
      setOrders(list);
      if (list.length > 0) selectOrder(list[0]);
      else setLoading(false);
    } catch (e: any) {
      if (!isStale()) setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
      setLoading(false);
    }
  };

  // ── 작업지시서 선택 → 전체 라인 로드 ──

  const selectOrder = async (wo: ActiveOrder) => {
    setSelectedOrder(wo);
    setLoading(true);
    setSaved(false);
    setError(null);
    setUploadComparison(null);
    setXlsxError(null);
    setSelectedDate(today);
    setHistoryItems([]);
    try {
      // 마킹 필요 라인만 조회 (단품 제외)
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, received_qty, marked_qty, sent_qty, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
        .eq('work_order_id', wo.id)
        .eq('needs_marking', true);
      if (linesErr) throw linesErr;
      if (isStale()) return;

      const lineIds = ((lines || []) as any[]).map((l: any) => l.id);
      setAllLineIds(lineIds);

      // BOM + daily_marking 병렬 조회 (둘 다 1단계 lines 결과에만 의존)
      const markingSkuIds = ((lines || []) as any[]).map((l: any) => l.finished_sku_id as string);

      const [bomResult, markingResult, whResult] = await Promise.all([
        // BOM 로드 (마킹 시 구성품 재고 변경용)
        supabase
          .from('bom')
          .select('finished_sku_id, component_sku_id, quantity')
          .in('finished_sku_id', markingSkuIds.length > 0 ? markingSkuIds : ['__none__']),
        // 전체 daily_marking 조회 (이월 판별용)
        lineIds.length > 0
          ? supabase
              .from('daily_marking')
              .select('work_order_line_id, completed_qty, date')
              .in('work_order_line_id', lineIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        // 플레이위즈 창고 ID 조회
        supabase
          .from('warehouse')
          .select('id')
          .eq('name', '플레이위즈')
          .maybeSingle(),
      ]);

      if (bomResult.error) throw bomResult.error;
      if (markingResult.error) throw markingResult.error;
      if (isStale()) return;

      const bMap: Record<string, { componentSkuId: string; quantity: number }[]> = {};
      for (const b of (bomResult.data || []) as any[]) {
        if (!bMap[b.finished_sku_id]) bMap[b.finished_sku_id] = [];
        bMap[b.finished_sku_id].push({ componentSkuId: b.component_sku_id, quantity: b.quantity });
      }
      setBomMap(bMap);

      // 플레이위즈 창고의 구성품 재고 조회
      const pwWhId = (whResult.data as any)?.id;
      const allComponentSkuIds = new Set<string>();
      for (const comps of Object.values(bMap)) {
        for (const c of comps) allComponentSkuIds.add(c.componentSkuId);
      }
      const componentSkuArr = Array.from(allComponentSkuIds);

      let inventoryMap: Record<string, number> = {};
      if (pwWhId && componentSkuArr.length > 0) {
        const { data: invData } = await supabase
          .from('inventory')
          .select('sku_id, quantity')
          .eq('warehouse_id', pwWhId)
          .in('sku_id', componentSkuArr);
        if (isStale()) return;
        for (const inv of (invData || []) as any[]) {
          inventoryMap[inv.sku_id] = inv.quantity || 0;
        }
      }

      const allMarkings = (markingResult.data || []) as any[];

      const todayMap: Record<string, number> = {};
      const hasHistory = new Set<string>();

      for (const m of allMarkings) {
        if (m.date === today) {
          todayMap[m.work_order_line_id] = m.completed_qty;
        }
        if (m.date < today) {
          hasHistory.add(m.work_order_line_id);
        }
      }

      const markingItems: MarkingItem[] = [];
      const unavailable: UnavailableItem[] = [];
      const overprocessed: OverprocessedItem[] = [];

      for (const line of (lines || []) as any[]) {
        const skuName = line.finished_sku?.sku_name || line.finished_sku_id;
        const sentQty = line.sent_qty || 0;

        // 과처리 판별 (완료 여부와 무관하게 체크)
        if (line.marked_qty > line.ordered_qty) {
          const overQty = line.marked_qty - line.ordered_qty;
          const resolvedQty = Math.min(sentQty, overQty);
          const unresolvedQty = overQty - resolvedQty;
          if (unresolvedQty > 0) {
            overprocessed.push({
              finishedSkuId: line.finished_sku_id,
              skuName,
              orderedQty: line.ordered_qty,
              markedQty: line.marked_qty,
              sentQty,
              overQty,
              resolvedQty,
              unresolvedQty,
            });
          }
        }

        // 미입고: received_qty = 0
        if (line.received_qty === 0) {
          unavailable.push({
            lineId: line.id,
            finishedSkuId: line.finished_sku_id,
            skuName,
            orderedQty: line.ordered_qty,
            receivedQty: line.received_qty,
            markedQty: line.marked_qty,
            reason: '미입고',
          });
          continue;
        }

        const remaining = line.received_qty - line.marked_qty;
        if (remaining <= 0) continue; // 이미 완료

        // 구성품 재고 부족 판별
        const comps = bMap[line.finished_sku_id] || [];
        const shortage = comps.find((c) => {
          const inv = inventoryMap[c.componentSkuId] || 0;
          return inv < c.quantity * remaining;
        });

        if (shortage) {
          const reason = shortage.componentSkuId.includes('MK') ? '마킹자재 재고 부족' : '유니폼 재고 부족';
          unavailable.push({
            lineId: line.id,
            finishedSkuId: line.finished_sku_id,
            skuName,
            orderedQty: line.ordered_qty,
            receivedQty: line.received_qty,
            markedQty: line.marked_qty,
            reason,
          });
        } else {
          // 작업 가능
          markingItems.push({
            lineId: line.id,
            finishedSkuId: line.finished_sku_id,
            skuName,
            barcode: line.finished_sku?.barcode || null,
            remainingQty: remaining,
            todayQty: 0, // 항상 0으로 시작 (중복 저장 방지)
            markedQty: line.marked_qty,
            orderedQty: line.ordered_qty,
            sentQty,
            isCarryOver: hasHistory.has(line.id) || (line.marked_qty > 0 && line.marked_qty < line.received_qty),
          });
        }
      }

      // 정렬: 이월 우선 → 나머지
      markingItems.sort((a, b) => {
        if (a.isCarryOver !== b.isCarryOver) return a.isCarryOver ? -1 : 1;
        return 0;
      });

      setItems(markingItems);
      setUnavailableItems(unavailable);
      setOverprocessedItems(overprocessed);
      // 아코디언 캐시에 저장
      setWoItemsCache((prev) => ({ ...prev, [wo.id]: { items: markingItems, unavailable } }));
    } catch (e: any) {
      if (!isStale()) setError(`마킹 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  // ── 아코디언 토글 ──
  const toggleAccordion = async (wo: ActiveOrder) => {
    const newSet = new Set(expandedWoIds);
    if (newSet.has(wo.id)) {
      newSet.delete(wo.id);
      setExpandedWoIds(newSet);
      return;
    }
    newSet.add(wo.id);
    setExpandedWoIds(newSet);

    // 통합 뷰 접기
    setMergedExpanded(false);

    if (woItemsCache[wo.id]) {
      setSelectedOrder(wo);
      setItems(woItemsCache[wo.id].items);
      setUnavailableItems(woItemsCache[wo.id].unavailable);
      return;
    }

    setWoLoadingId(wo.id);
    await selectOrder(wo);
    setWoLoadingId(null);
  };

  // ── 전체 통합 뷰 ──
  const buildMergedMarkingItems = async () => {
    setMergedLoading(true);
    setError(null);
    try {
      const sorted = [...orders].sort((a, b) => a.download_date.localeCompare(b.download_date));

      // 캐시 없는 WO 선조회
      const uncached = sorted.filter((wo) => !woItemsCache[wo.id]);
      if (uncached.length > 0) {
        await Promise.all(uncached.map((wo) => selectOrder(wo)));
      }

      setWoItemsCache((currentCache) => {
        const mergedMap: Record<string, MergedMarkingItem> = {};

        for (const wo of sorted) {
          const cached = currentCache[wo.id];
          if (!cached) continue;
          for (const item of cached.items) {
            if (!mergedMap[item.finishedSkuId]) {
              mergedMap[item.finishedSkuId] = {
                finishedSkuId: item.finishedSkuId,
                skuName: item.skuName,
                barcode: item.barcode,
                remainingQty: 0,
                todayQty: 0,
                markedQty: 0,
                orderedQty: 0,
                sentQty: 0,
                isCarryOver: false,
                sources: [],
              };
            }
            mergedMap[item.finishedSkuId].remainingQty += item.remainingQty;
            mergedMap[item.finishedSkuId].markedQty += item.markedQty;
            mergedMap[item.finishedSkuId].orderedQty += item.orderedQty;
            mergedMap[item.finishedSkuId].sentQty += item.sentQty;
            if (item.isCarryOver) mergedMap[item.finishedSkuId].isCarryOver = true;
            mergedMap[item.finishedSkuId].sources.push({
              woId: wo.id,
              woDate: wo.download_date,
              lineId: item.lineId,
              availableQty: item.remainingQty,
            });
          }
        }

        const merged = Object.values(mergedMap).sort((a, b) => {
          if (a.isCarryOver !== b.isCarryOver) return a.isCarryOver ? -1 : 1;
          return 0;
        });

        setMergedItems(merged);
        return currentCache;
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
    setExpandedWoIds(new Set());
    setSelectedOrder(null);
    await buildMergedMarkingItems();
  };

  // 통합 뷰 수량 변경
  const handleMergedQtyChange = (skuId: string, value: number) => {
    setMergedItems((prev) =>
      prev.map((item) =>
        item.finishedSkuId === skuId ? { ...item, todayQty: Math.max(0, value) } : item
      )
    );
  };

  // 통합 뷰 파생 값
  const mergedCarryOverItems = mergedItems.filter((i) => i.isCarryOver);
  const mergedNewItems = mergedItems.filter((i) => !i.isCarryOver);
  const mergedTotalRemaining = mergedItems.reduce((s, i) => s + i.remainingQty, 0);
  const mergedTotalToday = mergedItems.reduce((s, i) => s + i.todayQty, 0);

  // 통합 뷰 엑셀 다운로드
  const handleMergedDownloadTemplate = () => {
    generateTemplate(
      mergedItems.map((item) => ({
        skuId: item.finishedSkuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.todayQty || item.remainingQty,
      })),
      `전체마킹작업_${today}.xlsx`
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
        mergedItems.map((item) => ({ skuId: item.finishedSkuId, skuName: item.skuName, barcode: item.barcode }))
      );
      const matchMap = new Map(result.matched.map((m) => [m.skuId, m.uploadedQty]));
      setMergedItems((prev) =>
        prev.map((item) =>
          matchMap.has(item.finishedSkuId)
            ? { ...item, todayQty: matchMap.get(item.finishedSkuId)! }
            : item
        )
      );
      const rows: ComparisonRow[] = result.matched.map((m) => {
        const item = mergedItems.find((i) => i.finishedSkuId === m.skuId);
        return {
          skuId: m.skuId,
          skuName: item?.skuName || m.skuId,
          expected: item?.remainingQty ?? 0,
          uploaded: m.uploadedQty,
          diff: m.uploadedQty - (item?.remainingQty ?? 0),
        };
      });
      setMergedUploadComparison({ rows, unmatched: result.unmatched });
    } catch (err: any) {
      setError(err.message || '파일 처리 실패');
    }
    if (mergedFileInputRef.current) mergedFileInputRef.current.value = '';
  };

  // 통합 뷰 저장 — 날짜순 차감
  const handleMergedSave = async () => {
    setMergedSaving(true);
    setMergedSaveProgress(null);
    setError(null);
    try {
      const activeItems = mergedItems.filter((item) => item.todayQty > 0);
      if (activeItems.length === 0) return;

      // Step A: todayQty를 WO별 라인에 분배 (날짜순)
      const lineAllocation: Record<string, number> = {}; // lineId → qty
      const woIds = new Set<string>();
      for (const item of activeItems) {
        let remaining = item.todayQty;
        for (const src of item.sources) {
          if (remaining <= 0) break;
          const alloc = Math.min(src.availableQty, remaining);
          if (alloc > 0) {
            lineAllocation[src.lineId] = (lineAllocation[src.lineId] || 0) + alloc;
            woIds.add(src.woId);
            remaining -= alloc;
          }
        }
      }

      const affectedLineIds = Object.keys(lineAllocation);
      const totalSteps = 6;

      // Step 1: 데이터 일괄 조회
      setMergedSaveProgress({ current: 1, total: totalSteps, step: '데이터 조회 중...' });
      const [dmResult, lineResult, whResult] = await Promise.all([
        supabase.from('daily_marking').select('id, work_order_line_id, completed_qty')
          .eq('date', today).in('work_order_line_id', affectedLineIds),
        supabase.from('work_order_line').select('id, marked_qty, finished_sku_id, needs_marking, work_order_id')
          .in('id', affectedLineIds),
        supabase.from('warehouse').select('id').eq('name', '플레이위즈').maybeSingle(),
      ]);

      const existingDmMap = new Map(
        ((dmResult.data || []) as any[]).map((dm: any) => [dm.work_order_line_id, dm])
      );
      const lineMap = new Map(
        ((lineResult.data || []) as any[]).map((l: any) => [l.id, l])
      );
      const pwWhId = (whResult.data as any)?.id;

      // diff 계산
      const diffs = affectedLineIds.map((lineId) => {
        const allocQty = lineAllocation[lineId];
        const existing = existingDmMap.get(lineId);
        const previousQty = existing?.completed_qty || 0;
        const lineData = lineMap.get(lineId);
        return {
          lineId,
          todayQty: allocQty,
          diff: allocQty - previousQty,
          existing,
          finishedSkuId: lineData?.finished_sku_id || '',
          currentMarkedQty: lineData?.marked_qty || 0,
          workOrderId: lineData?.work_order_id || '',
        };
      });

      // Step 2: daily_marking 저장
      setMergedSaveProgress({ current: 2, total: totalSteps, step: '마킹 기록 저장 중...' });
      const toInsert = diffs.filter((d) => !d.existing);
      const toUpdate = diffs.filter((d) => d.existing);

      if (toInsert.length > 0) {
        await supabase.from('daily_marking').insert(
          toInsert.map((d) => ({
            date: today, work_order_line_id: d.lineId,
            completed_qty: d.todayQty, sent_to_cj_qty: d.todayQty,
          }))
        );
      }
      const BATCH = 10;
      for (let i = 0; i < toUpdate.length; i += BATCH) {
        const batch = toUpdate.slice(i, i + BATCH);
        await Promise.all(batch.map((d) =>
          supabase.from('daily_marking')
            .update({ completed_qty: d.todayQty, sent_to_cj_qty: d.todayQty })
            .eq('id', d.existing.id)
        ));
      }

      // Step 3: marked_qty 업데이트
      setMergedSaveProgress({ current: 3, total: totalSteps, step: 'marked_qty 업데이트 중...' });
      for (let i = 0; i < diffs.length; i += BATCH) {
        const batch = diffs.slice(i, i + BATCH);
        await Promise.all(batch.map((d) =>
          supabase.from('work_order_line')
            .update({ marked_qty: d.currentMarkedQty + d.diff })
            .eq('id', d.lineId)
        ));
      }

      // Step 4: 재고 트랜잭션 (SKU별 1회)
      setMergedSaveProgress({ current: 4, total: totalSteps, step: '재고 반영 중...' });
      if (pwWhId) {
        const txRows: RecordTxParams[] = [];
        // SKU별 diff 합산
        const skuDiffMap: Record<string, number> = {};
        for (const d of diffs) {
          if (d.diff === 0) continue;
          skuDiffMap[d.finishedSkuId] = (skuDiffMap[d.finishedSkuId] || 0) + d.diff;
        }
        for (const [skuId, totalDiff] of Object.entries(skuDiffMap)) {
          if (totalDiff <= 0) continue;
          const components = bomMap[skuId] || [];
          for (const comp of components) {
            txRows.push({
              warehouseId: pwWhId, skuId: comp.componentSkuId,
              txType: '마킹출고', quantity: comp.quantity * totalDiff, source: 'system',
              memo: `전체마킹 구성품 차감 (${skuId})`,
            });
          }
          txRows.push({
            warehouseId: pwWhId, skuId,
            txType: '마킹입고', quantity: totalDiff, source: 'system',
            memo: '전체마킹 완성품 증가',
          });
        }
        if (txRows.length > 0) {
          await recordTransactionBatch(txRows);
        }
      }

      // Step 5: WO status 업데이트
      setMergedSaveProgress({ current: 5, total: totalSteps, step: '완료 상태 업데이트 중...' });
      for (const woId of woIds) {
        const { data: allLines } = await supabase
          .from('work_order_line')
          .select('received_qty, marked_qty, needs_marking')
          .eq('work_order_id', woId);
        const allDone = ((allLines || []) as any[])
          .filter((l) => l.needs_marking)
          .every((l) => l.marked_qty >= l.received_qty);
        await supabase.from('work_order')
          .update({ status: allDone ? '마킹완료' : '마킹중' })
          .eq('id', woId);
      }

      // Step 6: Activity log (중복 방지: 같은 날 같은 WO면 update)
      setMergedSaveProgress({ current: 6, total: totalSteps, step: '완료 처리 중...' });
      for (const woId of woIds) {
        try {
          const woDate = orders.find((w) => w.id === woId)?.download_date || '';
          const woItems = diffs.filter((d) => d.workOrderId === woId);
          const logSummary = {
            mergedWork: true,
            items: woItems.map((d) => ({
              skuId: d.finishedSkuId,
              skuName: mergedItems.find((m) => m.finishedSkuId === d.finishedSkuId)?.skuName || d.finishedSkuId,
              completedQty: d.todayQty,
            })),
            totalQty: woItems.reduce((s, d) => s + d.todayQty, 0),
            workOrderDate: woDate,
          };
          const { data: existingLog } = await supabase
            .from('activity_log')
            .select('id')
            .eq('user_id', currentUser.id)
            .eq('action_type', 'marking_work')
            .eq('work_order_id', woId)
            .eq('action_date', today)
            .order('created_at', { ascending: false })
            .limit(1);
          if (existingLog && existingLog.length > 0) {
            await supabase.from('activity_log')
              .update({ summary: logSummary })
              .eq('id', (existingLog[0] as any).id);
          } else {
            await supabase.from('activity_log').insert({
              user_id: currentUser.id,
              action_type: 'marking_work',
              work_order_id: woId,
              action_date: today,
              summary: logSummary,
            });
          }
        } catch (logErr) { console.warn('Activity log failed:', logErr); }
      }

      // 캐시 초기화 + 재조회
      setWoItemsCache({});
      setMergedItems([]);
      setMergedExpanded(false);
      setMergedSaved(true);
      loadOrders();

      // 슬랙 알림
      notifySlack({
        action: '마킹작업',
        user: currentUser.name || currentUser.email,
        date: `전체 (${woIds.size}건)`,
        items: activeItems.map((i) => ({ name: i.skuName, qty: i.todayQty })),
      }).catch(() => {});
    } catch (e: any) {
      setError(`전체 마킹 저장 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setMergedSaving(false);
      setMergedSaveProgress(null);
    }
  };

  // ── 날짜 이동 ──

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    const newDate = d.toISOString().split('T')[0];
    // 내일까지만 허용
    if (newDate > tomorrowDate) return;
    setSelectedDate(newDate);
    if (newDate === today) {
      // 오늘로 돌아오면 작업 모드
      setHistoryItems([]);
    } else if (newDate === tomorrowDate) {
      // 내일 → 이월 미리보기 (loadHistory는 호출하지 않음)
      setHistoryItems([]);
    } else {
      // 과거 날짜 → 이력 조회
      loadHistory(newDate);
    }
  };

  const loadHistory = async (date: string) => {
    if (allLineIds.length === 0) return;
    setHistoryLoading(true);
    try {
      const { data, error: err } = await supabase
        .from('daily_marking')
        .select('work_order_line_id, completed_qty, work_order_line:work_order_line!inner(finished_sku_id, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name))')
        .eq('date', date)
        .in('work_order_line_id', allLineIds);
      if (err) throw err;
      if (isStale()) return;

      setHistoryItems(
        ((data || []) as any[]).map((d: any) => ({
          lineId: d.work_order_line_id,
          skuName: d.work_order_line?.finished_sku?.sku_name || d.work_order_line?.finished_sku_id || '',
          completedQty: d.completed_qty,
        }))
      );
    } catch (e: any) {
      if (!isStale()) setError(`이력 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setHistoryLoading(false);
    }
  };

  // ── 수량 변경 ──

  const handleQtyChange = (lineId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.lineId !== lineId) return item;
        const clamped = Math.max(0, Math.min(value, item.remainingQty));
        return { ...item, todayQty: clamped };
      })
    );
  };

  // ── 엑셀 양식 다운로드 ──

  const handleDownloadTemplate = () => {
    generateTemplate(
      items.map((item) => ({
        skuId: item.finishedSkuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.remainingQty,
      })),
      `마킹작업_${selectedOrder?.download_date || '양식'}.xlsx`
    );
  };

  // 작업 가능 목록만 다운로드
  const handleDownloadAvailable = () => {
    const available = items.filter((item) => item.todayQty > 0 || item.remainingQty > 0);
    generateTemplate(
      available.map((item) => ({
        skuId: item.finishedSkuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.remainingQty,
      })),
      `작업가능목록_${selectedOrder?.download_date || '양식'}.xlsx`
    );
  };

  // ── 엑셀 업로드 ──

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

      // todayQty 일괄 업데이트
      const matchMap = new Map(result.matched.map((m) => [m.skuId, m.uploadedQty]));
      setItems((prev) =>
        prev.map((item) =>
          matchMap.has(item.finishedSkuId)
            ? { ...item, todayQty: Math.min(matchMap.get(item.finishedSkuId)!, item.remainingQty) }
            : item
        )
      );

      // 비교 패널
      const compRows: ComparisonRow[] = items
        .map((item) => ({
          skuId: item.finishedSkuId,
          skuName: item.skuName,
          expected: item.remainingQty,
          uploaded: matchMap.get(item.finishedSkuId) || 0,
          diff: (matchMap.get(item.finishedSkuId) || 0) - item.remainingQty,
        }))
        .filter((r) => r.uploaded > 0 || matchMap.has(r.skuId));

      if (compRows.length > 0) {
        setUploadComparison({ rows: compRows, unmatched: result.unmatched });
      } else if (result.unmatched.length > 0) {
        setXlsxError(`매칭 실패: ${result.unmatched.join(', ')}`);
      }
    } catch (err: any) {
      setXlsxError(err.message || '엑셀 파싱 실패');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── 집계 ──

  const carryOverItems = items.filter((i) => i.isCarryOver);
  const totalRemaining = items.reduce((s, i) => s + i.remainingQty, 0);
  const unavailableRemaining = unavailableItems.reduce((s, i) => s + Math.max(0, (i.receivedQty || 0) - (i.markedQty || 0)), 0);
  const grandTotalRemaining = totalRemaining + unavailableRemaining;
  const totalToday = items.reduce((s, i) => s + i.todayQty, 0);
  const allComplete = items.every((item) => item.todayQty >= item.remainingQty);

  // ── 저장 ──

  // ── 과처리 검사 (저장 전) ──
  const checkOverprocess = () => {
    const activeItems = items.filter((item) => item.todayQty > 0);
    const warnings: OverprocessWarning[] = [];
    for (const item of activeItems) {
      const newMarkedQty = item.markedQty + item.todayQty;
      if (newMarkedQty > item.orderedQty) {
        warnings.push({
          skuName: item.skuName,
          orderedQty: item.orderedQty,
          newMarkedQty,
          overQty: newMarkedQty - item.orderedQty,
        });
      }
    }
    if (warnings.length > 0) {
      setOverprocessWarnings(warnings);
      setPendingSaveType('single');
      setShowOverprocessWarning(true);
    } else {
      handleSave();
    }
  };

  const checkMergedOverprocess = () => {
    const activeItems = mergedItems.filter((item) => item.todayQty > 0);
    const warnings: OverprocessWarning[] = [];
    for (const item of activeItems) {
      const newMarkedQty = item.markedQty + item.todayQty;
      if (newMarkedQty > item.orderedQty) {
        warnings.push({
          skuName: item.skuName,
          orderedQty: item.orderedQty,
          newMarkedQty,
          overQty: newMarkedQty - item.orderedQty,
        });
      }
    }
    if (warnings.length > 0) {
      setOverprocessWarnings(warnings);
      setPendingSaveType('merged');
      setShowOverprocessWarning(true);
    } else {
      handleMergedSave();
    }
  };

  const confirmOverprocessSave = () => {
    setShowOverprocessWarning(false);
    if (pendingSaveType === 'single') handleSave();
    else if (pendingSaveType === 'merged') handleMergedSave();
    setPendingSaveType(null);
  };

  const handleSave = async () => {
    if (!selectedOrder) return;
    setSaving(true);
    setSaveProgress(null);
    setError(null);
    try {
      const activeItems = items.filter((item) => item.todayQty > 0);
      if (activeItems.length === 0) return;
      const totalSteps = 6;

      // ── 1단계: 데이터 일괄 조회 (병렬) ──
      setSaveProgress({ current: 1, total: totalSteps, step: '데이터 조회 중...' });
      const lineIds = activeItems.map((item) => item.lineId);

      const [dmResult, lineResult, whResult] = await Promise.all([
        supabase.from('daily_marking').select('id, work_order_line_id, completed_qty')
          .eq('date', today).in('work_order_line_id', lineIds),
        supabase.from('work_order_line').select('id, marked_qty').in('id', lineIds),
        supabase.from('warehouse').select('id').eq('name', '플레이위즈').maybeSingle(),
      ]);

      const existingDmMap = new Map(
        ((dmResult.data || []) as any[]).map((dm: any) => [dm.work_order_line_id, dm])
      );
      const lineMap = new Map(
        ((lineResult.data || []) as any[]).map((l: any) => [l.id, l.marked_qty || 0])
      );
      const pwWhId = (whResult.data as any)?.id;

      // diff 계산 (메모리에서)
      const diffs = activeItems.map((item) => {
        const existing = existingDmMap.get(item.lineId);
        const previousQty = existing?.completed_qty || 0;
        return { ...item, diff: item.todayQty - previousQty, existing };
      });

      // ── 2단계: daily_marking 배치 처리 ──
      setSaveProgress({ current: 2, total: totalSteps, step: '마킹 기록 저장 중...' });
      const toInsert = diffs.filter((d) => !d.existing);
      const toUpdate = diffs.filter((d) => d.existing);

      // 신규 항목 일괄 삽입
      if (toInsert.length > 0) {
        const { error: insErr } = await supabase.from('daily_marking').insert(
          toInsert.map((d) => ({
            date: today, work_order_line_id: d.lineId,
            completed_qty: d.todayQty, sent_to_cj_qty: d.todayQty,
          }))
        );
        if (insErr) throw insErr;
      }

      // 기존 항목 배치 업데이트 (BATCH=10, Promise.all)
      const BATCH = 10;
      for (let i = 0; i < toUpdate.length; i += BATCH) {
        const batch = toUpdate.slice(i, i + BATCH);
        await Promise.all(batch.map((d) =>
          supabase.from('daily_marking')
            .update({ completed_qty: d.todayQty, sent_to_cj_qty: d.todayQty })
            .eq('id', d.existing.id)
        ));
      }

      // ── 3단계: work_order_line marked_qty 배치 업데이트 ──
      setSaveProgress({ current: 3, total: totalSteps, step: 'marked_qty 업데이트 중...' });
      for (let i = 0; i < diffs.length; i += BATCH) {
        const batch = diffs.slice(i, i + BATCH);
        await Promise.all(batch.map((d) => {
          const currentMarkedQty = lineMap.get(d.lineId) || 0;
          return supabase.from('work_order_line')
            .update({ marked_qty: currentMarkedQty + d.diff })
            .eq('id', d.lineId);
        }));
      }

      // ── 4단계: 재고 트랜잭션 일괄 기록 (recordTransactionBatch) ──
      setSaveProgress({ current: 4, total: totalSteps, step: '재고 반영 중...' });
      if (pwWhId) {
        const txRows: RecordTxParams[] = [];
        for (const d of diffs) {
          if (d.diff === 0) continue;
          const components = bomMap[d.finishedSkuId] || [];
          // 구성품 마킹출고
          for (const comp of components) {
            const deltaQty = comp.quantity * d.diff;
            if (deltaQty > 0) {
              txRows.push({
                warehouseId: pwWhId, skuId: comp.componentSkuId,
                txType: '마킹출고', quantity: deltaQty, source: 'system',
                memo: `마킹작업 구성품 차감 (${d.finishedSkuId})`,
              });
            }
          }
          // 완성품 마킹입고
          if (d.diff > 0) {
            txRows.push({
              warehouseId: pwWhId, skuId: d.finishedSkuId,
              txType: '마킹입고', quantity: d.diff, source: 'system',
              memo: '마킹작업 완성품 증가',
            });
          }
        }
        if (txRows.length > 0) {
          await recordTransactionBatch(txRows);
        }
      }

      // ── 5단계: 상태 업데이트 ──
      setSaveProgress({ current: 5, total: totalSteps, step: '완료 상태 업데이트 중...' });
      const { data: allLines, error: allLinesErr } = await supabase
        .from('work_order_line')
        .select('received_qty, marked_qty, needs_marking')
        .eq('work_order_id', selectedOrder.id);
      if (allLinesErr) throw allLinesErr;

      const allDone = ((allLines || []) as any[])
        .filter((l) => l.needs_marking)
        .every((l) => l.marked_qty >= l.received_qty);

      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: allDone ? '마킹완료' : '마킹중' })
        .eq('id', selectedOrder.id);
      if (statusErr) throw statusErr;

      // ── 6단계: Activity log (중복 방지: 같은 날 같은 WO면 update) ──
      setSaveProgress({ current: 6, total: totalSteps, step: '완료 처리 중...' });
      try {
        const logItems = activeItems.map((item) => ({
          skuId: item.finishedSkuId, skuName: item.skuName, completedQty: item.todayQty,
        }));
        const logSummary = {
          items: logItems,
          totalQty: logItems.reduce((s, i) => s + i.completedQty, 0),
          workOrderDate: selectedOrder.download_date,
        };
        const { data: existingLog } = await supabase
          .from('activity_log')
          .select('id')
          .eq('user_id', currentUser.id)
          .eq('action_type', 'marking_work')
          .eq('work_order_id', selectedOrder.id)
          .eq('action_date', today)
          .order('created_at', { ascending: false })
          .limit(1);
        if (existingLog && existingLog.length > 0) {
          await supabase.from('activity_log')
            .update({ summary: logSummary })
            .eq('id', (existingLog[0] as any).id);
        } else {
          await supabase.from('activity_log').insert({
            user_id: currentUser.id,
            action_type: 'marking_work',
            work_order_id: selectedOrder.id,
            action_date: today,
            summary: logSummary,
          });
        }
      } catch (logErr) { console.warn('Activity log failed:', logErr); }

      await selectOrder(selectedOrder);
      setSaved(true);

      // 슬랙 알림 (마킹 실적)
      const savedItems = items.filter((i) => (i.todayQty || 0) > 0);
      notifySlack({
        action: '마킹작업',
        user: currentUser.name || currentUser.email,
        date: selectedOrder.download_date,
        items: savedItems.map((i) => ({ name: i.skuName, qty: i.todayQty || 0 })),
      }).catch(() => {});

      // 초과 마킹으로 인한 작업불가 품목 감지
      try {
        const { data: currentInv } = await supabase
          .from('inventory')
          .select('sku_id, quantity')
          .eq('warehouse_id', pwWhId);
        const invMap: Record<string, number> = {};
        for (const inv of (currentInv || []) as any[]) {
          invMap[inv.sku_id] = inv.quantity;
        }

        // 미완료 라인 확인 (marked_qty < received_qty)
        const { data: freshLines } = await supabase
          .from('work_order_line')
          .select('finished_sku_id, ordered_qty, marked_qty, received_qty, needs_marking')
          .eq('work_order_id', selectedOrder.id);

        const newlyUnavail: { skuName: string; reason: string; needed: number; available: number }[] = [];
        for (const line of (freshLines || []) as any[]) {
          if (!line.needs_marking) continue;
          const remaining = (line.received_qty || 0) - (line.marked_qty || 0);
          if (remaining <= 0) continue;

          const comps = bomMap[line.finished_sku_id] || [];
          for (const comp of comps) {
            const needed = comp.quantity * remaining;
            const available = invMap[comp.componentSkuId] || 0;
            if (available < needed) {
              const { data: skuInfo } = await supabase.from('sku').select('sku_name').eq('sku_id', line.finished_sku_id).maybeSingle();
              newlyUnavail.push({
                skuName: (skuInfo as any)?.sku_name || line.finished_sku_id,
                reason: comp.componentSkuId.includes('MK') ? '마킹자재 부족' : '유니폼 부족',
                needed,
                available,
              });
              break; // 하나라도 부족하면 작업불가
            }
          }
        }

        if (newlyUnavail.length > 0) {
          setUnavailableAlert(newlyUnavail);
          // 슬랙 작업불가 알림
          notifySlack({
            action: '작업불가알림' as any,
            user: currentUser.name || currentUser.email,
            date: selectedOrder.download_date,
            items: newlyUnavail.map((i) => ({ name: `${i.skuName} (${i.reason})`, qty: i.needed - i.available })),
            message: `초과 마킹으로 ${newlyUnavail.length}종 작업 불가`,
          }).catch(() => {});
        }
      } catch { /* 작업불가 감지 실패해도 마킹 저장은 성공 */ }
    } catch (e: any) {
      setError(`마킹 저장 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  // ── 마킹 실적 삭제 ──

  const prepareDeleteMarking = () => {
    // 현재 이력에서 삭제 미리보기 생성
    setDeletePreview(historyItems.map((h) => ({ lineId: h.lineId, skuName: h.skuName, qty: h.completedQty })));
    setShowDeleteModal(true);
  };

  const handleDeleteMarking = async () => {
    if (!selectedOrder || deletePreview.length === 0) return;
    setDeleting(true);
    setRollbackProgress(null);
    setError(null);
    const totalSteps = 7;
    const onProgress: ProgressCallback = (current, total, step) => {
      setRollbackProgress({ current, total, step });
    };
    try {
      onProgress(1, totalSteps, '창고 정보 조회 중...');
      const { data: pwWarehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      const pwWhId = (pwWarehouse as any)?.id;

      onProgress(2, totalSteps, '마킹 기록 조회 및 삭제 중...');
      for (const item of deletePreview) {
        // 1) daily_marking 해당 날짜 레코드 조회
        const { data: dailyRecord } = await supabase
          .from('daily_marking')
          .select('id, completed_qty')
          .eq('date', selectedDate)
          .eq('work_order_line_id', item.lineId)
          .maybeSingle();
        if (!dailyRecord) continue;

        const qty = (dailyRecord as any).completed_qty;

        // 2) work_order_line.marked_qty 차감
        const { data: lineData } = await supabase
          .from('work_order_line')
          .select('marked_qty, finished_sku_id')
          .eq('id', item.lineId)
          .maybeSingle();
        if (lineData) {
          const newMarkedQty = Math.max(0, ((lineData as any).marked_qty || 0) - qty);
          await supabase
            .from('work_order_line')
            .update({ marked_qty: newMarkedQty })
            .eq('id', item.lineId);
        }

        // 3) BOM 기반: 구성품 재고 복원(+), 완성품 재고 차감(-)
        if (pwWhId && lineData) {
          const finSkuId = (lineData as any).finished_sku_id;
          const components = bomMap[finSkuId] || [];

          // 구성품 재고 복원 (입고)
          for (const comp of components) {
            const deltaQty = comp.quantity * qty;
            const { data: compInv } = await supabase
              .from('inventory')
              .select('quantity')
              .eq('warehouse_id', pwWhId)
              .eq('sku_id', comp.componentSkuId)
              .maybeSingle();
            const newQty = ((compInv as any)?.quantity || 0) + deltaQty;
            await supabase
              .from('inventory')
              .upsert({ warehouse_id: pwWhId, sku_id: comp.componentSkuId, quantity: newQty }, { onConflict: 'warehouse_id,sku_id' });
          }

          // 완성품 재고 차감 (출고)
          const { data: finInv } = await supabase
            .from('inventory')
            .select('quantity')
            .eq('warehouse_id', pwWhId)
            .eq('sku_id', finSkuId)
            .maybeSingle();
          const newFinQty = Math.max(0, ((finInv as any)?.quantity || 0) - qty);
          await supabase
            .from('inventory')
            .upsert({ warehouse_id: pwWhId, sku_id: finSkuId, quantity: newFinQty }, { onConflict: 'warehouse_id,sku_id' });
        }

        // 4) 관련 inventory_transaction 삭제 (구성품 출고 + 완성품 입고)
        if (pwWhId && lineData) {
          const finSkuId = (lineData as any).finished_sku_id;
          // 구성품 차감 트랜잭션 삭제
          await deleteSystemTransactions({
            warehouseId: pwWhId,
            memo: `마킹작업 구성품 차감 (${finSkuId})`,
          });
          // 완성품 증가 트랜잭션 삭제
          await deleteSystemTransactions({
            warehouseId: pwWhId,
            memo: `마킹작업 완성품 증가`,
          });
        }

        // 5) daily_marking 레코드 삭제
        await supabase
          .from('daily_marking')
          .delete()
          .eq('id', (dailyRecord as any).id);
      }

      onProgress(3, totalSteps, 'marked_qty 업데이트 완료');
      onProgress(4, totalSteps, '재고 복원 완료');
      onProgress(5, totalSteps, '트랜잭션 삭제 완료');

      // 6) work_order 상태 체크 (마킹중이었는지)
      onProgress(6, totalSteps, '상태 확인 중...');
      const { data: woCheck } = await supabase
        .from('work_order')
        .select('status')
        .eq('id', selectedOrder.id)
        .maybeSingle();
      if ((woCheck as any)?.status === '마킹중' || (woCheck as any)?.status === '마킹완료') {
        // 다시 마킹 시작 전 상태인지 체크
        const { data: remainingMarkings } = await supabase
          .from('daily_marking')
          .select('id')
          .in('work_order_line_id', allLineIds)
          .limit(1);
        if (!remainingMarkings || remainingMarkings.length === 0) {
          // 마킹 기록이 없으면 입고확인완료로 복원
          await supabase
            .from('work_order')
            .update({ status: '입고확인완료' })
            .eq('id', selectedOrder.id);
        }
      }

      // 7) activity_log: 원본 marking_work 로그 삭제 + 삭제 이력 기록
      onProgress(7, totalSteps, '이력 기록 중...');
      await supabase.from('activity_log').delete()
        .eq('work_order_id', selectedOrder.id)
        .eq('action_type', 'marking_work')
        .eq('action_date', selectedDate);
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'delete_marking',
        work_order_id: selectedOrder.id,
        action_date: today,
        summary: {
          items: deletePreview.map((h) => ({ skuName: h.skuName, completedQty: h.qty })),
          totalQty: deletePreview.reduce((s, h) => s + h.qty, 0),
          workOrderDate: selectedOrder.download_date,
          deletedDate: selectedDate,
        },
      });

      // 8) UI 초기화
      setHistoryItems([]);
      setShowDeleteModal(false);
      setDeletePreview([]);
      loadOrders();
    } catch (e: any) {
      setError(`삭제 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setDeleting(false);
      setRollbackProgress(null);
    }
  };

  // ── 날짜 포맷 ──

  const formatDate = (d: string) => {
    const date = new Date(d + 'T00:00:00');
    const mm = date.getMonth() + 1;
    const dd = date.getDate();
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayName = dayNames[date.getDay()];
    return `${mm}월 ${dd}일 (${dayName})`;
  };

  // ── 로딩 ──

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-gray-900">마킹 작업</h2>
        <TableSkeleton rows={6} />
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-600 font-medium">작업할 마킹 물량이 없습니다</p>
        </div>
      </div>
    );
  }

  // ── 아이템 행 렌더링 ──

  const renderItemRow = (item: MarkingItem) => {
    const isComplete = item.todayQty >= item.remainingQty;
    return (
      <div
        key={item.lineId}
        className={`px-5 py-3.5 flex items-center gap-3 ${isComplete ? 'bg-green-50' : ''}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-900 truncate">{item.skuName}</p>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-blue-600">잔여 {item.remainingQty}개</span>
            {item.isCarryOver && (
              <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded-full">이월</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <input
            type="number"
            min="0"
            max={item.remainingQty}
            value={item.todayQty}
            onChange={(e) => handleQtyChange(item.lineId, Number(e.target.value))}
            className={`w-20 border rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              isComplete ? 'border-green-300 bg-green-50' : 'border-gray-300'
            }`}
          />
          <span className="text-sm text-gray-500">/ {item.remainingQty}개</span>
          {isComplete && <CheckCircle size={16} className="text-green-500" />}
        </div>
      </div>
    );
  };

  // ── 렌더링 ──

  return (
    <div className="space-y-5 max-w-3xl">
      {/* 에러 */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800">{error}</p>
            <button onClick={loadOrders} className="text-xs text-red-600 underline mt-1">
              다시 시도
            </button>
          </div>
        </div>
      )}

      {/* 헤더 */}
      <h2 className="text-xl font-bold text-gray-900">마킹 작업</h2>

      {/* 날짜 네비게이션 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => changeDate(-1)}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold text-gray-900">{formatDate(selectedDate)}</p>
            {isToday ? (
              <span className="text-xs text-blue-600 font-medium">오늘 — 작업 모드</span>
            ) : isTomorrow ? (
              <span className="text-xs text-orange-600 font-medium">내일 — 이월 미리보기 (읽기 전용)</span>
            ) : (
              <span className="text-xs text-gray-400">이력 조회 (읽기 전용)</span>
            )}
          </div>
          <button
            onClick={() => changeDate(1)}
            disabled={isTomorrow}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* ── 내일 이월 미리보기 모드 ── */}
      {isTomorrow && (
        <div className="bg-white rounded-xl shadow-sm border border-orange-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-orange-100 bg-orange-50">
            <div className="flex items-center gap-2">
              <Eye size={16} className="text-orange-600" />
              <h3 className="font-medium text-orange-800">내일 이월 미리보기</h3>
            </div>
            <p className="text-xs text-orange-500 mt-0.5">아직 마킹이 완료되지 않은 항목이 내일 자동으로 표시됩니다</p>
          </div>

          {items.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">
              이월될 작업이 없습니다 — 모든 마킹이 완료되었습니다
            </div>
          ) : (
            <>
              <div className="divide-y divide-gray-50">
                {items.map((item) => (
                  <div key={item.lineId} className="px-5 py-3.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900 truncate">{item.skuName}</p>
                        {item.isCarryOver && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded-full">이월</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-blue-600">잔여 {item.remainingQty}개</span>
                        {item.isCarryOver && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded-full">이월</span>
                        )}
                      </div>
                    </div>
                    <p className="text-sm font-semibold text-orange-700 flex-shrink-0">
                      잔여 {item.remainingQty}개
                    </p>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 bg-orange-50 border-t border-orange-100 flex items-center justify-between">
                <p className="text-sm text-orange-600">이월 예정 총 잔여:</p>
                <p className="text-sm font-bold text-orange-800">
                  {items.reduce((s, i) => s + i.remainingQty, 0)}개 ({items.length}건)
                </p>
              </div>
            </>
          )}

          <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
            <button
              onClick={() => { setSelectedDate(today); setHistoryItems([]); }}
              className="text-sm text-blue-600 font-medium hover:underline"
            >
              오늘 작업으로 돌아가기
            </button>
          </div>
        </div>
      )}

      {/* ── 이력 조회 모드 (과거 날짜) ── */}
      {!isToday && !isTomorrow && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
            <h3 className="font-medium text-gray-700">
              {formatDate(selectedDate)} 작업 이력
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">읽기 전용 — 수정은 오늘 날짜에서만 가능</p>
          </div>

          {historyLoading ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : historyItems.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">
              이 날짜에 기록된 작업이 없습니다
            </div>
          ) : (
            <>
              <div className="divide-y divide-gray-50">
                {historyItems.map((h) => (
                  <div key={h.lineId} className="px-5 py-3.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{h.skuName}</p>
                    </div>
                    <p className="text-sm font-semibold text-gray-700 flex-shrink-0">
                      {h.completedQty}개 완료
                    </p>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <p className="text-sm text-gray-600">이 날 총 완료:</p>
                <p className="text-sm font-bold text-gray-900">
                  {historyItems.reduce((s, h) => s + h.completedQty, 0)}개
                </p>
              </div>
            </>
          )}

          {/* 삭제 버튼 (마킹중 상태일 때만) */}
          {historyItems.length > 0 && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100">
              <button
                onClick={prepareDeleteMarking}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
              >
                <Trash2 size={16} />
                이 날짜 마킹 실적 삭제
              </button>
            </div>
          )}

          <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
            <button
              onClick={() => { setSelectedDate(today); setHistoryItems([]); }}
              className="text-sm text-blue-600 font-medium hover:underline"
            >
              오늘 작업으로 돌아가기
            </button>
          </div>
        </div>
      )}

      {/* 마킹 삭제 확인 모달 */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">마킹 실적 삭제</h3>
              <p className="text-sm text-gray-500 mt-1">이 작업은 되돌릴 수 없습니다</p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="bg-red-50 rounded-lg p-3">
                <p className="text-sm text-red-700 font-medium">삭제 시 다음이 함께 처리됩니다:</p>
                <ul className="text-xs text-red-600 mt-2 space-y-1">
                  <li>• 마킹 완료 수량 차감 (marked_qty 감소)</li>
                  <li>• BOM 구성품 재고 복원 + 완성품 재고 차감</li>
                  <li>• 관련 수불부 트랜잭션 삭제</li>
                  <li>• daily_marking 레코드 삭제</li>
                </ul>
              </div>
              <div className="text-sm text-gray-600">
                <p>삭제 날짜: <span className="font-medium">{formatDate(selectedDate)}</span></p>
                <p>삭제 대상: <span className="font-medium">{deletePreview.length}종 / {deletePreview.reduce((s, h) => s + h.qty, 0)}개</span></p>
              </div>
              <div className="max-h-40 overflow-y-auto bg-gray-50 rounded-lg p-2">
                {deletePreview.map((d, idx) => (
                  <div key={idx} className="flex justify-between text-xs py-1">
                    <span className="text-gray-600 truncate flex-1 mr-2">{d.skuName}</span>
                    <span className="text-red-600 font-medium">{d.qty}개</span>
                  </div>
                ))}
              </div>
            </div>
            {deleting && rollbackProgress && (
              <div className="px-6 py-3">
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-red-700 font-medium text-center">{rollbackProgress.step}</p>
                  <div className="w-full bg-red-200 rounded-full h-2 overflow-hidden">
                    <div className="bg-red-600 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((rollbackProgress.current / rollbackProgress.total) * 100)}%` }} />
                  </div>
                  <p className="text-[10px] text-red-500 text-center">{rollbackProgress.current} / {rollbackProgress.total}</p>
                </div>
              </div>
            )}
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} disabled={deleting} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">취소</button>
              <button onClick={handleDeleteMarking} disabled={deleting} className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50">
                {deleting ? '삭제 중...' : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 과처리 경고 모달 */}
      {showOverprocessWarning && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100 bg-orange-50">
              <div className="flex items-center gap-2">
                <AlertTriangle size={20} className="text-orange-600" />
                <h3 className="text-lg font-bold text-orange-800">과처리 경고</h3>
              </div>
              <p className="text-sm text-orange-600 mt-1">주문 수량보다 많이 마킹됩니다</p>
            </div>
            <div className="px-6 py-4 max-h-60 overflow-y-auto space-y-2">
              {overprocessWarnings.map((w, i) => (
                <div key={i} className="bg-red-50 rounded-lg p-3">
                  <p className="text-sm font-medium text-gray-900 truncate">{w.skuName}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    주문 <span className="font-medium">{w.orderedQty}개</span> → 마킹 완료 <span className="font-bold text-red-600">{w.newMarkedQty}개</span>
                  </p>
                  <p className="text-xs font-medium text-red-600 mt-0.5">
                    과처리 {w.overQty}개
                  </p>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button
                onClick={() => { setShowOverprocessWarning(false); setPendingSaveType(null); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={confirmOverprocessSave}
                className="flex-1 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
              >
                그래도 저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 작업불가 알림 모달 */}
      {unavailableAlert.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100 bg-red-50">
              <div className="flex items-center gap-2">
                <AlertTriangle size={20} className="text-red-600" />
                <h3 className="text-lg font-bold text-red-800">⚠️ 재고 부족 알림</h3>
              </div>
              <p className="text-sm text-red-600 mt-1">초과 마킹으로 아래 품목의 구성품이 부족합니다</p>
            </div>
            <div className="px-6 py-4 max-h-60 overflow-y-auto space-y-2">
              {unavailableAlert.map((item, i) => (
                <div key={i} className="bg-red-50 rounded-lg p-3">
                  <p className="text-sm font-medium text-gray-900">{item.skuName}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    사유: <span className="font-medium text-red-600">{item.reason}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    필요 <span className="font-medium">{item.needed}개</span> / 보유 <span className="font-bold text-red-600">{item.available}개</span>
                    {' '}→ 부족 <span className="font-bold text-red-700">{item.needed - item.available}개</span>
                  </p>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setUnavailableAlert([])}
                className="w-full py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 전체 통합 뷰 아코디언 (오늘이고 orders > 1) ── */}
      {isToday && orders.length > 1 && (
        <div className="bg-white rounded-xl shadow-sm border border-indigo-200 overflow-hidden">
          <button
            onClick={toggleMergedAccordion}
            className={`w-full flex items-center justify-between px-5 py-3.5 transition-colors ${
              mergedExpanded ? 'bg-gradient-to-r from-indigo-50 to-purple-50 border-b border-indigo-100' : 'bg-gradient-to-r from-indigo-50 to-purple-50 hover:from-indigo-100 hover:to-purple-100'
            }`}
          >
            <div className="flex items-center gap-3">
              {mergedExpanded ? <ChevronUp size={18} className="text-indigo-600" /> : <ChevronDown size={18} className="text-indigo-400" />}
              <div className="flex items-center gap-2">
                <Hammer size={18} className="text-indigo-600" />
                <span className="text-sm font-semibold text-indigo-800">전체 작업 물량</span>
                <span className="text-xs text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded">통합</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-indigo-600">작업지시서 {orders.length}건</p>
              <p className="text-sm font-bold text-indigo-900">
                잔여 {orders.reduce((s, wo) => {
                  const cached = woItemsCache[wo.id];
                  if (!cached) return s;
                  return s + cached.items.reduce((ss, i) => ss + i.remainingQty, 0);
                }, 0).toLocaleString() || '—'}개
              </p>
            </div>
          </button>

          {mergedExpanded && (
            <div className="px-5 py-4 space-y-4">
              {mergedLoading ? (
                <TableSkeleton />
              ) : mergedSaved ? (
                <div className="bg-green-50 border border-green-200 rounded-xl p-5">
                  <div className="flex items-center gap-3 mb-2">
                    <CheckCircle size={24} className="text-green-600" />
                    <p className="font-semibold text-green-900">전체 작업이 저장되었습니다</p>
                  </div>
                  <p className="text-sm text-green-700">
                    총 <strong>{mergedTotalToday}개</strong> 완료
                  </p>
                  <button onClick={() => setMergedSaved(false)} className="mt-3 text-sm text-green-700 underline">
                    수량 수정하기
                  </button>
                </div>
              ) : mergedItems.length > 0 ? (
                <>
                  {/* 엑셀 버튼 */}
                  <div className="flex gap-2">
                    <button onClick={handleMergedDownloadTemplate}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors">
                      <Download size={15} /> 양식 다운로드
                    </button>
                    <button onClick={() => mergedFileInputRef.current?.click()}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-blue-300 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors">
                      <FileUp size={15} /> 엑셀 업로드
                    </button>
                    <input ref={mergedFileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleMergedExcelUpload} />
                  </div>

                  {mergedUploadComparison && (
                    <ComparisonPanel rows={mergedUploadComparison.rows} unmatched={mergedUploadComparison.unmatched}
                      onClose={() => setMergedUploadComparison(null)} />
                  )}

                  {/* 수량 요약 */}
                  <div className="bg-white rounded-xl border border-gray-100 px-5 py-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="flex justify-between">
                        <span className="text-orange-600">이월:</span>
                        <span className="font-medium text-orange-700">{mergedCarryOverItems.length}건</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-blue-600">신규:</span>
                        <span className="font-medium text-blue-700">{mergedNewItems.length}건</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">총 잔여:</span>
                        <span className="font-bold text-gray-900">{mergedTotalRemaining}개</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-green-600">오늘 입력:</span>
                        <span className="font-bold text-green-700">{mergedTotalToday}개</span>
                      </div>
                    </div>
                  </div>

                  {/* 작업 목록 */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    {mergedCarryOverItems.length > 0 && (
                      <>
                        <div className="px-5 py-2.5 bg-orange-50 border-b border-orange-100">
                          <span className="text-xs font-semibold text-orange-700">이월 작업건 ({mergedCarryOverItems.length})</span>
                        </div>
                        <div className="divide-y divide-gray-50">
                          {mergedCarryOverItems.map((item) => (
                            <div key={item.finishedSkuId} className={`px-5 py-3.5 flex items-center gap-3 ${item.todayQty >= item.remainingQty ? 'bg-green-50' : ''}`}>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{item.skuName}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  잔여 {item.remainingQty}개 {item.markedQty > 0 && `(누적완료 ${item.markedQty}개)`}
                                </p>
                                {item.sources.length > 1 && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {item.sources.map((src) => (
                                      <span key={src.lineId} className="text-[10px] bg-gray-100 text-gray-500 px-1 rounded">
                                        {src.woDate.slice(5)} ({src.availableQty})
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <input type="number" min="0" max={item.remainingQty} value={item.todayQty}
                                  onChange={(e) => handleMergedQtyChange(item.finishedSkuId, Number(e.target.value))}
                                  className={`w-20 border rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                                    item.todayQty >= item.remainingQty ? 'border-green-300 bg-green-50' : 'border-gray-300'
                                  }`} />
                                <span className="text-sm text-gray-500">/ {item.remainingQty}개</span>
                                {item.todayQty >= item.remainingQty && <CheckCircle size={16} className="text-green-500" />}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {mergedNewItems.length > 0 && (
                      <>
                        <div className="px-5 py-2.5 bg-blue-50 border-b border-blue-100">
                          <span className="text-xs font-semibold text-blue-700">신규 작업건 ({mergedNewItems.length})</span>
                        </div>
                        <div className="divide-y divide-gray-50">
                          {mergedNewItems.map((item) => (
                            <div key={item.finishedSkuId} className={`px-5 py-3.5 flex items-center gap-3 ${item.todayQty >= item.remainingQty ? 'bg-green-50' : ''}`}>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{item.skuName}</p>
                                <p className="text-xs text-gray-400 mt-0.5">잔여 {item.remainingQty}개</p>
                                {item.sources.length > 1 && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {item.sources.map((src) => (
                                      <span key={src.lineId} className="text-[10px] bg-gray-100 text-gray-500 px-1 rounded">
                                        {src.woDate.slice(5)} ({src.availableQty})
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <input type="number" min="0" max={item.remainingQty} value={item.todayQty}
                                  onChange={(e) => handleMergedQtyChange(item.finishedSkuId, Number(e.target.value))}
                                  className={`w-20 border rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                                    item.todayQty >= item.remainingQty ? 'border-green-300 bg-green-50' : 'border-gray-300'
                                  }`} />
                                <span className="text-sm text-gray-500">/ {item.remainingQty}개</span>
                                {item.todayQty >= item.remainingQty && <CheckCircle size={16} className="text-green-500" />}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* 진행 바 */}
                  {mergedSaveProgress && (
                    <div className="space-y-2">
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div className="bg-indigo-600 h-2 rounded-full transition-all"
                          style={{ width: `${(mergedSaveProgress.current / mergedSaveProgress.total) * 100}%` }} />
                      </div>
                      <p className="text-xs text-gray-500 text-center">{mergedSaveProgress.step}</p>
                    </div>
                  )}

                  {/* 저장 버튼 */}
                  <button onClick={checkMergedOverprocess} disabled={mergedSaving || mergedTotalToday === 0}
                    className="w-full py-3.5 rounded-xl text-white font-semibold text-base bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors">
                    {mergedSaving ? '저장 중...' : `전체 작업 완료 저장 (${mergedTotalToday}개)`}
                  </button>
                </>
              ) : (
                <p className="text-sm text-gray-500 text-center py-4">품목을 불러오는 중...</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 날짜별 아코디언 (오늘이고 orders > 1) — 완료된 날짜 제외 ── */}
      {isToday && orders.length > 1 && orders.map((wo) => {
        const isExpanded = expandedWoIds.has(wo.id);
        const isLoadingThis = woLoadingId === wo.id;
        const cached = woItemsCache[wo.id];
        const woRemaining = cached ? cached.items.reduce((s, i) => s + i.remainingQty, 0) : 0;
        const woItemCount = cached ? cached.items.length : 0;

        // 작업 완료된 날짜는 아코디언 제외
        if (cached && woRemaining === 0) return null;

        return (
          <div key={wo.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <button
              onClick={() => toggleAccordion(wo)}
              className={`w-full flex items-center justify-between px-5 py-3.5 transition-colors ${
                isExpanded ? 'bg-blue-50 border-b border-blue-100' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                {isExpanded ? <ChevronUp size={18} className="text-blue-600" /> : <ChevronDown size={18} className="text-gray-400" />}
                <div className="text-left">
                  <p className="text-sm font-semibold text-gray-900">{wo.download_date}</p>
                  {cached && <p className="text-xs text-gray-500 mt-0.5">{woItemCount}종</p>}
                </div>
              </div>
              <div className="text-right">
                {cached ? (
                  <p className="text-sm font-bold text-blue-700">잔여 {woRemaining.toLocaleString()}개</p>
                ) : (
                  <p className="text-xs text-gray-400">클릭하여 조회</p>
                )}
              </div>
            </button>

            {isExpanded && (
              <div className="px-5 py-3 space-y-1">
                {isLoadingThis ? (
                  <TableSkeleton />
                ) : cached ? (
                  <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                    {cached.items.filter((i) => i.remainingQty > 0).map((item) => (
                      <div key={item.lineId} className="flex items-center justify-between py-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-gray-800 truncate">{item.skuName}</span>
                          {item.isCarryOver && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded-full flex-shrink-0">이월</span>
                          )}
                        </div>
                        <span className="text-blue-700 font-medium flex-shrink-0 ml-2">잔여 {item.remainingQty}개</span>
                      </div>
                    ))}
                    {cached.unavailable.length > 0 && (
                      <div className="py-2 text-xs text-yellow-600">
                        ⚠️ 작업불가 {cached.unavailable.length}종 (재고 부족)
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}

      {/* ── 오늘 작업 모드 ── */}
      {isToday && saved ? (
        <div className="bg-green-50 border border-green-200 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle size={24} className="text-green-600" />
            <p className="font-semibold text-green-900">오늘 작업이 저장되었습니다</p>
          </div>
          <p className="text-sm text-green-700">
            총 <strong>{totalToday}개</strong> 완료. 관리자 화면에서 STEP 3 양식을 다운로드하세요.
          </p>
          {!allComplete && (
            <p className="text-sm text-yellow-700 mt-2 flex items-center gap-1">
              <Clock size={14} />
              미완료 수량은 내일 작업 목록에 자동으로 표시됩니다
            </p>
          )}
          <button
            onClick={() => setSaved(false)}
            className="mt-3 text-sm text-green-700 underline"
          >
            수량 수정하기
          </button>
        </div>
      ) : isToday && (
        <>
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
              onClick={handleDownloadAvailable}
              disabled={items.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-green-300 rounded-lg text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
            >
              <Download size={15} />
              작업 가능 양식 다운로드
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
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

          {/* 총 수량 합계 */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-5 py-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <div className="flex gap-1">
                <span className="text-gray-500">총 잔여:</span>
                <span className="font-semibold text-gray-900">{grandTotalRemaining}개</span>
                {unavailableRemaining > 0 && (
                  <span className="text-yellow-600 text-xs">(작업가능 {totalRemaining} + 불가 {unavailableRemaining})</span>
                )}
              </div>
              {carryOverItems.length > 0 && (
                <div className="flex gap-1">
                  <span className="text-orange-600">이월:</span>
                  <span className="font-semibold text-orange-700">{carryOverItems.reduce((s, i) => s + i.remainingQty, 0)}개</span>
                </div>
              )}
              <div className="flex gap-1">
                <span className="text-gray-500">오늘 입력:</span>
                <span className="font-bold text-blue-700">{totalToday}개</span>
              </div>
            </div>
          </div>

          {/* 작업 불가 리스트 — 작업 목록 위에 배치 (기본 접힘) */}
          {unavailableItems.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-4 py-3 bg-yellow-50 border-b border-yellow-200 flex items-center justify-between">
                <button
                  onClick={() => setShowUnavailable(!showUnavailable)}
                  className="flex items-center gap-2 text-sm font-medium text-yellow-800"
                >
                  <AlertTriangle size={14} className="text-yellow-600" />
                  <span>작업 불가 ({unavailableItems.length}종)</span>
                  {showUnavailable ? <ChevronUp size={14} className="text-yellow-500" /> : <ChevronDown size={14} className="text-yellow-500" />}
                </button>
                <button
                  onClick={() => {
                    const wsData = [
                      ['SKU ID', '상품명', '사유', '주문수량', '입고수량', '마킹완료수량'],
                      ...unavailableItems.map((item) => [
                        item.finishedSkuId, item.skuName, item.reason,
                        item.orderedQty, item.receivedQty, item.markedQty,
                      ]),
                    ];
                    const ws = XLSX.utils.aoa_to_sheet(wsData);
                    ws['!cols'] = [{ wch: 22 }, { wch: 40 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, '작업불가목록');
                    XLSX.writeFile(wb, `작업불가목록_${new Date().toISOString().slice(0, 10)}.xlsx`);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-yellow-300 rounded-lg text-yellow-700 hover:bg-yellow-100 transition-colors"
                >
                  <Download size={13} />
                  다운로드
                </button>
              </div>
              {showUnavailable && (
                <div className="divide-y divide-gray-50">
                  {unavailableItems.map((item) => (
                    <div key={item.lineId} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-700 leading-snug">{item.skuName}</p>
                        <p className="text-xs text-gray-400 font-mono mt-0.5">{item.finishedSkuId}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          주문 {item.orderedQty} / 입고 {item.receivedQty} / 마킹완료 {item.markedQty}
                        </p>
                      </div>
                      <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 whitespace-nowrap flex-shrink-0">{item.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 과처리 현황 */}
          {overprocessedItems.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-red-200 overflow-hidden">
              <div className="px-4 py-3 bg-red-50 border-b border-red-200 flex items-center justify-between">
                <button
                  onClick={() => setShowOverprocessed(!showOverprocessed)}
                  className="flex items-center gap-2 text-sm font-medium text-red-800"
                >
                  <AlertTriangle size={14} className="text-red-600" />
                  <span>과처리 현황 ({overprocessedItems.length}종)</span>
                  {showOverprocessed ? <ChevronUp size={14} className="text-red-500" /> : <ChevronDown size={14} className="text-red-500" />}
                </button>
                <span className="text-xs font-medium text-red-600">
                  미해소 {overprocessedItems.reduce((s, i) => s + i.unresolvedQty, 0)}개
                </span>
              </div>
              {showOverprocessed && (
                <div className="divide-y divide-gray-50">
                  {overprocessedItems.map((item) => (
                    <div key={item.finishedSkuId} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-700 leading-snug">{item.skuName}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          주문 {item.orderedQty}개 / 마킹완료 {item.markedQty}개
                        </p>
                        <div className="flex gap-2 mt-1">
                          <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">
                            정상 {item.orderedQty}개
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded-full">
                            과처리 {item.overQty}개
                          </span>
                          {item.resolvedQty > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                              출고해소 {item.resolvedQty}개
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-sm font-bold text-red-600 whitespace-nowrap">
                        미해소 {item.unresolvedQty}개
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 작업 목록 카드 — 통합 리스트 */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            {items.length === 0 ? (
              <div className="px-5 py-8 text-center text-gray-400 text-sm">
                모든 마킹 작업이 완료되었습니다
              </div>
            ) : (
              <div>
                <div className="px-4 py-2.5 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
                  <span className="text-sm font-medium text-blue-800">
                    작업 목록 ({items.length}건)
                    {carryOverItems.length > 0 && (
                      <span className="ml-2 text-orange-600 font-normal">
                        * 이월 {carryOverItems.length}건 포함
                      </span>
                    )}
                  </span>
                </div>
                <div className="divide-y divide-gray-50">
                  {items.map(renderItemRow)}
                </div>
              </div>
            )}

            {items.length > 0 && (
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <p className="text-sm text-gray-600">물류센터 발송 합계:</p>
                <p className="text-sm font-bold text-gray-900">{totalToday}개</p>
              </div>
            )}
          </div>

          {items.length > 0 && (
            <>
              <p className="text-xs text-center text-gray-400">
                미완료 수량은 내일 자동으로 남습니다
              </p>
              {saving && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
                  <p className="text-sm text-blue-700 font-medium text-center">
                    {saveProgress?.step ?? '저장 중...'}
                  </p>
                  {saveProgress && (
                    <>
                      <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${Math.round((saveProgress.current / saveProgress.total) * 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-blue-500 text-center">
                        {saveProgress.current} / {saveProgress.total}
                        ({Math.round((saveProgress.current / saveProgress.total) * 100)}%)
                      </p>
                    </>
                  )}
                </div>
              )}
              <button
                onClick={checkOverprocess}
                disabled={saving || totalToday === 0}
                className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors text-base"
              >
                {saving ? '저장 중...' : '오늘 작업 완료 저장'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
