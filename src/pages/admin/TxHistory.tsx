import { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import * as XLSX from 'xlsx';
import { BarChart3, Calendar, Download, Search } from 'lucide-react';

// DB tx_type → UI 표시 매핑
const TX_COLS = [
  { dbType: '입고', label: '입고', color: 'blue', sign: +1 },
  { dbType: '이동입고', label: '이동입고', color: 'teal', sign: +1 },
  { dbType: '판매', label: '판매', color: 'red', sign: -1 },
  { dbType: '출고', label: '이동출고', color: 'orange', sign: -1 },
  { dbType: '반품', label: '반품', color: 'green', sign: +1 },
  { dbType: '재고조정', label: '조정', color: 'amber', sign: 1 },
  { dbType: '마킹출고', label: '마킹출고', color: 'purple', sign: -1 },
  { dbType: '마킹입고', label: '마킹입고', color: 'violet', sign: +1 },
] as const;

interface DailyRow {
  date: string;
  입고: number;
  이동입고: number;
  판매: number;
  출고: number;     // DB '출고' = UI '이동출고'
  반품: number;
  재고조정: number;
  마킹출고: number;
  마킹입고: number;
  total: number;
}

function calcTotal(r: Omit<DailyRow, 'date' | 'total'>): number {
  return r.입고 + r.이동입고 - r.판매 - r.출고 + r.반품 + r.재고조정 - r.마킹출고 + r.마킹입고;
}

function getFirstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export default function TxHistory() {
  const isStale = useStaleGuard();

  const [startDate, setStartDate] = useState(getFirstOfMonth());
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [warehouseFilter, setWarehouseFilter] = useState('전체');
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(false);
  useLoadingTimeout(loading, setLoading);
  const [loaded, setLoaded] = useState(false);

  // 창고 로드
  const loadWarehouses = useCallback(async () => {
    if (warehouses.length > 0) return;
    const { data } = await supabase.from('warehouse').select('id, name');
    if (data) setWarehouses(data);
  }, [warehouses.length]);

  // 데이터 조회
  const handleSearch = async () => {
    await loadWarehouses();
    setLoading(true);
    setRows([]);

    try {
      const allTx: { tx_date: string; tx_type: string; quantity: number; warehouse_id: string }[] = [];
      const PAGE = 1000;
      let offset = 0;

      while (true) {
        let q = supabase
          .from('inventory_transaction')
          .select('tx_date, tx_type, quantity, warehouse_id')
          .gte('tx_date', startDate)
          .lte('tx_date', endDate)
          .range(offset, offset + PAGE - 1);

        if (warehouseFilter !== '전체') {
          const wh = warehouses.find((w) => w.name === warehouseFilter);
          if (wh) q = q.eq('warehouse_id', wh.id);
        }

        const { data } = await q;
        if (!data || data.length === 0) break;
        allTx.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }

      if (isStale()) return;

      // 기초재고 제외, 날짜별 집계
      const map: Record<string, DailyRow> = {};
      for (const tx of allTx) {
        if (tx.tx_type === '기초재고') continue;
        if (!map[tx.tx_date]) {
          map[tx.tx_date] = {
            date: tx.tx_date,
            입고: 0, 이동입고: 0, 판매: 0, 출고: 0,
            반품: 0, 재고조정: 0, 마킹출고: 0, 마킹입고: 0,
            total: 0,
          };
        }
        const row = map[tx.tx_date];
        switch (tx.tx_type) {
          case '입고': row.입고 += tx.quantity; break;
          case '이동입고': row.이동입고 += tx.quantity; break;
          case '판매': row.판매 += tx.quantity; break;
          case '출고': row.출고 += tx.quantity; break;
          case '반품': row.반품 += tx.quantity; break;
          case '재고조정': row.재고조정 += tx.quantity; break;
          case '마킹출고': row.마킹출고 += tx.quantity; break;
          case '마킹입고': row.마킹입고 += tx.quantity; break;
        }
      }

      // total 계산 + 정렬
      const sorted = Object.values(map)
        .map((r) => ({ ...r, total: calcTotal(r) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      setRows(sorted);
      setLoaded(true);
    } catch (err) {
      console.error('TxHistory fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  // 합계 행
  const totals: Omit<DailyRow, 'date'> = {
    입고: 0, 이동입고: 0, 판매: 0, 출고: 0,
    반품: 0, 재고조정: 0, 마킹출고: 0, 마킹입고: 0,
    total: 0,
  };
  for (const r of rows) {
    totals.입고 += r.입고;
    totals.이동입고 += r.이동입고;
    totals.판매 += r.판매;
    totals.출고 += r.출고;
    totals.반품 += r.반품;
    totals.재고조정 += r.재고조정;
    totals.마킹출고 += r.마킹출고;
    totals.마킹입고 += r.마킹입고;
  }
  totals.total = calcTotal(totals);

  // 엑셀 다운로드
  const exportExcel = () => {
    const header = ['날짜', ...TX_COLS.map((c) => c.label), '순증감'];
    const data = rows.map((r) => [
      r.date, r.입고, r.이동입고, r.판매, r.출고,
      r.반품, r.재고조정, r.마킹출고, r.마킹입고, r.total,
    ]);
    data.push([
      '합계', totals.입고, totals.이동입고, totals.판매, totals.출고,
      totals.반품, totals.재고조정, totals.마킹출고, totals.마킹입고, totals.total,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '입출고현황');
    XLSX.writeFile(wb, `입출고현황_${startDate}_${endDate}.xlsx`);
  };

  const fmtCell = (v: number) => v === 0 ? '-' : v.toLocaleString();

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <BarChart3 className="w-7 h-7 text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900">입/출고 현황</h1>
      </div>

      {/* 필터 */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-400" />
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
            <span className="text-gray-400">~</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
          </div>
          <select value={warehouseFilter} onChange={(e) => setWarehouseFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
            <option value="전체">전체 창고</option>
            {warehouses.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
          </select>
          <button onClick={handleSearch} disabled={loading}
            className="bg-gray-900 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 flex items-center gap-1.5">
            <Search className="w-4 h-4" />
            {loading ? '조회 중...' : '조회'}
          </button>
          {rows.length > 0 && (
            <button onClick={exportExcel}
              className="border border-gray-300 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 flex items-center gap-1.5">
              <Download className="w-4 h-4" />
              엑셀 다운로드
            </button>
          )}
        </div>
      </div>

      {/* 테이블 */}
      {loaded && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {rows.length === 0 ? (
            <div className="px-5 py-12 text-center text-gray-400 text-sm">해당 기간에 거래 내역이 없습니다</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2.5 text-left font-semibold text-gray-700 sticky left-0 bg-gray-50 z-10">날짜</th>
                    {TX_COLS.map((col) => (
                      <th key={col.dbType} className={`px-3 py-2.5 text-right font-semibold text-${col.color}-700 whitespace-nowrap`}>
                        {col.label}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 text-right font-semibold text-gray-900 whitespace-nowrap">순증감</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.date} className="border-t border-gray-100 hover:bg-gray-50/50">
                      <td className="px-3 py-2 font-medium text-gray-900 sticky left-0 bg-white z-10">{r.date}</td>
                      <td className="px-3 py-2 text-right text-blue-700">{fmtCell(r.입고)}</td>
                      <td className="px-3 py-2 text-right text-teal-700">{fmtCell(r.이동입고)}</td>
                      <td className="px-3 py-2 text-right text-red-700">{fmtCell(r.판매)}</td>
                      <td className="px-3 py-2 text-right text-orange-700">{fmtCell(r.출고)}</td>
                      <td className="px-3 py-2 text-right text-green-700">{fmtCell(r.반품)}</td>
                      <td className="px-3 py-2 text-right text-amber-700">{fmtCell(r.재고조정)}</td>
                      <td className="px-3 py-2 text-right text-purple-700">{fmtCell(r.마킹출고)}</td>
                      <td className="px-3 py-2 text-right text-violet-700">{fmtCell(r.마킹입고)}</td>
                      <td className={`px-3 py-2 text-right font-bold ${r.total >= 0 ? 'text-blue-800' : 'text-red-800'}`}>
                        {r.total === 0 ? '-' : (r.total > 0 ? '+' : '') + r.total.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold">
                    <td className="px-3 py-2.5 sticky left-0 bg-gray-100 z-10">합계</td>
                    <td className="px-3 py-2.5 text-right text-blue-800">{fmtCell(totals.입고)}</td>
                    <td className="px-3 py-2.5 text-right text-teal-800">{fmtCell(totals.이동입고)}</td>
                    <td className="px-3 py-2.5 text-right text-red-800">{fmtCell(totals.판매)}</td>
                    <td className="px-3 py-2.5 text-right text-orange-800">{fmtCell(totals.출고)}</td>
                    <td className="px-3 py-2.5 text-right text-green-800">{fmtCell(totals.반품)}</td>
                    <td className="px-3 py-2.5 text-right text-amber-800">{fmtCell(totals.재고조정)}</td>
                    <td className="px-3 py-2.5 text-right text-purple-800">{fmtCell(totals.마킹출고)}</td>
                    <td className="px-3 py-2.5 text-right text-violet-800">{fmtCell(totals.마킹입고)}</td>
                    <td className={`px-3 py-2.5 text-right ${totals.total >= 0 ? 'text-blue-900' : 'text-red-900'}`}>
                      {totals.total === 0 ? '-' : (totals.total > 0 ? '+' : '') + totals.total.toLocaleString()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <div className="px-4 py-2.5 border-t border-gray-100 text-xs text-gray-500">
              {rows.length}일간 데이터 · 순증감 = +입고 +이동입고 -판매 -이동출고 +반품 ±조정 -마킹출고 +마킹입고
            </div>
          )}
        </div>
      )}
    </div>
  );
}
