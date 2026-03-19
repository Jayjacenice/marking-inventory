import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import {
  recordTransactionBatch,
  validateTransactionBatch,
  deletePosTransactions,
  countPosTransactions,
} from '../../lib/inventoryTransaction';
import type { ValidationError } from '../../lib/inventoryTransaction';
import {
  extractDateFromPosFilename,
  parsePosExcel,
  matchPosBarcodes,
} from '../../lib/posExcelParser';
import type { PosSaleItem, PosMatchResult } from '../../lib/posExcelParser';
import * as XLSX from 'xlsx';
import {
  ShoppingCart,
  X,
  AlertTriangle,
  CheckCircle,
  Trash2,
  Calendar,
  FileUp,
} from 'lucide-react';

interface ParsedFile {
  filename: string;
  saleDate: string;
  items: PosSaleItem[];
  matched: PosMatchResult[];
  unmatched: PosSaleItem[];
  totalQty: number;
  totalSales: number;
}

export default function SalesUpload() {
  const isStale = useStaleGuard();

  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

  // 오프라인샵 창고
  const [offlineWarehouse, setOfflineWarehouse] = useState<{ id: string; name: string } | null>(null);
  const [warehouseLoading, setWarehouseLoading] = useState(true);

  // 기존 POS 등록 현황
  const [posStatus, setPosStatus] = useState<{ dates: { date: string; count: number }[]; total: number }>({ dates: [], total: 0 });

  // 삭제 모달
  const [deleteModal, setDeleteModal] = useState<{ date: string; count: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 오프라인샵 창고 조회
  useEffect(() => {
    supabase.from('warehouse').select('id, name').then(({ data }) => {
      if (!data) { setWarehouseLoading(false); return; }
      const wh = data.find((w) => w.name.includes('오프라인'));
      if (wh) setOfflineWarehouse(wh);
      setWarehouseLoading(false);
    });
  }, []);

  // POS 등록 현황 조회
  const fetchPosStatus = useCallback(async () => {
    if (!offlineWarehouse) return;
    const { data } = await supabase
      .from('inventory_transaction')
      .select('tx_date')
      .eq('source', 'pos_excel')
      .eq('warehouse_id', offlineWarehouse.id)
      .eq('tx_type', '판매');
    if (!data) return;
    const dateMap: Record<string, number> = {};
    for (const row of data) {
      dateMap[row.tx_date] = (dateMap[row.tx_date] || 0) + 1;
    }
    const dates = Object.entries(dateMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!isStale()) setPosStatus({ dates, total: data.length });
  }, [offlineWarehouse, isStale]);

  useEffect(() => {
    if (offlineWarehouse) fetchPosStatus();
  }, [offlineWarehouse, fetchPosStatus]);

  // 파일 선택 → 파싱 + 바코드 매칭
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = '';

    setParsing(true);
    setUploadResult(null);
    setValidationErrors([]);

    const results: ParsedFile[] = [];
    const errors: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf);
        const items = parsePosExcel(wb);

        const dateStr = extractDateFromPosFilename(file.name);
        const saleDate = dateStr || new Date().toISOString().slice(0, 10);

        const { matched, unmatched } = await matchPosBarcodes(items);
        const totalQty = items.reduce((s, i) => s + i.quantity, 0);
        const totalSales = items.reduce((s, i) => s + i.netSales, 0);

        results.push({
          filename: file.name,
          saleDate,
          items,
          matched,
          unmatched,
          totalQty,
          totalSales,
        });
      } catch (err: any) {
        errors.push(`${file.name}: ${err.message}`);
      }
    }

    setParsing(false);
    if (errors.length > 0) {
      setUploadResult(`파싱 실패: ${errors.join(', ')}`);
    }
    if (!isStale()) setParsedFiles(results);
  };

  // 날짜 수정
  const updateDate = (idx: number, newDate: string) => {
    setParsedFiles((prev) => prev.map((f, i) => i === idx ? { ...f, saleDate: newDate } : f));
  };

  // 파일 제거
  const removeFile = (idx: number) => {
    setParsedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  // 저장
  const handleSave = async () => {
    if (parsedFiles.length === 0 || !offlineWarehouse) return;

    // 매칭된 항목만 저장
    const allMatched = parsedFiles.flatMap((f) =>
      f.matched.map((m) => ({
        warehouseId: offlineWarehouse.id,
        skuId: m.skuId,
        txType: '판매' as const,
        quantity: m.item.quantity,
        source: 'pos_excel' as const,
        txDate: f.saleDate,
        memo: `POS:판매:${f.saleDate}`,
      }))
    );

    if (allMatched.length === 0) {
      setUploadResult('매칭된 항목이 없어 저장할 수 없습니다.');
      return;
    }

    // 중복 확인 (같은 날짜에 이미 등록된 데이터)
    const dates = [...new Set(parsedFiles.map((f) => f.saleDate))];
    const duplicateDates: string[] = [];
    for (const date of dates) {
      const count = await countPosTransactions({
        warehouseId: offlineWarehouse.id,
        startDate: date,
        endDate: date,
      });
      if (count > 0) duplicateDates.push(`${date}(${count}건)`);
    }
    if (duplicateDates.length > 0) {
      const ok = window.confirm(
        `이미 등록된 날짜가 있습니다: ${duplicateDates.join(', ')}\n기존 데이터에 추가 등록됩니다. 계속하시겠습니까?`
      );
      if (!ok) return;
    }

    setUploading(true);
    setUploadProgress(null);
    setValidationErrors([]);

    const skuNameMap = new Map<string, string>();
    for (const f of parsedFiles) {
      for (const m of f.matched) {
        skuNameMap.set(m.skuId, m.skuName);
      }
    }

    // 검증
    setUploadResult('검증 중...');
    const validation = await validateTransactionBatch(allMatched, skuNameMap);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      setUploadResult(null);
      setUploading(false);
      return;
    }

    // 저장
    setUploadResult('저장 중...');
    setUploadProgress({ current: 0, total: allMatched.length });
    const result = await recordTransactionBatch(allMatched, skuNameMap, (current, total) => {
      setUploadProgress({ current, total });
    });
    setUploadProgress(null);
    setUploadResult(
      `저장 완료: ${result.success}건 성공${result.failed > 0 ? `, ${result.failed}건 실패` : ''}`
    );
    setUploading(false);
    setParsedFiles([]);
    fetchPosStatus();
  };

  // 날짜별 삭제
  const openDeleteModal = async (date: string) => {
    if (!offlineWarehouse) return;
    const count = await countPosTransactions({
      warehouseId: offlineWarehouse.id,
      startDate: date,
      endDate: date,
    });
    setDeleteModal({ date, count });
    setDeleteConfirm(false);
  };

  const handleDelete = async () => {
    if (!deleteModal || !offlineWarehouse) return;
    setDeleting(true);
    const result = await deletePosTransactions({
      warehouseId: offlineWarehouse.id,
      startDate: deleteModal.date,
      endDate: deleteModal.date,
    });
    setDeleting(false);
    setDeleteModal(null);
    if (result.error) {
      setUploadResult(`삭제 실패: ${result.error}`);
    } else {
      setUploadResult(`${deleteModal.date} 판매 데이터 ${result.deleted}건 삭제 완료`);
    }
    fetchPosStatus();
  };

  // 전체 통계
  const totalMatchedQty = parsedFiles.reduce((s, f) => s + f.matched.reduce((ss, m) => ss + m.item.quantity, 0), 0);
  const totalUnmatchedQty = parsedFiles.reduce((s, f) => s + f.unmatched.reduce((ss, u) => ss + u.quantity, 0), 0);
  const totalMatchedCount = parsedFiles.reduce((s, f) => s + f.matched.length, 0);
  const totalUnmatchedCount = parsedFiles.reduce((s, f) => s + f.unmatched.length, 0);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ShoppingCart className="w-7 h-7 text-emerald-600" />
        <h1 className="text-2xl font-bold text-gray-900">POS 판매 등록</h1>
      </div>

      {/* 오프라인샵 창고 확인 */}
      {!warehouseLoading && !offlineWarehouse && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 inline mr-1" />
          오프라인샵 창고를 찾을 수 없습니다. 창고 설정을 확인하세요.
        </div>
      )}

      {/* 파일 업로드 영역 */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 mb-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">POS 판매 엑셀 업로드</h3>
        <p className="text-xs text-gray-500 mb-3">
          파일명에서 날짜를 자동 추출합니다 (예: SL팀스토어 오프라인 판매 현황_260318.xlsx → 2026-03-18)
        </p>
        <label className={`cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          parsing || !offlineWarehouse
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
            : 'bg-emerald-600 text-white hover:bg-emerald-700'
        }`}>
          <FileUp className="w-4 h-4" />
          {parsing ? '파싱 중...' : '엑셀 파일 선택 (여러 파일 가능)'}
          <input
            type="file"
            accept=".xls,.xlsx"
            multiple
            onChange={handleFileSelect}
            disabled={parsing || !offlineWarehouse}
            className="hidden"
          />
        </label>
      </div>

      {/* 파싱 결과 미리보기 */}
      {parsedFiles.length > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-4">
          {/* 전체 요약 */}
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-emerald-800">
              파싱 결과: {parsedFiles.length}개 파일
            </h3>
            <button
              onClick={() => { setParsedFiles([]); setValidationErrors([]); }}
              className="text-emerald-600 hover:text-emerald-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 매칭 통계 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="bg-white rounded-lg p-3 border border-emerald-100">
              <div className="text-xs text-gray-500">매칭 성공</div>
              <div className="text-lg font-bold text-emerald-700">{totalMatchedCount}건</div>
              <div className="text-xs text-gray-400">{totalMatchedQty.toLocaleString()}개</div>
            </div>
            <div className="bg-white rounded-lg p-3 border border-emerald-100">
              <div className="text-xs text-gray-500">매칭 실패</div>
              <div className={`text-lg font-bold ${totalUnmatchedCount > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {totalUnmatchedCount}건
              </div>
              <div className="text-xs text-gray-400">{totalUnmatchedQty.toLocaleString()}개</div>
            </div>
            <div className="bg-white rounded-lg p-3 border border-emerald-100">
              <div className="text-xs text-gray-500">총 판매수량</div>
              <div className="text-lg font-bold text-gray-900">
                {(totalMatchedQty + totalUnmatchedQty).toLocaleString()}개
              </div>
            </div>
            <div className="bg-white rounded-lg p-3 border border-emerald-100">
              <div className="text-xs text-gray-500">매칭률</div>
              <div className="text-lg font-bold text-emerald-700">
                {totalMatchedCount + totalUnmatchedCount > 0
                  ? Math.round((totalMatchedCount / (totalMatchedCount + totalUnmatchedCount)) * 100)
                  : 0}%
              </div>
            </div>
          </div>

          {/* 파일별 카드 */}
          {parsedFiles.map((file, idx) => (
            <div key={idx} className="bg-white rounded-lg border border-emerald-100 p-4 mb-3">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate max-w-[300px]">
                    {file.filename}
                  </span>
                  <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                    {file.matched.length}건 매칭
                  </span>
                  {file.unmatched.length > 0 && (
                    <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                      {file.unmatched.length}건 미매칭
                    </span>
                  )}
                </div>
                <button onClick={() => removeFile(idx)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 날짜 편집 */}
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-4 h-4 text-gray-400" />
                <span className="text-xs text-gray-500">판매일:</span>
                <input
                  type="date"
                  value={file.saleDate}
                  onChange={(e) => updateDate(idx, e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
                />
                <span className="text-xs text-gray-400">
                  수량 {file.totalQty.toLocaleString()}개 · 실매출 {file.totalSales.toLocaleString()}원
                </span>
              </div>

              {/* 매칭 상세 (접기) */}
              <details className="text-xs">
                <summary className="cursor-pointer text-emerald-700 font-medium mb-1">
                  상세 보기 ({file.matched.length + file.unmatched.length}건)
                </summary>
                <div className="overflow-x-auto max-h-48 overflow-y-auto mt-2">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-1 text-left">상태</th>
                        <th className="px-2 py-1 text-left">바코드</th>
                        <th className="px-2 py-1 text-left">POS 상품명</th>
                        <th className="px-2 py-1 text-left">매칭 SKU</th>
                        <th className="px-2 py-1 text-right">수량</th>
                        <th className="px-2 py-1 text-right">실매출</th>
                      </tr>
                    </thead>
                    <tbody>
                      {file.matched.map((m, i) => (
                        <tr key={`m-${i}`} className="border-t border-gray-100">
                          <td className="px-2 py-1">
                            <CheckCircle className="w-3.5 h-3.5 text-emerald-500 inline" />
                          </td>
                          <td className="px-2 py-1 font-mono">{m.item.barcode}</td>
                          <td className="px-2 py-1 truncate max-w-[150px]">{m.item.productName}</td>
                          <td className="px-2 py-1 truncate max-w-[150px] text-emerald-700">{m.skuName}</td>
                          <td className="px-2 py-1 text-right font-semibold">{m.item.quantity}</td>
                          <td className="px-2 py-1 text-right">{m.item.netSales.toLocaleString()}</td>
                        </tr>
                      ))}
                      {file.unmatched.map((u, i) => (
                        <tr key={`u-${i}`} className="border-t border-red-100 bg-red-50">
                          <td className="px-2 py-1">
                            <AlertTriangle className="w-3.5 h-3.5 text-red-500 inline" />
                          </td>
                          <td className="px-2 py-1 font-mono text-red-700">{u.barcode}</td>
                          <td className="px-2 py-1 truncate max-w-[150px] text-red-700">{u.productName}</td>
                          <td className="px-2 py-1 text-red-400">-</td>
                          <td className="px-2 py-1 text-right font-semibold text-red-700">{u.quantity}</td>
                          <td className="px-2 py-1 text-right text-red-700">{u.netSales.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          ))}

          {/* 검증 실패 */}
          {validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-sm font-semibold text-red-800">
                  {validationErrors.length}건 검증 실패
                </span>
              </div>
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

          {/* 저장/취소 버튼 */}
          {uploading && uploadProgress ? (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-600 font-medium">
                  저장 중... {uploadProgress.current.toLocaleString()} / {uploadProgress.total.toLocaleString()}건
                  ({uploadProgress.total > 0 ? Math.round((uploadProgress.current / uploadProgress.total) * 100) : 0}%)
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-emerald-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setParsedFiles([]); setValidationErrors([]); }}
                className="px-4 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={uploading || totalMatchedCount === 0 || !offlineWarehouse}
                className="bg-emerald-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {uploading ? '저장 중...' : `매칭된 ${totalMatchedCount}건 저장`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 결과 메시지 */}
      {uploadResult && !uploading && parsedFiles.length === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-800">
          {uploadResult}
        </div>
      )}

      {/* 기존 POS 등록 현황 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">
            판매 등록 현황
            {posStatus.total > 0 && (
              <span className="ml-2 text-xs text-gray-400 font-normal">
                총 {posStatus.total.toLocaleString()}건
              </span>
            )}
          </h3>
        </div>
        {posStatus.dates.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            등록된 판매 데이터가 없습니다
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {posStatus.dates.map((d) => (
              <div key={d.date} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <Calendar className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-900">{d.date}</span>
                  <span className="text-xs text-gray-500">{d.count}건</span>
                </div>
                <button
                  onClick={() => openDeleteModal(d.date)}
                  className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                  title="삭제"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 삭제 확인 모달 */}
      {deleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">판매 데이터 삭제</h3>
            <p className="text-sm text-gray-500 mb-4">
              {deleteModal.date} 판매 데이터 {deleteModal.count}건을 삭제합니다.
            </p>

            {deleteModal.count > 0 && (
              <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm font-medium">
                삭제 대상: {deleteModal.count.toLocaleString()}건
              </div>
            )}

            {deleteModal.count > 0 && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-red-600 font-medium">
                  {deleteModal.count.toLocaleString()}건을 삭제합니다 (복구 불가)
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteModal(null)}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={handleDelete}
                disabled={!deleteConfirm || deleting}
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
