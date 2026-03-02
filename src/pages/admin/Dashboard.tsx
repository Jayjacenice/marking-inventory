import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Package, Truck, ClipboardList, Trash2, AlertTriangle } from 'lucide-react';

interface InventorySummary {
  warehouseName: string;
  totalSkus: number;
  totalQty: number;
}

interface ActiveOrder {
  id: string;
  downloadDate: string;
  status: string;
  lineCount: number;
}

export default function Dashboard() {
  const [inventories, setInventories] = useState<InventorySummary[]>([]);
  const [activeOrders, setActiveOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);

    // 창고별 재고 요약
    const { data: invData } = await supabase
      .from('inventory')
      .select('quantity, warehouse(name)')
      .gt('quantity', 0);

    if (invData) {
      const summary: Record<string, InventorySummary> = {};
      for (const row of invData as any[]) {
        const name = row.warehouse?.name || '알 수 없음';
        if (!summary[name]) summary[name] = { warehouseName: name, totalSkus: 0, totalQty: 0 };
        summary[name].totalSkus++;
        summary[name].totalQty += row.quantity;
      }
      setInventories(Object.values(summary));
    }

    // 진행 중인 작업지시서
    const { data: woData } = await supabase
      .from('work_order')
      .select('id, download_date, status, work_order_line(id)')
      .not('status', 'in', '("출고완료")')
      .order('uploaded_at', { ascending: false })
      .limit(10);

    if (woData) {
      setActiveOrders(
        (woData as any[]).map((wo) => ({
          id: wo.id,
          downloadDate: wo.download_date,
          status: wo.status,
          lineCount: wo.work_order_line?.length || 0,
        }))
      );
    }

    setLoading(false);
  };

  const handleDelete = async (workOrderId: string) => {
    setDeleting(true);
    try {
      // 1. daily_marking 삭제
      const { data: lines } = await supabase
        .from('work_order_line')
        .select('id')
        .eq('work_order_id', workOrderId);
      const lineIds = (lines || []).map((l: any) => l.id);
      if (lineIds.length > 0) {
        await supabase.from('daily_marking').delete().in('work_order_line_id', lineIds);
      }
      // 2. work_order_line 삭제
      await supabase.from('work_order_line').delete().eq('work_order_id', workOrderId);
      // 3. work_order 삭제
      await supabase.from('work_order').delete().eq('id', workOrderId);
      await loadData();
    } finally {
      setDeleting(false);
      setConfirmId(null);
    }
  };

  const statusColor: Record<string, string> = {
    업로드됨: 'bg-gray-100 text-gray-700',
    이관준비: 'bg-yellow-100 text-yellow-700',
    이관중: 'bg-orange-100 text-orange-700',
    입고확인완료: 'bg-blue-100 text-blue-700',
    마킹중: 'bg-purple-100 text-purple-700',
    마킹완료: 'bg-green-100 text-green-700',
    출고완료: 'bg-emerald-100 text-emerald-700',
  };

  const warehouseIcon: Record<string, React.ReactNode> = {
    오프라인샵: <Package size={20} className="text-blue-600" />,
    플레이위즈: <ClipboardList size={20} className="text-purple-600" />,
    CJ창고: <Truck size={20} className="text-green-600" />,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        불러오는 중...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">대시보드</h2>

      {/* 창고별 재고 현황 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
          창고별 재고 현황
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {['오프라인샵', '플레이위즈', 'CJ창고'].map((wh) => {
            const data = inventories.find((i) => i.warehouseName === wh);
            return (
              <div key={wh} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
                <div className="flex items-center gap-3 mb-3">
                  {warehouseIcon[wh]}
                  <span className="font-medium text-gray-900">{wh}</span>
                </div>
                {data ? (
                  <>
                    <p className="text-2xl font-bold text-gray-900">{data.totalQty.toLocaleString()}개</p>
                    <p className="text-sm text-gray-500">{data.totalSkus}개 SKU</p>
                  </>
                ) : (
                  <p className="text-gray-400 text-sm">재고 없음</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 진행 중인 작업지시서 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
          진행 중인 작업지시서
        </h3>
        {activeOrders.length === 0 ? (
          <div className="bg-white rounded-xl p-8 text-center text-gray-400 shadow-sm border border-gray-100">
            진행 중인 작업지시서가 없습니다
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">다운로드 날짜</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">라인 수</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">상태</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {activeOrders.map((wo) =>
                  confirmId === wo.id ? (
                    <tr key={wo.id} className="bg-red-50">
                      <td colSpan={4} className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AlertTriangle size={15} className="text-red-500 flex-shrink-0" />
                          <span className="text-sm text-red-800">
                            <span className="font-semibold">{wo.downloadDate}</span>
                            {' '}작업지시서를 삭제할까요?{' '}
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                statusColor[wo.status] || 'bg-gray-100 text-gray-700'
                              }`}
                            >
                              현재 상태: {wo.status}
                            </span>
                            {' '}— 연관 데이터가 모두 삭제됩니다.
                          </span>
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              onClick={() => setConfirmId(null)}
                              disabled={deleting}
                              className="px-3 py-1 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                            >
                              취소
                            </button>
                            <button
                              onClick={() => handleDelete(wo.id)}
                              disabled={deleting}
                              className="px-3 py-1 text-xs text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1"
                            >
                              <Trash2 size={12} />
                              {deleting ? '삭제 중...' : '삭제'}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={wo.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-900">{wo.downloadDate}</td>
                      <td className="px-4 py-3 text-gray-600">{wo.lineCount}건</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            statusColor[wo.status] || 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {wo.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setConfirmId(wo.id)}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title="삭제"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
