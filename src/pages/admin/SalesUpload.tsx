import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { recordTransactionBatch } from '../../lib/inventoryTransaction';
import type { TxType } from '../../types';
import * as XLSX from 'xlsx';
import {
  ArrowDownCircle,
  ShoppingCart,
  Truck,
  AlertTriangle,
  Trash2,
  Calendar,
  FileUp,
  Upload,
} from 'lucide-react';

// 4개 탭 정의
const TX_TABS = [
  { key: '입고' as TxType, label: '입고', icon: ArrowDownCircle, color: 'blue', desc: '제작 입고 (직입고)' },
  { key: '이동입고' as TxType, label: '이동입고', icon: ArrowDownCircle, color: 'teal', desc: '타 매장/창고에서 이동 입고' },
  { key: '판매' as TxType, label: '판매', icon: ShoppingCart, color: 'emerald', desc: '매장 판매 출고' },
  { key: '출고' as TxType, label: '이동출고', icon: Truck, color: 'orange', desc: '타 매장/창고로 이동 출고' },
] as const;

interface ParsedRow {
  barcode: string;
  quantity: number;
  skuId: string | null;
  skuName: string | null;
  matched: boolean;
}

export default function SalesUpload() {
  const isStale = useStaleGuard();

  // 탭 상태
  const [activeTab, setActiveTab] = useState<TxType>('입고');
  const activeTabInfo = TX_TABS.find((t) => t.key === activeTab)!;

  // 업로드 상태
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [txDate, setTxDate] = useState(new Date().toISOString().slice(0, 10));
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);

  // 오프라인샵 창고
  const [offlineWarehouse, setOfflineWarehouse] = useState<{ id: string; name: string } | null>(null);
  const [warehouseLoading, setWarehouseLoading] = useState(true);

  // 등록 현황
  const [txStatus, setTxStatus] = useState<{ date: string; txType: string; count: number; totalQty: number }[]>([]);

  // 삭제 모달
  const [deleteModal, setDeleteModal] = useState<{ date: string; txType: string; count: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 창고 조회
  useEffect(() => {
    supabase.from('warehouse').select('id, name').then(({ data }) => {
      if (!data) { setWarehouseLoading(false); return; }
      const wh = data.find((w) => w.name.includes('오프라인'));
      if (wh) setOfflineWarehouse(wh);
      setWarehouseLoading(false);
    });
  }, []);

  // 등록 현황 조회
  const fetchTxStatus = useCallback(async () => {
    if (!offlineWarehouse) return;
    const { data } = await supabase
      .from('inventory_transaction')
      .select('tx_date, tx_type, quantity')
      .eq('warehouse_id', offlineWarehouse.id)
      .eq('source', 'offline_manual')
      .order('tx_date', { ascending: false })
      .limit(1000);
    if (!data || isStale()) return;

    const map: Record<string, { count: number; totalQty: number }> = {};
    for (const row of data) {
      const displayType = row.tx_type === '출고' ? '이동출고' : row.tx_type;
      const key = `${row.tx_date}|${displayType}`;
      if (!map[key]) map[key] = { count: 0, totalQty: 0 };
      map[key].count += 1;
      map[key].totalQty += row.quantity || 0;
    }
    const result = Object.entries(map).map(([k, v]) => {
      const [date, txType] = k.split('|');
      return { date, txType, ...v };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.txType.localeCompare(b.txType));
    setTxStatus(result);
  }, [offlineWarehouse, isStale]);

  useEffect(() => { if (offlineWarehouse) fetchTxStatus(); }, [offlineWarehouse, fetchTxStatus]);

  // 엑셀 파싱 (3컬럼: 구분자, 바코드, 수량 또는 2컬럼: 바코드, 수량)
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setParsing(true);
    setUploadResult(null);
    setParsedRows([]);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // 헤더 스킵 (첫 행이 텍스트면 헤더)
      const startIdx = raw.length > 0 && typeof raw[0][0] === 'string' && isNaN(Number(raw[0][0])) ? 1 : 0;

      const rows: { barcode: string; quantity: number }[] = [];
      for (let i = startIdx; i < raw.length; i++) {
        const r = raw[i];
        if (!r || r.length === 0) continue;

        let barcode: string;
        let qty: number;

        if (r.length >= 3 && typeof r[0] === 'string' && isNaN(Number(r[0]))) {
          // 3컬럼: 구분자, 바코드, 수량
          barcode = String(r[1] || '').trim();
          qty = Number(r[2]) || 0;
        } else {
          // 2컬럼: 바코드, 수량
          barcode = String(r[0] || '').trim();
          qty = Number(r[1]) || 0;
        }

        if (!barcode || qty <= 0) continue;
        rows.push({ barcode, quantity: qty });
      }

      if (rows.length === 0) {
        setUploadResult('파싱 가능한 데이터가 없습니다. 엑셀에 바코드, 수량 컬럼이 있는지 확인하세요.');
        setParsing(false);
        return;
      }

      // 바코드 → SKU 매칭
      const barcodes = [...new Set(rows.map((r) => r.barcode))];
      const barcodeToSku: Record<string, { skuId: string; skuName: string }> = {};

      for (let i = 0; i < barcodes.length; i += 500) {
        const batch = barcodes.slice(i, i + 500);
        const { data: skus } = await supabase
          .from('sku')
          .select('sku_id, sku_name, barcode')
          .in('barcode', batch);
        if (skus) {
          for (const s of skus) {
            if (s.barcode) barcodeToSku[s.barcode] = { skuId: s.sku_id, skuName: s.sku_name || s.sku_id };
          }
        }
      }

      const parsed: ParsedRow[] = rows.map((r) => {
        const match = barcodeToSku[r.barcode];
        return {
          barcode: r.barcode,
          quantity: r.quantity,
          skuId: match?.skuId || null,
          skuName: match?.skuName || null,
          matched: !!match,
        };
      });

      if (!isStale()) setParsedRows(parsed);
    } catch (err: any) {
      setUploadResult(`파싱 실패: ${err.message}`);
    } finally {
      setParsing(false);
    }
  };

  // 저장
  const handleSave = async () => {
    if (!offlineWarehouse) return;
    const matched = parsedRows.filter((r) => r.matched && r.skuId);
    if (matched.length === 0) return;

    setUploading(true);
    setUploadResult('저장 중...');

    try {
      const txRows = matched.map((r) => ({
        warehouseId: offlineWarehouse.id,
        skuId: r.skuId!,
        txType: activeTab,
        quantity: r.quantity,
        source: 'offline_manual' as const,
        txDate: txDate,
        memo: `매장입출고:${txDate}:${activeTabInfo.label}`,
      }));

      const skuNameMap = new Map<string, string>();
      for (const r of matched) {
        if (r.skuId && r.skuName) skuNameMap.set(r.skuId, r.skuName);
      }

      const result = await recordTransactionBatch(txRows, skuNameMap);
      setUploadResult(
        `저장 완료: ${result.success}건 성공${result.failed > 0 ? `, ${result.failed}건 실패` : ''}`
      );
      setParsedRows([]);
      fetchTxStatus();
    } catch (err: any) {
      setUploadResult(`저장 실패: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  // 삭제
  const openDeleteModal = async (date: string, txType: string) => {
    if (!offlineWarehouse) return;
    const dbTxType = txType === '이동출고' ? '출고' : txType;
    const { count } = await supabase
      .from('inventory_transaction')
      .select('id', { count: 'exact', head: true })
      .eq('warehouse_id', offlineWarehouse.id)
      .eq('source', 'offline_manual')
      .eq('tx_type', dbTxType)
      .eq('tx_date', date);
    setDeleteModal({ date, txType, count: count || 0 });
    setDeleteConfirm(false);
  };

  const handleDelete = async () => {
    if (!deleteModal || !offlineWarehouse) return;
    setDeleting(true);
    const dbTxType = deleteModal.txType === '이동출고' ? '출고' : deleteModal.txType;
    const { error } = await supabase
      .from('inventory_transaction')
      .delete()
      .eq('warehouse_id', offlineWarehouse.id)
      .eq('source', 'offline_manual')
      .eq('tx_type', dbTxType)
      .eq('tx_date', deleteModal.date);
    setDeleting(false);
    setDeleteModal(null);
    if (error) {
      setUploadResult(`삭제 실패: ${error.message}`);
    } else {
      setUploadResult(`${deleteModal.date} ${deleteModal.txType} 데이터 삭제 완료`);
    }
    fetchTxStatus();
  };

  // 통계
  const matchedRows = parsedRows.filter((r) => r.matched);
  const unmatchedRows = parsedRows.filter((r) => !r.matched);
  const matchedQty = matchedRows.reduce((s, r) => s + r.quantity, 0);
  const unmatchedQty = unmatchedRows.reduce((s, r) => s + r.quantity, 0);

  // 탭별 색상
  const tabColor = activeTabInfo.color;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Upload className="w-7 h-7 text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900">매장 입/출고 등록</h1>
      </div>

      {!warehouseLoading && !offlineWarehouse && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 inline mr-1" />
          오프라인샵 창고를 찾을 수 없습니다.
        </div>
      )}

      {/* 4개 탭 */}
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
        {TX_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setParsedRows([]); setUploadResult(null); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? `bg-white shadow-sm text-${tab.color}-700`
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 업로드 영역 */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className={`text-sm font-semibold text-${tabColor}-700`}>{activeTabInfo.desc}</h3>
            <p className="text-xs text-gray-500 mt-1">
              엑셀 양식: 바코드, 수량 (2컬럼) 또는 구분자, 바코드, 수량 (3컬럼)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-400" />
            <input
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <label className={`cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          parsing || !offlineWarehouse
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
            : `bg-${tabColor}-600 text-white hover:bg-${tabColor}-700`
        }`}>
          <FileUp className="w-4 h-4" />
          {parsing ? '파싱 중...' : '엑셀 파일 선택'}
          <input
            type="file"
            accept=".xls,.xlsx"
            onChange={handleFileSelect}
            disabled={parsing || !offlineWarehouse}
            className="hidden"
          />
        </label>
      </div>

      {/* 파싱 결과 */}
      {parsedRows.length > 0 && (
        <div className={`bg-${tabColor}-50 border border-${tabColor}-200 rounded-xl p-4 mb-4`}>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">매칭 성공</div>
              <div className={`text-lg font-bold text-${tabColor}-700`}>{matchedRows.length}건</div>
              <div className="text-xs text-gray-400">{matchedQty.toLocaleString()}개</div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">매칭 실패</div>
              <div className={`text-lg font-bold ${unmatchedRows.length > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {unmatchedRows.length}건
              </div>
              <div className="text-xs text-gray-400">{unmatchedQty.toLocaleString()}개</div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">매칭률</div>
              <div className={`text-lg font-bold text-${tabColor}-700`}>
                {parsedRows.length > 0 ? Math.round((matchedRows.length / parsedRows.length) * 100) : 0}%
              </div>
            </div>
          </div>

          {/* 상세 테이블 */}
          <details className="text-xs" open={parsedRows.length <= 30}>
            <summary className={`cursor-pointer text-${tabColor}-700 font-medium mb-2`}>
              상세 ({parsedRows.length}건)
            </summary>
            <div className="overflow-x-auto max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">상태</th>
                    <th className="px-2 py-1 text-left">바코드</th>
                    <th className="px-2 py-1 text-left">SKU</th>
                    <th className="px-2 py-1 text-left">상품명</th>
                    <th className="px-2 py-1 text-right">수량</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((r, i) => (
                    <tr key={i} className={`border-t ${r.matched ? '' : 'bg-red-50'}`}>
                      <td className="px-2 py-1">
                        <span className={`inline-block w-2 h-2 rounded-full ${r.matched ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      </td>
                      <td className="px-2 py-1 font-mono">{r.barcode}</td>
                      <td className="px-2 py-1 text-gray-500">{r.skuId || '-'}</td>
                      <td className="px-2 py-1 truncate max-w-[200px]">{r.skuName || '미매칭'}</td>
                      <td className="px-2 py-1 text-right font-semibold">{r.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {/* 저장 버튼 */}
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => { setParsedRows([]); setUploadResult(null); }}
              className="px-4 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50"
            >
              취소
            </button>
            <button
              onClick={handleSave}
              disabled={uploading || matchedRows.length === 0}
              className={`bg-${tabColor}-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-${tabColor}-700 disabled:opacity-50`}
            >
              {uploading ? '저장 중...' : `${activeTabInfo.label} ${matchedRows.length}건 저장`}
            </button>
          </div>
        </div>
      )}

      {/* 결과 메시지 */}
      {uploadResult && !uploading && parsedRows.length === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-800">
          {uploadResult}
        </div>
      )}

      {/* 등록 현황 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">
            등록 현황
            {txStatus.length > 0 && (
              <span className="ml-2 text-xs text-gray-400 font-normal">
                {txStatus.reduce((s, d) => s + d.count, 0).toLocaleString()}건
              </span>
            )}
          </h3>
        </div>
        {txStatus.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">등록된 데이터가 없습니다</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {txStatus.map((d) => {
              const tab = TX_TABS.find((t) => t.label === d.txType || (t.key === '출고' && d.txType === '이동출고'));
              const color = tab?.color || 'gray';
              return (
                <div key={`${d.date}-${d.txType}`} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <Calendar className="w-4 h-4 text-gray-400" />
                    <span className="text-sm font-medium text-gray-900">{d.date}</span>
                    <span className={`text-xs bg-${color}-100 text-${color}-700 px-2 py-0.5 rounded-full`}>
                      {d.txType}
                    </span>
                    <span className="text-xs text-gray-500">{d.count}건 · {d.totalQty.toLocaleString()}개</span>
                  </div>
                  <button
                    onClick={() => openDeleteModal(d.date, d.txType)}
                    className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
                    title="삭제"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 삭제 모달 */}
      {deleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">데이터 삭제</h3>
            <p className="text-sm text-gray-500 mb-4">
              {deleteModal.date} {deleteModal.txType} 데이터 {deleteModal.count}건을 삭제합니다.
            </p>
            <label className="flex items-center gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-red-600"
              />
              <span className="text-sm text-red-600 font-medium">
                {deleteModal.count}건 삭제 확인 (복구 불가)
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteModal(null)} className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">취소</button>
              <button
                onClick={handleDelete}
                disabled={!deleteConfirm || deleting}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? '삭제 중...' : '삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
