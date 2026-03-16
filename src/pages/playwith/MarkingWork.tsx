import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction } from '../../lib/inventoryTransaction';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
import type { AppUser } from '../../types';
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileUp,
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
  isCarryOver: boolean;   // 이월 작업건 여부
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

  const isToday = selectedDate === today;

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
        .select('id, finished_sku_id, ordered_qty, received_qty, marked_qty, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
        .eq('work_order_id', wo.id)
        .eq('needs_marking', true);
      if (linesErr) throw linesErr;
      if (isStale()) return;

      const lineIds = ((lines || []) as any[]).map((l: any) => l.id);
      setAllLineIds(lineIds);

      // BOM 로드 (마킹 시 구성품 재고 변경용)
      const markingSkuIds = ((lines || []) as any[]).map((l: any) => l.finished_sku_id as string);
      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity')
        .in('finished_sku_id', markingSkuIds.length > 0 ? markingSkuIds : ['__none__']);
      if (bomErr) throw bomErr;
      if (isStale()) return;

      const bMap: Record<string, { componentSkuId: string; quantity: number }[]> = {};
      for (const b of (bomData || []) as any[]) {
        if (!bMap[b.finished_sku_id]) bMap[b.finished_sku_id] = [];
        bMap[b.finished_sku_id].push({ componentSkuId: b.component_sku_id, quantity: b.quantity });
      }
      setBomMap(bMap);

      // 전체 daily_marking 조회 (이월 판별용)
      let allMarkings: any[] = [];
      if (lineIds.length > 0) {
        const { data: markings, error: markingErr } = await supabase
          .from('daily_marking')
          .select('work_order_line_id, completed_qty, date')
          .in('work_order_line_id', lineIds);
        if (markingErr) throw markingErr;
        if (isStale()) return;
        allMarkings = (markings || []) as any[];
      }

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

      const markingItems: MarkingItem[] = ((lines || []) as any[])
        .filter((line) => line.received_qty - line.marked_qty > 0)
        .map((line) => ({
          lineId: line.id,
          finishedSkuId: line.finished_sku_id,
          skuName: line.finished_sku?.sku_name || line.finished_sku_id,
          barcode: line.finished_sku?.barcode || null,
          remainingQty: line.received_qty - line.marked_qty,
          todayQty: todayMap[line.id] || 0,
          markedQty: line.marked_qty,
          orderedQty: line.ordered_qty,
          isCarryOver: hasHistory.has(line.id) || (line.marked_qty > 0 && line.marked_qty < line.received_qty),
        }));

      // 정렬: 이월 우선 → 나머지
      markingItems.sort((a, b) => {
        if (a.isCarryOver !== b.isCarryOver) return a.isCarryOver ? -1 : 1;
        return 0;
      });

      setItems(markingItems);
    } catch (e: any) {
      if (!isStale()) setError(`마킹 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  // ── 날짜 이동 ──

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    const newDate = d.toISOString().split('T')[0];
    // 미래 날짜 방지
    if (newDate > today) return;
    setSelectedDate(newDate);
    if (newDate === today) {
      // 오늘로 돌아오면 작업 모드
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
  const todayNewItems = items.filter((i) => !i.isCarryOver);
  const totalRemaining = items.reduce((s, i) => s + i.remainingQty, 0);
  const totalToday = items.reduce((s, i) => s + i.todayQty, 0);
  const allComplete = items.every((item) => item.todayQty >= item.remainingQty);

  // ── 저장 ──

  const handleSave = async () => {
    if (!selectedOrder) return;
    setSaving(true);
    setSaveProgress(null);
    setError(null);
    try {
      const activeItems = items.filter((item) => item.todayQty > 0);
      const total = activeItems.length + 2;
      let processed = 0;

      // 플레이위즈 warehouse ID 조회 (1회)
      const { data: pwWarehouse, error: pwWhErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      if (pwWhErr) throw pwWhErr;
      const pwWhId = (pwWarehouse as any)?.id;

      for (const item of activeItems) {
        processed++;
        setSaveProgress({ current: processed, total, step: `마킹 기록 저장 중... (${processed} / ${activeItems.length})` });

        // daily_marking 기록 (오늘 기존 기록 확인)
        const { data: existing, error: existingErr } = await supabase
          .from('daily_marking')
          .select('id, completed_qty')
          .eq('date', today)
          .eq('work_order_line_id', item.lineId)
          .maybeSingle();
        if (existingErr) throw existingErr;

        const previousQty = existing?.completed_qty || 0;
        const diff = item.todayQty - previousQty;

        if (existing) {
          const { error: updateErr } = await supabase
            .from('daily_marking')
            .update({ completed_qty: item.todayQty, sent_to_cj_qty: item.todayQty })
            .eq('id', existing.id);
          if (updateErr) throw updateErr;
        } else {
          const { error: insertErr } = await supabase.from('daily_marking').insert({
            date: today,
            work_order_line_id: item.lineId,
            completed_qty: item.todayQty,
            sent_to_cj_qty: item.todayQty,
          });
          if (insertErr) throw insertErr;
        }

        // work_order_line marked_qty 업데이트
        const { data: currentLine, error: lineReadErr } = await supabase
          .from('work_order_line')
          .select('marked_qty')
          .eq('id', item.lineId)
          .maybeSingle();
        if (lineReadErr) throw lineReadErr;

        const currentMarkedQty = currentLine?.marked_qty || 0;
        const { error: lineUpdateErr } = await supabase
          .from('work_order_line')
          .update({ marked_qty: currentMarkedQty + diff })
          .eq('id', item.lineId);
        if (lineUpdateErr) throw lineUpdateErr;

        // ── 재고 업데이트: 구성품 감소 + 완성품 증가 ──
        if (diff !== 0 && pwWhId) {
          const components = bomMap[item.finishedSkuId] || [];

          // 구성품(component) 재고 감소
          for (const comp of components) {
            const deltaQty = comp.quantity * diff;
            const { data: compInv } = await supabase
              .from('inventory')
              .select('quantity')
              .eq('warehouse_id', pwWhId)
              .eq('sku_id', comp.componentSkuId)
              .maybeSingle();

            const newCompQty = Math.max(0, ((compInv as any)?.quantity || 0) - deltaQty);
            const { error: compErr } = await supabase
              .from('inventory')
              .upsert(
                { warehouse_id: pwWhId, sku_id: comp.componentSkuId, quantity: newCompQty },
                { onConflict: 'warehouse_id,sku_id' }
              );
            if (compErr) throw compErr;
            // 수불부: 구성품 출고 기록
            if (deltaQty > 0) {
              await recordTransaction({
                warehouseId: pwWhId,
                skuId: comp.componentSkuId,
                txType: '출고',
                quantity: deltaQty,
                source: 'system',
                memo: `마킹작업 구성품 차감 (${item.finishedSkuId})`,
              });
            }
          }

          // 완성품(finished) 재고 증가
          const { data: finInv } = await supabase
            .from('inventory')
            .select('quantity')
            .eq('warehouse_id', pwWhId)
            .eq('sku_id', item.finishedSkuId)
            .maybeSingle();

          const newFinQty = Math.max(0, ((finInv as any)?.quantity || 0) + diff);
          const { error: finErr } = await supabase
            .from('inventory')
            .upsert(
              { warehouse_id: pwWhId, sku_id: item.finishedSkuId, quantity: newFinQty },
              { onConflict: 'warehouse_id,sku_id' }
            );
          if (finErr) throw finErr;
          // 수불부: 완성품 입고 기록
          if (diff > 0) {
            await recordTransaction({
              warehouseId: pwWhId,
              skuId: item.finishedSkuId,
              txType: '입고',
              quantity: diff,
              source: 'system',
              memo: `마킹작업 완성품 증가`,
            });
          }
        }
      }

      // 모두 완료됐으면 상태 업데이트
      setSaveProgress({ current: total, total, step: '완료 상태 업데이트 중...' });
      const { data: allLines, error: allLinesErr } = await supabase
        .from('work_order_line')
        .select('received_qty, marked_qty, needs_marking')
        .eq('work_order_id', selectedOrder.id);
      if (allLinesErr) throw allLinesErr;

      // 마킹 필요 라인만 체크 (단품은 마킹 불필요)
      const allDone = ((allLines || []) as any[])
        .filter((l) => l.needs_marking)
        .every((l) => l.marked_qty >= l.received_qty);

      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: allDone ? '마킹완료' : '마킹중' })
        .eq('id', selectedOrder.id);
      if (statusErr) throw statusErr;

      // Activity log
      try {
        const logItems = activeItems.map((item) => ({
          skuId: item.finishedSkuId, skuName: item.skuName, completedQty: item.todayQty,
        }));
        await supabase.from('activity_log').insert({
          user_id: currentUser.id,
          action_type: 'marking_work',
          work_order_id: selectedOrder.id,
          action_date: today,
          summary: {
            items: logItems,
            totalQty: logItems.reduce((s, i) => s + i.completedQty, 0),
            workOrderDate: selectedOrder.download_date,
          },
        });
      } catch (logErr) { console.warn('Activity log failed:', logErr); }

      // DB 재조회로 완료 아이템 자동 제거 + 잔여 수량 갱신
      await selectOrder(selectedOrder);
      setSaved(true); // selectOrder 내부에서 setSaved(false) 호출되므로 다시 설정
    } catch (e: any) {
      setError(`마킹 저장 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setSaving(false);
      setSaveProgress(null);
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
    return <div className="flex items-center justify-center h-64 text-gray-400">불러오는 중...</div>;
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
          <p className="text-xs text-gray-400 mt-0.5">
            잔여 {item.remainingQty}개
            {item.markedQty > 0 && ` (누적완료 ${item.markedQty}개)`}
          </p>
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
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">마킹 작업</h2>
        {orders.length > 1 && (
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedOrder?.id}
            onChange={(e) => {
              const wo = orders.find((w) => w.id === e.target.value);
              if (wo) selectOrder(wo);
            }}
          >
            {orders.map((wo) => (
              <option key={wo.id} value={wo.id}>
                {wo.download_date}
              </option>
            ))}
          </select>
        )}
      </div>

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
            ) : (
              <span className="text-xs text-gray-400">이력 조회 (읽기 전용)</span>
            )}
          </div>
          <button
            onClick={() => changeDate(1)}
            disabled={isToday}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* ── 이력 조회 모드 (과거 날짜) ── */}
      {!isToday && (
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
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex justify-between">
                <span className="text-orange-600">이월:</span>
                <span className="font-semibold text-gray-900">{carryOverItems.length}건 {carryOverItems.reduce((s, i) => s + i.remainingQty, 0)}개</span>
              </div>
              <div className="flex justify-between">
                <span className="text-blue-600">신규:</span>
                <span className="font-semibold text-gray-900">{todayNewItems.length}건 {todayNewItems.reduce((s, i) => s + i.remainingQty, 0)}개</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">총 잔여:</span>
                <span className="font-semibold text-gray-900">{totalRemaining}개</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">오늘 입력:</span>
                <span className="font-bold text-blue-700">{totalToday}개</span>
              </div>
            </div>
          </div>

          {/* 작업 목록 카드 */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            {items.length === 0 ? (
              <div className="px-5 py-8 text-center text-gray-400 text-sm">
                모든 마킹 작업이 완료되었습니다
              </div>
            ) : (
              <>
                {/* 이월 작업건 (상단, 주황 배경) */}
                {carryOverItems.length > 0 && (
                  <div>
                    <div className="px-4 py-2.5 bg-orange-50 border-b border-orange-200 flex items-center gap-2">
                      <AlertTriangle size={14} className="text-orange-600" />
                      <span className="text-sm font-medium text-orange-800">
                        이월 작업 ({carryOverItems.length}건) — 우선 처리
                      </span>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {carryOverItems.map(renderItemRow)}
                    </div>
                  </div>
                )}

                {/* 오늘 신규 작업건 */}
                {todayNewItems.length > 0 && (
                  <div>
                    <div className="px-4 py-2.5 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
                      <span className="text-sm font-medium text-blue-800">
                        {carryOverItems.length > 0 ? '오늘 작업' : '작업 목록'} ({todayNewItems.length}건)
                      </span>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {todayNewItems.map(renderItemRow)}
                    </div>
                  </div>
                )}
              </>
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
                onClick={handleSave}
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
