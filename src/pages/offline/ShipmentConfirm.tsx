import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertTriangle, CheckCircle, Download, FileUp, Truck, X } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';

interface ShipmentItem {
  lineId: string;
  skuId: string;
  skuName: string;
  barcode: string | null;
  orderedQty: number;
  sentQty: number;      // 실제 발송 수량 (사용자 입력)
  inventoryQty: number; // 오프라인샵 현재 재고
  isShortage: boolean;
  isMarking: boolean;
}

interface ActiveWorkOrder {
  id: string;
  download_date: string;
}

interface ComparisonRow {
  skuId: string;
  skuName: string;
  expected: number;
  uploaded: number;
  diff: number;
}

export default function ShipmentConfirm() {
  const [workOrders, setWorkOrders] = useState<ActiveWorkOrder[]>([]);
  const [selectedWo, setSelectedWo] = useState<ActiveWorkOrder | null>(null);
  const [items, setItems] = useState<ShipmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmProgress, setConfirmProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadComparison, setUploadComparison] = useState<{ rows: ComparisonRow[]; unmatched: string[] } | null>(null);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadPendingOrders();
  }, []);

  const loadPendingOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date')
        .eq('status', '이관준비')
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      const orders = (data || []) as ActiveWorkOrder[];
      setWorkOrders(orders);
      if (orders.length > 0) {
        selectOrder(orders[0]);
      } else {
        setLoading(false);
      }
    } catch (e: any) {
      setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
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
      // 작업지시서 라인 + 바코드 포함 조회
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
        .eq('work_order_id', wo.id);
      if (linesErr) throw linesErr;

      const { data: warehouses, error: warehouseErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .maybeSingle();
      if (warehouseErr) throw warehouseErr;

      const offlineWarehouseId = (warehouses as any)?.id;

      // BOM — 단품 바코드 포함 조회
      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name, barcode)');
      if (bomErr) throw bomErr;

      // 오프라인샵 재고 조회
      const { data: inventoryData, error: invErr } = await supabase
        .from('inventory')
        .select('sku_id, quantity')
        .eq('warehouse_id', offlineWarehouseId);
      if (invErr) throw invErr;

      const inventoryMap: Record<string, number> = {};
      for (const inv of (inventoryData || []) as any[]) {
        inventoryMap[inv.sku_id] = inv.quantity;
      }

      // 단품 단위로 집계
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
                isMarking: bom.component?.sku_name?.includes('마킹') || false,
              };
            }
            componentMap[key].needed += bom.quantity * line.ordered_qty;
          }
        } else {
          const key = line.finished_sku_id;
          componentMap[key] = {
            lineId: line.id,
            skuId: line.finished_sku_id,
            skuName: line.finished_sku?.sku_name || line.finished_sku_id,
            barcode: line.finished_sku?.barcode || null,
            needed: line.ordered_qty,
            isMarking: false,
          };
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
      }));

      setItems(shipmentItems);
    } catch (e: any) {
      setError(`발주 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSentChange = (skuId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.skuId === skuId ? { ...item, sentQty: Math.max(0, value) } : item
      )
    );
  };

  // ── 엑셀 양식 다운로드 ─────────────────────────
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

  // ── 엑셀 업로드 → sentQty 적용 + 비교 패널 ────
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

      // sentQty 일괄 업데이트
      const matchMap = new Map(result.matched.map((m) => [m.skuId, m.uploadedQty]));
      setItems((prev) =>
        prev.map((item) =>
          matchMap.has(item.skuId) ? { ...item, sentQty: matchMap.get(item.skuId)! } : item
        )
      );

      // 비교 데이터 구성
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

  const handleConfirm = async () => {
    if (!selectedWo) return;
    setConfirming(true);
    setConfirmProgress(null);
    setError(null);
    try {
      const sentMap: Record<string, number> = {};
      for (const item of items) sentMap[item.skuId] = item.sentQty;

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

      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity');
      if (bomErr) throw bomErr;

      const lineList = (lines || []) as any[];
      const totalSteps = lineList.length + items.length + 2;
      let step = 3;

      for (let i = 0; i < lineList.length; i++) {
        const line = lineList[i];
        setConfirmProgress({ current: step, total: totalSteps, step: `라인 처리 중... (${i + 1} / ${lineList.length})` });

        let lineSentQty: number;
        if (!line.needs_marking) {
          lineSentQty = sentMap[line.finished_sku_id] ?? line.ordered_qty;
        } else {
          const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          if (boms.length > 0) {
            lineSentQty = Math.min(
              ...boms.map((b: any) => Math.floor((sentMap[b.component_sku_id] || 0) / b.quantity))
            );
          } else {
            lineSentQty = line.ordered_qty;
          }
        }

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
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          setConfirmProgress({ current: step, total: totalSteps, step: `재고 차감 중... (${i + 1} / ${items.length})` });

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
          step++;
        }
      }

      setConfirmed(true);
      loadPendingOrders();
    } catch (e: any) {
      setError(`발송 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setConfirming(false);
      setConfirmProgress(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">불러오는 중...</div>;
  }

  if (workOrders.length === 0 && !confirmed) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-600 font-medium">발송 대기 중인 물량이 없습니다</p>
          <p className="text-sm text-gray-400 mt-1">관리자가 작업지시서를 등록하면 표시됩니다</p>
        </div>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Truck size={48} className="mx-auto text-blue-500 mb-3" />
          <p className="text-gray-700 font-semibold text-lg">발송 완료 처리되었습니다</p>
          <p className="text-sm text-gray-400 mt-1">플레이위즈에서 입고 확인을 진행해주세요</p>
        </div>
      </div>
    );
  }

  const hasShortage = items.some((item) => item.isShortage);

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

      {/* 엑셀 파싱 에러 */}
      {xlsxError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{xlsxError}</p>
        </div>
      )}

      {/* 업로드 비교 패널 */}
      {uploadComparison && (
        <div className="bg-white rounded-xl shadow-sm border border-blue-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">📊 업로드 비교 결과</p>
              <p className="text-xs text-gray-400 mt-0.5">{uploadComparison.rows.length}개 품목 수량 적용됨</p>
            </div>
            <button
              onClick={() => setUploadComparison(null)}
              className="text-gray-400 hover:text-gray-600 transition-colors p-1"
            >
              <X size={15} />
            </button>
          </div>

          {/* 비교 테이블 헤더 */}
          <div className="grid grid-cols-4 px-4 py-2 bg-gray-50 text-xs text-gray-500 font-medium border-b border-gray-100">
            <span>SKU명</span>
            <span className="text-right">예정</span>
            <span className="text-right">업로드</span>
            <span className="text-right">차이</span>
          </div>

          <div className="divide-y divide-gray-50 max-h-56 overflow-y-auto">
            {uploadComparison.rows.map((row) => (
              <div key={row.skuId} className="grid grid-cols-4 px-4 py-2.5 text-xs items-center">
                <span className="text-gray-800 truncate pr-2">{row.skuName}</span>
                <span className="text-right text-gray-500">{row.expected}</span>
                <span className="text-right text-gray-800 font-medium">{row.uploaded}</span>
                <span
                  className={`text-right font-medium ${
                    row.diff > 0
                      ? 'text-orange-600'
                      : row.diff < 0
                      ? 'text-red-600'
                      : 'text-gray-400'
                  }`}
                >
                  {row.diff > 0 ? `+${row.diff}` : row.diff === 0 ? '—' : row.diff}
                </span>
              </div>
            ))}
          </div>

          {uploadComparison.unmatched.length > 0 && (
            <div className="px-4 py-2.5 border-t border-gray-100 bg-yellow-50">
              <p className="text-xs text-yellow-800">
                ⚠️ 미매칭 {uploadComparison.unmatched.length}개:{' '}
                {uploadComparison.unmatched.slice(0, 3).join(', ')}
                {uploadComparison.unmatched.length > 3 && ` 외 ${uploadComparison.unmatched.length - 3}개`}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 품목 카드 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <h3 className="font-medium text-gray-900">📦 제작센터(플레이위즈)로 보낼 물량</h3>
          <p className="text-sm text-gray-500 mt-0.5">{selectedWo?.download_date} 기준</p>
        </div>

        {hasShortage && (
          <div className="mx-4 mt-4 flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <AlertTriangle size={16} className="text-yellow-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-800">
              일부 품목 재고가 부족합니다. 실제 발송 수량을 직접 입력해주세요.
            </p>
          </div>
        )}

        <div className="divide-y divide-gray-50">
          {items.map((item) => (
            <div
              key={item.skuId}
              className={`px-5 py-3.5 flex items-center justify-between gap-3 ${item.isShortage ? 'bg-red-50' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{item.skuName}</p>
                <p className="text-xs text-gray-400 mt-0.5 font-mono">{item.skuId}</p>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    value={item.sentQty}
                    onChange={(e) => handleSentChange(item.skuId, Number(e.target.value))}
                    className={`w-20 border rounded-lg px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      item.sentQty > item.inventoryQty ? 'border-orange-300 bg-orange-50' : 'border-gray-300'
                    }`}
                  />
                  <span className="text-xs text-gray-500">개</span>
                </div>
                <p className="text-xs text-gray-400">주문 {item.orderedQty}개</p>
                {item.isShortage ? (
                  <p className="text-xs text-red-500">재고 {item.inventoryQty}개 (부족)</p>
                ) : (
                  <p className="text-xs text-gray-400">재고 {item.inventoryQty}개</p>
                )}
              </div>
            </div>
          ))}
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
        onClick={handleConfirm}
        disabled={confirming}
        className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base"
      >
        <Truck size={20} />
        {confirming ? '처리 중...' : '발송 완료 확인'}
      </button>
      <p className="text-xs text-center text-gray-400">
        버튼 클릭 시 플레이위즈에 발송 완료 신호가 전달됩니다
      </p>
    </div>
  );
}
