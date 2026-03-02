import { useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { parseWorkOrderExcel, type RawOrderLine } from '../../lib/excelParser';
import { Upload, CheckCircle, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface ParseResult {
  lines: RawOrderLine[];
  markingLines: RawOrderLine[];
  nonMarkingLines: RawOrderLine[];
  downloadDate: string;
}

export default function WorkOrderUpload() {
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState('');
  const [savedWorkOrderId, setSavedWorkOrderId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const processFile = async (file: File) => {
    setParsing(true);
    setParseProgress(null);
    setError('');
    setResult(null);
    setSavedWorkOrderId(null);

    try {
      const parsed = await parseWorkOrderExcel(file, setParseProgress);

      const markingSkuIds = new Set(parsed.markingSkuCodes);
      const markingLines = parsed.lines.filter((l) => markingSkuIds.has(l.skuId));
      const nonMarkingLines = parsed.lines.filter((l) => !markingSkuIds.has(l.skuId));

      setResult({
        lines: parsed.lines,
        markingLines,
        nonMarkingLines,
        downloadDate: parsed.downloadDate,
      });
    } catch (err: any) {
      setError(err.message || '파일 파싱 중 오류가 발생했습니다.');
    } finally {
      setParsing(false);
      setParseProgress(null);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
      processFile(file);
    } else {
      setError('.xlsx 또는 .xls 파일만 업로드 가능합니다.');
    }
  };

  const handleSave = async () => {
    if (!result) return;
    setSaving(true);
    setSaveProgress(null);
    setError('');

    try {
      // 1. 작업지시서 생성
      setSaveProgress({ current: 1, total: 4, step: '작업지시서 생성 중...' });
      const { data: wo, error: woErr } = await supabase
        .from('work_order')
        .insert({ download_date: result.downloadDate, status: '업로드됨' })
        .select()
        .single();

      if (woErr) throw woErr;

      // 2. SKU 자동 등록 (없는 경우)
      setSaveProgress({ current: 2, total: 4, step: `SKU 등록 중... (${result.lines.length}건)` });
      const skuUpserts = result.lines.map((l) => ({
        sku_id: l.skuId,
        sku_name: l.skuName,
        barcode: l.barcode || null,
        type: '완제품',
      }));

      await supabase.from('sku').upsert(skuUpserts, { onConflict: 'sku_id', ignoreDuplicates: true });

      // 3. 작업지시서 라인 생성
      setSaveProgress({ current: 3, total: 4, step: `라인 등록 중... (${result.lines.length}건)` });
      const markingSkuIdSet = new Set(result.markingLines.map((l) => l.skuId));
      const lines = result.lines.map((l) => ({
        work_order_id: wo.id,
        finished_sku_id: l.skuId,
        ordered_qty: l.quantity,
        sent_qty: 0,
        received_qty: 0,
        marked_qty: 0,
        needs_marking: markingSkuIdSet.has(l.skuId),
      }));

      const { error: lineErr } = await supabase.from('work_order_line').insert(lines);
      if (lineErr) throw lineErr;

      // 4. 상태 업데이트
      setSaveProgress({ current: 4, total: 4, step: '상태 업데이트 중...' });
      await supabase
        .from('work_order')
        .update({ status: '이관준비' })
        .eq('id', wo.id);

      setSavedWorkOrderId(wo.id);
    } catch (err: any) {
      setError(err.message || '저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-xl font-bold text-gray-900">작업지시서 업로드</h2>

      {/* 파일 업로드 영역 (클릭 + 드래그앤드롭) */}
      <div
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-blue-500 bg-blue-100'
            : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <FileSpreadsheet size={40} className={`mx-auto mb-3 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
        <p className={`font-medium ${isDragging ? 'text-blue-700' : 'text-gray-600'}`}>
          {isDragging ? '여기에 파일을 놓으세요' : 'BERRIZ 작업지시서 엑셀 파일을 선택하거나 드래그하세요'}
        </p>
        <p className="text-sm text-gray-400 mt-1">
          WorkOrder_YYYYMMDD-YYYYMMDD_YYYYMMDDHHII.xlsx
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFile}
          className="hidden"
        />
      </div>

      {parsing && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-blue-700 font-medium text-center">
            {parseProgress?.step ?? '파일 분석 중...'}
          </p>
          {parseProgress && (
            <>
              <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((parseProgress.current / parseProgress.total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-blue-500 text-center">
                {parseProgress.current} / {parseProgress.total} 단계
                ({Math.round((parseProgress.current / parseProgress.total) * 100)}%)
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* 파싱 결과 */}
      {result && !savedWorkOrderId && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-900 mb-4">
              파싱 결과 — 다운로드 날짜: {result.downloadDate}
            </h3>

            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-gray-900">{result.lines.length}</p>
                <p className="text-xs text-gray-500 mt-0.5">전체 라인</p>
              </div>
              <div className="bg-purple-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-purple-700">{result.markingLines.length}</p>
                <p className="text-xs text-purple-500 mt-0.5">마킹 필요</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-blue-700">{result.nonMarkingLines.length}</p>
                <p className="text-xs text-blue-500 mt-0.5">단품 주문</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">SKU명</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">SKU ID</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">수량</th>
                    <th className="text-center px-3 py-2 font-medium text-gray-600">마킹</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {result.lines.map((line, i) => {
                    const isMarking = result.markingLines.some((m) => m.skuId === line.skuId);
                    return (
                      <tr key={i} className={isMarking ? 'bg-purple-50' : ''}>
                        <td className="px-3 py-2 text-gray-900">{line.skuName}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono">{line.skuId}</td>
                        <td className="px-3 py-2 text-right text-gray-900">{line.quantity}</td>
                        <td className="px-3 py-2 text-center">
                          {isMarking ? (
                            <span className="text-purple-600 font-medium">필요</span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {saving && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
              <p className="text-sm text-blue-700 font-medium text-center">
                {saveProgress?.step ?? '저장 중...'}
              </p>
              {saveProgress && (
                <>
                  <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((saveProgress.current / saveProgress.total) * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-blue-500 text-center">
                    {saveProgress.current} / {saveProgress.total} 단계 완료
                    ({Math.round((saveProgress.current / saveProgress.total) * 100)}%)
                  </p>
                </>
              )}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            <Upload size={18} />
            {saving ? '저장 중...' : '작업지시서 저장 및 등록'}
          </button>
        </div>
      )}

      {/* 저장 완료 */}
      {savedWorkOrderId && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle size={24} className="text-green-600" />
            <div>
              <p className="font-semibold text-green-900">작업지시서가 등록되었습니다</p>
              <p className="text-sm text-green-700">
                양식 다운로드 페이지에서 이관지시서와 재고조정양식을 다운로드하세요.
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate('/admin/downloads')}
            className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
          >
            양식 다운로드 페이지로 이동
          </button>
        </div>
      )}
    </div>
  );
}
