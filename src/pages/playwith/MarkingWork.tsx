import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertTriangle, CheckCircle, Clock } from 'lucide-react';

interface MarkingItem {
  lineId: string;
  finishedSkuId: string;
  skuName: string;
  remainingQty: number; // 아직 마킹 안 된 수량
  todayQty: number;     // 오늘 완료할 수량 (입력값)
  markedQty: number;    // 누적 완료 수량
}

interface ActiveOrder {
  id: string;
  download_date: string;
}

export default function MarkingWork() {
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<ActiveOrder | null>(null);
  const [items, setItems] = useState<MarkingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0];

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
        .in('status', ['입고확인완료', '마킹중'])
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      const list = (data || []) as ActiveOrder[];
      setOrders(list);
      if (list.length > 0) selectOrder(list[0]);
      else setLoading(false);
    } catch (e: any) {
      setError(`데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
      setLoading(false);
    }
  };

  const selectOrder = async (wo: ActiveOrder) => {
    setSelectedOrder(wo);
    setLoading(true);
    setSaved(false);
    setError(null);
    try {
      // 마킹이 필요한 라인만 조회
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, received_qty, marked_qty, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name)')
        .eq('work_order_id', wo.id)
        .eq('needs_marking', true);
      if (linesErr) throw linesErr;

      // 오늘 이미 입력된 마킹 수량 조회
      const { data: todayMarkings, error: markingErr } = await supabase
        .from('daily_marking')
        .select('work_order_line_id, completed_qty')
        .eq('date', today)
        .in('work_order_line_id', (lines || []).map((l: any) => l.id));
      if (markingErr) throw markingErr;

      const todayMap: Record<string, number> = {};
      for (const m of (todayMarkings || []) as any[]) {
        todayMap[m.work_order_line_id] = m.completed_qty;
      }

      const markingItems: MarkingItem[] = ((lines || []) as any[])
        .filter((line) => line.received_qty - line.marked_qty > 0)
        .map((line) => ({
          lineId: line.id,
          finishedSkuId: line.finished_sku_id,
          skuName: line.finished_sku?.sku_name || line.finished_sku_id,
          remainingQty: line.received_qty - line.marked_qty,
          todayQty: todayMap[line.id] || 0,
          markedQty: line.marked_qty,
        }));

      setItems(markingItems);
    } catch (e: any) {
      setError(`마킹 데이터 조회 실패: ${e.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleQtyChange = (lineId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.lineId !== lineId) return item;
        const clamped = Math.max(0, Math.min(value, item.remainingQty));
        return { ...item, todayQty: clamped };
      })
    );
  };

  const totalToday = items.reduce((sum, item) => sum + item.todayQty, 0);
  const allComplete = items.every((item) => item.todayQty >= item.remainingQty);

  const handleSave = async () => {
    if (!selectedOrder) return;
    setSaving(true);
    setSaveProgress(null);
    setError(null);
    try {
      const activeItems = items.filter((item) => item.todayQty > 0);
      const total = activeItems.length + 1;
      let processed = 0;

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
        const diff = item.todayQty - previousQty; // 실제 증가분

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

        // work_order_line marked_qty 업데이트 (DB에서 현재값을 다시 읽어 동시성 문제 방지)
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
      }

      // 모두 완료됐으면 상태 업데이트
      setSaveProgress({ current: total, total, step: '완료 상태 업데이트 중...' });
      const { data: allLines, error: allLinesErr } = await supabase
        .from('work_order_line')
        .select('received_qty, marked_qty')
        .eq('work_order_id', selectedOrder.id)
        .eq('needs_marking', true);
      if (allLinesErr) throw allLinesErr;

      const allDone = ((allLines || []) as any[]).every(
        (l) => l.marked_qty >= l.received_qty
      );

      const { error: statusErr } = await supabase
        .from('work_order')
        .update({ status: allDone ? '마킹완료' : '마킹중' })
        .eq('id', selectedOrder.id);
      if (statusErr) throw statusErr;

      setSaved(true);
    } catch (e: any) {
      setError(`마킹 저장 실패: ${e.message || '알 수 없는 오류'}. 잠시 후 다시 시도해주세요.`);
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">불러오는 중...</div>;
  }

  if (orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-600 font-medium">오늘 작업할 마킹 물량이 없습니다</p>
        </div>
      </div>
    );
  }

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
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">마킹 작업</h2>
        <span className="text-sm text-gray-500">{today}</span>
      </div>

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
            <option key={wo.id} value={wo.id}>{wo.download_date}</option>
          ))}
        </select>
      )}

      {saved ? (
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
      ) : (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-50">
              <h3 className="font-medium text-gray-900">🔨 오늘 작업 목록</h3>
              <p className="text-xs text-gray-400 mt-0.5">완료된 수량을 입력하세요 (미완료분은 내일 이월)</p>
            </div>

            {items.length === 0 ? (
              <div className="px-5 py-8 text-center text-gray-400 text-sm">
                모든 마킹 작업이 완료되었습니다
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {items.map((item) => {
                  const isComplete = item.todayQty >= item.remainingQty;
                  return (
                    <div key={item.lineId} className={`px-5 py-3.5 flex items-center gap-3 ${isComplete ? 'bg-green-50' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{item.skuName}</p>
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
                })}
              </div>
            )}

            {items.length > 0 && (
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <p className="text-sm text-gray-600">
                  물류센터 발송 합계:
                </p>
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
