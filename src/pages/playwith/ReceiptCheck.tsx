import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CheckCircle, AlertTriangle } from 'lucide-react';

interface ReceiptItem {
  skuId: string;
  skuName: string;
  expectedQty: number;
  actualQty: number;
}

interface PendingOrder {
  id: string;
  download_date: string;
}

export default function ReceiptCheck() {
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<PendingOrder | null>(null);
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const list = (data || []) as PendingOrder[];
      setOrders(list);
      if (list.length > 0) selectOrder(list[0]);
      else setLoading(false);
    } catch (e: any) {
      setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
      setLoading(false);
    }
  };

  const selectOrder = async (wo: PendingOrder) => {
    setSelectedOrder(wo);
    setLoading(true);
    setDone(false);
    setError(null);
    try {
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('finished_sku_id, sent_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name)')
        .eq('work_order_id', wo.id);
      if (linesErr) throw linesErr;

      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name)');
      if (bomErr) throw bomErr;

      // 단품 단위로 집계
      const componentMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};

      for (const line of (lines || []) as any[]) {
        if (line.needs_marking) {
          const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          for (const bom of boms as any[]) {
            const key = bom.component_sku_id;
            if (!componentMap[key]) {
              componentMap[key] = { skuId: bom.component_sku_id, skuName: bom.component?.sku_name || '', qty: 0 };
            }
            componentMap[key].qty += bom.quantity * line.sent_qty;
          }
        } else {
          componentMap[line.finished_sku_id] = {
            skuId: line.finished_sku_id,
            skuName: line.finished_sku?.sku_name || line.finished_sku_id,
            qty: line.sent_qty,
          };
        }
      }

      setItems(
        Object.values(componentMap).map((c) => ({
          skuId: c.skuId,
          skuName: c.skuName,
          expectedQty: c.qty,
          actualQty: c.qty, // 기본값: 예정 수량
        }))
      );
    } catch (e: any) {
      setError(`입고 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleActualChange = (skuId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.skuId !== skuId) return item;
        const clamped = Math.max(0, Math.min(value, item.expectedQty));
        return { ...item, actualQty: clamped };
      })
    );
  };

  const handleConfirm = async () => {
    if (!selectedOrder) return;
    setSaving(true);
    setSaveProgress(null);
    setError(null);
    try {
      // 작업지시서 라인의 received_qty 업데이트
      setSaveProgress({ current: 1, total: 3, step: '데이터 조회 중...' });
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, needs_marking')
        .eq('work_order_id', selectedOrder.id);
      if (linesErr) throw linesErr;

      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity');
      if (bomErr) throw bomErr;

      // 실제 입고 수량 기반으로 완제품 단위 received_qty 계산
      const actualMap: Record<string, number> = {};
      for (const item of items) actualMap[item.skuId] = item.actualQty;

      const lineList = (lines || []) as any[];
      for (let i = 0; i < lineList.length; i++) {
        const line = lineList[i];
        setSaveProgress({ current: i + 1, total: lineList.length + 1, step: `입고 수량 처리 중... (${i + 1} / ${lineList.length})` });
        let receivedQty = line.ordered_qty;
        if (line.needs_marking) {
          const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
          if (boms.length > 0) {
            receivedQty = Math.min(
              ...boms.map((b: any) => Math.floor((actualMap[b.component_sku_id] || 0) / b.quantity))
            );
          }
        }
        const { error: updateErr } = await supabase
          .from('work_order_line')
          .update({ received_qty: receivedQty })
          .eq('id', line.id);
        if (updateErr) throw updateErr;
      }

      // 상태 업데이트
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

  return (
    <div className="space-y-5 max-w-lg">
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800">{error}</p>
            <button onClick={loadOrders} className="text-xs text-red-600 underline mt-1">다시 시도</button>
          </div>
        </div>
      )}
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

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <h3 className="font-medium text-gray-900">📬 입고 확인 — {selectedOrder?.download_date}</h3>
          <p className="text-xs text-gray-400 mt-0.5">실제 입고된 수량을 입력하세요</p>
        </div>

        <div className="divide-y divide-gray-50">
          {items.map((item) => (
            <div key={item.skuId} className="px-5 py-3.5 flex items-center gap-4">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{item.skuName}</p>
                <p className="text-xs text-gray-400 mt-0.5">예정 {item.expectedQty}개</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max={item.expectedQty}
                  value={item.actualQty}
                  onChange={(e) => handleActualChange(item.skuId, Number(e.target.value))}
                  className={`w-20 border rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    item.actualQty !== item.expectedQty ? 'border-red-300 bg-red-50' : 'border-gray-300'
                  }`}
                />
                <span className="text-sm text-gray-500">개</span>
              </div>
            </div>
          ))}
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
