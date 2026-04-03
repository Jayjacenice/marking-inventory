import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransactionBatch } from '../../lib/inventoryTransaction';
import type { RecordTxParams } from '../../lib/inventoryTransaction';
import type { AppUser } from '../../types';
import { AlertTriangle, CheckCircle, Hammer, ChevronDown, ChevronUp, Clock } from 'lucide-react';

interface RequestItem {
  finishedSkuId: string;
  skuName: string;
  barcode: string | null;
  qty: number;
  components: { skuId: string; skuName: string; needed: number; available: number }[];
  canMark: boolean;
}

interface PendingRequest {
  id: string;
  request_date: string;
  status: string;
  items: RequestItem[];
  requested_at: string;
  notes: string | null;
}

export default function ManualMarking({ currentUser }: { currentUser: AppUser }) {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 완료 수량 관리
  const [completionQty, setCompletionQty] = useState<Record<string, number>>({});

  const today = new Date().toISOString().split('T')[0];

  useEffect(() => { loadPendingRequests(); }, []);

  const loadPendingRequests = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('marking_request')
        .select('id, request_date, status, items, requested_at, notes')
        .in('status', ['pending', 'in_progress'])
        .order('requested_at', { ascending: true });
      setRequests((data || []) as PendingRequest[]);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setCompletionQty({});
    } else {
      setExpandedId(id);
      // 요청 수량을 기본 완료 수량으로 세팅
      const req = requests.find((r) => r.id === id);
      if (req) {
        const qtyMap: Record<string, number> = {};
        for (const item of req.items) qtyMap[item.finishedSkuId] = item.qty;
        setCompletionQty(qtyMap);
      }
    }
    setCompleted(false);
    setError(null);
  };

  const handleComplete = async (reqId: string) => {
    const req = requests.find((r) => r.id === reqId);
    if (!req) return;

    setCompletingId(reqId);
    setError(null);
    try {
      const { data: wh } = await supabase.from('warehouse').select('id').eq('name', '플레이위즈').maybeSingle();
      if (!wh) throw new Error('플레이위즈 창고를 찾을 수 없습니다.');
      const pwWhId = (wh as any).id;

      // 완료할 아이템 필터
      const activeItems = req.items.filter((i) => (completionQty[i.finishedSkuId] || 0) > 0);
      if (activeItems.length === 0) throw new Error('완료할 수량을 입력해주세요.');

      // BOM 재조회
      const finSkuIds = activeItems.map((i) => i.finishedSkuId);
      const { data: boms } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity')
        .in('finished_sku_id', finSkuIds);
      const bomMap: Record<string, { componentSkuId: string; quantity: number }[]> = {};
      for (const b of (boms || []) as any[]) {
        if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
        bomMap[b.finished_sku_id].push({ componentSkuId: b.component_sku_id, quantity: b.quantity || 1 });
      }

      // 트랜잭션 생성
      const txRows: RecordTxParams[] = [];
      const completionItems: { skuId: string; skuName: string; completedQty: number }[] = [];

      for (const item of activeItems) {
        const qty = completionQty[item.finishedSkuId] || 0;
        if (qty <= 0) continue;
        const comps = bomMap[item.finishedSkuId] || [];
        for (const comp of comps) {
          txRows.push({
            warehouseId: pwWhId, skuId: comp.componentSkuId,
            txType: '마킹출고', quantity: comp.quantity * qty, source: 'system',
            needsMarking: true,
            memo: `수기마킹 구성품 차감 (${item.finishedSkuId}) ${today}`,
          });
        }
        txRows.push({
          warehouseId: pwWhId, skuId: item.finishedSkuId,
          txType: '마킹입고', quantity: qty, source: 'system',
          needsMarking: false,
          memo: `수기마킹 완성품 증가 ${today}`,
        });
        completionItems.push({ skuId: item.finishedSkuId, skuName: item.skuName, completedQty: qty });
      }

      if (txRows.length > 0) {
        await recordTransactionBatch(txRows);
      }

      // marking_request 완료 처리
      await supabase.from('marking_request').update({
        status: 'completed',
        completed_by: currentUser.id,
        completed_at: new Date().toISOString(),
        completion_summary: {
          items: completionItems,
          totalQty: completionItems.reduce((s, i) => s + i.completedQty, 0),
        },
      }).eq('id', reqId);

      // Activity log
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'marking_work',
        work_order_id: null,
        action_date: today,
        summary: {
          manualMarking: true,
          markingRequestId: reqId,
          items: completionItems,
          totalQty: completionItems.reduce((s, i) => s + i.completedQty, 0),
        },
      });

      setCompleted(true);
      setExpandedId(null);
      loadPendingRequests();
    } catch (err: any) {
      setError(err.message || '마킹 완료 처리 실패');
    } finally {
      setCompletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium text-gray-900">수기 마킹 작업</h3>
        <p className="text-xs text-gray-500 mt-0.5">관리자가 등록한 마킹 요청을 확인하고 완료 처리합니다</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {completed && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
          <CheckCircle size={24} className="mx-auto text-green-500 mb-2" />
          <p className="text-sm text-green-800 font-medium">마킹 완료 처리되었습니다!</p>
        </div>
      )}

      {loading ? (
        <div className="bg-gray-50 rounded-xl p-8 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : requests.length === 0 ? (
        <div className="bg-gray-50 rounded-xl p-8 text-center text-gray-400 text-sm">
          대기 중인 마킹 요청이 없습니다
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => {
            const reqItems = req.items || [];
            const totalQty = reqItems.reduce((s, i) => s + (i.qty || 0), 0);
            const isExpanded = expandedId === req.id;
            const isCompleting = completingId === req.id;

            return (
              <div key={req.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                {/* 카드 헤더 */}
                <button onClick={() => toggleExpand(req.id)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${req.status === 'pending' ? 'bg-yellow-100 text-yellow-800' : 'bg-blue-100 text-blue-800'}`}>
                      {req.status === 'pending' ? '대기' : '작업중'}
                    </span>
                    <div className="text-left">
                      <p className="text-sm font-medium text-gray-800">{req.request_date} 요청</p>
                      <p className="text-xs text-gray-500">{reqItems.length}종 · {totalQty}개</p>
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                </button>

                {/* 상세 + 완료 처리 */}
                {isExpanded && (
                  <div className="border-t border-gray-100">
                    {req.notes && (
                      <div className="px-4 py-2 bg-yellow-50 text-xs text-yellow-700 flex items-center gap-1">
                        <Clock size={12} />메모: {req.notes}
                      </div>
                    )}
                    <div className="divide-y divide-gray-50">
                      {reqItems.map((item) => (
                        <div key={item.finishedSkuId} className="px-4 py-3">
                          <div className="flex items-center justify-between">
                            <div className="flex-1 min-w-0 mr-3">
                              <p className="text-sm font-medium text-gray-800 truncate">{item.skuName}</p>
                              <p className="text-xs text-gray-400 font-mono">{item.finishedSkuId}</p>
                              {item.barcode && <p className="text-xs text-gray-400 font-mono">{item.barcode}</p>}
                              <p className="text-xs text-gray-500 mt-0.5">요청: {item.qty}개</p>
                            </div>
                            <div className="flex items-center gap-1">
                              <input
                                type="number" min="0"
                                value={completionQty[item.finishedSkuId] ?? item.qty}
                                onChange={(e) => setCompletionQty((prev) => ({ ...prev, [item.finishedSkuId]: Math.max(0, Number(e.target.value)) }))}
                                className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              />
                              <span className="text-xs text-gray-400">개</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                      <button onClick={() => handleComplete(req.id)}
                        disabled={isCompleting}
                        className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
                        <Hammer size={18} />
                        {isCompleting ? '처리 중...' : `마킹 완료 (${Object.values(completionQty).filter((q) => q > 0).length}종 ${Object.values(completionQty).reduce((s, q) => s + q, 0)}개)`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
