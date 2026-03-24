import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction, deleteSystemTransactions } from '../../lib/inventoryTransaction';
import { type ProgressCallback } from '../../lib/workOrderRollback';
import { notifySlack } from '../../lib/slackNotify';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Download, FileUp, Trash2 } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';
import ComparisonPanel, { type ComparisonRow } from '../../components/ComparisonPanel';
import type { AppUser } from '../../types';
import { TwoColumnSkeleton } from '../../components/LoadingSkeleton';

interface ReceiptItem {
  skuId: string;
  skuName: string;
  barcode: string | null;
  expectedQty: number;
  actualQty: number;
  isMarking: boolean;
}

interface PendingOrder {
  id: string;
  download_date: string;
  status: string;
  pendingWaveCount: number;
}

export default function ReceiptCheck({ currentUser }: { currentUser: AppUser }) {
  const isStale = useStaleGuard();
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<PendingOrder | null>(null);
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadComparison, setUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 차수 관련 상태
  const [currentWaveNum, setCurrentWaveNum] = useState<number>(1);
  const [pendingWaveCount, setPendingWaveCount] = useState<number>(0);

  // 이력 조회
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [historyItems, setHistoryItems] = useState<{ skuName: string; qty: number }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const isToday = selectedDate === today;

  // 이력 삭제
  const [historyWorkOrder, setHistoryWorkOrder] = useState<{ id: string; date: string; status: string; markingStarted: boolean } | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rollbackProgress, setRollbackProgress] = useState<{current:number;total:number;step:string}|null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      // 미입고 차수가 있을 수 있는 모든 상태의 WO 조회
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .in('status', ['이관중', '입고확인완료', '마킹중', '마킹완료'])
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      if (isStale()) return;

      const woIds = (data || []).map((w: any) => w.id);
      if (woIds.length === 0) {
        setOrders([]);
        setLoading(false);
        return;
      }

      // 모든 발송/입고 activity_log 한번에 조회
      const [allShipRes, allRecRes] = await Promise.all([
        supabase.from('activity_log').select('work_order_id, summary').in('work_order_id', woIds).eq('action_type', 'shipment_confirm'),
        supabase.from('activity_log').select('work_order_id, summary').in('work_order_id', woIds).eq('action_type', 'receipt_check'),
      ]);
      if (isStale()) return;

      // WO별 미입고 차수 계산
      const pendingList: PendingOrder[] = (data || []).filter((wo: any) => {
        const ships = (allShipRes.data || []).filter((s: any) => s.work_order_id === wo.id);
        const recs = (allRecRes.data || []).filter((r: any) => r.work_order_id === wo.id);
        if (ships.length === 0) return false; // 발송 없음 -> 표시 안함
        const recWaves = new Set(recs.map((r: any) => r.summary?.wave ?? 1));
        return ships.some((s: any) => !recWaves.has(s.summary?.wave ?? 1));
      }).map((wo: any) => {
        const ships = (allShipRes.data || []).filter((s: any) => s.work_order_id === wo.id);
        const recs = (allRecRes.data || []).filter((r: any) => r.work_order_id === wo.id);
        const recWaves = new Set(recs.map((r: any) => r.summary?.wave ?? 1));
        const pendingCount = ships.filter((s: any) => !recWaves.has(s.summary?.wave ?? 1)).length;
        return {
          id: wo.id,
          download_date: wo.download_date,
          status: wo.status,
          pendingWaveCount: pendingCount,
        };
      });

      setOrders(pendingList);
      if (pendingList.length > 0) selectOrder(pendingList[0]);
      else setLoading(false);
    } catch (e: any) {
      if (!isStale()) setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
      setLoading(false);
    }
  };

  const selectOrder = async (wo: PendingOrder) => {
    setSelectedOrder(wo);
    setLoading(true);
    setDone(false);
    setError(null);
    setUploadComparison(null);
    setXlsxError(null);
    try {
      // 1. 발송 차수 조회 (shipment_confirm)
      const { data: shipmentLogs } = await supabase
        .from('activity_log')
        .select('id, summary, created_at')
        .eq('work_order_id', wo.id)
        .eq('action_type', 'shipment_confirm')
        .order('created_at', { ascending: true });

      // 2. 입고 차수 조회 (receipt_check)
      const { data: receiptLogs } = await supabase
        .from('activity_log')
        .select('id, summary')
        .eq('work_order_id', wo.id)
        .eq('action_type', 'receipt_check');

      if (isStale()) return;

      // 3. 미입고 차수 계산
      const confirmedWaves = new Set((receiptLogs || []).map((r: any) => r.summary?.wave ?? 1));
      const pendingWaves = (shipmentLogs || []).filter((s: any) => !confirmedWaves.has(s.summary?.wave ?? 1));

      setPendingWaveCount(pendingWaves.length);

      if (pendingWaves.length === 0) {
        // 미입고 차수 없음 -> 이미 모두 입고 완료
        setItems([]);
        setCurrentWaveNum(0);
        setLoading(false);
        return;
      }

      // 가장 오래된 미입고 차수
      const currentWave = pendingWaves[0];
      const waveNum = currentWave.summary?.wave ?? 1;
      setCurrentWaveNum(waveNum);

      const waveItems: { skuId: string; skuName: string; sentQty: number }[] = currentWave.summary?.items || [];

      if (waveItems.length === 0) {
        setItems([]);
        setLoading(false);
        return;
      }

      // barcode 조회를 위해 SKU 테이블에서 가져오기
      const skuIds = waveItems.map((i) => i.skuId);
      const { data: skuData } = await supabase
        .from('sku')
        .select('sku_id, barcode')
        .in('sku_id', skuIds);
      if (isStale()) return;

      const barcodeMap: Record<string, string | null> = {};
      for (const s of (skuData || []) as any[]) {
        barcodeMap[s.sku_id] = s.barcode || null;
      }

      // waveItems가 곧 expectedQty (발송 시 이미 단품으로 전개됨)
      setItems(waveItems.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        barcode: barcodeMap[item.skuId] || null,
        expectedQty: item.sentQty,
        actualQty: item.sentQty,
        isMarking: item.skuId?.includes('MK') || item.skuName?.includes('마킹') || false,
      })));
    } catch (e: any) {
      if (!isStale()) setError(`입고 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
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
        .eq('action_type', 'receipt_check')
        .eq('action_date', date);
      const items = (data || []).flatMap((d: any) =>
        (d.summary?.items || []).map((i: any) => ({ skuName: i.skuName, qty: i.actualQty || 0 }))
      );
      setHistoryItems(items);

      // work_order 상태 + 마킹 시작 여부 조회
      const woId = (data || [])[0]?.work_order_id;
      if (woId) {
        const { data: wo } = await supabase
          .from('work_order')
          .select('id, download_date, status')
          .eq('id', woId)
          .maybeSingle();
        if (wo) {
          // 마킹 시작 여부: daily_marking 레코드 존재 확인
          const { data: woLines } = await supabase
            .from('work_order_line')
            .select('id')
            .eq('work_order_id', (wo as any).id);
          const lineIds = ((woLines || []) as any[]).map((l) => l.id);
          let markingStarted = false;
          if (lineIds.length > 0) {
            const { count } = await supabase
              .from('daily_marking')
              .select('*', { count: 'exact', head: true })
              .in('work_order_line_id', lineIds);
            markingStarted = (count || 0) > 0;
          }
          setHistoryWorkOrder({ id: (wo as any).id, date: (wo as any).download_date, status: (wo as any).status, markingStarted });
        }
      }
    } catch { /* silent */ }
    finally { setHistoryLoading(false); }
  };

  // ── 입고 실적 삭제 ──
  const handleDeleteReceipt = async () => {
    if (!historyWorkOrder) return;
    setDeleting(true);
    setError(null);
    setRollbackProgress(null);
    const onProgress: ProgressCallback = (current, total, step) => {
      setRollbackProgress({ current, total, step });
    };
    try {
      // 1) work_order_line.received_qty → 0 초기화
      onProgress(1, 5, 'received_qty 초기화 중...');
      const { data: lines } = await supabase
        .from('work_order_line')
        .select('id')
        .eq('work_order_id', historyWorkOrder.id);
      for (const line of (lines || []) as any[]) {
        await supabase
          .from('work_order_line')
          .update({ received_qty: 0 })
          .eq('id', line.id);
      }

      // 2) work_order.status → '이관중' 복원
      onProgress(2, 5, '상태 복원 중...');
      await supabase
        .from('work_order')
        .update({ status: '이관중' })
        .eq('id', historyWorkOrder.id);

      // 3) inventory_transaction 삭제 + inventory 역반영
      onProgress(3, 5, '재고 트랜잭션 삭제 중...');
      const { data: warehouse } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      if (warehouse) {
        await deleteSystemTransactions({
          warehouseId: (warehouse as any).id,
          memo: `입고확인 (작업지시서 ${historyWorkOrder.date})`,
        });
      }

      // 4) activity_log에 삭제 이력 기록
      onProgress(4, 5, '삭제 이력 기록 중...');
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'delete_receipt',
        work_order_id: historyWorkOrder.id,
        action_date: today,
        summary: {
          items: historyItems.map((h) => ({ skuName: h.skuName, actualQty: h.qty })),
          totalQty: historyItems.reduce((s, h) => s + h.qty, 0),
          workOrderDate: historyWorkOrder.date,
          deletedDate: selectedDate,
        },
      });

      // 5) UI 초기화
      onProgress(5, 5, '완료!');
      setHistoryItems([]);
      setHistoryWorkOrder(null);
      setShowDeleteModal(false);
      loadOrders();
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

  const handleActualChange = (skuId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.skuId !== skuId) return item;
        return { ...item, actualQty: Math.max(0, value) };
      })
    );
  };

  // ── 엑셀 양식 다운로드 ─────────────────────────
  const handleDownloadTemplate = () => {
    generateTemplate(
      items.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        barcode: item.barcode,
        qty: item.actualQty,
      })),
      `입고수량_${selectedOrder?.download_date || '양식'}_${currentWaveNum}차.xlsx`
    );
  };

  // ── 엑셀 업로드 → actualQty 적용 + 비교 패널 ──
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

      // actualQty 일괄 업데이트
      const matchMap = new Map(result.matched.map((m) => [m.skuId, m.uploadedQty]));
      setItems((prev) =>
        prev.map((item) =>
          matchMap.has(item.skuId) ? { ...item, actualQty: matchMap.get(item.skuId)! } : item
        )
      );

      // 비교 데이터 구성
      const rows: ComparisonRow[] = result.matched.map((m) => {
        const item = items.find((i) => i.skuId === m.skuId);
        return {
          skuId: m.skuId,
          skuName: item?.skuName || m.skuId,
          expected: item?.expectedQty ?? 0,
          uploaded: m.uploadedQty,
          diff: m.uploadedQty - (item?.expectedQty ?? 0),
        };
      });
      setUploadComparison({ rows, unmatched: result.unmatched });
    } catch (err: any) {
      setXlsxError(err.message || '파일 처리 실패');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleConfirm = async () => {
    if (!selectedOrder) return;
    setSaving(true);
    setSaveProgress(null);
    setError(null);
    try {
      setSaveProgress({ current: 1, total: 5, step: '데이터 조회 중...' });

      // work_order_line 조회 (received_qty 포함)
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, sent_qty, received_qty, needs_marking')
        .eq('work_order_id', selectedOrder.id);
      if (linesErr) throw linesErr;

      const lineList = (lines || []) as any[];
      const actualMap: Record<string, number> = {};
      for (const item of items) actualMap[item.skuId] = item.actualQty;

      // BOM 조회 (needs_marking=true 라인의 역산용)
      const markingSkuIds = lineList
        .filter((l) => l.needs_marking)
        .map((l) => l.finished_sku_id as string);
      let bomData: any[] = [];
      if (markingSkuIds.length > 0) {
        const { data: bomResult } = await supabase
          .from('bom')
          .select('finished_sku_id, component_sku_id, quantity')
          .in('finished_sku_id', markingSkuIds);
        bomData = bomResult || [];
      }

      const BATCH = 10;
      const lineBatches = Math.ceil(lineList.length / BATCH);
      const activeItems = items.filter((i) => i.actualQty > 0);
      const itemBatches = Math.ceil(activeItems.length / BATCH);
      const stepsTotal = lineBatches + itemBatches + 4;
      let progressStep = 1;

      // ── received_qty 업데이트 (차수별 누적, consume 패턴) ──
      // 같은 구성품을 여러 finished_sku가 공유할 때 중복 할당 방지
      const consumeMap: Record<string, number> = {};
      for (const item of items) {
        consumeMap[item.skuId] = (consumeMap[item.skuId] || 0) + item.actualQty;
      }

      // 라인별 thisWaveQty를 미리 계산 (consumeMap에서 순차 차감)
      const lineWaveQtyMap: Record<string, number> = {};
      for (const line of lineList) {
        let thisWaveQty: number;
        if (line.needs_marking) {
          const boms = bomData.filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          const uniformComp = boms.find((b: any) => !b.component_sku_id?.includes('MK'));
          const comp = uniformComp || boms[0];
          if (comp) {
            const available = consumeMap[comp.component_sku_id] || 0;
            const maxFromComp = Math.floor(available / (comp.quantity || 1));
            const remaining = Math.max(0, (line.ordered_qty || 0) - (line.received_qty || 0));
            thisWaveQty = Math.min(maxFromComp, remaining);
            // 소비: 사용한 만큼 차감
            for (const b of boms) {
              consumeMap[b.component_sku_id] = Math.max(0, (consumeMap[b.component_sku_id] || 0) - thisWaveQty * (b.quantity || 1));
            }
          } else {
            thisWaveQty = 0;
          }
        } else {
          thisWaveQty = consumeMap[line.finished_sku_id] ?? 0;
          consumeMap[line.finished_sku_id] = Math.max(0, (consumeMap[line.finished_sku_id] || 0) - thisWaveQty);
        }
        lineWaveQtyMap[line.id] = thisWaveQty;
      }

      setSaveProgress({ current: 2, total: stepsTotal, step: '입고 수량 처리 중...' });
      for (let i = 0; i < lineList.length; i += BATCH) {
        const batch = lineList.slice(i, i + BATCH);
        progressStep++;
        setSaveProgress({ current: progressStep, total: stepsTotal, step: `입고 수량 처리 중... (${Math.min(i + BATCH, lineList.length)} / ${lineList.length})` });
        await Promise.all(batch.map((line: any) => {
          const thisWaveQty = lineWaveQtyMap[line.id] || 0;
          const newReceivedQty = (line.received_qty || 0) + thisWaveQty;
          return supabase.from('work_order_line').update({ received_qty: newReceivedQty }).eq('id', line.id);
        }));
      }

      // ── 플레이위즈 재고 증가 (배치 병렬) ──
      progressStep++;
      setSaveProgress({ current: progressStep, total: stepsTotal, step: '플레이위즈 창고 조회 중...' });
      const { data: pwWarehouse, error: pwWhErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '플레이위즈')
        .maybeSingle();
      if (pwWhErr) throw pwWhErr;

      if (pwWarehouse) {
        const pwWhId = (pwWarehouse as any).id;
        for (let i = 0; i < activeItems.length; i += BATCH) {
          const batch = activeItems.slice(i, i + BATCH);
          progressStep++;
          setSaveProgress({ current: progressStep, total: stepsTotal, step: `재고 반영 중... (${Math.min(i + BATCH, activeItems.length)} / ${activeItems.length})` });
          await Promise.all(batch.map(async (item) => {
            const { data: existing } = await supabase
              .from('inventory')
              .select('quantity')
              .eq('warehouse_id', pwWhId)
              .eq('sku_id', item.skuId)
              .maybeSingle();
            const newQty = ((existing as any)?.quantity || 0) + item.actualQty;
            await supabase.from('inventory').upsert(
              { warehouse_id: pwWhId, sku_id: item.skuId, quantity: newQty },
              { onConflict: 'warehouse_id,sku_id' }
            );
            await recordTransaction({
              warehouseId: pwWhId,
              skuId: item.skuId,
              txType: '입고',
              quantity: item.actualQty,
              source: 'system',
              memo: `입고확인 ${currentWaveNum}차 (작업지시서 ${selectedOrder.download_date})`,
            });
          }));
        }
      }

      // ── 상태 전이: 미입고 차수 남았으면 유지, 모두 완료면 입고확인완료 ──
      progressStep++;
      setSaveProgress({ current: progressStep, total: stepsTotal, step: '상태 업데이트 중...' });

      // 이번 차수 입고 후 남은 미입고 차수 확인
      const remainingPendingAfterThis = pendingWaveCount - 1;
      if (remainingPendingAfterThis <= 0) {
        // 모든 차수 입고 완료
        const { error: statusErr } = await supabase
          .from('work_order')
          .update({ status: '입고확인완료' })
          .eq('id', selectedOrder.id);
        if (statusErr) throw statusErr;
      }
      // 미입고 차수가 남아있으면 상태 변경 안함 (이관중 유지)

      // Activity log (wave 번호 포함)
      try {
        await supabase.from('activity_log').insert({
          user_id: currentUser.id,
          action_type: 'receipt_check',
          work_order_id: selectedOrder.id,
          action_date: new Date().toISOString().split('T')[0],
          summary: {
            wave: currentWaveNum,
            items: items.map((i) => ({ skuId: i.skuId, skuName: i.skuName, actualQty: i.actualQty })),
            totalQty: items.reduce((s, i) => s + i.actualQty, 0),
            workOrderDate: selectedOrder.download_date,
          },
        });
      } catch (logErr) { console.warn('Activity log failed:', logErr); }

      setDone(true);
      loadOrders();

      // 슬랙 알림
      notifySlack({
        action: '입고확인',
        user: currentUser.name || currentUser.email,
        date: selectedOrder.download_date,
        items: items.filter((i) => i.actualQty > 0).map((i) => ({ name: i.skuName, qty: i.actualQty })),
      }).catch(() => {});

      // 온라인 주문 상태 업데이트: 이관중 → 마킹중 (FIFO)
      import('../../lib/onlineOrderSync').then(({ updateOnlineOrderBySkus }) => {
        const skuIds = items.filter((i) => i.actualQty > 0).map((i) => i.skuId);
        updateOnlineOrderBySkus(skuIds, '마킹중', '이관중').catch(() => {});
      });
    } catch (e: any) {
      setError(`입고 확인 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-gray-900">입고 확인</h2>
        <TwoColumnSkeleton />
      </div>
    );
  }

  const noWorkToday = (orders.length === 0 && !done) || done;

  if (noWorkToday && isToday) {
    return (
      <div className="space-y-5 max-w-3xl">
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
            {done ? (
              <>
                <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
                <p className="text-gray-700 font-semibold text-lg">입고 확인 완료!</p>
                <p className="text-sm text-gray-400 mt-1">마킹 작업 페이지에서 작업을 진행해주세요</p>
              </>
            ) : (
              <>
                <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
                <p className="text-gray-600 font-medium">입고 확인 대기 중인 물량이 없습니다</p>
                <p className="text-sm text-gray-400 mt-1">오프라인 매장에서 발송 완료 처리 후 나타납니다</p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (noWorkToday && !isToday) {
    return (
      <div className="space-y-5 max-w-3xl">
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
            <h3 className="font-medium text-gray-700">{formatDate(selectedDate)} 입고 이력</h3>
            <p className="text-xs text-gray-400 mt-0.5">읽기 전용</p>
          </div>
          {historyLoading ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : historyItems.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">이 날짜에 기록된 입고가 없습니다</div>
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
                <p className="text-sm text-gray-600">총 입고:</p>
                <p className="text-sm font-bold text-gray-900">{historyItems.reduce((s, h) => s + h.qty, 0)}개</p>
              </div>
            </>
          )}
          {/* 삭제 버튼 */}
          {historyItems.length > 0 && historyWorkOrder && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100">
              {historyWorkOrder.status === '입고확인완료' && !historyWorkOrder.markingStarted ? (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
                >
                  <Trash2 size={16} />
                  입고 실적 삭제
                </button>
              ) : (
                <p className="text-xs text-red-400 text-center">
                  {historyWorkOrder.markingStarted ? '마킹 진행중 — 삭제 불가' : `현재 상태: ${historyWorkOrder.status} — 삭제 불가`}
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
        {/* 삭제 확인 모달 */}
        {showDeleteModal && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
              <div className="px-6 py-5 border-b border-gray-100">
                <h3 className="text-lg font-bold text-gray-900">입고 실적 삭제</h3>
                <p className="text-sm text-gray-500 mt-1">이 작업은 되돌릴 수 없습니다</p>
              </div>
              <div className="px-6 py-4 space-y-3">
                <div className="bg-red-50 rounded-lg p-3">
                  <p className="text-sm text-red-700 font-medium">삭제 시 다음이 함께 처리됩니다:</p>
                  <ul className="text-xs text-red-600 mt-2 space-y-1">
                    <li>• 입고 수량 초기화 (received_qty → 0)</li>
                    <li>• 작업지시서 상태 복원 (이관중)</li>
                    <li>• 재고 수불부 트랜잭션 삭제 + 재고 복원</li>
                  </ul>
                </div>
                <div className="text-sm text-gray-600">
                  <p>작업지시서: <span className="font-medium">{historyWorkOrder?.date}</span></p>
                  <p>삭제 대상: <span className="font-medium">{historyItems.length}종 / {historyItems.reduce((s, h) => s + h.qty, 0)}개</span></p>
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
                <button onClick={handleDeleteReceipt} disabled={deleting} className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50">
                  {deleting ? '삭제 중...' : '삭제 확인'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const hasDiscrepancy = items.some((item) => item.actualQty !== item.expectedQty);
  const totalUniformQty = items.filter((i) => !i.isMarking).reduce((s, i) => s + i.expectedQty, 0);
  const totalMarkingQty = items.filter((i) => i.isMarking).reduce((s, i) => s + i.expectedQty, 0);
  const totalReceiptQty = totalUniformQty + totalMarkingQty;

  return (
    <div className="space-y-5 max-w-3xl">
      {/* 에러 */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800">{error}</p>
            <button onClick={loadOrders} className="text-xs text-red-600 underline mt-1">다시 시도</button>
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
              <span className="text-xs text-blue-600 font-medium">오늘 — 작업 모드</span>
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
            <h3 className="font-medium text-gray-700">{formatDate(selectedDate)} 입고 이력</h3>
            <p className="text-xs text-gray-400 mt-0.5">읽기 전용</p>
          </div>
          {historyLoading ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : historyItems.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">이 날짜에 기록된 입고가 없습니다</div>
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
                <p className="text-sm text-gray-600">총 입고:</p>
                <p className="text-sm font-bold text-gray-900">{historyItems.reduce((s, h) => s + h.qty, 0)}개</p>
              </div>
            </>
          )}
          {/* 삭제 버튼 */}
          {historyItems.length > 0 && historyWorkOrder && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100">
              {historyWorkOrder.status === '입고확인완료' && !historyWorkOrder.markingStarted ? (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
                >
                  <Trash2 size={16} />
                  입고 실적 삭제
                </button>
              ) : (
                <p className="text-xs text-red-400 text-center">
                  {historyWorkOrder.markingStarted ? '마킹 진행중 — 삭제 불가' : `현재 상태: ${historyWorkOrder.status} — 삭제 불가`}
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
      )}

      {/* 삭제 확인 모달 (메인 뷰) */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">입고 실적 삭제</h3>
              <p className="text-sm text-gray-500 mt-1">이 작업은 되돌릴 수 없습니다</p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="bg-red-50 rounded-lg p-3">
                <p className="text-sm text-red-700 font-medium">삭제 시 다음이 함께 처리됩니다:</p>
                <ul className="text-xs text-red-600 mt-2 space-y-1">
                  <li>• 입고 수량 초기화 (received_qty → 0)</li>
                  <li>• 작업지시서 상태 복원 (이관중)</li>
                  <li>• 재고 수불부 트랜잭션 삭제 + 재고 복원</li>
                </ul>
              </div>
              <div className="text-sm text-gray-600">
                <p>작업지시서: <span className="font-medium">{historyWorkOrder?.date}</span></p>
                <p>삭제 대상: <span className="font-medium">{historyItems.length}종 / {historyItems.reduce((s, h) => s + h.qty, 0)}개</span></p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} disabled={deleting} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">취소</button>
              <button onClick={handleDeleteReceipt} disabled={deleting} className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50">
                {deleting ? '삭제 중...' : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 헤더 */}
      {isToday && <><h2 className="text-xl font-bold text-gray-900">입고 확인</h2>

      {orders.length > 1 && (
        <select
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={selectedOrder?.id}
          onChange={(e) => {
            const wo = orders.find((w) => w.id === e.target.value);
            if (wo) selectOrder(wo);
          }}
        >
          {orders.map((wo) => (
            <option key={wo.id} value={wo.id}>
              {wo.download_date} (미입고 {wo.pendingWaveCount}차수)
            </option>
          ))}
        </select>
      )}

      {/* 미입고 차수 안내 배너 */}
      {pendingWaveCount > 1 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <p className="text-sm text-amber-800">
            미입고 차수가 {pendingWaveCount}개 있습니다. {currentWaveNum}차부터 순서대로 입고해주세요.
          </p>
        </div>
      )}

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

      {/* 품목 카드 — 유니폼/마킹 좌우 2컬럼 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <h3 className="font-medium text-gray-900">
            {currentWaveNum}차 입고 확인 — {selectedOrder?.download_date}
            {pendingWaveCount > 1 && (
              <span className="text-xs text-amber-600 ml-2">
                (미입고 {pendingWaveCount}차수)
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">실제 입고된 수량을 입력하세요</p>
        </div>

        {/* 총 수량 합계 */}
        <div className="px-5 py-3 bg-blue-50/60 border-b border-gray-100 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-blue-700">유니폼 소계</span>
            <span className="font-semibold text-blue-800">{totalUniformQty}개</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-purple-700">마킹 소계</span>
            <span className="font-semibold text-purple-800">{totalMarkingQty}개</span>
          </div>
          <div className="border-t border-blue-200 pt-1 mt-1 flex items-center justify-between text-sm">
            <span className="font-bold text-gray-800">총 입고 수량</span>
            <span className="font-bold text-gray-900 text-base">{totalReceiptQty}개</span>
          </div>
        </div>

        {/* 2컬럼 헤더 */}
        <div className="grid grid-cols-2 border-b border-gray-100">
          <div className="px-4 py-2.5 border-r border-gray-100 bg-blue-50">
            <p className="text-xs font-semibold text-blue-700">
              유니폼 단품{' '}
              <span className="font-normal text-blue-500">
                ({items.filter((i) => !i.isMarking).length}종)
              </span>
            </p>
          </div>
          <div className="px-4 py-2.5 bg-purple-50">
            <p className="text-xs font-semibold text-purple-700">
              마킹 단품{' '}
              <span className="font-normal text-purple-500">
                ({items.filter((i) => i.isMarking).length}종)
              </span>
            </p>
          </div>
        </div>

        {/* 2컬럼 아이템 목록 */}
        <div className="grid grid-cols-2">
          {/* 왼쪽: 유니폼 */}
          <div className="border-r border-gray-100 divide-y divide-gray-50">
            {items
              .filter((item) => !item.isMarking)
              .map((item) => (
                <div key={item.skuId} className="px-3 py-3">
                  <p className="text-xs font-medium text-gray-800 leading-tight truncate">{item.skuName}</p>
                  <p className="text-[10px] text-gray-400 font-mono mt-0.5 truncate">{item.skuId}</p>
                  <div className="flex items-center justify-between mt-1.5 gap-1">
                    <p className="text-[10px] text-gray-400">예정 {item.expectedQty}개</p>
                    <div className="flex flex-col items-end gap-0.5">
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          min="0"
                          value={item.actualQty}
                          onChange={(e) => handleActualChange(item.skuId, Number(e.target.value))}
                          className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                            item.actualQty > item.expectedQty
                              ? 'border-orange-300 bg-orange-50'
                              : item.actualQty < item.expectedQty
                              ? 'border-red-300 bg-red-50'
                              : 'border-gray-300'
                          }`}
                        />
                        <span className="text-[10px] text-gray-400">개</span>
                      </div>
                      {item.actualQty !== item.expectedQty && (
                        <span
                          className={`text-[10px] font-medium ${
                            item.actualQty > item.expectedQty ? 'text-orange-600' : 'text-red-600'
                          }`}
                        >
                          {item.actualQty > item.expectedQty
                            ? `+${item.actualQty - item.expectedQty}`
                            : `${item.actualQty - item.expectedQty}`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>

          {/* 오른쪽: 마킹 */}
          <div className="divide-y divide-gray-50">
            {items
              .filter((item) => item.isMarking)
              .map((item) => (
                <div key={item.skuId} className="px-3 py-3">
                  <p className="text-xs font-medium text-gray-800 leading-tight truncate">{item.skuName}</p>
                  <p className="text-[10px] text-gray-400 font-mono mt-0.5 truncate">{item.skuId}</p>
                  <div className="flex items-center justify-between mt-1.5 gap-1">
                    <p className="text-[10px] text-gray-400">예정 {item.expectedQty}개</p>
                    <div className="flex flex-col items-end gap-0.5">
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          min="0"
                          value={item.actualQty}
                          onChange={(e) => handleActualChange(item.skuId, Number(e.target.value))}
                          className={`w-16 border rounded-lg px-1.5 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-purple-500 ${
                            item.actualQty > item.expectedQty
                              ? 'border-orange-300 bg-orange-50'
                              : item.actualQty < item.expectedQty
                              ? 'border-red-300 bg-red-50'
                              : 'border-gray-300'
                          }`}
                        />
                        <span className="text-[10px] text-gray-400">개</span>
                      </div>
                      {item.actualQty !== item.expectedQty && (
                        <span
                          className={`text-[10px] font-medium ${
                            item.actualQty > item.expectedQty ? 'text-orange-600' : 'text-red-600'
                          }`}
                        >
                          {item.actualQty > item.expectedQty
                            ? `+${item.actualQty - item.expectedQty}`
                            : `${item.actualQty - item.expectedQty}`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {hasDiscrepancy && (
        <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-yellow-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800">
            예정 수량과 다른 항목이 있습니다. 실제 입고 수량을 정확히 입력 후 확인해주세요.
          </p>
        </div>
      )}

      {saving && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-blue-700 font-medium text-center">
            {saveProgress?.step ?? '처리 중...'}
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
        onClick={handleConfirm}
        disabled={saving}
        className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors text-base"
      >
        {saving ? '처리 중...' : `${currentWaveNum}차 입고 확인 완료`}
      </button>
      </>}
    </div>
  );
}
