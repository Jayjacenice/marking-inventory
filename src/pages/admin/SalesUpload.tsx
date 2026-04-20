import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouses } from '../../lib/warehouseStore';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { recordTransactionBatch } from '../../lib/inventoryTransaction';
import type { TxType } from '../../types';
import * as XLSX from 'xlsx';
import { useReadOnly } from '../../contexts/ReadOnlyContext';
import {
  AlertTriangle,
  Trash2,
  Calendar,
  FileUp,
  Upload,
  Download,
  Filter,
} from 'lucide-react';

// 유형별 색상 맵 (표시용)
const TYPE_COLORS: Record<string, string> = {
  '입고': 'blue',
  '이동입고': 'teal',
  '판매': 'emerald',
  '이동출고': 'orange',
  '재고조정': 'yellow',
  '반품': 'pink',
};

// 유효한 유형 리스트 (엑셀 '유형' 컬럼 검증용)
const VALID_TYPES = ['입고', '이동입고', '판매', '이동출고', '재고조정'] as const;

// 공백/특수문자 정규화 (엑셀 셀 값에 보이지 않는 공백 방어)
const normalizeType = (s: string) =>
  (s || '').replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]/g, '').trim();

interface ParsedRow {
  barcode: string;
  quantity: number;
  skuId: string | null;
  skuName: string | null;
  matched: boolean;
  txType: TxType | null;   // '유형' 컬럼 값 (DB용 — '이동출고'는 '출고'로 변환 저장)
  displayType: string;     // 화면 표시용 라벨 (이동출고/입고/판매/...)
  saleDate?: string;
  saleType?: string;       // POS 매장판매일보용
  brand?: string;          // POS 매장판매일보용
  rowError?: string;       // 행별 에러
}

/** Excel serial date → YYYY-MM-DD */
function excelDateToStr(serial: number): string {
  const d = new Date((serial - 25569) * 86400000);
  return d.toISOString().slice(0, 10);
}

/** 날짜 셀 값을 YYYY-MM-DD 문자열로 변환 */
function parseDateValue(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'number' && val > 40000) return excelDateToStr(val);
  if (typeof val === 'string') {
    const s = val.trim();
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return '';
}

interface SalesUploadProps {
  /** 기준 창고 이름 키워드 (기본 '오프라인' — '오프라인샵' 자동 감지). '플레이위즈' 전달 시 플레이위즈 창고 기준 */
  warehouseName?: string;
}

export default function SalesUpload({ warehouseName = '오프라인' }: SalesUploadProps = {}) {
  const isStale = useStaleGuard();
  const readOnly = useReadOnly();
  const isPlaywith = warehouseName.includes('플레이위즈');

  // 업로드 상태
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [txDate, setTxDate] = useState(new Date().toISOString().slice(0, 10));
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);

  // 이동출고 받는 창고 / 이동입고 출처 창고
  const [transferDestId, setTransferDestId] = useState<string>('');
  const [transferSourceId, setTransferSourceId] = useState<string>('');

  // 창고 목록
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [offlineWarehouse, setOfflineWarehouse] = useState<{ id: string; name: string } | null>(null);
  const [warehouseLoading, setWarehouseLoading] = useState(true);

  // 등록 현황
  const [txStatus, setTxStatus] = useState<{ date: string; txType: string; count: number; totalQty: number }[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('전체');

  // 저장 확인 모달
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);

  // 삭제 모달
  const [deleteModal, setDeleteModal] = useState<{ date: string; txType: string; count: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 매장판매일보 / 날짜별 포맷 감지 상태
  const [isPosDaily, setIsPosDaily] = useState(false);
  const [posDailyStats, setPosDailyStats] = useState<{ total: number; filtered: number; saleCount: number; returnCount: number } | null>(null);

  // 창고 조회
  useEffect(() => {
    getWarehouses().then((list) => {
      setWarehouses(list);
      const wh = list.find((w) => w.name.includes(warehouseName));
      if (wh) setOfflineWarehouse(wh);
      setWarehouseLoading(false);
    });
  }, []);

  // 등록 현황 조회 (이 화면에서 직접 등록한 건만 — memo 패턴으로 구분)
  // 이동 자동 연계(`{창고} → {창고} 이동`)로 상대 창고에 생성된 건은 제외
  const fetchTxStatus = useCallback(async () => {
    if (!offlineWarehouse) return;
    try {
      const { data } = await supabase
        .from('inventory_transaction')
        .select('tx_date, tx_type, quantity, memo')
        .eq('warehouse_id', offlineWarehouse.id)
        .eq('source', 'offline_manual')
        .like('memo', '매장입출고:%')
        .order('tx_date', { ascending: false })
        .limit(5000);
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
    } catch (err) {
      console.error('fetchTxStatus error:', err);
    }
  }, [offlineWarehouse, isStale]);

  useEffect(() => { if (offlineWarehouse) fetchTxStatus(); }, [offlineWarehouse, fetchTxStatus]);

  // 양식 다운로드 (빈 샘플 엑셀)
  const handleDownloadTemplate = () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      ['날짜', '바코드', '수량', '유형'],
      [today, '8804775000001', 10, '입고'],
      [today, '8804775000002', 5, '이동입고'],
      [today, '8804775000003', 3, '판매'],
      [today, '8804775000004', 2, '이동출고'],
      [today, '8804775000005', -1, '재고조정'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 8 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '매장입출고');
    XLSX.writeFile(wb, `매장입출고_양식.xlsx`);
  };

  // 엑셀 파싱
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setParsing(true);
    setUploadResult(null);
    setParsedRows([]);
    setIsPosDaily(false);
    setPosDailyStats(null);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // 매장판매일보 자동 감지 (10컬럼 이상)
      const isDaily = raw.length > 0 && raw[0]?.length >= 10;

      if (isDaily) {
        // ─── 매장판매일보 파싱 (유형 컬럼 불필요 — 자동 판매/반품 분류) ───
        setIsPosDaily(true);
        const startIdx = typeof raw[0][0] === 'string' && isNaN(Number(raw[0][0])) ? 1 : 0;

        interface DailyRow {
          skuCode: string;
          barcode: string;
          quantity: number;
          txType: TxType;
          saleDate: string;
          saleType: string;
          brand: string;
        }

        const dailyRows: DailyRow[] = [];
        let totalDataRows = 0;

        for (let i = startIdx; i < raw.length; i++) {
          const r = raw[i];
          if (!r || !r[3]) continue;
          totalDataRows++;

          const brand = String(r[3] || '');
          if (!brand.includes('카카오엔터')) continue;

          const qty = Number(r[13]) || 0;
          if (qty === 0) continue;

          const saleType = String(r[12] || '').trim();
          const isReturn = saleType === '반품' || qty < 0;

          let saleDate = txDate;
          const rawDate = r[1];
          if (typeof rawDate === 'number' && rawDate > 40000) {
            saleDate = excelDateToStr(rawDate);
          } else if (typeof rawDate === 'string' && rawDate.includes('-')) {
            saleDate = rawDate.slice(0, 10);
          }

          dailyRows.push({
            skuCode: String(r[11] || '').trim(),
            barcode: String(r[10] || '').trim(),
            quantity: Math.abs(qty),
            txType: isReturn ? '반품' : '판매',
            saleDate,
            saleType: isReturn ? '반품' : '판매',
            brand,
          });
        }

        if (dailyRows.length === 0) {
          setPosDailyStats({ total: totalDataRows, filtered: 0, saleCount: 0, returnCount: 0 });
          setUploadResult(`전체 ${totalDataRows}행 중 카카오엔터 브랜드 데이터가 없습니다.`);
          setParsing(false);
          return;
        }

        const saleCount = dailyRows.filter((r) => r.saleType === '판매').length;
        const returnCount = dailyRows.filter((r) => r.saleType === '반품').length;
        setPosDailyStats({ total: totalDataRows, filtered: dailyRows.length, saleCount, returnCount });

        // SKU 매칭
        const skuCodes = [...new Set(dailyRows.map((r) => r.skuCode).filter(Boolean))];
        const skuCodeMap: Record<string, { skuId: string; skuName: string }> = {};
        for (let i = 0; i < skuCodes.length; i += 500) {
          const batch = skuCodes.slice(i, i + 500);
          const { data: skus } = await supabase
            .from('sku')
            .select('sku_id, sku_name')
            .in('sku_id', batch);
          if (skus) for (const s of skus) skuCodeMap[s.sku_id] = { skuId: s.sku_id, skuName: s.sku_name || s.sku_id };
        }

        const unmatchedBarcodes = [...new Set(
          dailyRows.filter((r) => !skuCodeMap[r.skuCode] && r.barcode).map((r) => r.barcode)
        )];
        const barcodeMap: Record<string, { skuId: string; skuName: string }> = {};
        for (let i = 0; i < unmatchedBarcodes.length; i += 500) {
          const batch = unmatchedBarcodes.slice(i, i + 500);
          const { data: skus } = await supabase
            .from('sku')
            .select('sku_id, sku_name, barcode')
            .in('barcode', batch);
          if (skus) for (const s of skus) {
            if (s.barcode) barcodeMap[s.barcode] = { skuId: s.sku_id, skuName: s.sku_name || s.sku_id };
          }
        }

        const parsed: ParsedRow[] = dailyRows.map((r) => {
          const match = skuCodeMap[r.skuCode] || barcodeMap[r.barcode];
          return {
            barcode: r.skuCode || r.barcode,
            quantity: r.quantity,
            skuId: match?.skuId || null,
            skuName: match?.skuName || null,
            matched: !!match,
            txType: r.txType,
            displayType: r.saleType,
            saleDate: r.saleDate,
            saleType: r.saleType,
            brand: r.brand,
          };
        });

        if (!isStale()) setParsedRows(parsed);
      } else {
        // ─── 신규 양식: [날짜, 바코드, 수량, 유형] ───
        if (raw.length < 2) {
          setUploadResult('엑셀에 데이터가 없습니다.');
          setParsing(false);
          return;
        }

        // 헤더에서 컬럼 위치 찾기 (다양한 이름 허용)
        const headers = (raw[0] || []).map((h) => String(h || '').trim().toLowerCase());
        const findIdx = (aliases: string[]) => headers.findIndex((h) => aliases.includes(h));
        const typeIdx = findIdx(['유형', '구분', '종류', 'type']);
        const dateIdx = findIdx(['날짜', '일자', 'date']);
        const barcodeIdx = findIdx(['바코드', 'barcode', 'sku코드', 'sku', 'sku_id']);
        const qtyIdx = findIdx(['수량', 'qty', 'quantity']);

        if (typeIdx < 0) {
          setUploadResult('엑셀에 "유형" 컬럼이 없습니다. 상단의 "양식 다운로드" 버튼으로 새 양식을 받아 사용해주세요.');
          setParsing(false);
          return;
        }
        if (barcodeIdx < 0 || qtyIdx < 0) {
          setUploadResult('엑셀에 "바코드" 또는 "수량" 컬럼이 없습니다.');
          setParsing(false);
          return;
        }

        const parsingRows: {
          barcode: string;
          quantity: number;
          txType: TxType | null;
          displayType: string;
          saleDate?: string;
          saleType?: string;
          rowError?: string;
        }[] = [];

        for (let i = 1; i < raw.length; i++) {
          const r = raw[i];
          if (!r || r.length === 0) continue;

          const barcode = String(r[barcodeIdx] || '').trim();
          const qty = Number(r[qtyIdx]) || 0;
          const rawTypeStr = String(r[typeIdx] || '');
          const normalizedType = normalizeType(rawTypeStr);
          const rowDate = dateIdx >= 0 ? (parseDateValue(r[dateIdx]) || undefined) : undefined;

          if (!barcode && qty === 0) continue; // 빈 행 스킵

          // 유형 검증
          if (!normalizedType) {
            parsingRows.push({
              barcode, quantity: qty, txType: null, displayType: '-',
              saleDate: rowDate,
              rowError: '유형 컬럼이 비어있습니다',
            });
            continue;
          }

          const validType = (VALID_TYPES as readonly string[]).includes(normalizedType);
          if (!validType) {
            parsingRows.push({
              barcode, quantity: qty, txType: null, displayType: rawTypeStr,
              saleDate: rowDate,
              rowError: `알 수 없는 유형: "${rawTypeStr}"`,
            });
            continue;
          }

          // DB 저장용 tx_type ('이동출고'는 '출고'로)
          const dbTxType: TxType = normalizedType === '이동출고' ? '출고' : (normalizedType as TxType);
          const displayType = normalizedType; // 화면 표시는 이동출고 그대로

          if (!barcode) {
            parsingRows.push({
              barcode: '', quantity: qty, txType: dbTxType, displayType,
              saleDate: rowDate,
              rowError: '바코드 누락',
            });
            continue;
          }

          // 수량 처리: 재고조정은 음수 허용, 판매 음수는 반품 자동 변환, 그 외 음수는 에러
          if (qty === 0) {
            parsingRows.push({
              barcode, quantity: 0, txType: dbTxType, displayType,
              saleDate: rowDate,
              rowError: '수량이 0입니다',
            });
            continue;
          }

          if (qty < 0) {
            if (normalizedType === '재고조정') {
              parsingRows.push({ barcode, quantity: qty, txType: '재고조정', displayType: '재고조정', saleDate: rowDate });
            } else if (normalizedType === '판매') {
              parsingRows.push({ barcode, quantity: Math.abs(qty), txType: '반품', displayType: '반품', saleType: '반품', saleDate: rowDate });
            } else {
              parsingRows.push({
                barcode, quantity: qty, txType: dbTxType, displayType,
                saleDate: rowDate,
                rowError: '이 유형은 음수 수량이 허용되지 않습니다',
              });
            }
          } else {
            parsingRows.push({ barcode, quantity: qty, txType: dbTxType, displayType, saleDate: rowDate });
          }
        }

        if (parsingRows.length === 0) {
          setUploadResult('파싱 가능한 데이터가 없습니다.');
          setParsing(false);
          return;
        }

        // SKU 매칭
        const barcodes = [...new Set(parsingRows.map((r) => r.barcode).filter(Boolean))];
        const barcodeToSku: Record<string, { skuId: string; skuName: string }> = {};

        for (let i = 0; i < barcodes.length; i += 500) {
          const batch = barcodes.slice(i, i + 500);
          const { data: skus } = await supabase
            .from('sku')
            .select('sku_id, sku_name, barcode')
            .in('barcode', batch);
          if (skus) for (const s of skus) {
            if (s.barcode) barcodeToSku[s.barcode] = { skuId: s.sku_id, skuName: s.sku_name || s.sku_id };
          }
        }

        const unmatchedCodes = barcodes.filter((b) => !barcodeToSku[b]);
        if (unmatchedCodes.length > 0) {
          for (let i = 0; i < unmatchedCodes.length; i += 500) {
            const batch = unmatchedCodes.slice(i, i + 500);
            const { data: skus } = await supabase
              .from('sku')
              .select('sku_id, sku_name')
              .in('sku_id', batch);
            if (skus) for (const s of skus) {
              barcodeToSku[s.sku_id] = { skuId: s.sku_id, skuName: s.sku_name || s.sku_id };
            }
          }
        }

        const parsed: ParsedRow[] = parsingRows.map((r) => {
          const match = r.barcode ? barcodeToSku[r.barcode] : null;
          return {
            barcode: r.barcode,
            quantity: r.quantity,
            skuId: match?.skuId || null,
            skuName: match?.skuName || null,
            matched: !!match && !r.rowError,
            txType: r.txType,
            displayType: r.displayType,
            saleDate: r.saleDate,
            saleType: r.saleType,
            rowError: r.rowError,
          };
        });

        if (!isStale()) setParsedRows(parsed);
      }
    } catch (err: any) {
      setUploadResult(`파싱 실패: ${err.message}`);
    } finally {
      setParsing(false);
    }
  };

  // 저장
  const handleSave = async () => {
    if (!offlineWarehouse) return;
    const matched = parsedRows.filter((r) => r.matched && r.skuId && r.txType && !r.rowError);
    if (matched.length === 0) return;

    // 이동출고 받는 창고 / 이동입고 출처 창고 검증
    const hasTransferOut = matched.some((r) => r.txType === '출고');
    const hasTransferIn = matched.some((r) => r.txType === '이동입고');
    if (hasTransferOut && !transferDestId) {
      setUploadResult('이동출고 행이 있습니다. 상단에서 "받는 창고"를 선택해주세요.');
      return;
    }
    if (hasTransferIn && !transferSourceId) {
      setUploadResult('이동입고 행이 있습니다. 상단에서 "출처 창고"를 선택해주세요.');
      return;
    }

    setUploading(true);
    setUploadResult('저장 중...');

    try {
      const destName = warehouses.find((w) => w.id === transferDestId)?.name || '';
      const sourceName = warehouses.find((w) => w.id === transferSourceId)?.name || '';

      // 1. 오프라인샵 트랜잭션 (모든 행)
      const offlineTx = matched.map((r) => ({
        warehouseId: offlineWarehouse.id,
        skuId: r.skuId!,
        txType: r.txType!,
        quantity: r.quantity,
        source: 'offline_manual' as const,
        txDate: r.saleDate || txDate,
        memo: `매장입출고:${r.displayType}${r.saleType ? `:${r.saleType}` : ''}`,
      }));

      // 2. 이동출고 → 받는 창고에 '이동입고' 자동 생성
      const destInTx = matched
        .filter((r) => r.txType === '출고')
        .map((r) => ({
          warehouseId: transferDestId,
          skuId: r.skuId!,
          txType: '이동입고' as TxType,
          quantity: r.quantity,
          source: 'offline_manual' as const,
          txDate: r.saleDate || txDate,
          memo: `${offlineWarehouse.name} → ${destName} 이동`,
        }));

      // 3. 이동입고 → 출처 창고에 '출고' 자동 생성
      const sourceOutTx = matched
        .filter((r) => r.txType === '이동입고')
        .map((r) => ({
          warehouseId: transferSourceId,
          skuId: r.skuId!,
          txType: '출고' as TxType,
          quantity: r.quantity,
          source: 'offline_manual' as const,
          txDate: r.saleDate || txDate,
          memo: `${sourceName} → ${offlineWarehouse.name} 이동`,
        }));

      const allTx = [...offlineTx, ...destInTx, ...sourceOutTx];

      const skuNameMap = new Map<string, string>();
      for (const r of matched) {
        if (r.skuId && r.skuName) skuNameMap.set(r.skuId, r.skuName);
      }

      const allowNegative = matched.some((r) => r.txType === '재고조정');
      const result = await recordTransactionBatch(allTx, skuNameMap, undefined, { allowNegative });

      const extras: string[] = [];
      if (destInTx.length > 0) extras.push(`${destName}에 이동입고 ${destInTx.length}건 자동 등록`);
      if (sourceOutTx.length > 0) extras.push(`${sourceName}에서 이동출고 ${sourceOutTx.length}건 자동 등록`);
      const extraMsg = extras.length > 0 ? ` (${extras.join(', ')})` : '';

      setUploadResult(
        `저장 완료: ${result.success}건 성공${result.failed > 0 ? `, ${result.failed}건 실패` : ''}${extraMsg}`
      );
      setParsedRows([]);
      setTransferDestId('');
      setTransferSourceId('');
      fetchTxStatus();
    } catch (err: any) {
      setUploadResult(`저장 실패: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  // 삭제 (이 화면에서 직접 등록한 건만 — 이동 자동 연계 건은 상대 창고에 그대로 유지)
  const openDeleteModal = async (date: string, txType: string) => {
    if (!offlineWarehouse) return;
    const dbTxType = txType === '이동출고' ? '출고' : txType;
    const { count } = await supabase
      .from('inventory_transaction')
      .select('id', { count: 'exact', head: true })
      .eq('warehouse_id', offlineWarehouse.id)
      .eq('source', 'offline_manual')
      .eq('tx_type', dbTxType)
      .eq('tx_date', date)
      .like('memo', '매장입출고:%');
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
      .eq('tx_date', deleteModal.date)
      .like('memo', '매장입출고:%');
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
  const matchedRows = parsedRows.filter((r) => r.matched && !r.rowError);
  const errorRows = parsedRows.filter((r) => r.rowError);
  const unmatchedRows = parsedRows.filter((r) => !r.matched && !r.rowError);
  const matchedQty = matchedRows.reduce((s, r) => s + Math.abs(r.quantity), 0);

  // 유형별 카운트 (미리보기)
  const typeCounts: Record<string, number> = {};
  for (const r of matchedRows) typeCounts[r.displayType] = (typeCounts[r.displayType] || 0) + 1;

  // 이동출고/입고 존재 여부
  const hasTransferOut = matchedRows.some((r) => r.txType === '출고');
  const hasTransferIn = matchedRows.some((r) => r.txType === '이동입고');

  // 이동 창고 옵션: 현재 기준 창고 제외
  const transferWhOptions = warehouses.filter((w) => !w.name.includes(warehouseName));

  // 등록 현황 필터링
  const filteredStatus = statusFilter === '전체'
    ? txStatus
    : txStatus.filter((s) => s.txType === statusFilter);
  const uniqueStatusTypes = [...new Set(txStatus.map((s) => s.txType))];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Upload className="w-7 h-7 text-gray-700" />
          <h1 className="text-2xl font-bold text-gray-900">
            {isPlaywith ? '플레이위즈 입/출고 등록' : '매장 입/출고 등록'}
          </h1>
        </div>
        <button
          onClick={handleDownloadTemplate}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          title="엑셀 양식 다운로드"
        >
          <Download className="w-3.5 h-3.5" />
          양식 다운로드
        </button>
      </div>

      {!warehouseLoading && !offlineWarehouse && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 inline mr-1" />
          {isPlaywith ? '플레이위즈' : '오프라인샵'} 창고를 찾을 수 없습니다.
        </div>
      )}

      {/* 안내 배너 */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 text-xs text-blue-800">
        <p className="font-semibold mb-1">양식 안내</p>
        <p>엑셀 양식: <code className="bg-white px-1.5 py-0.5 rounded text-xs font-mono">[날짜, 바코드, 수량, 유형]</code></p>
        <p className="mt-1">유형: <span className="font-semibold">입고 / 이동입고 / 판매 / 이동출고 / 재고조정</span></p>
        <p className="text-blue-600 mt-1">※ 매장판매일보(POS) 엑셀은 자동 인식되어 판매/반품으로 분류됩니다</p>
      </div>

      {/* 업로드 영역 */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">엑셀 업로드</h3>
            <p className="text-xs text-gray-500 mt-1">유형 컬럼으로 거래 구분 (탭 선택 불필요)</p>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-400" />
            <input
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
              title="날짜 컬럼이 없는 행의 기본 날짜"
            />
          </div>
        </div>
        <label className={`cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          parsing || !offlineWarehouse
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}>
          <FileUp className="w-4 h-4" />
          {parsing ? '파싱 중...' : '엑셀 파일 선택'}
          <input
            type="file"
            accept=".xls,.xlsx"
            onChange={handleFileSelect}
            disabled={readOnly || parsing || !offlineWarehouse}
            className="hidden"
          />
        </label>
      </div>

      {/* 이동 창고 드롭다운 (이동출고/이동입고 있을 때 표시) */}
      {(hasTransferOut || hasTransferIn) && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-4 space-y-2">
          <p className="text-sm font-semibold text-orange-800 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" /> 이동 상대 창고 지정 필요
          </p>
          {hasTransferOut && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-700 min-w-[100px]">이동출고 → 받는 창고:</span>
              <select
                value={transferDestId}
                onChange={(e) => setTransferDestId(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              >
                <option value="">선택하세요</option>
                {transferWhOptions.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
          )}
          {hasTransferIn && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-700 min-w-[100px]">이동입고 ← 출처 창고:</span>
              <select
                value={transferSourceId}
                onChange={(e) => setTransferSourceId(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              >
                <option value="">선택하세요</option>
                {transferWhOptions.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* 파싱 결과 */}
      {parsedRows.length > 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4">
          {/* 매장판매일보 안내 */}
          {isPosDaily && posDailyStats && (
            <div className="bg-white rounded-lg px-3 py-2 mb-3 text-xs text-gray-600">
              매장판매일보 감지 — 전체 {posDailyStats.total}행 중 카카오엔터 <b>{posDailyStats.filtered}행</b> 필터
              {posDailyStats.returnCount > 0 && (
                <span className="ml-2">(판매 {posDailyStats.saleCount}건 + <span className="text-red-600 font-semibold">반품 {posDailyStats.returnCount}건</span>)</span>
              )}
            </div>
          )}

          {/* 요약 카드 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">정상</div>
              <div className="text-lg font-bold text-emerald-700">{matchedRows.length}건</div>
              <div className="text-xs text-gray-400">{matchedQty.toLocaleString()}개</div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">미매칭</div>
              <div className={`text-lg font-bold ${unmatchedRows.length > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {unmatchedRows.length}건
              </div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">에러</div>
              <div className={`text-lg font-bold ${errorRows.length > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {errorRows.length}건
              </div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">전체</div>
              <div className="text-lg font-bold text-gray-700">{parsedRows.length}건</div>
            </div>
          </div>

          {/* 유형별 카운트 */}
          {Object.keys(typeCounts).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(typeCounts).map(([type, count]) => {
                const color = TYPE_COLORS[type] || 'gray';
                return (
                  <span key={type} className={`text-xs px-2.5 py-1 rounded-full bg-${color}-100 text-${color}-700 font-medium`}>
                    {type}: {count}건
                  </span>
                );
              })}
            </div>
          )}

          {/* 상세 테이블 */}
          <details className="text-xs" open={parsedRows.length <= 30}>
            <summary className="cursor-pointer text-gray-700 font-medium mb-2">
              상세 ({parsedRows.length}건)
            </summary>
            <div className="overflow-x-auto max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">상태</th>
                    <th className="px-2 py-1 text-left">유형</th>
                    <th className="px-2 py-1 text-left">날짜</th>
                    <th className="px-2 py-1 text-left">바코드</th>
                    <th className="px-2 py-1 text-left">상품명</th>
                    <th className="px-2 py-1 text-right">수량</th>
                    <th className="px-2 py-1 text-left">비고</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((r, i) => {
                    const typeColor = TYPE_COLORS[r.displayType] || 'gray';
                    return (
                      <tr key={i} className={`border-t ${r.rowError ? 'bg-red-50' : r.matched ? '' : 'bg-yellow-50'}`}>
                        <td className="px-2 py-1">
                          <span className={`inline-block w-2 h-2 rounded-full ${
                            r.rowError ? 'bg-red-500' : r.matched ? 'bg-emerald-500' : 'bg-yellow-500'
                          }`} />
                        </td>
                        <td className="px-2 py-1">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium bg-${typeColor}-100 text-${typeColor}-700`}>
                            {r.displayType || '-'}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-gray-600">{r.saleDate || txDate}</td>
                        <td className="px-2 py-1 font-mono">{r.barcode || '-'}</td>
                        <td className="px-2 py-1 truncate max-w-[200px]">{r.skuName || '-'}</td>
                        <td className={`px-2 py-1 text-right font-semibold ${r.quantity < 0 ? 'text-red-600' : ''}`}>
                          {r.quantity > 0 ? `+${r.quantity}` : r.quantity}
                        </td>
                        <td className="px-2 py-1 text-red-600">{r.rowError || (!r.matched ? 'SKU 미등록' : '')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>

          {/* 저장 버튼 */}
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => { setParsedRows([]); setUploadResult(null); setTransferDestId(''); setTransferSourceId(''); }}
              className="px-4 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50"
            >
              취소
            </button>
            <button
              onClick={() => setSaveConfirmOpen(true)}
              disabled={readOnly || uploading || matchedRows.length === 0}
              className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? '저장 중...' : `${matchedRows.length}건 저장`}
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
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">
            등록 현황
            {filteredStatus.length > 0 && (
              <span className="ml-2 text-xs text-gray-400 font-normal">
                {filteredStatus.reduce((s, d) => s + d.count, 0).toLocaleString()}건
              </span>
            )}
          </h3>
          {uniqueStatusTypes.length > 0 && (
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-gray-400" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
              >
                <option value="전체">전체</option>
                {uniqueStatusTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {filteredStatus.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            {statusFilter === '전체' ? '등록된 데이터가 없습니다' : `"${statusFilter}" 유형 데이터가 없습니다`}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto">
            {filteredStatus.map((d) => {
              const color = TYPE_COLORS[d.txType] || 'gray';
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
                    disabled={readOnly}
                    className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
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

      {/* 저장 확인 모달 */}
      {saveConfirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setSaveConfirmOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">저장 확인</h3>
            <p className="text-sm text-gray-600 mb-4">아래 내용으로 저장하시겠습니까?</p>

            <div className="bg-gray-50 rounded-xl p-4 mb-4 space-y-2 text-sm">
              {Object.entries(typeCounts).map(([type, count]) => {
                const color = TYPE_COLORS[type] || 'gray';
                return (
                  <div key={type} className="flex items-center justify-between">
                    <span className={`text-xs font-medium bg-${color}-100 text-${color}-700 px-2 py-0.5 rounded-full`}>{type}</span>
                    <span className="font-medium text-gray-700">{count}건</span>
                  </div>
                );
              })}
            </div>

            {hasTransferOut && transferDestId && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-2.5 mb-2 text-xs text-orange-800">
                <b>{warehouses.find((w) => w.id === transferDestId)?.name}</b>에 이동입고 {matchedRows.filter((r) => r.txType === '출고').length}건 자동 등록
              </div>
            )}
            {hasTransferIn && transferSourceId && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-2.5 mb-2 text-xs text-orange-800">
                <b>{warehouses.find((w) => w.id === transferSourceId)?.name}</b>에서 이동출고 {matchedRows.filter((r) => r.txType === '이동입고').length}건 자동 등록
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setSaveConfirmOpen(false)} className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">취소</button>
              <button
                onClick={() => { setSaveConfirmOpen(false); handleSave(); }}
                disabled={readOnly}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

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
                disabled={readOnly || !deleteConfirm || deleting}
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
