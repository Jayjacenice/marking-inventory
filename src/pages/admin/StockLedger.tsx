import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { recordTransactionBatch, validateTransactionBatch, deleteCjTransactions, countCjTransactions } from '../../lib/inventoryTransaction';
import type { ValidationError } from '../../lib/inventoryTransaction';
import { parseCjShipment, parseCjReceipt, parseCjReturn, detectCjFileType } from '../../lib/cjExcelParser';
import type { CjTransaction } from '../../lib/cjExcelParser';
import { parseOfflineStockExcel } from '../../lib/offlineStockParser';
import type { OfflineStockParseResult } from '../../lib/offlineStockParser';
import type { TxType } from '../../types';
import * as XLSX from 'xlsx';
import { Upload, Download, Search, X, AlertTriangle, CheckCircle, SkipForward, FileUp, Trash2, Store } from 'lucide-react';

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

  // CJ 엑셀 업로드
  const [uploadType, setUploadType] = useState<TxType | null>(null);
  const [parsedItems, setParsedItems] = useState<CjTransaction[]>([]);
  const [skippedCount, setSkippedCount] = useState(0); // 중복 제거된 건수
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null); // 기간 겹침 경고
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

  // CJ 업로드 현황
  const [cjStatus, setCjStatus] = useState<Record<string, { maxDate: string; minDate: string; count: number }>>({});

  // CJ 삭제 모달
  const [deleteModal, setDeleteModal] = useState<{ type: TxType; minDate: string; maxDate: string } | null>(null);
  const [deleteStartDate, setDeleteStartDate] = useState('');
  const [deleteEndDate, setDeleteEndDate] = useState('');
  const [deletePreviewCount, setDeletePreviewCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

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
    supabase.from('warehouse').select('id, name').then(({ data }) => {
      if (data) setWarehouses(data);
    });
  }, []);

  // CJ 업로드 현황 조회
  const fetchCjStatus = useCallback(async () => {
    const cjWh = warehouses.find((w) => w.name.includes('CJ') || w.name.includes('cj'));
    if (!cjWh) return;
    try {
      const { data } = await supabase
        .from('inventory_transaction')
        .select('tx_type, tx_date')
        .eq('source', 'cj_excel')
        .eq('warehouse_id', cjWh.id);
      if (!data) return;
      const status: Record<string, { maxDate: string; minDate: string; count: number }> = {};
      for (const row of data) {
        const type = row.tx_type as string;
        if (!status[type]) status[type] = { maxDate: '', minDate: '9999-99-99', count: 0 };
        status[type].count++;
        if (row.tx_date > status[type].maxDate) status[type].maxDate = row.tx_date;
        if (row.tx_date < status[type].minDate) status[type].minDate = row.tx_date;
      }
      setCjStatus(status);
    } catch (err) {
      console.error('fetchCjStatus error:', err);
    }
  }, [warehouses]);

  useEffect(() => {
    if (warehouses.length > 0) fetchCjStatus();
  }, [fetchCjStatus, warehouses]);

  /** 1,000행 제한 우회: 페이지네이션으로 전체 데이터 조회 */
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
      if (data.length < PAGE_SIZE) break; // 마지막 페이지
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

      // 기초/기간내를 각각 페이지네이션 조회 (1,000행 제한 우회)
      const prevDay = new Date(new Date(startDate).getTime() - 86400000).toISOString().slice(0, 10);
      const preTxData = startDate > SYSTEM_START
        ? await fetchAllTransactions(SYSTEM_START, prevDay)
        : [];
      const txData = await fetchAllTransactions(startDate, endDate);

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
        const isMarkedProduct = skuId.includes('_') && (skuId.startsWith('26UN-') || skuId.startsWith('26MK-'));
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
        const opening = Math.max(0, openingMap[key] || 0);
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

  // CJ 창고 조회 헬퍼 (warehouses state가 비어있을 때 직접 조회)
  const findCjWarehouse = async () => {
    let wh = warehouses.find((w) => w.name.includes('CJ') || w.name.includes('cj'));
    if (!wh) {
      const { data } = await supabase.from('warehouse').select('id, name');
      if (data) {
        setWarehouses(data);
        wh = data.find((w) => w.name.includes('CJ') || w.name.includes('cj'));
      }
    }
    return wh || null;
  };

  // CJ 엑셀 파일 하나를 파싱 + 중복 제거
  const parseAndDedup = async (file: File, forceType: TxType | null): Promise<{
    items: CjTransaction[];
    skipped: number;
    type: TxType;
    overlapMsg: string | null;
  } | null> => {
    const detected = detectCjFileType(file.name);
    const type = forceType || detected;
    if (!type) return null;

    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);

    let allItems: CjTransaction[] = [];
    switch (type) {
      case '출고': allItems = parseCjShipment(wb); break;
      case '입고': allItems = parseCjReceipt(wb); break;
      case '반품': allItems = parseCjReturn(wb); break;
    }

    const cjWh = await findCjWarehouse();
    let newItems = allItems;
    let skipped = 0;
    let overlapMsg: string | null = null;

    if (cjWh) {
      // 출고 파일은 판매+출고 두 타입이 섞일 수 있으므로 두 타입 모두 중복 확인
      const typesToCheck = type === '출고' ? ['출고', '판매'] : [type];
      const existingRefNos = new Set<string>();

      for (const t of typesToCheck) {
        const { data: existingTx } = await supabase
          .from('inventory_transaction')
          .select('memo')
          .eq('source', 'cj_excel')
          .eq('warehouse_id', cjWh.id)
          .eq('tx_type', t);

        for (const tx of existingTx || []) {
          if (tx.memo?.startsWith('CJ:')) {
            const refNo = tx.memo.split(':')[2];
            if (refNo) existingRefNos.add(refNo);
          }
        }
      }

      if (existingRefNos.size > 0) {
        newItems = allItems.filter((item) => !item.refNo || !existingRefNos.has(item.refNo));
        skipped = allItems.length - newItems.length;
      }

      if (newItems.length > 0) {
        const dates = newItems.map((i) => i.date).filter(Boolean).sort();
        const minDate = dates[0];
        const maxDate = dates[dates.length - 1];
        if (minDate && maxDate) {
          let totalOverlap = 0;
          for (const t of typesToCheck) {
            const { count } = await supabase
              .from('inventory_transaction')
              .select('*', { count: 'exact', head: true })
              .eq('source', 'cj_excel')
              .eq('warehouse_id', cjWh.id)
              .eq('tx_type', t)
              .gte('tx_date', minDate)
              .lte('tx_date', maxDate);
            totalOverlap += count || 0;
          }
          if (totalOverlap > 0 && skipped === 0) {
            overlapMsg = `${minDate} ~ ${maxDate} 기간에 이미 출고/판매 데이터 ${totalOverlap}건이 있습니다.`;
          }
        }
      }
    }

    return { items: newItems, skipped, type, overlapMsg };
  };

  // 유형별 단일 파일 업로드 (카드 내 버튼)
  const handleSingleUpload = async (e: React.ChangeEvent<HTMLInputElement>, forceType: TxType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const result = await parseAndDedup(file, forceType);
    if (!result) return;

    setUploadType(result.type);
    setParsedItems(result.items);
    setSkippedCount(result.skipped);
    setOverlapWarning(result.overlapMsg);
    setUploadResult(null);
  };

  // 일괄 업로드 (multiple 파일, 파일명 자동 감지)
  const handleBatchUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = '';

    let allItems: CjTransaction[] = [];
    let totalSkipped = 0;
    const overlapMsgs: string[] = [];
    const failedFiles: string[] = [];

    for (const file of Array.from(files)) {
      const result = await parseAndDedup(file, null);
      if (!result) {
        failedFiles.push(file.name);
        continue;
      }
      allItems = allItems.concat(result.items);
      totalSkipped += result.skipped;
      if (result.overlapMsg) overlapMsgs.push(result.overlapMsg);
    }

    if (failedFiles.length > 0) {
      setOverlapWarning(`파일명으로 유형 감지 실패: ${failedFiles.join(', ')}. 유형별 버튼을 사용해주세요.`);
    } else {
      setOverlapWarning(overlapMsgs.length > 0 ? overlapMsgs.join(' / ') : null);
    }

    // 일괄이므로 uploadType은 혼합일 수 있음 → null로 설정
    const types = [...new Set(allItems.map((i) => i.type))];
    setUploadType(types.length === 1 ? types[0] : null);
    setParsedItems(allItems);
    setSkippedCount(totalSkipped);
    setUploadResult(null);
  };

  const handleSaveTx = async () => {
    if (parsedItems.length === 0) return;
    setUploading(true);
    setUploadProgress(null);
    setValidationErrors([]);

    const cjWarehouse = await findCjWarehouse();
    if (!cjWarehouse) {
      setUploadResult('CJ 창고를 찾을 수 없습니다.');
      setUploading(false);
      return;
    }

    const txRows = parsedItems.map((item) => ({
      warehouseId: cjWarehouse.id,
      skuId: item.skuId,
      txType: item.type,
      quantity: item.quantity,
      source: 'cj_excel' as const,
      txDate: item.date,
      memo: item.refNo ? `CJ:${item.type}:${item.refNo}` : `CJ 엑셀 업로드 (${item.type})`,
    }));

    const skuNameMap = new Map(parsedItems.map((item) => [item.skuId, item.skuName]));

    // 1단계: 검증 (SKU 자동 등록 시도 후 여전히 누락된 SKU 확인)
    setUploadResult('검증 중... SKU 확인');
    const validation = await validateTransactionBatch(txRows, skuNameMap);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      setUploadResult(null);
      setUploading(false);
      return;
    }

    // 2단계: 저장 (검증 통과)
    setUploadResult('저장 중...');
    setUploadProgress({ current: 0, total: txRows.length });
    const result = await recordTransactionBatch(txRows, skuNameMap, (current, total) => {
      setUploadProgress({ current, total });
    });
    setUploadProgress(null);
    setUploadResult(`저장 완료: ${result.success}건 성공${result.failed > 0 ? `, ${result.failed}건 실패` : ''}${skippedCount > 0 ? ` (중복 ${skippedCount}건 자동 제외)` : ''}`);
    setUploading(false);
    setParsedItems([]);
    setSkippedCount(0);
    setOverlapWarning(null);
    setUploadType(null);
    fetchLedger();
    fetchCjStatus();
  };

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

  // CJ 데이터 삭제 모달 열기
  const openDeleteModal = (type: TxType, minDate: string, maxDate: string) => {
    setDeleteModal({ type, minDate, maxDate });
    setDeleteStartDate(minDate);
    setDeleteEndDate(maxDate);
    setDeletePreviewCount(null);
    setDeleteConfirm(false);
    // 초기 건수 조회
    handleDeletePreview(type, minDate, maxDate);
  };

  // 삭제 대상 건수 미리보기
  const handleDeletePreview = async (type: TxType, start: string, end: string) => {
    const cjWh = await findCjWarehouse();
    if (!cjWh) return;
    // 출고 삭제 시 판매도 함께 카운트
    const typesToDelete = type === '출고' ? ['출고', '판매'] as TxType[] : [type];
    let total = 0;
    for (const t of typesToDelete) {
      total += await countCjTransactions({
        warehouseId: cjWh.id,
        txType: t,
        startDate: start,
        endDate: end,
      });
    }
    setDeletePreviewCount(total);
    setDeleteConfirm(false);
  };

  // 삭제 실행
  const handleDelete = async () => {
    if (!deleteModal) return;
    setDeleting(true);
    const cjWh = await findCjWarehouse();
    if (!cjWh) {
      setDeleting(false);
      return;
    }
    // 출고 삭제 시 판매도 함께 삭제
    const typesToDelete = deleteModal.type === '출고' ? ['출고', '판매'] as TxType[] : [deleteModal.type];
    let totalDeleted = 0;
    let lastError: string | null = null;
    for (const t of typesToDelete) {
      const result = await deleteCjTransactions({
        warehouseId: cjWh.id,
        txType: t,
        startDate: deleteStartDate,
        endDate: deleteEndDate,
      });
      if (result.error) lastError = result.error;
      totalDeleted += result.deleted;
    }
    setDeleting(false);
    setDeleteModal(null);
    if (lastError) {
      setUploadResult(`삭제 실패: ${lastError}`);
    } else {
      setUploadResult(`${deleteModal.type} 데이터 ${totalDeleted}건 삭제 완료`);
    }
    fetchLedger();
    fetchCjStatus();
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

      {/* CJ 물류센터 데이터 관리 카드 */}
      {(() => {
        const cjTypes: { type: TxType; label: string }[] = [
          { type: '입고', label: '입고' },
          { type: '출고', label: '출고 (판매+이동출고)' },
          { type: '반품', label: '반품' },
        ];
        const getDaysAgo = (dateStr: string) => {
          return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
        };
        const getColor = (days: number) => {
          if (days <= 3) return { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', dot: 'bg-green-500' };
          if (days <= 7) return { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', dot: 'bg-yellow-500' };
          return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-500' };
        };
        return (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 mb-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">CJ 물류센터 데이터 관리</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              {cjTypes.map(({ type, label }) => {
                // 출고 카드는 판매(CJ) 건수도 합산
                const s = type === '출고' && (cjStatus['출고'] || cjStatus['판매'])
                  ? (() => {
                      const out = cjStatus['출고'];
                      const sales = cjStatus['판매'];
                      if (out && sales) {
                        return {
                          count: out.count + sales.count,
                          minDate: out.minDate < sales.minDate ? out.minDate : sales.minDate,
                          maxDate: out.maxDate > sales.maxDate ? out.maxDate : sales.maxDate,
                        };
                      }
                      return out || sales!;
                    })()
                  : cjStatus[type];
                if (!s) {
                  return (
                    <div key={type} className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex flex-col">
                      <div className="text-xs font-semibold text-gray-500 mb-2">{label}</div>
                      <div className="text-xs text-gray-400 mb-3">업로드 없음</div>
                      <label className="mt-auto cursor-pointer bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 inline-flex items-center justify-center gap-1.5">
                        <Upload className="w-3.5 h-3.5" /> 엑셀 업로드
                        <input type="file" accept=".xls,.xlsx" onChange={(e) => handleSingleUpload(e, type)} className="hidden" />
                      </label>
                    </div>
                  );
                }
                const days = getDaysAgo(s.maxDate);
                const c = getColor(days);
                return (
                  <div key={type} className={`${c.bg} border ${c.border} rounded-lg p-3 flex flex-col`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                      <span className="text-xs font-semibold text-gray-700">{label}</span>
                    </div>
                    <div className="text-sm font-bold text-gray-900">최종: {s.maxDate}</div>
                    <div className="flex items-center justify-between mt-1 mb-3">
                      <span className="text-xs text-gray-500">{s.count.toLocaleString()}건</span>
                      <span className={`text-xs font-medium ${c.text}`}>{days === 0 ? '오늘' : `${days}일 전`}</span>
                    </div>
                    <div className="mt-auto flex items-center gap-2">
                      <label className="flex-1 cursor-pointer bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 inline-flex items-center justify-center gap-1.5">
                        <Upload className="w-3.5 h-3.5" /> 엑셀 업로드
                        <input type="file" accept=".xls,.xlsx" onChange={(e) => handleSingleUpload(e, type)} className="hidden" />
                      </label>
                      <button
                        onClick={() => openDeleteModal(type, s.minDate, s.maxDate)}
                        className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="업로드 이력 삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* 일괄 업로드 */}
            <div className="border-t border-gray-100 pt-3">
              <label className="cursor-pointer bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 inline-flex items-center gap-2">
                <FileUp className="w-4 h-4" /> 일괄 업로드 (여러 파일)
                <input type="file" accept=".xls,.xlsx" multiple onChange={handleBatchUpload} className="hidden" />
              </label>
              <span className="ml-3 text-xs text-gray-400">파일명으로 입고/출고/반품 자동 감지</span>
            </div>
          </div>
        );
      })()}

      {/* CJ 엑셀 파싱 결과 미리보기 */}
      {(parsedItems.length > 0 || skippedCount > 0) && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-yellow-800">
              CJ {uploadType ? `${uploadType} ` : ''}파싱 결과: {parsedItems.length}건
              {parsedItems.length > 0 && (() => {
                const sorted = [...parsedItems].map(i => i.date).filter(Boolean).sort();
                return sorted.length > 0 ? ` (${sorted[0]} ~ ${sorted[sorted.length - 1]})` : '';
              })()}
            </h3>
            <button onClick={() => { setParsedItems([]); setUploadType(null); setSkippedCount(0); setOverlapWarning(null); }}
              className="text-yellow-600 hover:text-yellow-800"><X className="w-5 h-5" /></button>
          </div>
          {/* 중복 제거 안내 */}
          {skippedCount > 0 && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3 text-sm">
              <SkipForward className="w-4 h-4 text-green-600 shrink-0" />
              <span className="text-green-800">전표번호 기준 <strong>{skippedCount}건</strong> 중복 자동 제외 (이미 업로드됨)</span>
            </div>
          )}
          {/* 모든 건이 중복인 경우 */}
          {parsedItems.length === 0 && skippedCount > 0 && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-3 text-sm">
              <CheckCircle className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-blue-800">모든 데이터({skippedCount}건)가 이미 업로드되어 있습니다. 신규 저장할 항목이 없습니다.</span>
            </div>
          )}
          {/* 기간 겹침 경고 */}
          {overlapWarning && (
            <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mb-3 text-sm">
              <AlertTriangle className="w-4 h-4 text-orange-600 shrink-0" />
              <span className="text-orange-800">{overlapWarning}</span>
            </div>
          )}
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            {(() => {
              const isMixed = !uploadType;
              const colCount = isMixed ? 5 : 4;
              // 일괄 업로드 시 유형별 요약
              const typeSummary = isMixed ? (() => {
                const m: Record<string, number> = {};
                for (const item of parsedItems) { m[item.type] = (m[item.type] || 0) + 1; }
                return Object.entries(m).map(([t, c]) => `${t} ${c}건`).join(' / ');
              })() : null;
              return (
                <>
                  {typeSummary && (
                    <div className="text-xs text-yellow-700 mb-2 font-medium">{typeSummary}</div>
                  )}
                  <table className="w-full text-xs">
                    <thead className="bg-yellow-100">
                      <tr>
                        {isMixed && <th className="px-2 py-1 text-left">유형</th>}
                        <th className="px-2 py-1 text-left">날짜</th>
                        <th className="px-2 py-1 text-left">SKU코드</th>
                        <th className="px-2 py-1 text-left">상품명</th>
                        <th className="px-2 py-1 text-right">수량</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedItems.slice(0, 20).map((item, i) => (
                        <tr key={i} className="border-t border-yellow-100">
                          {isMixed && <td className="px-2 py-1 font-medium">{item.type}</td>}
                          <td className="px-2 py-1">{item.date}</td>
                          <td className="px-2 py-1 font-mono">{item.skuId}</td>
                          <td className="px-2 py-1 max-w-[400px]">{item.skuName}</td>
                          <td className="px-2 py-1 text-right font-semibold">{item.quantity.toLocaleString()}</td>
                        </tr>
                      ))}
                      {parsedItems.length > 20 && (
                        <tr className="border-t border-yellow-100">
                          <td colSpan={colCount} className="px-2 py-1 text-center text-yellow-600">... 외 {parsedItems.length - 20}건</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </div>
          {/* 검증 실패 상세 패널 */}
          {validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-sm font-semibold text-red-800">
                  {validationErrors.length}건 검증 실패 — 전체 저장이 차단되었습니다
                </span>
              </div>
              <p className="text-xs text-red-600 mb-2">아래 SKU가 DB에 등록되지 않아 저장할 수 없습니다. 관리자에게 문의하세요.</p>
              <div className="overflow-x-auto max-h-40 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-red-100">
                    <tr>
                      <th className="px-2 py-1 text-left">SKU코드</th>
                      <th className="px-2 py-1 text-left">상품명</th>
                      <th className="px-2 py-1 text-left">사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validationErrors.map((err, i) => (
                      <tr key={i} className="border-t border-red-100">
                        <td className="px-2 py-1 font-mono">{err.skuId}</td>
                        <td className="px-2 py-1">{err.skuName}</td>
                        <td className="px-2 py-1 text-red-600">{err.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 진행률 바 (저장 중) */}
          {uploading && uploadProgress ? (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-600 font-medium">
                  저장 중... {uploadProgress.current.toLocaleString()} / {uploadProgress.total.toLocaleString()}건
                  ({uploadProgress.total > 0 ? Math.round((uploadProgress.current / uploadProgress.total) * 100) : 0}%)
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-green-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => { setParsedItems([]); setUploadType(null); setSkippedCount(0); setOverlapWarning(null); setValidationErrors([]); }}
                className="px-4 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">취소</button>
              <button onClick={handleSaveTx} disabled={uploading || parsedItems.length === 0}
                className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                {uploading ? '검증 중...' : `${parsedItems.length}건 저장`}
              </button>
            </div>
          )}
        </div>
      )}

      {uploadResult && !uploading && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-800">
          {uploadResult}
        </div>
      )}

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
            <input type="file" accept=".xls,.xlsx" className="hidden" onChange={handleOfflineFileUpload} />
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
              disabled={offlineUploading}
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
              {loading ? (
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

      {/* 삭제 확인 모달 */}
      {deleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">CJ {deleteModal.type} 데이터 삭제</h3>
            <p className="text-sm text-gray-500 mb-4">삭제할 기간을 선택하세요 (CJ 엑셀 업로드 데이터만 삭제됩니다)</p>

            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1">
                <label className="text-xs text-gray-500 mb-1 block">시작일</label>
                <input type="date" value={deleteStartDate}
                  onChange={(e) => {
                    setDeleteStartDate(e.target.value);
                    setDeletePreviewCount(null);
                    setDeleteConfirm(false);
                    if (e.target.value && deleteEndDate) handleDeletePreview(deleteModal.type, e.target.value, deleteEndDate);
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <span className="text-gray-400 mt-5">~</span>
              <div className="flex-1">
                <label className="text-xs text-gray-500 mb-1 block">종료일</label>
                <input type="date" value={deleteEndDate}
                  onChange={(e) => {
                    setDeleteEndDate(e.target.value);
                    setDeletePreviewCount(null);
                    setDeleteConfirm(false);
                    if (deleteStartDate && e.target.value) handleDeletePreview(deleteModal.type, deleteStartDate, e.target.value);
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>

            {/* 삭제 대상 건수 미리보기 */}
            {deletePreviewCount !== null && (
              <div className={`rounded-lg px-4 py-3 mb-4 text-sm font-medium ${
                deletePreviewCount > 0 ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-gray-50 text-gray-500 border border-gray-200'
              }`}>
                {deletePreviewCount > 0
                  ? `삭제 대상: ${deletePreviewCount.toLocaleString()}건`
                  : '해당 기간에 삭제할 데이터가 없습니다'}
              </div>
            )}

            {/* 2차 확인 체크박스 */}
            {deletePreviewCount !== null && deletePreviewCount > 0 && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input type="checkbox" checked={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500" />
                <span className="text-sm text-red-600 font-medium">
                  {deletePreviewCount.toLocaleString()}건을 삭제합니다 (복구 불가)
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteModal(null)}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
                취소
              </button>
              <button
                onClick={handleDelete}
                disabled={!deleteConfirm || deleting || !deletePreviewCount}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
