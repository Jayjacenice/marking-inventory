import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouses } from '../../lib/warehouseStore';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import * as XLSX from 'xlsx';
import { History, Search, Download, AlertTriangle, Calendar } from 'lucide-react';
import type { TxType } from '../../types';

const TYPE_COLORS: Record<string, string> = {
  '입고': 'blue',
  '이동입고': 'teal',
  '판매': 'emerald',
  '이동출고': 'orange',
  '반품': 'pink',
  '재고조정': 'yellow',
  '마킹출고': 'purple',
  '마킹입고': 'purple',
  '기초재고': 'gray',
};

/** 재고 변동 방향: +1 = 입고성, -1 = 출고성 */
function deltaSign(type: TxType): number {
  switch (type) {
    case '입고':
    case '이동입고':
    case '반품':
    case '재고조정':
    case '마킹입고':
    case '기초재고':
      return +1;
    case '출고':
    case '판매':
    case '마킹출고':
      return -1;
    default:
      return 0;
  }
}

function displayType(type: string): string {
  return type === '출고' ? '이동출고' : type;
}

interface Warehouse { id: string; name: string; }

interface SkuSearchResult {
  sku_id: string;
  sku_name: string;
  barcode: string | null;
}

interface HistoryRow {
  date: string;
  txType: string;       // display 값
  dbType: string;       // 실제 tx_type
  quantity: number;     // 원본 수량 (항상 양수 저장이지만 재고조정은 음수 가능)
  signedQty: number;    // 방향 반영 (+/-)
  memo: string | null;
  warehouseName: string;
  runningBalance: number;
}

export default function SkuHistory() {
  const isStale = useStaleGuard();

  // 창고
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseFilter, setWarehouseFilter] = useState<string>('전체');

  // 기간
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = today.slice(0, 8) + '01';
  const [startDate, setStartDate] = useState(firstDay);
  const [endDate, setEndDate] = useState(today);

  // SKU 검색
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SkuSearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedSku, setSelectedSku] = useState<SkuSearchResult | null>(null);
  const searchTimerRef = useRef<number | null>(null);

  // 결과
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLoadingTimeout(loading, setLoading, setError);

  // 창고 로드
  useEffect(() => {
    getWarehouses().then(setWarehouses);
  }, []);

  // SKU 자동완성 (디바운스 300ms)
  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    if (!searchTerm || searchTerm.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = window.setTimeout(async () => {
      const q = searchTerm.trim();
      const { data } = await supabase
        .from('sku')
        .select('sku_id, sku_name, barcode')
        .or(`sku_id.ilike.%${q}%,barcode.ilike.%${q}%,sku_name.ilike.%${q}%`)
        .limit(20);
      if (!isStale()) setSearchResults((data || []) as SkuSearchResult[]);
    }, 300);
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [searchTerm, isStale]);

  /** 1,000행 제한 우회 페이지네이션 */
  const fetchAllTransactions = async (filters: {
    skuId: string;
    warehouseId?: string;
    startDate?: string;
    endDate?: string;
  }) => {
    const PAGE_SIZE = 1000;
    const all: any[] = [];
    let offset = 0;
    while (true) {
      let query = supabase
        .from('inventory_transaction')
        .select('tx_date, tx_type, quantity, needs_marking, memo, source, warehouse_id, created_at')
        .eq('sku_id', filters.skuId);
      if (filters.warehouseId) query = query.eq('warehouse_id', filters.warehouseId);
      if (filters.startDate) query = query.gte('tx_date', filters.startDate);
      if (filters.endDate) query = query.lte('tx_date', filters.endDate);

      const { data, error } = await query
        .order('tx_date', { ascending: true })
        .order('created_at', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`트랜잭션 조회 실패: ${error.message}`);
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return all;
  };

  const handleSearch = useCallback(async () => {
    if (!selectedSku) {
      setError('품목을 선택해주세요.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const whId = warehouseFilter === '전체'
        ? undefined
        : warehouses.find((w) => w.name === warehouseFilter)?.id;

      // 1. 시작일 이전 누적 (opening balance)
      const preRaw = await fetchAllTransactions({
        skuId: selectedSku.sku_id,
        warehouseId: whId,
        endDate: (() => {
          const d = new Date(startDate);
          d.setDate(d.getDate() - 1);
          return d.toISOString().slice(0, 10);
        })(),
      });
      let opening = 0;
      for (const tx of preRaw) {
        opening += deltaSign(tx.tx_type as TxType) * (tx.quantity || 0);
      }

      // 2. 기간 내 트랜잭션
      const txRaw = await fetchAllTransactions({
        skuId: selectedSku.sku_id,
        warehouseId: whId,
        startDate,
        endDate,
      });

      if (isStale()) return;

      // 3. 누적 계산
      let running = opening;
      const whMap = new Map(warehouses.map((w) => [w.id, w.name]));
      const result: HistoryRow[] = txRaw.map((tx: any) => {
        const delta = deltaSign(tx.tx_type as TxType) * (tx.quantity || 0);
        running += delta;
        return {
          date: tx.tx_date,
          txType: displayType(tx.tx_type),
          dbType: tx.tx_type,
          quantity: tx.quantity,
          signedQty: delta,
          memo: tx.memo,
          warehouseName: whMap.get(tx.warehouse_id) || '?',
          runningBalance: running,
        };
      });

      setOpeningBalance(opening);
      setRows(result);
    } catch (e: any) {
      setError(e.message || '조회 실패');
    } finally {
      setLoading(false);
    }
  }, [selectedSku, warehouseFilter, warehouses, startDate, endDate, isStale]);

  const handleDownload = () => {
    if (!selectedSku || rows.length === 0) return;
    const data = rows.map((r) => ({
      일자: r.date,
      유형: r.txType,
      수량: r.signedQty,
      창고: r.warehouseName,
      메모: r.memo || '',
      누적재고: r.runningBalance,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '재고이력');
    const fname = `재고이력_${selectedSku.sku_id}_${startDate}_${endDate}.xlsx`;
    XLSX.writeFile(wb, fname);
  };

  const periodDelta = rows.length > 0 ? rows[rows.length - 1].runningBalance - openingBalance : 0;
  const currentBalance = rows.length > 0 ? rows[rows.length - 1].runningBalance : openingBalance;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <History className="w-7 h-7 text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900">품목별 재고 이력</h1>
      </div>

      {/* 조회 조건 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          {/* 검색 input + 자동완성 */}
          <div className="relative md:col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">품목 검색 (SKU / 바코드 / 상품명)</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setSearchOpen(true); }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                placeholder="2자 이상 입력"
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            {searchOpen && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto z-10">
                {searchResults.map((s) => (
                  <button
                    key={s.sku_id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedSku(s);
                      setSearchTerm(`${s.sku_name} (${s.barcode || s.sku_id})`);
                      setSearchOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 border-b border-gray-100 last:border-b-0"
                  >
                    <div className="font-medium text-gray-800 truncate">{s.sku_name}</div>
                    <div className="text-gray-400 font-mono">{s.sku_id} · {s.barcode || '-'}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 창고 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">창고</label>
            <select
              value={warehouseFilter}
              onChange={(e) => setWarehouseFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              <option value="전체">전체</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.name}>{w.name}</option>
              ))}
            </select>
          </div>

          {/* 시작일 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">시작일</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>

          {/* 종료일 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">종료일</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-gray-100">
          <div className="text-xs text-gray-500">
            {selectedSku ? (
              <>선택됨: <span className="font-semibold text-gray-700">{selectedSku.sku_name}</span> <span className="font-mono text-gray-400">({selectedSku.sku_id})</span></>
            ) : (
              <>검색창에 바코드나 상품명을 입력하세요</>
            )}
          </div>
          <div className="flex gap-2">
            {rows.length > 0 && (
              <button
                onClick={handleDownload}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                <Download size={14} /> 엑셀 다운로드
              </button>
            )}
            <button
              onClick={handleSearch}
              disabled={!selectedSku || loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '조회 중...' : '조회'}
            </button>
          </div>
        </div>
      </div>

      {/* 에러 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 mb-4 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* 요약 카드 */}
      {selectedSku && !loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-white rounded-xl p-4 border border-gray-100">
            <p className="text-xs text-gray-500">시작 재고</p>
            <p className="text-xl font-bold text-gray-800">{openingBalance.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100">
            <p className="text-xs text-gray-500">기간 내 증감</p>
            <p className={`text-xl font-bold ${periodDelta > 0 ? 'text-blue-600' : periodDelta < 0 ? 'text-red-600' : 'text-gray-500'}`}>
              {periodDelta > 0 ? '+' : ''}{periodDelta.toLocaleString()}
            </p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100">
            <p className="text-xs text-gray-500">현재 재고</p>
            <p className="text-xl font-bold text-gray-800">{currentBalance.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100">
            <p className="text-xs text-gray-500">거래 건수</p>
            <p className="text-xl font-bold text-gray-800">{rows.length.toLocaleString()}</p>
          </div>
        </div>
      )}

      {/* 이력 테이블 */}
      {selectedSku && rows.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                    <Calendar size={12} className="inline mr-1" /> 일자
                  </th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600 whitespace-nowrap">유형</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 whitespace-nowrap">수량</th>
                  {warehouseFilter === '전체' && (
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">창고</th>
                  )}
                  <th className="text-left px-4 py-3 font-medium text-gray-600">메모</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 bg-blue-50 whitespace-nowrap">누적재고</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r, i) => {
                  const color = TYPE_COLORS[r.txType] || 'gray';
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-800">{r.date}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-${color}-100 text-${color}-700`}>
                          {r.txType}
                        </span>
                      </td>
                      <td className={`px-4 py-2.5 text-right font-semibold ${r.signedQty > 0 ? 'text-blue-600' : r.signedQty < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {r.signedQty > 0 ? '+' : ''}{r.signedQty.toLocaleString()}
                      </td>
                      {warehouseFilter === '전체' && (
                        <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{r.warehouseName}</td>
                      )}
                      <td className="px-4 py-2.5 text-gray-500 text-xs truncate max-w-[280px]" title={r.memo || ''}>
                        {r.memo || '-'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-bold text-blue-700 bg-blue-50 whitespace-nowrap">
                        {r.runningBalance.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 빈 상태 */}
      {selectedSku && !loading && rows.length === 0 && !error && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          해당 기간 내 거래 이력이 없습니다
        </div>
      )}

      {!selectedSku && !loading && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          품목을 검색하고 조회해주세요
        </div>
      )}
    </div>
  );
}
