import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouses } from '../../lib/warehouseStore';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { recordTransactionBatch } from '../../lib/inventoryTransaction';
import { parseOfflineStockExcel } from '../../lib/offlineStockParser';
import type { OfflineStockParseResult } from '../../lib/offlineStockParser';
import type { TxType } from '../../types';
import * as XLSX from 'xlsx';
import { Upload, Download, Search, AlertTriangle, Store } from 'lucide-react';
import { useReadOnly } from '../../contexts/ReadOnlyContext';
import { isUniform, PREFIX } from '../../lib/skuPrefix';

interface LedgerRow {
  warehouseName: string;
  skuId: string;
  barcode: string;
  skuName: string;
  opening: number;
  inQty: number;
  transferInQty: number;
  salesQty: number;
  outQty: number;
  returnQty: number;
  adjustQty: number;
  markingOutQty: number;
  markingInQty: number;
  closing: number;
}

export default function StockLedger() {
  const readOnly = useReadOnly();
  const isStale = useStaleGuard();
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = today.slice(0, 8) + '01';

  const [startDate, setStartDate] = useState(firstDay);
  const [endDate, setEndDate] = useState(today);
  const [warehouseFilter, setWarehouseFilter] = useState('전체');
  const [searchText, setSearchText] = useState('');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLoadingTimeout(loading, setLoading, setError, 120_000); // 수불부는 데이터 많아서 120초

  // 매장수불 업로드
  const [offlineParseResult, setOfflineParseResult] = useState<OfflineStockParseResult | null>(null);
  const [offlineMapped, setOfflineMapped] = useState<{ skuId: string; barcode: string; skuName: string; date: string; quantity: number; type: TxType }[]>([]);
  const [offlineUnmatched, setOfflineUnmatched] = useState<{ barcode: string; skuName: string }[]>([]);
  const [offlineUploading, setOfflineUploading] = useState(false);
  const [offlineUploadResult, setOfflineUploadResult] = useState<string | null>(null);
  const [offlineUploadProgress, setOfflineUploadProgress] = useState<{ current: number; total: number } | null>(null);
  // 창고 목록
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    getWarehouses().then((list) => setWarehouses(list));
  }, []);

  /** 1,000행 제한 우회: 페이지네이션으로 전체 데이터 조회 (순차) */
  const fetchAllTransactions = async (
    from: string, to: string
  ): Promise<{ warehouse_id: string; sku_id: string; tx_type: string; quantity: number }[]> => {
    const PAGE_SIZE = 1000;
    const allRows: { warehouse_id: string; sku_id: string; tx_type: string; quantity: number }[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('inventory_transaction')
        .select('warehouse_id, sku_id, tx_type, quantity')
        .gte('tx_date', from)
        .lte('tx_date', to)
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`트랜잭션 조회 실패: ${error.message}`);
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return allRows;
  };

  const fetchLedger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const SYSTEM_START = '2026-02-01';
      const openingMap: Record<string, number> = {};
      const txMap: Record<string, { in: number; transferIn: number; sales: number; out: number; return: number; adjust: number; markingOut: number; markingIn: number }> = {};

      // 기초/기간내를 동시에 병렬 조회
      const prevDay = new Date(new Date(startDate).getTime() - 86400000).toISOString().slice(0, 10);
      const [preTxData, txData] = await Promise.all([
        startDate > SYSTEM_START ? fetchAllTransactions(SYSTEM_START, prevDay) : Promise.resolve([]),
        fetchAllTransactions(startDate, endDate),
      ]);

      // ── SKU 정보 먼저 조회 → base_barcode 매핑 생성 ──
      const allTxSkuIds = new Set<string>();
      for (const tx of [...preTxData, ...txData]) allTxSkuIds.add(tx.sku_id);

      // sku_id → { name, barcode, baseBarcode } 매핑
      const skuLookup: Record<string, { name: string; barcode: string; baseBarcode: string }> = {};
      const skuIdArr = [...allTxSkuIds];
      for (let i = 0; i < skuIdArr.length; i += 500) {
        const batch = skuIdArr.slice(i, i + 500);
        const { data: skuData } = await supabase
          .from('sku')
          .select('sku_id, sku_name, barcode')
          .in('sku_id', batch);
        if (skuData) {
          for (const s of skuData) {
            const base = s.barcode ? s.barcode.split('_')[0] : '';
            skuLookup[s.sku_id] = {
              name: s.sku_name || s.sku_id,
              barcode: s.barcode || '',
              baseBarcode: base,
            };
          }
        }
      }

      // key 생성 헬퍼: base_barcode가 있으면 합산, 없으면 sku_id 개별
      // 단, 마킹 완성품(SKU에 _선수명 접미사)은 단품과 합산하면 안 되므로 개별 처리
      const makeKey = (whId: string, skuId: string) => {
        const info = skuLookup[skuId];
        // 마킹 완성품: SKU에 _ 접미사가 있고 26UN- 또는 26MK-로 시작
        const isMarkedProduct = skuId.includes('_') && (isUniform(skuId) || skuId.startsWith(PREFIX.marking));
        const groupId = isMarkedProduct ? skuId : (info?.baseBarcode || skuId);
        return `${whId}|${groupId}`;
      };

      // 기초재고 맵 (시작일 이전 트랜잭션 누적, base_barcode 기준 합산)
      for (const tx of preTxData) {
        const key = makeKey(tx.warehouse_id, tx.sku_id);
        if (!openingMap[key]) openingMap[key] = 0;
        switch (tx.tx_type as TxType) {
          case '입고': openingMap[key] += tx.quantity; break;
          case '이동입고': openingMap[key] += tx.quantity; break;
          case '출고': openingMap[key] -= tx.quantity; break;
          case '반품': openingMap[key] += tx.quantity; break;
          case '재고조정': openingMap[key] += tx.quantity; break;
          case '마킹출고': openingMap[key] -= tx.quantity; break;
          case '마킹입고': openingMap[key] += tx.quantity; break;
          case '판매': openingMap[key] -= tx.quantity; break;
          case '기초재고': openingMap[key] += tx.quantity; break;
        }
      }

      // 기간내 트랜잭션 집계 (base_barcode 기준 합산)
      for (const tx of txData) {
        const key = makeKey(tx.warehouse_id, tx.sku_id);
        if (!txMap[key]) txMap[key] = { in: 0, transferIn: 0, sales: 0, out: 0, return: 0, adjust: 0, markingOut: 0, markingIn: 0 };
        switch (tx.tx_type as TxType) {
          case '입고': txMap[key].in += tx.quantity; break;
          case '이동입고': txMap[key].transferIn += tx.quantity; break;
          case '출고': txMap[key].out += tx.quantity; break;
          case '반품': txMap[key].return += tx.quantity; break;
          case '재고조정': txMap[key].adjust += tx.quantity; break;
          case '마킹출고': txMap[key].markingOut += tx.quantity; break;
          case '마킹입고': txMap[key].markingIn += tx.quantity; break;
          case '판매': txMap[key].sales += tx.quantity; break;
          case '기초재고': txMap[key].in += tx.quantity; break;
        }
      }

      // 모든 그룹 키 수집
      const allKeys = new Set<string>();
      for (const key of Object.keys(openingMap)) allKeys.add(key);
      for (const key of Object.keys(txMap)) allKeys.add(key);

      // 그룹 키별 대표 SKU 정보 결정
      // base_barcode → 대표 상품명/바코드 (접미사 없는 SKU 우선)
      const groupInfo: Record<string, { name: string; barcode: string; skuId: string; whName: string }> = {};
      for (const key of allKeys) {
        const [whId, groupId] = key.split('|');
        const wh = warehouses.find((w) => w.id === whId);
        const whName = wh?.name || '';

        // 이 그룹에 해당하는 SKU 중 대표 선택
        let bestName = groupId;
        let bestBarcode = groupId;
        let bestSkuId = groupId;
        let hasPure = false; // 접미사 없는 바코드가 있는지

        for (const [skuId, info] of Object.entries(skuLookup)) {
          if (info.baseBarcode === groupId || skuId === groupId) {
            const isPure = info.barcode === groupId; // 접미사 없는 순수 바코드
            if (!hasPure || isPure) {
              bestName = info.name;
              bestBarcode = info.baseBarcode || info.barcode;
              bestSkuId = skuId;
              if (isPure) hasPure = true;
            }
          }
        }

        groupInfo[key] = { name: bestName, barcode: bestBarcode, skuId: bestSkuId, whName };
      }

      // 수불부 행 계산: 기말 = 기초 + 입고 + 이동입고 - 판매 - 이동출고 + 반품 + 조정 - 마킹출고 + 마킹입고
      const ledgerRows: LedgerRow[] = [];
      for (const key of allKeys) {
        const opening = openingMap[key] || 0;
        const tx = txMap[key] || { in: 0, transferIn: 0, sales: 0, out: 0, return: 0, adjust: 0, markingOut: 0, markingIn: 0 };
        const closing = opening + tx.in + tx.transferIn - tx.sales - tx.out + tx.return + tx.adjust - tx.markingOut + tx.markingIn;
        const info = groupInfo[key] || { name: '', barcode: '', skuId: '', whName: '' };

        if (opening === 0 && closing === 0 && tx.in === 0 && tx.transferIn === 0 && tx.sales === 0 && tx.out === 0 && tx.return === 0 && tx.adjust === 0 && tx.markingOut === 0 && tx.markingIn === 0) continue;

        ledgerRows.push({
          warehouseName: info.whName,
          skuId: info.skuId,
          barcode: info.barcode,
          skuName: info.name,
          opening,
          inQty: tx.in,
          transferInQty: tx.transferIn,
          salesQty: tx.sales,
          outQty: tx.out,
          returnQty: tx.return,
          adjustQty: tx.adjust,
          markingOutQty: tx.markingOut,
          markingInQty: tx.markingIn,
          closing,
        });
      }

      // 정렬: 창고명 → 바코드 → SKU코드
      ledgerRows.sort((a, b) => a.warehouseName.localeCompare(b.warehouseName) || a.barcode.localeCompare(b.barcode) || a.skuId.localeCompare(b.skuId));
      if (!isStale()) setRows(ledgerRows);
    } catch (err: any) {
      console.error('수불부 조회 실패:', err);
      setError(err.message || '수불부 조회 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, warehouses]);

  // 필터링
  const filtered = rows.filter((r) => {
    if (warehouseFilter !== '전체' && r.warehouseName !== warehouseFilter) return false;
    if (searchText) {
      const q = searchText.toLowerCase();
      return r.skuId.toLowerCase().includes(q) || r.skuName.toLowerCase().includes(q) || r.barcode.toLowerCase().includes(q);
    }
    return true;
  });

  // ── 매장수불 업로드 핸들러 ──
  const handleOfflineFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset

    setOfflineParseResult(null);
    setOfflineMapped([]);
    setOfflineUnmatched([]);
    setOfflineUploadResult(null);

    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);
      const result = parseOfflineStockExcel(wb);

      if (result.transactions.length === 0) {
        setOfflineUploadResult('파싱된 트랜잭션이 없습니다.');
        return;
      }
      setOfflineParseResult(result);

      // 바코드 → SKU ID 매핑
      const uniqueBarcodes = [...new Set(result.transactions.map((t) => t.barcode))];
      const bcToSku: Record<string, { skuId: string; skuName: string }> = {};
      for (let i = 0; i < uniqueBarcodes.length; i += 500) {
        const batch = uniqueBarcodes.slice(i, i + 500);
        const { data } = await supabase.from('sku').select('sku_id, sku_name, barcode').in('barcode', batch);
        for (const s of (data || []) as any[]) {
          if (s.barcode) bcToSku[s.barcode] = { skuId: s.sku_id, skuName: s.sku_name };
        }
      }

      const mapped: typeof offlineMapped = [];
      const unmatchedSet = new Map<string, string>();

      for (const tx of result.transactions) {
        const sku = bcToSku[tx.barcode];
        if (sku) {
          mapped.push({
            skuId: sku.skuId,
            barcode: tx.barcode,
            skuName: sku.skuName,
            date: tx.date,
            quantity: tx.quantity,
            type: tx.txType,
          });
        } else {
          unmatchedSet.set(tx.barcode, tx.skuName);
        }
      }

      setOfflineMapped(mapped);
      setOfflineUnmatched([...unmatchedSet].map(([barcode, skuName]) => ({ barcode, skuName })));
    } catch (err: any) {
      setOfflineUploadResult(`파싱 오류: ${err.message}`);
    }
  };

  const handleOfflineSave = async () => {
    if (offlineMapped.length === 0) return;
    const offWhId = warehouses.find((w) => w.name === '오프라인샵')?.id;
    if (!offWhId) { setOfflineUploadResult('오프라인샵 창고를 찾을 수 없습니다.'); return; }

    setOfflineUploading(true);
    setOfflineUploadResult(null);

    // 양수/음수 분리 (recordTransactionBatch는 quantity>0만 처리)
    const positive = offlineMapped.filter((t) => t.quantity > 0);
    const negative = offlineMapped.filter((t) => t.quantity < 0);

    const skuNameMap = new Map(offlineMapped.map((t) => [t.skuId, t.skuName]));

    let totalSuccess = 0;
    let totalFailed = 0;

    // 양수 배치
    if (positive.length > 0) {
      const result = await recordTransactionBatch(
        positive.map((t) => ({
          warehouseId: offWhId,
          skuId: t.skuId,
          txType: t.type as any,
          quantity: t.quantity,
          source: 'offline_manual' as const,
          txDate: t.date,
          memo: `매장수불:${t.date}:${t.type}`,
        })),
        skuNameMap,
        (cur, tot) => setOfflineUploadProgress({ current: cur, total: tot }),
      );
      totalSuccess += result.success;
      totalFailed += result.failed;
    }

    // 음수(재고조정) 개별 처리
    for (const t of negative) {
      const { recordTransaction } = await import('../../lib/inventoryTransaction');
      await recordTransaction({
        warehouseId: offWhId,
        skuId: t.skuId,
        txType: t.type as any,
        quantity: t.quantity,
        source: 'offline_manual',
        txDate: t.date,
        memo: `매장수불:${t.date}:${t.type}`,
      });
      totalSuccess++;
    }

    setOfflineUploadProgress(null);
    setOfflineUploading(false);
    setOfflineUploadResult(
      `저장 완료: ${totalSuccess}건 성공${totalFailed > 0 ? `, ${totalFailed}건 실패` : ''}` +
      (offlineUnmatched.length > 0 ? ` (매핑 실패 ${offlineUnmatched.length}종 제외)` : '')
    );
    setOfflineMapped([]);
    setOfflineParseResult(null);
    fetchLedger();
  };

  // 엑셀 다운로드
  const handleExport = () => {
    const exportData = filtered.map((r) => ({
      '창고': r.warehouseName,
      'SKU코드': r.skuId,
      '바코드': r.barcode,
      '상품명': r.skuName,
      '기초': r.opening,
      '입고': r.inQty,
      '이동입고': r.transferInQty,
      '판매': r.salesQty,
      '이동출고': r.outQty,
      '반품': r.returnQty,
      '조정': r.adjustQty,
      '마킹출고': r.markingOutQty,
      '마킹입고': r.markingInQty,
      '기말': r.closing,
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '수불부');
    XLSX.writeFile(wb, `재고수불부_${startDate}_${endDate}.xlsx`);
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">재고 수불부</h1>

      {/* 필터 영역 */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-gray-600">기간:</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
          <span className="text-gray-400">~</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />

          <select value={warehouseFilter} onChange={(e) => setWarehouseFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
            <option value="전체">전체 창고</option>
            {warehouses.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
          </select>

          <button onClick={fetchLedger} disabled={loading}
            className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {loading ? '조회 중...' : '조회'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="SKU코드, 상품명, 바코드 검색" value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-1.5 text-sm" />
          </div>

          <button onClick={handleExport} disabled={filtered.length === 0}
            className="bg-gray-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Download className="w-4 h-4" /> 엑셀 다운로드
          </button>
        </div>
      </div>

      {/* ── 매장수불 업로드 ── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Store size={18} className="text-green-600" />
            <h3 className="font-semibold text-gray-800">매장 수불부 업로드</h3>
          </div>
          <label className="cursor-pointer bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-colors">
            <Upload size={14} />
            엑셀 선택
            <input type="file" accept=".xls,.xlsx" className="hidden" onChange={handleOfflineFileUpload} disabled={readOnly} />
          </label>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          오프라인 매장 수불부 엑셀을 업로드하면 기초재고/입고/판매/재고조정이 자동 반영됩니다.
          (이동출고는 발송확인으로 이미 기록되어 있어 제외됩니다)
        </p>

        {/* 파싱 결과 미리보기 */}
        {offlineParseResult && offlineMapped.length > 0 && (
          <div className="space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
              <p className="font-medium text-green-800 mb-1">파싱 완료</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-green-700">
                <span>기간: {offlineParseResult.dateRange.min} ~ {offlineParseResult.dateRange.max}</span>
                <span>품목: {offlineParseResult.productCount}종</span>
                {Object.entries(offlineParseResult.summary).map(([type, count]) => (
                  <span key={type}>{type}: {count}건</span>
                ))}
                <span className="font-semibold">매핑 성공: {offlineMapped.length}건</span>
              </div>
            </div>

            {offlineUnmatched.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm">
                <p className="font-medium text-yellow-800 mb-1">
                  <AlertTriangle size={14} className="inline mr-1" />
                  바코드 매핑 실패 ({offlineUnmatched.length}종) — 아래 품목은 제외됩니다
                </p>
                <div className="max-h-24 overflow-y-auto text-xs text-yellow-700 space-y-0.5">
                  {offlineUnmatched.map((u) => (
                    <div key={u.barcode}>{u.barcode} — {u.skuName}</div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={handleOfflineSave}
              disabled={readOnly || offlineUploading}
              className="w-full py-2.5 rounded-lg text-white font-medium bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {offlineUploading ? '저장 중...' : `DB 저장 (${offlineMapped.length}건)`}
            </button>

            {offlineUploadProgress && (
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-green-600 h-2 rounded-full transition-all"
                  style={{ width: `${Math.round((offlineUploadProgress.current / offlineUploadProgress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {offlineUploadResult && !offlineUploading && (
          <div className={`rounded-lg p-3 text-sm mt-3 ${offlineUploadResult.includes('오류') ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-blue-50 border border-blue-200 text-blue-800'}`}>
            {offlineUploadResult}
          </div>
        )}
      </div>

      {/* 데이터 갱신 중 표시 */}
      {loading && rows.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-blue-700">데이터 갱신 중...</span>
        </div>
      )}

      {/* 수불부 테이블 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">창고</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">SKU코드</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">바코드</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">상품명</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600 whitespace-nowrap">기초</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-blue-600 whitespace-nowrap">입고</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-teal-600 whitespace-nowrap">이동입고</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-red-600 whitespace-nowrap">판매</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-orange-600 whitespace-nowrap">이동출고</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-green-600 whitespace-nowrap">반품</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-amber-600 whitespace-nowrap">조정</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-purple-600 whitespace-nowrap">마킹출고</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-purple-600 whitespace-nowrap">마킹입고</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-900 whitespace-nowrap">기말</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={14} className="px-3 py-8 text-center text-gray-400">조회 중...</td></tr>
              ) : error ? (
                <tr><td colSpan={14} className="px-3 py-8 text-center text-red-500">{error}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={14} className="px-3 py-12 text-center text-gray-400">
                  <div className="flex flex-col items-center gap-2">
                    <Search className="w-8 h-8 text-gray-300" />
                    <p>조회 기간을 설정한 후 <strong className="text-gray-500">조회</strong> 버튼을 클릭하세요</p>
                  </div>
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={14} className="px-3 py-8 text-center text-gray-400">검색 결과가 없습니다</td></tr>
              ) : (
                <>
                  {/* 합계 행 (맨 위) */}
                  <tr className="bg-blue-50 border-b-2 border-blue-200 sticky top-0">
                    <td colSpan={4} className="px-3 py-2.5 text-xs font-bold text-gray-700">합계 ({filtered.length}건)</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums">{filtered.reduce((s, r) => s + r.opening, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-blue-600">{filtered.reduce((s, r) => s + r.inQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-teal-600">{filtered.reduce((s, r) => s + r.transferInQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-red-600">{filtered.reduce((s, r) => s + r.salesQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-orange-600">{filtered.reduce((s, r) => s + r.outQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-green-600">{filtered.reduce((s, r) => s + r.returnQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-amber-600">{filtered.reduce((s, r) => s + r.adjustQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-purple-600">{filtered.reduce((s, r) => s + r.markingOutQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-purple-600">{filtered.reduce((s, r) => s + r.markingInQty, 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums">{filtered.reduce((s, r) => s + r.closing, 0).toLocaleString()}</td>
                  </tr>
                  {filtered.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{r.warehouseName}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs font-mono">{r.skuId}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs font-mono text-gray-500">{r.barcode}</td>
                      <td className="px-3 py-2 text-xs max-w-[400px]">{r.skuName}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">{r.opening.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-blue-600 font-medium">
                        {r.inQty > 0 ? r.inQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-teal-600 font-medium">
                        {r.transferInQty > 0 ? r.transferInQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-red-600 font-medium">
                        {r.salesQty > 0 ? r.salesQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-orange-600 font-medium">
                        {r.outQty > 0 ? r.outQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-green-600 font-medium">
                        {r.returnQty > 0 ? r.returnQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-amber-600 font-medium">
                        {r.adjustQty !== 0 ? r.adjustQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-purple-600 font-medium">
                        {r.markingOutQty > 0 ? r.markingOutQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-purple-600 font-medium">
                        {r.markingInQty > 0 ? r.markingInQty.toLocaleString() : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums font-bold">{r.closing.toLocaleString()}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
