import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction } from '../../lib/inventoryTransaction';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Download, FileUp, Truck, Info } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
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
  const [uploadComparison, setUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 이력 조회
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [historyItems, setHistoryItems] = useState<{ skuName: string; qty: number }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const isToday = selectedDate === today;

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
        .in('status', ['마킹중', '마킹완료'])
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
      // 1. 작업지시서 라인 조회
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, received_qty, marked_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
        .eq('work_order_id', wo.id);
      if (linesErr) throw linesErr;
      if (isStale()) return;
      const lineList = (lines || []) as any[];

      // 2. daily_marking 합산 (마킹 완성품의 실제 완료 수량)
      const lineIds = lineList.map((l) => l.id);
      let markingTotals: Record<string, number> = {};
      if (lineIds.length > 0) {
        const { data: markings, error: markErr } = await supabase
          .from('daily_marking')
          .select('work_order_line_id, completed_qty')
          .in('work_order_line_id', lineIds);
        if (markErr) throw markErr;
        if (isStale()) return;
        for (const m of (markings || []) as any[]) {
          markingTotals[m.work_order_line_id] =
            (markingTotals[m.work_order_line_id] || 0) + m.completed_qty;
        }
      }

      // 3. 플레이위즈 창고 재고 조회
      const { data: warehouse, error: whErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      if (whErr) throw whErr;
      if (isStale()) return;

      const warehouseId = (warehouse as any)?.id;
      const { data: inventoryData, error: invErr } = await supabase
        .from('inventory')
        .select('sku_id, quantity')
        .eq('warehouse_id', warehouseId);
      if (invErr) throw invErr;
      if (isStale()) return;

      const inventoryMap: Record<string, number> = {};
      for (const inv of (inventoryData || []) as any[]) {
        inventoryMap[inv.sku_id] = inv.quantity;
      }

      // 4. finished_sku_id 수준 집계 (BOM 전개 없음!)
      const itemMap: Record<string, ShipmentOutItem> = {};
      for (const line of lineList) {
        const qty = line.needs_marking
          ? (markingTotals[line.id] || 0)     // 마킹 완성품: daily_marking 합산
          : (line.received_qty || 0);         // 단품: 입고확인 수량 (마킹 불필요)

        if (qty <= 0) continue;

        const key = line.finished_sku_id;
        if (!itemMap[key]) {
          itemMap[key] = {
            finishedSkuId: key,
            skuName: line.finished_sku?.sku_name || key,
            barcode: line.finished_sku?.barcode || null,
            availableQty: 0,
            shipQty: 0,
            inventoryQty: key in inventoryMap ? inventoryMap[key] : null,
            isShortage: false,
            needsMarking: line.needs_marking,
          };
        }
        itemMap[key].availableQty += qty;
      }

      const shipmentItems: ShipmentOutItem[] = Object.values(itemMap).map((item) => ({
        ...item,
        shipQty: item.availableQty,
        isShortage: item.finishedSkuId in inventoryMap
          ? inventoryMap[item.finishedSkuId] < item.availableQty
          : false,
      }));

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
    try {
      const { data } = await supabase
        .from('activity_log')
        .select('summary')
        .eq('user_id', currentUser.id)
        .eq('action_type', 'shipment_out')
        .eq('action_date', date);
      const items = (data || []).flatMap((d: any) =>
        (d.summary?.items || []).map((i: any) => ({ skuName: i.skuName, qty: i.shipQty || 0 }))
      );
      setHistoryItems(items);
    } catch { /* silent */ }
    finally { setHistoryLoading(false); }
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
      const totalSteps = items.length + 2;
      let step = 1;

      // 1. 상태 '출고완료'로 업데이트
      setConfirmProgress({ current: step, total: totalSteps, step: '출고 상태 업데이트 중...' });
      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: '출고완료' })
        .eq('id', selectedWo.id);
      if (statusErr) throw statusErr;
      step++;

      // 2. 플레이위즈 창고 조회
      setConfirmProgress({ current: step, total: totalSteps, step: '창고 정보 조회 중...' });
      const { data: warehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      step++;

      // 3. 플레이위즈 재고 차감 (finished_sku_id 수준)
      if (warehouse) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          setConfirmProgress({
            current: step,
            total: totalSteps,
            step: `재고 차감 중... (${i + 1} / ${items.length})`,
          });

          const { data: inv } = await supabase
            .from('inventory')
            .select('id, quantity')
            .eq('warehouse_id', (warehouse as any).id)
            .eq('sku_id', item.finishedSkuId)
            .maybeSingle();

          if (inv) {
            await supabase
              .from('inventory')
              .update({ quantity: Math.max(0, (inv as any).quantity - item.shipQty) })
              .eq('id', (inv as any).id);
          }
          // 수불부 트랜잭션 기록
          if (item.shipQty > 0) {
            await recordTransaction({
              warehouseId: (warehouse as any).id,
              skuId: item.finishedSkuId,
              txType: '출고',
              quantity: item.shipQty,
              source: 'system',
              memo: `출고확인 (작업지시서 ${selectedWo.download_date})`,
            });
          }
          step++;
        }
      }

      // Activity log
      try {
        await supabase.from('activity_log').insert({
          user_id: currentUser.id,
          action_type: 'shipment_out',
          work_order_id: selectedWo.id,
          action_date: new Date().toISOString().split('T')[0],
          summary: {
            items: items.map((i) => ({ skuId: i.finishedSkuId, skuName: i.skuName, shipQty: i.shipQty })),
            totalQty: items.reduce((s, i) => s + i.shipQty, 0),
            workOrderDate: selectedWo.download_date,
          },
        });
      } catch (logErr) { console.warn('Activity log failed:', logErr); }

      setConfirmed(true);
      loadPendingOrders();
    } catch (e: any) {
      setError(`출고 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setConfirming(false);
      setConfirmProgress(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">불러오는 중...</div>;
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
          <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
            <button onClick={() => { setSelectedDate(today); setHistoryItems([]); }} className="text-sm text-blue-600 font-medium hover:underline">
              오늘 작업으로 돌아가기
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isMarkingDone = selectedWo?.status === '마킹완료';
  const hasShortage = items.some((item) => item.isShortage);
  const markingItems = items.filter((i) => i.needsMarking);
  const directItems = items.filter((i) => !i.needsMarking);
  const totalMarkingQty = markingItems.reduce((s, i) => s + i.shipQty, 0);
  const totalDirectQty = directItems.reduce((s, i) => s + i.shipQty, 0);
  const totalShipQty = totalMarkingQty + totalDirectQty;

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
          <div className="px-5 py-3 bg-emerald-50 border-t border-emerald-100 text-center">
            <button onClick={() => { setSelectedDate(today); setHistoryItems([]); }} className="text-sm text-emerald-600 font-medium hover:underline">
              오늘 작업으로 돌아가기
            </button>
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
          <h3 className="font-medium text-gray-900">CJ 물류센터로 보낼 물량</h3>
          <p className="text-sm text-gray-500 mt-0.5">{selectedWo?.download_date} 기준</p>
        </div>

        {/* 총 수량 합계 */}
        <div className="px-5 py-3 bg-emerald-50/60 border-b border-gray-100 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-purple-700">마킹 완성품 소계</span>
            <span className="font-semibold text-purple-800">{totalMarkingQty}개</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-emerald-700">단품 소계</span>
            <span className="font-semibold text-emerald-800">{totalDirectQty}개</span>
          </div>
          <div className="border-t border-emerald-200 pt-1 mt-1 flex items-center justify-between text-sm">
            <span className="font-bold text-gray-800">총 출고 수량</span>
            <span className="font-bold text-gray-900 text-base">{totalShipQty}개</span>
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
        disabled={confirming || items.length === 0 || !isMarkingDone}
        className="w-full bg-emerald-600 text-white py-3.5 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base"
      >
        <Truck size={20} />
        {confirming ? '처리 중...' : '출고 완료 확인'}
      </button>
      {!isMarkingDone ? (
        <p className="text-xs text-center text-amber-600">
          모든 마킹 작업 완료 후 출고가 가능합니다
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
