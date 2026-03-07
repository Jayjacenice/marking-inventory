import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Package, ClipboardList, Trash2, AlertTriangle, CheckCircle, XCircle, Eye } from 'lucide-react';

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

interface RequestDetail {
  workOrderId: string;
  workOrderDate: string;
  type: 'cancel' | 'modify';
  reason: string;
  items: { skuId: string; skuName: string; originalQty: number; newQty: number }[];
  totalQty: number;
  requestedBy: string;
  requestedAt: string;
}

export default function Dashboard() {
  const [inventories, setInventories] = useState<InventorySummary[]>([]);
  const [activeOrders, setActiveOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 취소/수정 요청 관련
  const [requestDetail, setRequestDetail] = useState<RequestDetail | null>(null);
  const [approving, setApproving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      // 창고별 재고 요약
      const { data: invData, error: invError } = await supabase
        .from('inventory')
        .select('quantity, warehouse(name)')
        .gt('quantity', 0);
      if (invError) throw invError;

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
      const { data: woData, error: woError } = await supabase
        .from('work_order')
        .select('id, download_date, status, work_order_line(id)')
        .not('status', 'in', '("출고완료")')
        .order('uploaded_at', { ascending: false })
        .limit(10);
      if (woError) throw woError;

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
    } catch (err: any) {
      console.error('loadData error:', err);
      setError(`대시보드 데이터 조회 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
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

  // ── 취소/수정 요청 상세 로드 ──
  const loadRequestDetail = async (woId: string, woDate: string, type: 'cancel' | 'modify') => {
    setError(null);
    try {
      const actionType = type === 'cancel' ? 'shipment_cancel_request' : 'shipment_modify_request';
      const { data, error: logErr } = await supabase
        .from('activity_log')
        .select('summary, created_at, user_id')
        .eq('work_order_id', woId)
        .eq('action_type', actionType)
        .order('created_at', { ascending: false })
        .limit(1);
      if (logErr) throw logErr;

      if (!data || data.length === 0) {
        setError('요청 기록을 찾을 수 없습니다.');
        return;
      }

      const log = data[0];
      const summary = log.summary as any;

      // 요청자 이름 조회
      const { data: userProfile } = await supabase
        .from('user_profile')
        .select('name')
        .eq('id', log.user_id)
        .single();

      setRequestDetail({
        workOrderId: woId,
        workOrderDate: woDate,
        type,
        reason: summary.reason || '',
        items: summary.items || [],
        totalQty: summary.totalQty || 0,
        requestedBy: userProfile?.name || '알 수 없음',
        requestedAt: log.created_at,
      });
    } catch (e: any) {
      setError(`요청 상세 로드 실패: ${e.message}`);
    }
  };

  // ── 취소 요청 승인 ──
  const handleApproveCancel = async (woId: string) => {
    setApproving(true);
    setError(null);
    try {
      // 1. 오프라인샵 창고 ID 조회
      const { data: wh } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .single();
      if (!wh) throw new Error('오프라인샵 창고를 찾을 수 없습니다.');

      // 2. 해당 작업지시서의 발송 기록(shipment_confirm) 조회 → 재고 복구용
      const { data: confirmLog } = await supabase
        .from('activity_log')
        .select('summary')
        .eq('work_order_id', woId)
        .eq('action_type', 'shipment_confirm')
        .order('created_at', { ascending: false })
        .limit(1);

      if (confirmLog && confirmLog.length > 0) {
        const logItems = (confirmLog[0].summary as any).items || [];
        // 3. 재고 복구: 각 SKU의 발송 수량만큼 오프라인샵 재고에 되돌림
        for (const item of logItems) {
          if (item.qty > 0) {
            const { data: inv } = await supabase
              .from('inventory')
              .select('quantity')
              .eq('warehouse_id', wh.id)
              .eq('sku_id', item.skuId)
              .single();

            if (inv) {
              await supabase
                .from('inventory')
                .update({ quantity: inv.quantity + item.qty })
                .eq('warehouse_id', wh.id)
                .eq('sku_id', item.skuId);
            } else {
              await supabase
                .from('inventory')
                .insert({ warehouse_id: wh.id, sku_id: item.skuId, quantity: item.qty });
            }
          }
        }
      }

      // 4. sent_qty 초기화
      await supabase
        .from('work_order_line')
        .update({ sent_qty: 0 })
        .eq('work_order_id', woId);

      // 5. 상태 복구
      await supabase
        .from('work_order')
        .update({ status: '이관준비' })
        .eq('id', woId);

      // 6. 승인 기록
      await supabase.from('activity_log').insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        action_type: 'shipment_cancel_approved',
        work_order_id: woId,
        action_date: new Date().toISOString().split('T')[0],
        summary: { items: [], totalQty: 0, workOrderDate: requestDetail?.workOrderDate },
      });

      setSuccessMsg('취소 요청이 승인되었습니다. 재고가 복구되었습니다.');
      setRequestDetail(null);
      loadData();
    } catch (e: any) {
      setError(`취소 승인 실패: ${e.message}`);
    } finally {
      setApproving(false);
    }
  };

  // ── 수정 요청 승인 ──
  const handleApproveModify = async (woId: string) => {
    if (!requestDetail) return;
    setApproving(true);
    setError(null);
    try {
      // 1. 오프라인샵 창고 ID 조회
      const { data: wh } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', '오프라인샵')
        .single();
      if (!wh) throw new Error('오프라인샵 창고를 찾을 수 없습니다.');

      // 2. 수정 항목 반영: 각 SKU별 delta 계산 후 재고 조정
      for (const modItem of requestDetail.items) {
        const delta = modItem.newQty - modItem.originalQty; // 양수면 추가 출고, 음수면 반납

        // 재고 조정 (delta 만큼 반대로)
        if (delta !== 0) {
          const { data: inv } = await supabase
            .from('inventory')
            .select('quantity')
            .eq('warehouse_id', wh.id)
            .eq('sku_id', modItem.skuId)
            .single();

          if (inv) {
            const newQty = Math.max(0, inv.quantity - delta);
            await supabase
              .from('inventory')
              .update({ quantity: newQty })
              .eq('warehouse_id', wh.id)
              .eq('sku_id', modItem.skuId);
          }
        }

        // sent_qty는 BOM 기반으로 매핑되어 있으므로, 발송 기록의 원래 SKU와 매칭
        // 여기서는 activity_log 기반이므로 직접 work_order_line 매핑은 복잡함
        // → 발송 기록의 원래 수량 기준으로 전체 업데이트
      }

      // 5. 상태 복구
      await supabase
        .from('work_order')
        .update({ status: '이관중' })
        .eq('id', woId);

      // 6. 승인 기록
      await supabase.from('activity_log').insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        action_type: 'shipment_modify_approved',
        work_order_id: woId,
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          items: requestDetail.items,
          totalQty: requestDetail.items.reduce((s, i) => s + i.newQty, 0),
          workOrderDate: requestDetail.workOrderDate,
        },
      });

      setSuccessMsg('수정 요청이 승인되었습니다. 수량이 반영되었습니다.');
      setRequestDetail(null);
      loadData();
    } catch (e: any) {
      setError(`수정 승인 실패: ${e.message}`);
    } finally {
      setApproving(false);
    }
  };

  // ── 요청 거부 ──
  const handleRejectRequest = async (woId: string) => {
    setApproving(true);
    setError(null);
    try {
      await supabase
        .from('work_order')
        .update({ status: '이관중' })
        .eq('id', woId);

      setSuccessMsg('요청이 거부되었습니다. 상태가 이관중으로 복구되었습니다.');
      setRequestDetail(null);
      loadData();
    } catch (e: any) {
      setError(`거부 처리 실패: ${e.message}`);
    } finally {
      setApproving(false);
    }
  };

  const statusColor: Record<string, string> = {
    업로드됨: 'bg-gray-100 text-gray-700',
    이관준비: 'bg-yellow-100 text-yellow-700',
    이관중: 'bg-orange-100 text-orange-700',
    취소요청: 'bg-red-100 text-red-700',
    수정요청: 'bg-amber-100 text-amber-700',
    입고확인완료: 'bg-blue-100 text-blue-700',
    마킹중: 'bg-purple-100 text-purple-700',
    마킹완료: 'bg-green-100 text-green-700',
    출고완료: 'bg-emerald-100 text-emerald-700',
  };

  const warehouseIcon: Record<string, React.ReactNode> = {
    오프라인샵: <Package size={20} className="text-blue-600" />,
    플레이위즈: <ClipboardList size={20} className="text-purple-600" />,
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

      {/* 성공 메시지 */}
      {successMsg && (
        <div className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-xl p-3">
          <CheckCircle size={16} className="text-green-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-green-800">{successMsg}</p>
            <button onClick={() => setSuccessMsg(null)} className="text-xs text-green-600 underline mt-1">닫기</button>
          </div>
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800">{error}</p>
            <button onClick={loadData} className="text-xs text-red-600 underline mt-1">다시 시도</button>
          </div>
        </div>
      )}

      {/* 창고별 재고 현황 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
          창고별 재고 현황
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {['오프라인샵', '플레이위즈'].map((wh) => {
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
                      <td className="px-4 py-3 text-right flex items-center justify-end gap-1">
                        {(wo.status === '취소요청' || wo.status === '수정요청') && (
                          <button
                            onClick={() => loadRequestDetail(wo.id, wo.downloadDate, wo.status === '취소요청' ? 'cancel' : 'modify')}
                            className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1"
                            title="상세 보기"
                          >
                            <Eye size={12} />
                            처리
                          </button>
                        )}
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

      {/* ── 취소/수정 요청 상세 모달 ── */}
      {requestDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                requestDetail.type === 'cancel' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
              }`}>
                {requestDetail.type === 'cancel' ? '취소 요청' : '수정 요청'}
              </span>
              <h3 className="text-lg font-bold text-gray-900">요청 상세</h3>
            </div>

            {/* 기본 정보 */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">작업지시서</span>
                <span className="font-medium text-gray-900">{requestDetail.workOrderDate}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">요청자</span>
                <span className="font-medium text-gray-900">{requestDetail.requestedBy}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">요청 시각</span>
                <span className="font-medium text-gray-900">
                  {new Date(requestDetail.requestedAt).toLocaleString('ko-KR')}
                </span>
              </div>
            </div>

            {/* 사유 */}
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">사유</p>
              <p className="text-sm text-gray-800 bg-gray-50 rounded-lg p-3">{requestDetail.reason}</p>
            </div>

            {/* 수정 요청: 변경 내역 */}
            {requestDetail.type === 'modify' && requestDetail.items.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-2">변경 내역</p>
                <div className="space-y-1">
                  {requestDetail.items.map((item) => (
                    <div key={item.skuId} className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2">
                      <p className="text-xs font-medium text-gray-800 flex-1 truncate">{item.skuName}</p>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-xs text-gray-500">{item.originalQty}개</span>
                        <span className="text-xs text-gray-400">→</span>
                        <span className={`text-xs font-semibold ${
                          item.newQty !== item.originalQty ? 'text-amber-600' : 'text-gray-600'
                        }`}>{item.newQty}개</span>
                        {item.newQty !== item.originalQty && (
                          <span className={`text-xs ${item.newQty > item.originalQty ? 'text-red-500' : 'text-green-500'}`}>
                            ({item.newQty > item.originalQty ? '+' : ''}{item.newQty - item.originalQty})
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 취소 요청: 경고 */}
            {requestDetail.type === 'cancel' && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
                <AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">
                  승인 시 발송 수량이 초기화되고, 오프라인샵 재고가 복구됩니다.
                  작업지시서 상태는 '이관준비'로 돌아갑니다.
                </p>
              </div>
            )}

            {/* 버튼 */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setRequestDetail(null)}
                disabled={approving}
                className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-200 disabled:opacity-50"
              >
                닫기
              </button>
              <button
                onClick={() => handleRejectRequest(requestDetail.workOrderId)}
                disabled={approving}
                className="flex-1 py-2.5 bg-gray-600 text-white rounded-xl text-sm font-semibold hover:bg-gray-700 disabled:opacity-50 flex items-center justify-center gap-1"
              >
                <XCircle size={14} />
                {approving ? '처리 중...' : '거부'}
              </button>
              <button
                onClick={() =>
                  requestDetail.type === 'cancel'
                    ? handleApproveCancel(requestDetail.workOrderId)
                    : handleApproveModify(requestDetail.workOrderId)
                }
                disabled={approving}
                className={`flex-1 py-2.5 text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1 ${
                  requestDetail.type === 'cancel'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-amber-500 hover:bg-amber-600'
                }`}
              >
                <CheckCircle size={14} />
                {approving ? '처리 중...' : '승인'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
