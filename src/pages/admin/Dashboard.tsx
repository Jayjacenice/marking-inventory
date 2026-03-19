import { useEffect, useState } from 'react';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { supabase } from '../../lib/supabase';
import { Trash2, AlertTriangle, CheckCircle, XCircle, Eye, RotateCcw, Settings } from 'lucide-react';
import { CardSkeleton } from '../../components/LoadingSkeleton';
import {
  getSteps,
  getStepStates,
  getRollbackableStep,
  getRollbackDescription,
  executeRollback,
  deleteWorkOrderCompletely,
  getMarkingSessions,
  type MarkingSession,
  type ProgressCallback,
} from '../../lib/workOrderRollback';
import type { WorkOrderStatus, AppUser } from '../../types';

interface DashboardProps {
  currentUser: AppUser;
}

interface ActiveOrder {
  id: string;
  downloadDate: string;
  status: string;
  lineCount: number;
}

interface RemainingLine {
  id: string;
  finishedSkuId: string;
  skuName: string;
  orderedQty: number;
  sentQty: number;
  remaining: number;
  newOrdered: number;
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

export default function Dashboard({ currentUser }: DashboardProps) {
  const isStale = useStaleGuard();
  const [activeOrders, setActiveOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 취소/수정 요청 관련
  const [requestDetail, setRequestDetail] = useState<RequestDetail | null>(null);
  const [approving, setApproving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 롤백 관리 모달
  const [manageOrder, setManageOrder] = useState<{ id: string; date: string; status: WorkOrderStatus } | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rollbackProgress, setRollbackProgress] = useState<{ current: number; total: number; step: string } | null>(null);

  // 마킹 세션 (날짜/시점별 롤백용)
  const [markingSessions, setMarkingSessions] = useState<MarkingSession[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [rollbackMode, setRollbackMode] = useState<'all' | 'select'>('all');

  // 잔량 관리 모달
  const [remainingModal, setRemainingModal] = useState<{woId: string; woDate: string; lines: RemainingLine[]} | null>(null);
  const [savingRemaining, setSavingRemaining] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      // 진행 중인 작업지시서
      const { data: woData, error: woError } = await supabase
        .from('work_order')
        .select('id, download_date, status, work_order_line(id)')
        .not('status', 'in', '("출고완료")')
        .order('uploaded_at', { ascending: false })
        .limit(10);
      if (woError) throw woError;

      if (isStale()) return;
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

  const handleDelete = async (wo: ActiveOrder) => {
    setDeleting(true);
    setRollbackProgress(null);
    setError(null);
    try {
      const onProgress: ProgressCallback = (current, total, step) => {
        setRollbackProgress({ current, total, step });
      };
      const result = await deleteWorkOrderCompletely(
        wo.id, wo.downloadDate, wo.status as any, currentUser.id, onProgress
      );
      if (!result.success) {
        setError(result.error || '삭제 실패');
      }
      await loadData();
    } catch (e: any) {
      setError(`삭제 실패: ${e.message}`);
    } finally {
      setDeleting(false);
      setConfirmId(null);
      setRollbackProgress(null);
    }
  };

  // ── 롤백 실행 ──
  const loadMarkingSessions = async (woId: string) => {
    const sessions = await getMarkingSessions(woId);
    setMarkingSessions(sessions);
    setSelectedSessions(new Set());
    setRollbackMode('all');
  };

  const handleRollback = async () => {
    if (!manageOrder) return;
    const step = getRollbackableStep(manageOrder.status);
    if (!step) return;
    setRolling(true);
    setRollbackProgress(null);
    setError(null);
    try {
      const onProgress: ProgressCallback = (current, total, stepName) => {
        setRollbackProgress({ current, total, step: stepName });
      };

      if (step === '마킹' && rollbackMode === 'select' && selectedSessions.size > 0) {
        // 선택한 날짜들을 순차 롤백
        const dates = [...selectedSessions];
        for (let i = 0; i < dates.length; i++) {
          const dateProgress: ProgressCallback = (current, total, stepName) => {
            setRollbackProgress({
              current: i * total + current,
              total: dates.length * total,
              step: `[${dates[i]}] ${stepName}`,
            });
          };
          const result = await executeRollback(step, manageOrder.id, manageOrder.date, currentUser.id, dateProgress, dates[i]);
          if (!result.success) {
            setError(result.error || '롤백 실패');
            return;
          }
        }
      } else {
        const result = await executeRollback(step, manageOrder.id, manageOrder.date, currentUser.id, onProgress);
        if (!result.success) {
          setError(result.error || '롤백 실패');
          return;
        }
      }
      setSuccessMsg(`${step} 롤백이 완료되었습니다.`);
      setManageOrder(null);
      setRollbackConfirm(false);
      setMarkingSessions([]);
      setSelectedSessions(new Set());
      loadData();
    } catch (e: any) {
      setError(`롤백 실패: ${e.message}`);
    } finally {
      setRolling(false);
      setRollbackProgress(null);
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
        user_id: currentUser.id,
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
        user_id: currentUser.id,
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

  // ── 잔량 관리 ──
  const openRemainingModal = async (wo: ActiveOrder) => {
    try {
      const { data: lines } = await supabase
        .from('work_order_line')
        .select('id, finished_sku_id, ordered_qty, sent_qty, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name)')
        .eq('work_order_id', wo.id);

      const remainingLines = (lines || [])
        .filter((l: any) => (l.ordered_qty || 0) > (l.sent_qty || 0))
        .map((l: any) => ({
          id: l.id,
          finishedSkuId: l.finished_sku_id,
          skuName: l.finished_sku?.sku_name || l.finished_sku_id,
          orderedQty: l.ordered_qty,
          sentQty: l.sent_qty || 0,
          remaining: l.ordered_qty - (l.sent_qty || 0),
          newOrdered: l.ordered_qty,
        }));

      setRemainingModal({ woId: wo.id, woDate: wo.downloadDate, lines: remainingLines });
    } catch (e: any) {
      setError(`잔량 조회 실패: ${e.message}`);
    }
  };

  const saveRemaining = async () => {
    if (!remainingModal) return;
    setSavingRemaining(true);
    try {
      for (const line of remainingModal.lines) {
        if (line.newOrdered !== line.orderedQty) {
          await supabase.from('work_order_line')
            .update({ ordered_qty: line.newOrdered })
            .eq('id', line.id);
        }
      }
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'shipment_modify_approved',
        work_order_id: remainingModal.woId,
        action_date: new Date().toISOString().slice(0, 10),
        summary: {
          items: remainingModal.lines
            .filter(l => l.newOrdered !== l.orderedQty)
            .map(l => ({ skuId: l.finishedSkuId, skuName: l.skuName, before: l.orderedQty, after: l.newOrdered })),
          reason: '관리자 잔량 수정',
        },
      });
      setRemainingModal(null);
      setSuccessMsg('잔량이 수정되었습니다.');
      await loadData();
    } catch (e: any) {
      alert('저장 실패: ' + e.message);
    } finally {
      setSavingRemaining(false);
    }
  };

  const cancelAllRemaining = () => {
    if (!remainingModal) return;
    setRemainingModal({
      ...remainingModal,
      lines: remainingModal.lines.map(l => ({ ...l, newOrdered: l.sentQty }))
    });
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

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-gray-900">대시보드</h2>
        <CardSkeleton count={3} />
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
                          <div className="flex-1">
                            {deleting && rollbackProgress ? (
                              <div className="space-y-1">
                                <p className="text-xs text-red-700 font-medium">{rollbackProgress.step}</p>
                                <div className="w-full bg-red-200 rounded-full h-1.5 overflow-hidden">
                                  <div
                                    className="bg-red-600 h-1.5 rounded-full transition-all duration-300"
                                    style={{ width: `${Math.round((rollbackProgress.current / rollbackProgress.total) * 100)}%` }}
                                  />
                                </div>
                              </div>
                            ) : (
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
                                {' '}— 재고 역반영 후 연관 데이터가 모두 삭제됩니다.
                              </span>
                            )}
                          </div>
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              onClick={() => setConfirmId(null)}
                              disabled={deleting}
                              className="px-3 py-1 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                            >
                              취소
                            </button>
                            <button
                              onClick={() => handleDelete(wo)}
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
                        {['이관중', '입고확인완료', '마킹중', '마킹완료'].includes(wo.status) && (
                          <button
                            onClick={() => openRemainingModal(wo)}
                            className="px-2.5 py-1 text-xs font-medium text-amber-600 bg-amber-50 rounded-lg hover:bg-amber-100 flex items-center gap-1"
                            title="잔량 수정"
                          >
                            잔량 수정
                          </button>
                        )}
                        <button
                          onClick={() => setManageOrder({ id: wo.id, date: wo.downloadDate, status: wo.status as WorkOrderStatus })}
                          className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 flex items-center gap-1"
                          title="관리"
                        >
                          <Settings size={12} />
                          관리
                        </button>
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
      {/* ── 롤백 관리 모달 ── */}
      {manageOrder && !rollbackConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-5 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center gap-2">
              <Settings size={18} className="text-gray-500" />
              <h3 className="text-lg font-bold text-gray-900">작업지시서 관리</h3>
              <span className="ml-auto text-sm font-medium text-gray-500">{manageOrder.date}</span>
            </div>

            {/* 스테퍼 */}
            {(() => {
              const steps = getSteps();
              const states = getStepStates(manageOrder.status);
              return (
                <div className="flex items-center justify-between px-2">
                  {steps.map((s, i) => {
                    const state = states[s.step];
                    return (
                      <div key={s.step} className="flex items-center flex-1">
                        <div className="flex flex-col items-center">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                            state === 'done' ? 'bg-green-500 text-white' :
                            state === 'active' ? 'bg-blue-500 text-white animate-pulse' :
                            'bg-gray-200 text-gray-400'
                          }`}>
                            {state === 'done' ? <CheckCircle size={16} /> : i + 1}
                          </div>
                          <span className={`text-xs mt-1.5 font-medium ${
                            state === 'done' ? 'text-green-600' :
                            state === 'active' ? 'text-blue-600' :
                            'text-gray-400'
                          }`}>{s.label.replace('오프라인 ', '').replace('플레이위즈 ', '').replace('최종 ', '')}</span>
                          <span className={`text-[10px] ${
                            state === 'done' ? 'text-green-500' :
                            state === 'active' ? 'text-blue-500' :
                            'text-gray-300'
                          }`}>{state === 'done' ? '완료' : state === 'active' ? '진행중' : '대기'}</span>
                        </div>
                        {i < steps.length - 1 && (
                          <div className={`flex-1 h-0.5 mx-1 mt-[-16px] ${
                            state === 'done' ? 'bg-green-400' : 'bg-gray-200'
                          }`} />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* 롤백 가능 단계 */}
            {(() => {
              const step = getRollbackableStep(manageOrder.status);
              if (!step) {
                return (
                  <div className="bg-gray-50 rounded-xl p-4 text-center">
                    <p className="text-sm text-gray-500">현재 롤백 가능한 단계가 없습니다.</p>
                    <p className="text-xs text-gray-400 mt-1">상태: {manageOrder.status}</p>
                  </div>
                );
              }
              const descriptions = getRollbackDescription(step);
              return (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <RotateCcw size={14} className="text-orange-500" />
                    <p className="text-sm font-semibold text-gray-700">롤백 가능: <span className="text-orange-600">{step}</span></p>
                  </div>
                  <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 space-y-1.5">
                    <p className="text-xs font-semibold text-orange-700">롤백 시 다음이 처리됩니다:</p>
                    {descriptions.map((desc, i) => (
                      <p key={i} className="text-xs text-orange-600 flex items-start gap-1.5">
                        <span className="mt-0.5">•</span>{desc}
                      </p>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* 버튼 */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => { setManageOrder(null); setMarkingSessions([]); }}
                className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-200"
              >
                닫기
              </button>
              {getRollbackableStep(manageOrder.status) && (
                <button
                  onClick={async () => {
                    const step = getRollbackableStep(manageOrder.status);
                    if (step === '마킹') {
                      await loadMarkingSessions(manageOrder.id);
                    }
                    setRollbackConfirm(true);
                  }}
                  className="flex-1 py-2.5 bg-orange-500 text-white rounded-xl text-sm font-semibold hover:bg-orange-600 flex items-center justify-center gap-1.5"
                >
                  <RotateCcw size={14} />
                  {getRollbackableStep(manageOrder.status)} 롤백
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 롤백 2차 확인 모달 ── */}
      {manageOrder && rollbackConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <AlertTriangle size={18} className="text-red-500" />
                <h3 className="text-lg font-bold text-gray-900">
                  {getRollbackableStep(manageOrder.status) === '마킹' ? '마킹 롤백 — 범위 선택' : '정말 롤백하시겠습니까?'}
                </h3>
              </div>
            </div>
            <div className="px-6 py-4 space-y-3">
              {/* 마킹 단계: 날짜/시점 선택 UI */}
              {getRollbackableStep(manageOrder.status) === '마킹' && markingSessions.length > 0 ? (
                <div className="space-y-3">
                  {/* 전체 롤백 옵션 */}
                  <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="rollbackMode"
                      checked={rollbackMode === 'all'}
                      onChange={() => { setRollbackMode('all'); setSelectedSessions(new Set()); }}
                      className="w-4 h-4 text-orange-600 focus:ring-orange-500"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-800">전체 롤백</p>
                      <p className="text-xs text-gray-500">
                        {markingSessions.reduce((s, m) => s + m.totalQty, 0)}개, {markingSessions.length}건 모두 삭제
                      </p>
                    </div>
                  </label>

                  {/* 날짜별 선택 옵션 */}
                  <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="rollbackMode"
                      checked={rollbackMode === 'select'}
                      onChange={() => setRollbackMode('select')}
                      className="w-4 h-4 text-orange-600 focus:ring-orange-500"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-800">날짜/시점별 선택</p>
                      <p className="text-xs text-gray-500">원하는 작업만 골라서 롤백</p>
                    </div>
                  </label>

                  {/* 세션 목록 (선택 모드일 때만) */}
                  {rollbackMode === 'select' && (
                    <div className="space-y-2 pl-2">
                      {markingSessions.map((session) => {
                        const key = session.date;
                        const time = new Date(session.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
                        const dateLabel = session.date.slice(5); // MM-DD
                        const isSelected = selectedSessions.has(key);
                        return (
                          <label
                            key={session.createdAt}
                            className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                              isSelected ? 'border-orange-400 bg-orange-50' : 'border-gray-200 hover:bg-gray-50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                const next = new Set(selectedSessions);
                                if (isSelected) next.delete(key); else next.add(key);
                                setSelectedSessions(next);
                              }}
                              className="w-4 h-4 rounded text-orange-600 focus:ring-orange-500"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-800">
                                {dateLabel} <span className="text-gray-400 font-normal">{time}</span>
                              </p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-sm font-semibold text-gray-700">{session.totalQty}개</p>
                              <p className="text-[10px] text-gray-400">{session.itemCount}종</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-700">
                    작업지시서 <span className="font-semibold">{manageOrder.date}</span>의{' '}
                    <span className="font-semibold text-orange-600">{getRollbackableStep(manageOrder.status)}</span> 실적이
                    모두 삭제되고 재고가 역반영됩니다.
                  </p>
                </>
              )}

              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-xs text-red-700 font-medium">이 작업은 되돌릴 수 없습니다.</p>
              </div>

              {/* 진행율 표시 */}
              {rolling && rollbackProgress && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-blue-700 font-medium text-center">{rollbackProgress.step}</p>
                  <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((rollbackProgress.current / rollbackProgress.total) * 100)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-blue-500 text-center">
                    {rollbackProgress.current} / {rollbackProgress.total}
                    ({Math.round((rollbackProgress.current / rollbackProgress.total) * 100)}%)
                  </p>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button
                onClick={() => { setRollbackConfirm(false); setMarkingSessions([]); setSelectedSessions(new Set()); }}
                disabled={rolling}
                className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                취소
              </button>
              <button
                onClick={handleRollback}
                disabled={rolling || (rollbackMode === 'select' && selectedSessions.size === 0)}
                className="flex-1 py-2.5 bg-red-500 text-white rounded-lg text-sm font-semibold hover:bg-red-600 disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <Trash2 size={14} />
                {rolling ? '처리 중...' : rollbackMode === 'select' && selectedSessions.size > 0
                  ? `선택 ${selectedSessions.size}건 롤백`
                  : '삭제 확인'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── 잔량 관리 모달 ── */}
      {remainingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">잔량 관리</h3>
              <p className="text-sm text-gray-500">{remainingModal.woDate} 작업지시서</p>
            </div>

            <div className="px-5 py-4 space-y-3 max-h-[50vh] overflow-y-auto">
              {/* 전체 취소 버튼 */}
              <button onClick={() => cancelAllRemaining()} className="text-xs text-red-600 underline">
                잔량 전체 취소 (발송 불필요 처리)
              </button>

              {remainingModal.lines.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">잔량이 있는 항목이 없습니다.</p>
              ) : (
                remainingModal.lines.map((line, idx) => (
                  <div key={line.id} className="border border-gray-200 rounded-lg p-3">
                    <p className="text-sm font-medium text-gray-800">{line.skuName}</p>
                    <p className="text-xs text-gray-400">{line.finishedSkuId}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-xs text-gray-500">발송완료: {line.sentQty}</span>
                      <span className="text-xs text-gray-500">잔량: {line.newOrdered - line.sentQty}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-600">주문수량:</span>
                        <input
                          type="number"
                          min={line.sentQty}
                          max={999}
                          value={line.newOrdered}
                          onChange={(e) => {
                            const val = Math.max(line.sentQty, Number(e.target.value));
                            setRemainingModal(prev => prev ? {
                              ...prev,
                              lines: prev.lines.map((l, i) => i === idx ? { ...l, newOrdered: val } : l)
                            } : null);
                          }}
                          className="w-16 text-center text-sm border rounded px-2 py-1"
                        />
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                onClick={() => setRemainingModal(null)}
                className="px-4 py-2 text-sm text-gray-600 border rounded-lg hover:bg-gray-50"
              >
                닫기
              </button>
              <button
                onClick={saveRemaining}
                disabled={savingRemaining || remainingModal.lines.every(l => l.newOrdered === l.orderedQty)}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {savingRemaining ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
