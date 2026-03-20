import { useEffect, useState } from 'react';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Download } from 'lucide-react';
import * as XLSX from 'xlsx';

interface LogEntry {
  id: string;
  user_id: string;
  action_type: string;
  work_order_id: string | null;
  action_date: string;
  summary: any;
  created_at: string;
}

const actionLabels: Record<string, string> = {
  shipment_confirm: '발송 확인',
  receipt_check: '입고 확인',
  marking_work: '마킹 작업',
  shipment_out: '출고 확인',
  shipment_cancel_request: '취소 요청',
  shipment_cancel_approved: '취소 승인',
  shipment_modify_request: '수정 요청',
  shipment_modify_approved: '수정 승인',
  inventory_adjust: '재고 수정',
  user_create: '계정 생성',
  user_update: '계정 수정',
  user_delete: '계정 삭제',
  delete_shipment: '발송 삭제',
  delete_receipt: '입고 삭제',
  delete_marking: '마킹 삭제',
  delete_shipment_out: '출고 삭제',
  rollback_shipment: '발송 롤백',
  rollback_receipt: '입고 롤백',
  rollback_marking: '마킹 롤백',
  rollback_shipment_out: '출고 롤백',
};

// 각 action_type이 발생한 메뉴(화면) 출처
const actionSource: Record<string, string> = {
  shipment_confirm: '오프라인',
  receipt_check: '플레이위즈',
  marking_work: '플레이위즈',
  shipment_out: '플레이위즈',
  shipment_cancel_request: '오프라인',
  shipment_cancel_approved: '관리자',
  shipment_modify_request: '오프라인',
  shipment_modify_approved: '관리자',
  inventory_adjust: '관리자',
  user_create: '관리자',
  user_update: '관리자',
  user_delete: '관리자',
  delete_shipment: '오프라인',
  delete_receipt: '플레이위즈',
  delete_marking: '플레이위즈',
  delete_shipment_out: '플레이위즈',
  rollback_shipment: '관리자',
  rollback_receipt: '관리자',
  rollback_marking: '관리자',
  rollback_shipment_out: '관리자',
};

const sourceColors: Record<string, string> = {
  '오프라인': 'text-orange-600',
  '플레이위즈': 'text-violet-600',
  '관리자': 'text-gray-500',
};

const actionColors: Record<string, string> = {
  shipment_confirm: 'bg-orange-100 text-orange-700',
  receipt_check: 'bg-blue-100 text-blue-700',
  marking_work: 'bg-purple-100 text-purple-700',
  shipment_out: 'bg-emerald-100 text-emerald-700',
  shipment_cancel_request: 'bg-red-100 text-red-700',
  shipment_cancel_approved: 'bg-red-100 text-red-700',
  shipment_modify_request: 'bg-amber-100 text-amber-700',
  shipment_modify_approved: 'bg-amber-100 text-amber-700',
  inventory_adjust: 'bg-cyan-100 text-cyan-700',
  user_create: 'bg-green-100 text-green-700',
  user_update: 'bg-yellow-100 text-yellow-700',
  user_delete: 'bg-red-100 text-red-700',
  delete_shipment: 'bg-rose-100 text-rose-700',
  delete_receipt: 'bg-rose-100 text-rose-700',
  delete_marking: 'bg-rose-100 text-rose-700',
  delete_shipment_out: 'bg-rose-100 text-rose-700',
  rollback_shipment: 'bg-orange-100 text-orange-700',
  rollback_receipt: 'bg-orange-100 text-orange-700',
  rollback_marking: 'bg-orange-100 text-orange-700',
  rollback_shipment_out: 'bg-orange-100 text-orange-700',
};

export default function ActivityHistory() {
  const isStale = useStaleGuard();
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const [users, setUsers] = useState<{ id: string; name: string; role: string }[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    loadLogs();
  }, [selectedDate, actionFilter, userFilter]);

  const loadUsers = async () => {
    const { data } = await supabaseAdmin.from('user_profile').select('id, name, role');
    if (!isStale() && data) setUsers(data as any[]);
  };

  const loadLogs = async () => {
    setLoading(true);
    try {
      let query = supabaseAdmin
        .from('activity_log')
        .select('*')
        .eq('action_date', selectedDate)
        .order('created_at', { ascending: false })
        .limit(100);

      if (actionFilter) query = query.eq('action_type', actionFilter);
      if (userFilter) query = query.eq('user_id', userFilter);

      const { data, error } = await query;
      if (error) throw error;
      if (!isStale()) setLogs((data || []) as LogEntry[]);
    } catch (e: any) {
      console.error('Failed to load activity logs:', e);
    } finally {
      setLoading(false);
    }
  };

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    const newDate = d.toISOString().split('T')[0];
    if (newDate > today) return;
    setSelectedDate(newDate);
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T00:00:00');
    const mm = date.getMonth() + 1;
    const dd = date.getDate();
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    return `${mm}월 ${dd}일 (${dayNames[date.getDay()]})`;
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const handleDownloadExcel = () => {
    if (logs.length === 0) return;
    const rows = logs.flatMap((log) => {
      const userName = users.find((u) => u.id === log.user_id)?.name || '—';
      const actionLabel = actionLabels[log.action_type] || log.action_type;
      const woDate = log.summary?.workOrderDate || '—';
      const items = log.summary?.items || [];
      const source = actionSource[log.action_type] || '';
      if (items.length === 0) {
        return [{
          시간: formatTime(log.created_at),
          담당자: userName,
          메뉴: source,
          유형: actionLabel,
          작업일: woDate,
          품목코드: '',
          품목명: '',
          수량: log.summary?.totalQty || 0,
        }];
      }
      return items.map((item: any) => ({
        시간: formatTime(log.created_at),
        담당자: userName,
        메뉴: source,
        유형: actionLabel,
        작업일: woDate,
        품목코드: item.skuId || '',
        품목명: item.skuName || '',
        수량: item.sentQty || item.actualQty || item.completedQty || item.shipQty || 0,
      }));
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 30 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '활동이력');
    XLSX.writeFile(wb, `활동이력_${selectedDate}.xlsx`);
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <h2 className="text-xl font-bold text-gray-900">활동 이력</h2>

      {/* 날짜 네비게이션 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <button onClick={() => changeDate(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
            <ChevronLeft size={18} />
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold text-gray-900">{formatDate(selectedDate)}</p>
            {selectedDate === today && <span className="text-xs text-blue-600 font-medium">오늘</span>}
          </div>
          <button onClick={() => changeDate(1)} disabled={selectedDate === today} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* 필터 + 엑셀 다운로드 */}
      <div className="flex gap-3 flex-wrap items-center">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">전체 유형</option>
          {Object.entries(actionLabels).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">전체 사용자</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
          ))}
        </select>
        <button
          onClick={handleDownloadExcel}
          disabled={logs.length === 0}
          className="ml-auto flex items-center gap-1.5 text-sm px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={14} />
          엑셀 다운로드
        </button>
      </div>

      {/* 결과 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">불러오는 중...</div>
        ) : logs.length === 0 ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">
            {formatDate(selectedDate)}에 기록된 활동이 없습니다
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {logs.map((log) => {
              const isExpanded = expandedId === log.id;
              const items = log.summary?.items || [];
              const totalQty = log.summary?.totalQty || 0;
              const userName = users.find((u) => u.id === log.user_id)?.name || '—';
              return (
                <div key={log.id}>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    className="w-full px-5 py-3.5 flex items-center gap-4 hover:bg-gray-50 transition-colors text-left"
                  >
                    <span className="text-xs text-gray-400 font-mono w-12 flex-shrink-0">
                      {formatTime(log.created_at)}
                    </span>
                    <span className="text-sm text-gray-700 w-20 flex-shrink-0 truncate">
                      {userName}
                    </span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <span className={`text-[10px] font-medium ${sourceColors[actionSource[log.action_type] || ''] || 'text-gray-400'}`}>
                        {actionSource[log.action_type] || ''}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${actionColors[log.action_type] || 'bg-gray-100 text-gray-600'}`}>
                        {actionLabels[log.action_type] || log.action_type}
                      </span>
                    </span>
                    <span className="text-sm text-gray-500 flex-shrink-0">
                      {log.summary?.workOrderDate || '—'}
                    </span>
                    <span className="text-sm font-semibold text-gray-800 ml-auto flex-shrink-0">
                      {totalQty}개
                    </span>
                    {isExpanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                  </button>
                  {isExpanded && items.length > 0 && (
                    <div className="bg-gray-50 px-5 py-3 border-t border-gray-100">
                      <div className="space-y-1.5 max-h-60 overflow-y-auto">
                        {items.map((item: any, idx: number) => {
                          const qty = item.sentQty || item.actualQty || item.completedQty || item.shipQty || 0;
                          return (
                            <div key={idx} className="flex items-center justify-between text-xs">
                              <span className="text-gray-600 truncate flex-1 mr-2">{item.skuName}</span>
                              <span className="text-gray-800 font-medium flex-shrink-0">{qty}개</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 요약 */}
        {!loading && logs.length > 0 && (
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
            <p className="text-sm text-gray-600">총 {logs.length}건</p>
            <p className="text-sm font-bold text-gray-900">
              합계 {logs.reduce((s, l) => s + (l.summary?.totalQty || 0), 0)}개
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
