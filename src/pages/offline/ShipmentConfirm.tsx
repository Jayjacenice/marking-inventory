import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertTriangle, CheckCircle, Truck } from 'lucide-react';

interface ShipmentItem {
  lineId: string;
  skuId: string;
  skuName: string;
  orderedQty: number;
  inventoryQty: number; // 오프라인샵 현재 재고
  isShortage: boolean;
  isMarking: boolean;
}

interface ActiveWorkOrder {
  id: string;
  download_date: string;
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
    try {
      // 작업지시서 라인 + 오프라인샵 재고 조회
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name)')
        .eq('work_order_id', wo.id);
      if (linesErr) throw linesErr;

      const { data: warehouses, error: warehouseErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .maybeSingle();
      if (warehouseErr) throw warehouseErr;

      const offlineWarehouseId = (warehouses as any)?.id;

      // BOM 기반으로 오프라인샵에서 필요한 단품 수량 계산
      const { data: bomData, error: bomErr } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name)');
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
        { lineId: string; skuId: string; skuName: string; needed: number; isMarking: boolean }
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
            needed: line.ordered_qty,
            isMarking: false,
          };
        }
      }

      const shipmentItems: ShipmentItem[] = Object.values(componentMap).map((c) => ({
        lineId: c.lineId,
        skuId: c.skuId,
        skuName: c.skuName,
        orderedQty: c.needed,
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

  const handleConfirm = async () => {
    if (!selectedWo) return;
    setConfirming(true);
    setConfirmProgress(null);
    setError(null);
    try {
      // 상태를 '이관중'으로 변경
      setConfirmProgress({ current: 1, total: 2, step: '발송 상태 업데이트 중...' });
      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: '이관중' })
        .eq('id', selectedWo.id);
      if (statusErr) throw statusErr;

      // 라인의 sent_qty를 ordered_qty로 업데이트
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, ordered_qty')
        .eq('work_order_id', selectedWo.id);
      if (linesErr) throw linesErr;

      const lineCount = (lines || []).length;
      const totalSteps = lineCount + items.length + 1;
      let step = 1;

      for (let i = 0; i < (lines || []).length; i++) {
        const line = (lines as any[])[i];
        setConfirmProgress({ current: step, total: totalSteps, step: `라인 처리 중... (${i + 1} / ${lineCount})` });
        await supabase
          .from('work_order_line')
          .update({ sent_qty: line.ordered_qty })
          .eq('id', line.id);
        step++;
      }

      // 오프라인샵 재고 차감
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
            .eq('warehouse_id', warehouse.id)
            .eq('sku_id', item.skuId)
            .maybeSingle();

          if (inv) {
            await supabase
              .from('inventory')
              .update({ quantity: Math.max(0, inv.quantity - item.orderedQty) })
              .eq('id', inv.id);
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
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800">{error}</p>
            <button onClick={loadPendingOrders} className="text-xs text-red-600 underline mt-1">다시 시도</button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
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

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <h3 className="font-medium text-gray-900">
            📦 제작센터(플레이위즈)로 보낼 물량
          </h3>
          <p className="text-sm text-gray-500 mt-0.5">{selectedWo?.download_date} 기준</p>
        </div>

        {hasShortage && (
          <div className="mx-4 mt-4 flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <AlertTriangle size={16} className="text-yellow-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-800">
              일부 품목 재고가 부족합니다. 가능한 수량만큼 발송하세요.
            </p>
          </div>
        )}

        <div className="divide-y divide-gray-50">
          {items.map((item) => (
            <div key={item.skuId} className={`px-5 py-3.5 flex items-center justify-between ${item.isShortage ? 'bg-red-50' : ''}`}>
              <div>
                <p className="text-sm font-medium text-gray-900">{item.skuName}</p>
                <p className="text-xs text-gray-400 mt-0.5 font-mono">{item.skuId}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-gray-900">{item.orderedQty}개</p>
                {item.isShortage ? (
                  <p className="text-xs text-red-600 mt-0.5">
                    재고 {item.inventoryQty}개 (부족)
                  </p>
                ) : (
                  <p className="text-xs text-gray-400 mt-0.5">재고 {item.inventoryQty}개</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

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
      {hasShortage && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">
            재고 부족 품목이 있어 발송을 진행할 수 없습니다. 재고를 보충한 후 다시 시도해주세요.
          </p>
        </div>
      )}
      <button
        onClick={handleConfirm}
        disabled={confirming || hasShortage}
        className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base"
      >
        <Truck size={20} />
        {confirming ? '처리 중...' : hasShortage ? '재고 부족 — 발송 불가' : '발송 완료 확인'}
      </button>
      <p className="text-xs text-center text-gray-400">
        버튼 클릭 시 플레이위즈에 발송 완료 신호가 전달됩니다
      </p>
    </div>
  );
}
