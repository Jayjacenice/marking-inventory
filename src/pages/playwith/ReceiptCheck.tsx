import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { AlertTriangle, CheckCircle, Download, FileUp, X } from 'lucide-react';
import { generateTemplate, parseQtyExcel } from '../../lib/excelUtils';

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
}

interface ComparisonRow {
  skuId: string;
  skuName: string;
  expected: number;
  uploaded: number;
  diff: number;
}

export default function ReceiptCheck() {
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

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date')
        .eq('status', '이관중')
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      if (isStale()) return;
      const list = (data || []) as PendingOrder[];
      setOrders(list);
      if (list.length > 0) selectOrder(list[0]);
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
      // 바코드 포함 조회
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('finished_sku_id, sent_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name, barcode)')
        .eq('work_order_id', wo.id);
      if (linesErr) throw linesErr;
      if (isStale()) return;

      // BOM — 마킹 대상 finished_sku_id로 필터링 (필터 없으면 1,000행 제한에 걸려 누락 발생)
      const markingSkuIds = ((lines || []) as any[])
        .filter((l) => l.needs_marking)
        .map((l) => l.finished_sku_id as string);
      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name, barcode)')
        .in('finished_sku_id', markingSkuIds.length > 0 ? markingSkuIds : ['__none__']);
      if (bomErr) throw bomErr;
      if (isStale()) return;

      // 단품 단위로 집계
      const componentMap: Record<string, { skuId: string; skuName: string; barcode: string | null; qty: number; isMarking: boolean }> = {};

      for (const line of (lines || []) as any[]) {
        if (line.needs_marking) {
          const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          for (const bom of boms as any[]) {
            const key = bom.component_sku_id;
            if (!componentMap[key]) {
              componentMap[key] = {
                skuId: bom.component_sku_id,
                skuName: bom.component?.sku_name || '',
                barcode: bom.component?.barcode || null,
                qty: 0,
                isMarking:
                  bom.component_sku_id?.includes('MK') ||
                  bom.component?.sku_name?.includes('마킹') ||
                  false,
              };
            }
            componentMap[key].qty += bom.quantity * line.sent_qty;
          }
        } else {
          const key = line.finished_sku_id;
          if (!componentMap[key]) {
            componentMap[key] = {
              skuId: line.finished_sku_id,
              skuName: line.finished_sku?.sku_name || line.finished_sku_id,
              barcode: line.finished_sku?.barcode || null,
              qty: 0,
              isMarking: false,
            };
          }
          componentMap[key].qty += line.sent_qty;
        }
      }

      setItems(
        Object.values(componentMap).map((c) => ({
          skuId: c.skuId,
          skuName: c.skuName,
          barcode: c.barcode,
          expectedQty: c.qty,
          actualQty: c.qty,
          isMarking: c.isMarking,
        }))
      );
    } catch (e: any) {
      if (!isStale()) setError(`입고 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
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
      `입고수량_${selectedOrder?.download_date || '양식'}.xlsx`
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
      setSaveProgress({ current: 1, total: 3, step: '데이터 조회 중...' });
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, needs_marking')
        .eq('work_order_id', selectedOrder.id);
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

      const actualMap: Record<string, number> = {};
      for (const item of items) actualMap[item.skuId] = item.actualQty;

      for (let i = 0; i < lineList.length; i++) {
        const line = lineList[i];
        setSaveProgress({ current: i + 1, total: lineList.length + 1, step: `입고 수량 처리 중... (${i + 1} / ${lineList.length})` });
        // needs_marking=true: BOM 공유 컴포넌트로 역산 불가 → ordered_qty 유지
        // needs_marking=false: 단품이므로 사용자 입력값(actualMap) 직접 사용
        const receivedQty = line.needs_marking
          ? line.ordered_qty
          : (actualMap[line.finished_sku_id] ?? line.ordered_qty);
        const { error: updateErr } = await supabase
          .from('work_order_line')
          .update({ received_qty: receivedQty })
          .eq('id', line.id);
        if (updateErr) throw updateErr;
      }

      setSaveProgress({ current: lineList.length + 1, total: lineList.length + 1, step: '상태 업데이트 중...' });
      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: '입고확인완료' })
        .eq('id', selectedOrder.id);
      if (statusErr) throw statusErr;

      setDone(true);
      loadOrders();
    } catch (e: any) {
      setError(`입고 확인 처리 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">불러오는 중...</div>;
  }

  if (orders.length === 0 && !done) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-600 font-medium">입고 확인 대기 중인 물량이 없습니다</p>
          <p className="text-sm text-gray-400 mt-1">오프라인 매장에서 발송 완료 처리 후 나타납니다</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-700 font-semibold text-lg">입고 확인 완료!</p>
          <p className="text-sm text-gray-400 mt-1">마킹 작업 페이지에서 작업을 진행해주세요</p>
        </div>
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

      {/* 헤더 */}
      <h2 className="text-xl font-bold text-gray-900">입고 확인</h2>

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
              {wo.download_date}
            </option>
          ))}
        </select>
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

      {/* 품목 카드 — 유니폼/마킹 좌우 2컬럼 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <h3 className="font-medium text-gray-900">📬 입고 확인 — {selectedOrder?.download_date}</h3>
          <p className="text-xs text-gray-400 mt-0.5">실제 입고된 수량을 입력하세요</p>
        </div>

        {/* 총 수량 합계 */}
        <div className="px-5 py-3 bg-blue-50/60 border-b border-gray-100 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-blue-700">👕 유니폼 소계</span>
            <span className="font-semibold text-blue-800">{totalUniformQty}개</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-purple-700">🎨 마킹 소계</span>
            <span className="font-semibold text-purple-800">{totalMarkingQty}개</span>
          </div>
          <div className="border-t border-blue-200 pt-1 mt-1 flex items-center justify-between text-sm">
            <span className="font-bold text-gray-800">📬 총 입고 수량</span>
            <span className="font-bold text-gray-900 text-base">{totalReceiptQty}개</span>
          </div>
        </div>

        {/* 2컬럼 헤더 */}
        <div className="grid grid-cols-2 border-b border-gray-100">
          <div className="px-4 py-2.5 border-r border-gray-100 bg-blue-50">
            <p className="text-xs font-semibold text-blue-700">
              👕 유니폼 단품{' '}
              <span className="font-normal text-blue-500">
                ({items.filter((i) => !i.isMarking).length}종)
              </span>
            </p>
          </div>
          <div className="px-4 py-2.5 bg-purple-50">
            <p className="text-xs font-semibold text-purple-700">
              🎨 마킹 단품{' '}
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
        {saving ? '처리 중...' : '입고 확인 완료'}
      </button>
    </div>
  );
}
