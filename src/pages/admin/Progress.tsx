import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';

/* ── 타입 ── */
interface WoOption {
  id: string;
  download_date: string;
  status: string;
}

interface StageStats {
  ordered: number;
  sent: number;
  received: number;
  markedTarget: number;   // 마킹 필요 라인의 received_qty 합
  marked: number;
  shippedOut: number;     // 최종 출고
}

interface SkuRow {
  skuId: string;
  skuName: string;
  needsMarking: boolean;
  ordered: number;
  sent: number;
  received: number;
  marked: number | null;  // null = 마킹 불필요
  shippedOut: number;
  stage: string;          // 현재 상태 텍스트
  stageColor: string;     // tailwind 색상
}

interface ActivityItem {
  id: string;
  actionType: string;
  userName: string;
  createdAt: string;
  totalQty: number;
  summary: any;
}

/* ── 상태 판별 ── */
function getStage(row: SkuRow): { stage: string; color: string } {
  if (row.shippedOut >= row.ordered && row.ordered > 0) return { stage: '출고완료', color: 'green' };
  if (row.needsMarking && row.marked !== null && row.marked >= row.received && row.received > 0) return { stage: '마킹완료', color: 'purple' };
  if (row.received >= row.sent && row.sent > 0) return { stage: '입고완료', color: 'blue' };
  if (row.sent > 0 && row.sent < row.ordered) return { stage: '발송중', color: 'yellow' };
  if (row.sent >= row.ordered && row.ordered > 0) return { stage: '발송완료', color: 'teal' };
  if (row.ordered > 0 && row.sent === 0) return { stage: '발송대기', color: 'gray' };
  return { stage: '-', color: 'gray' };
}

/* ── 액션 타입 라벨 ── */
const actionLabels: Record<string, { label: string; color: string }> = {
  shipment_confirm: { label: '발송 확인', color: 'blue' },
  receipt_check: { label: '입고 확인', color: 'teal' },
  marking_work: { label: '마킹 작업', color: 'purple' },
  shipment_out: { label: '출고 확인', color: 'green' },
  shipment_cancel_request: { label: '취소 요청', color: 'red' },
  shipment_cancel_approved: { label: '취소 승인', color: 'red' },
  shipment_modify_request: { label: '수정 요청', color: 'orange' },
  shipment_modify_approved: { label: '수정 승인', color: 'orange' },
  rollback_shipment: { label: '발송 롤백', color: 'red' },
  rollback_receipt: { label: '입고 롤백', color: 'red' },
  rollback_marking: { label: '마킹 롤백', color: 'red' },
  rollback_shipment_out: { label: '출고 롤백', color: 'red' },
};

/* ── 프로그레스 바 ── */
function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bgMap: Record<string, string> = {
    blue: 'bg-blue-500',
    teal: 'bg-teal-500',
    purple: 'bg-purple-500',
    green: 'bg-green-500',
  };
  return (
    <div className="w-full bg-gray-200 rounded-full h-2.5">
      <div className={`${bgMap[color] || 'bg-blue-500'} h-2.5 rounded-full transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ── 스테이지 카드 ── */
function StageCard({ label, value, max, color, icon }: { label: string; value: number; max: number; color: string; icon: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const textMap: Record<string, string> = {
    blue: 'text-blue-600',
    teal: 'text-teal-600',
    purple: 'text-purple-600',
    green: 'text-green-600',
  };
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 flex-1 min-w-[140px]">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{icon}</span>
        <span className="text-sm font-medium text-gray-700">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${textMap[color] || 'text-gray-800'}`}>
        {value} <span className="text-sm font-normal text-gray-400">/ {max}</span>
      </div>
      <div className="mt-2">
        <ProgressBar value={value} max={max} color={color} />
      </div>
      <p className="text-xs text-gray-400 mt-1 text-right">{pct}%</p>
    </div>
  );
}

/* ── 메인 컴포넌트 ── */
export default function Progress() {
  const [workOrders, setWorkOrders] = useState<WoOption[]>([]);
  const [selectedWoId, setSelectedWoId] = useState<string>('all');
  const [stats, setStats] = useState<StageStats>({ ordered: 0, sent: 0, received: 0, markedTarget: 0, marked: 0, shippedOut: 0 });
  const [skuRows, setSkuRows] = useState<SkuRow[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  useLoadingTimeout(loading, setLoading);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<'skuName' | 'ordered' | 'stage'>('skuName');
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [skuActivities, setSkuActivities] = useState<ActivityItem[]>([]);

  // WO 목록 로드
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .order('download_date', { ascending: false });
      setWorkOrders((data || []) as WoOption[]);
    })();
  }, []);

  // 메인 데이터 로드
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // work_order_line 조회
      let query = supabase
        .from('work_order_line')
        .select('finished_sku_id, ordered_qty, sent_qty, received_qty, marked_qty, needs_marking, work_order_id, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_name)');

      if (selectedWoId !== 'all') {
        query = query.eq('work_order_id', selectedWoId);
      }

      const { data: lines } = await query;
      if (!lines) { setLoading(false); return; }

      // 출고 실적: activity_log에서 shipment_out 조회
      let actQuery = supabase
        .from('activity_log')
        .select('summary')
        .eq('action_type', 'shipment_out');
      if (selectedWoId !== 'all') {
        actQuery = actQuery.eq('work_order_id', selectedWoId);
      }
      const { data: shipOutLogs } = await actQuery;

      // 출고 수량 집계 (SKU별)
      const shippedMap: Record<string, number> = {};
      for (const log of (shipOutLogs || []) as any[]) {
        const items = log.summary?.items || [];
        for (const item of items) {
          const key = item.skuId || item.sku_id;
          if (key) shippedMap[key] = (shippedMap[key] || 0) + (item.shipQty || item.sentQty || item.qty || 0);
        }
      }

      // SKU별 집계
      const skuMap: Record<string, SkuRow> = {};
      for (const line of lines as any[]) {
        const skuId = line.finished_sku_id;
        const skuName = line.finished_sku?.sku_name || skuId;
        if (!skuMap[skuId]) {
          skuMap[skuId] = {
            skuId,
            skuName,
            needsMarking: false,
            ordered: 0,
            sent: 0,
            received: 0,
            marked: null,
            shippedOut: shippedMap[skuId] || 0,
            stage: '',
            stageColor: '',
          };
        }
        skuMap[skuId].ordered += line.ordered_qty || 0;
        skuMap[skuId].sent += line.sent_qty || 0;
        skuMap[skuId].received += line.received_qty || 0;
        if (line.needs_marking) {
          skuMap[skuId].needsMarking = true;
          skuMap[skuId].marked = (skuMap[skuId].marked || 0) + (line.marked_qty || 0);
        }
      }

      // 상태 판별
      const rows = Object.values(skuMap).map((r) => {
        const { stage, color } = getStage(r);
        return { ...r, stage, stageColor: color };
      });

      // 전체 통계
      const totals: StageStats = { ordered: 0, sent: 0, received: 0, markedTarget: 0, marked: 0, shippedOut: 0 };
      for (const r of rows) {
        totals.ordered += r.ordered;
        totals.sent += r.sent;
        totals.received += r.received;
        if (r.needsMarking) {
          totals.markedTarget += r.received;
          totals.marked += r.marked || 0;
        }
        totals.shippedOut += r.shippedOut;
      }

      setStats(totals);
      setSkuRows(rows);

      // 최근 활동 로드
      let logQuery = supabase
        .from('activity_log')
        .select('id, action_type, summary, created_at, user:users!activity_log_user_id_fkey(name, email)')
        .order('created_at', { ascending: false })
        .limit(20);
      if (selectedWoId !== 'all') {
        logQuery = logQuery.eq('work_order_id', selectedWoId);
      }
      const { data: logData } = await logQuery;

      setActivities(
        ((logData || []) as any[]).map((l) => ({
          id: l.id,
          actionType: l.action_type,
          userName: l.user?.name || l.user?.email || '시스템',
          createdAt: l.created_at,
          totalQty: l.summary?.totalQty || l.summary?.items?.length || 0,
          summary: l.summary,
        }))
      );
    } catch (e) {
      console.error('Progress load error:', e);
    } finally {
      setLoading(false);
    }
  }, [selectedWoId]);

  useEffect(() => { loadData(); }, [loadData]);

  // SKU 클릭 → 해당 품목 활동 이력
  const loadSkuActivities = async (skuId: string) => {
    if (expandedSku === skuId) { setExpandedSku(null); return; }
    setExpandedSku(skuId);

    let query = supabase
      .from('activity_log')
      .select('id, action_type, summary, created_at, user:users!activity_log_user_id_fkey(name, email)')
      .order('created_at', { ascending: false })
      .limit(10);
    if (selectedWoId !== 'all') {
      query = query.eq('work_order_id', selectedWoId);
    }
    const { data } = await query;

    // summary.items 안에서 해당 skuId 포함된 로그만 필터
    const filtered = ((data || []) as any[]).filter((l) => {
      const items = l.summary?.items || [];
      return items.some((i: any) => (i.skuId || i.sku_id) === skuId);
    });

    setSkuActivities(
      filtered.map((l: any) => {
        const matchItem = (l.summary?.items || []).find((i: any) => (i.skuId || i.sku_id) === skuId);
        return {
          id: l.id,
          actionType: l.action_type,
          userName: l.user?.name || l.user?.email || '시스템',
          createdAt: l.created_at,
          totalQty: matchItem?.sentQty || matchItem?.actualQty || matchItem?.completedQty || matchItem?.shipQty || 0,
          summary: l.summary,
        };
      })
    );
  };

  // 필터 + 정렬
  const filtered = skuRows
    .filter((r) => !search || r.skuName.toLowerCase().includes(search.toLowerCase()) || r.skuId.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortKey === 'skuName') return a.skuName.localeCompare(b.skuName);
      if (sortKey === 'ordered') return b.ordered - a.ordered;
      // stage 정렬: 발송대기 > 발송중 > 발송완료 > 입고완료 > 마킹완료 > 출고완료
      const order = ['발송대기', '발송중', '발송완료', '입고완료', '마킹완료', '출고완료', '-'];
      return order.indexOf(a.stage) - order.indexOf(b.stage);
    });

  const woLabel = selectedWoId === 'all'
    ? '전체'
    : workOrders.find((w) => w.id === selectedWoId)?.download_date || '';

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <span className="text-2xl">📊</span> 물류 진행 현황
        </h1>
        <select
          value={selectedWoId}
          onChange={(e) => setSelectedWoId(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-400"
        >
          <option value="all">전체 작업지시서</option>
          {workOrders.map((wo) => (
            <option key={wo.id} value={wo.id}>
              {wo.download_date} ({wo.status || '진행중'})
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">데이터 로드 중...</div>
      ) : (
        <>
          {/* ① 파이프라인 카드 */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            <StageCard label="발송" value={stats.sent} max={stats.ordered} color="blue" icon="📦" />
            <div className="flex items-center text-gray-300 text-xl">→</div>
            <StageCard label="입고" value={stats.received} max={stats.sent} color="teal" icon="📥" />
            <div className="flex items-center text-gray-300 text-xl">→</div>
            <StageCard label="마킹" value={stats.marked} max={stats.markedTarget} color="purple" icon="🏷️" />
            <div className="flex items-center text-gray-300 text-xl">→</div>
            <StageCard label="출고" value={stats.shippedOut} max={stats.ordered} color="green" icon="🚚" />
          </div>

          {/* ② SKU별 상세 테이블 */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-700">품목별 상세 ({filtered.length}종)</h2>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="검색..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-300 rounded w-40"
                />
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as any)}
                  className="px-2 py-1 text-xs border border-gray-300 rounded"
                >
                  <option value="skuName">이름순</option>
                  <option value="ordered">수량순</option>
                  <option value="stage">단계순</option>
                </select>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">품목명</th>
                    <th className="px-3 py-2 text-center w-16">주문</th>
                    <th className="px-3 py-2 text-center w-16">발송</th>
                    <th className="px-3 py-2 text-center w-16">입고</th>
                    <th className="px-3 py-2 text-center w-16">마킹</th>
                    <th className="px-3 py-2 text-center w-16">출고</th>
                    <th className="px-3 py-2 text-center w-20">상태</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((row) => {
                    const hasMismatch = row.sent > row.ordered || row.received > row.sent;
                    return (
                      <tr
                        key={row.skuId}
                        className={`hover:bg-gray-50 cursor-pointer ${hasMismatch ? 'bg-red-50' : ''}`}
                        onClick={() => loadSkuActivities(row.skuId)}
                      >
                        <td className="px-3 py-2">
                          <p className="font-medium text-gray-800 text-xs truncate max-w-[280px]">{row.skuName}</p>
                          <p className="text-[10px] text-gray-400 truncate">{row.skuId}</p>
                        </td>
                        <td className="px-3 py-2 text-center font-mono">{row.ordered}</td>
                        <td className={`px-3 py-2 text-center font-mono ${row.sent < row.ordered ? 'text-orange-600 font-semibold' : ''}`}>
                          {row.sent}
                        </td>
                        <td className={`px-3 py-2 text-center font-mono ${row.received < row.sent ? 'text-orange-600 font-semibold' : ''}`}>
                          {row.received}
                        </td>
                        <td className={`px-3 py-2 text-center font-mono ${row.marked !== null && row.marked < row.received ? 'text-purple-600 font-semibold' : 'text-gray-300'}`}>
                          {row.marked !== null ? row.marked : '-'}
                        </td>
                        <td className={`px-3 py-2 text-center font-mono ${row.shippedOut < row.ordered ? 'text-gray-400' : 'text-green-600 font-semibold'}`}>
                          {row.shippedOut}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-full
                            ${row.stageColor === 'green' ? 'bg-green-100 text-green-700' : ''}
                            ${row.stageColor === 'purple' ? 'bg-purple-100 text-purple-700' : ''}
                            ${row.stageColor === 'blue' ? 'bg-blue-100 text-blue-700' : ''}
                            ${row.stageColor === 'teal' ? 'bg-teal-100 text-teal-700' : ''}
                            ${row.stageColor === 'yellow' ? 'bg-yellow-100 text-yellow-700' : ''}
                            ${row.stageColor === 'gray' ? 'bg-gray-100 text-gray-500' : ''}
                          `}>
                            {row.stage}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">데이터 없음</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* SKU 클릭 시 이력 패널 */}
            {expandedSku && (
              <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
                <h3 className="text-xs font-semibold text-gray-600 mb-2">
                  📋 {skuRows.find((r) => r.skuId === expandedSku)?.skuName} — 활동 이력
                </h3>
                {skuActivities.length === 0 ? (
                  <p className="text-xs text-gray-400">이력 없음</p>
                ) : (
                  <div className="space-y-1">
                    {skuActivities.map((a) => {
                      const info = actionLabels[a.actionType] || { label: a.actionType, color: 'gray' };
                      return (
                        <div key={a.id} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400 w-28 shrink-0">{new Date(a.createdAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium
                            ${info.color === 'blue' ? 'bg-blue-100 text-blue-700' : ''}
                            ${info.color === 'teal' ? 'bg-teal-100 text-teal-700' : ''}
                            ${info.color === 'purple' ? 'bg-purple-100 text-purple-700' : ''}
                            ${info.color === 'green' ? 'bg-green-100 text-green-700' : ''}
                            ${info.color === 'red' ? 'bg-red-100 text-red-700' : ''}
                            ${info.color === 'orange' ? 'bg-orange-100 text-orange-700' : ''}
                            ${info.color === 'gray' ? 'bg-gray-100 text-gray-600' : ''}
                          `}>{info.label}</span>
                          <span className="text-gray-600">{a.userName}</span>
                          <span className="text-gray-400">— {a.totalQty}개</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ③ 타임라인 */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">🕐 최근 활동 {woLabel !== '전체' ? `(${woLabel})` : ''}</h2>
            {activities.length === 0 ? (
              <p className="text-xs text-gray-400">활동 이력 없음</p>
            ) : (
              <div className="space-y-2">
                {activities.map((a) => {
                  const info = actionLabels[a.actionType] || { label: a.actionType, color: 'gray' };
                  const dt = new Date(a.createdAt);
                  return (
                    <div key={a.id} className="flex items-start gap-3 text-sm">
                      <div className="text-xs text-gray-400 w-32 shrink-0 pt-0.5">
                        {dt.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })} {dt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0
                        ${info.color === 'blue' ? 'bg-blue-100 text-blue-700' : ''}
                        ${info.color === 'teal' ? 'bg-teal-100 text-teal-700' : ''}
                        ${info.color === 'purple' ? 'bg-purple-100 text-purple-700' : ''}
                        ${info.color === 'green' ? 'bg-green-100 text-green-700' : ''}
                        ${info.color === 'red' ? 'bg-red-100 text-red-700' : ''}
                        ${info.color === 'orange' ? 'bg-orange-100 text-orange-700' : ''}
                        ${info.color === 'gray' ? 'bg-gray-100 text-gray-600' : ''}
                      `}>{info.label}</span>
                      <div className="flex-1">
                        <span className="text-gray-700">{a.userName}</span>
                        <span className="text-gray-400 ml-2">({a.totalQty}건)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
