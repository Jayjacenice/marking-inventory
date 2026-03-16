import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction } from '../../lib/inventoryTransaction';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Download, Edit3, FileUp, Truck, XCircle } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
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

  useEffect(() => {
    loadPendingOrders();
  }, []);

  const loadPendingOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      // 이관준비 (발송 대기)
      const { data: pending, error: pendErr } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .eq('status', '이관준비')
        .order('uploaded_at', { ascending: false });
      if (pendErr) throw pendErr;
      if (isStale()) return;

      // 이관중 / 취소요청 / 수정요청 (최근 발송 완료 건)
      const { data: recent, error: recentErr } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .in('status', ['이관중', '취소요청', '수정요청'])
        .order('uploaded_at', { ascending: false });
      if (recentErr) throw recentErr;
      if (isStale()) return;

      const orders = (pending || []) as ActiveWorkOrder[];
      setWorkOrders(orders);
      setRecentShipped((recent || []) as ActiveWorkOrder[]);

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
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
        .eq('work_order_id', wo.id);
      if (linesErr) throw linesErr;
      if (isStale()) return;

      const { data: warehouses, error: warehouseErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .maybeSingle();
      if (warehouseErr) throw warehouseErr;
      if (isStale()) return;

      const offlineWarehouseId = (warehouses as any)?.id;

      const markingSkuIds = ((lines || []) as any[])
        .filter((l) => l.needs_marking)
        .map((l) => l.finished_sku_id as string);
      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name, barcode)')
        .in('finished_sku_id', markingSkuIds.length > 0 ? markingSkuIds : ['__none__']);
      if (bomErr) throw bomErr;
      if (isStale()) return;

      const { data: inventoryData, error: invErr } = await supabase
        .from('inventory')
        .select('sku_id, quantity')
        .eq('warehouse_id', offlineWarehouseId);
      if (invErr) throw invErr;
      if (isStale()) return;

      const inventoryMap: Record<string, number> = {};
      for (const inv of (inventoryData || []) as any[]) {
        inventoryMap[inv.sku_id] = inv.quantity;
      }

      const componentMap: Record<
        string,
        { lineId: string; skuId: string; skuName: string; barcode: string | null; needed: number; isMarking: boolean }
      > = {};

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
            componentMap[key].needed += bom.quantity * line.ordered_qty;
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
              isMarking: false,
            };
          }
          componentMap[key].needed += line.ordered_qty;
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
    try {
      const { data } = await supabase
        .from('activity_log')
        .select('summary')
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

      setConfirmProgress({ current: 1, total: 4, step: '발송 상태 업데이트 중...' });
      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: '이관중' })
        .eq('id', selectedWo.id);
      if (statusErr) throw statusErr;

      setConfirmProgress({ current: 2, total: 4, step: '데이터 조회 중...' });
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, needs_marking')
        .eq('work_order_id', selectedWo.id);
      if (linesErr) throw linesErr;

      const lineList = (lines || []) as any[];
      const confirmMarkingSkuIds = lineList
        .filter((l) => l.needs_marking)
        .map((l) => l.finished_sku_id as string);
      const { error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity')
        .in('finished_sku_id', confirmMarkingSkuIds.length > 0 ? confirmMarkingSkuIds : ['__none__']);
      if (bomErr) throw bomErr;
      const totalSteps = lineList.length + finalItems.length + 2;
      let step = 3;

      for (let i = 0; i < lineList.length; i++) {
        const line = lineList[i];
        setConfirmProgress({ current: step, total: totalSteps, step: `라인 처리 중... (${i + 1} / ${lineList.length})` });
        const lineSentQty = line.needs_marking
          ? line.ordered_qty
          : (sentMap[line.finished_sku_id] ?? line.ordered_qty);
        await supabase
          .from('work_order_line')
          .update({ sent_qty: lineSentQty })
          .eq('id', line.id);
        step++;
      }

      const { data: warehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .maybeSingle();

      if (warehouse) {
        for (let i = 0; i < finalItems.length; i++) {
          const item = finalItems[i];
          setConfirmProgress({ current: step, total: totalSteps, step: `재고 차감 중... (${i + 1} / ${finalItems.length})` });
          if (item.sentQty > 0) {
            const { data: inv } = await supabase
              .from('inventory')
              .select('id, quantity')
              .eq('warehouse_id', (warehouse as any).id)
              .eq('sku_id', item.skuId)
              .maybeSingle();
            if (inv) {
              await supabase
                .from('inventory')
                .update({ quantity: Math.max(0, (inv as any).quantity - item.sentQty) })
                .eq('id', (inv as any).id);
            }
            // 수불부 트랜잭션 기록
            await recordTransaction({
              warehouseId: (warehouse as any).id,
              skuId: item.skuId,
              txType: '출고',
              quantity: item.sentQty,
              source: 'system',
              memo: `발송확인 (작업지시서 ${selectedWo.download_date})`,
            });
          }
          step++;
        }
      }

      // Activity log
      try {
        await supabase.from('activity_log').insert({
          user_id: currentUser.id,
          action_type: 'shipment_confirm',
          work_order_id: selectedWo.id,
          action_date: new Date().toISOString().split('T')[0],
          summary: {
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
    return <div className="flex items-center justify-center h-64 text-gray-400">불러오는 중...</div>;
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
                <p className="text-sm font-medium text-gray-900 truncate flex-1">{h.skuName}</p>
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
      <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
        <button onClick={() => { setSelectedDate(today); setHistoryItems([]); }} className="text-sm text-blue-600 font-medium hover:underline">
          오늘 작업으로 돌아가기
        </button>
      </div>
    </div>
  );

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
      <div className="space-y-5 max-w-lg">
        <DateNav />
        <HistoryPanel />
      </div>
    );
  }

  // ── 발송 대기 없음 + 오늘 ──
  if (noWorkToday && isToday) {
    return (
      <div className="space-y-5 max-w-lg">
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
                    <p className="text-xs font-medium text-gray-800 flex-1 truncate">{item.skuName}</p>
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

      <DateNav />

      {/* 헤더 */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-gray-900">발송 확인</h2>
        {workOrders.length > 1 && (
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedWo?.id}
            onChange={(e) => {
              const wo = workOrders.find((w) => w.id === e.target.value);
              if (wo) selectOrder(wo);
            }}
          >
            {workOrders.map((wo) => (
              <option key={wo.id} value={wo.id}>
                {wo.download_date}
              </option>
            ))}
          </select>
        )}
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

      {/* 품목 카드 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
          <div>
            <h3 className="font-medium text-gray-900">제작센터(플레이위즈)로 보낼 물량</h3>
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
                    <p className="text-xs font-medium text-gray-800 leading-tight truncate">{item.skuName}</p>
                    <p className="text-[10px] text-gray-400 font-mono mt-0.5 truncate">{item.skuId}</p>
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
                    <p className="text-xs font-medium text-gray-800 leading-tight truncate">{item.skuName}</p>
                    <p className="text-[10px] text-gray-400 font-mono mt-0.5 truncate">{item.skuId}</p>
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
                  <p className="text-xs font-medium text-gray-800 flex-1 truncate">{item.skuName}</p>
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
