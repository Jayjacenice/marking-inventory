import { useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { parseWorkOrderExcel, type RawOrderLine } from '../../lib/excelParser';
import { Upload, CheckCircle, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface ParseResult {
  lines: RawOrderLine[];
  markingLines: RawOrderLine[];
  nonMarkingLines: RawOrderLine[];
  downloadDate: string;
  berrizIdMap: Record<string, string>;
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
        berrizIdMap: parsed.berrizIdMap,
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

  // 중복 제외 통계
  const [dupStats, setDupStats] = useState<{ total: number; added: number; skipped: number } | null>(null);

  const handleSave = async () => {
    if (!result) return;
    setSaving(true);
    setSaveProgress(null);
    setError('');
    setDupStats(null);

    try {
      // 1. 모든 활성 작업지시서(이관준비~마킹완료)에서 이미 등록된 SKU 확인
      //    RLS가 work_order 읽기를 차단하므로 supabaseAdmin 사용
      setSaveProgress({ current: 1, total: 5, step: '중복 확인 중...' });
      const { data: existingWos } = await supabaseAdmin
        .from('work_order')
        .select('id, download_date, status')
        .in('status', ['이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료']);

      // 기존 작업지시서들의 라인에서 이미 등록된 SKU 목록 조회
      const existingSkuIds = new Set<string>();
      if (existingWos && existingWos.length > 0) {
        const woIds = existingWos.map((w) => w.id);
        for (let i = 0; i < woIds.length; i += 10) {
          const batch = woIds.slice(i, i + 10);
          const { data: existingLines } = await supabaseAdmin
            .from('work_order_line')
            .select('finished_sku_id')
            .in('work_order_id', batch);
          if (existingLines) {
            for (const line of existingLines) existingSkuIds.add(line.finished_sku_id);
          }
        }
      }

      // 중복 제외한 신규 라인만 필터
      const newLines = result.lines.filter((l) => !existingSkuIds.has(l.skuId));
      const skippedCount = result.lines.length - newLines.length;

      if (newLines.length === 0) {
        setDupStats({ total: result.lines.length, added: 0, skipped: skippedCount });
        setSaving(false);
        setSaveProgress(null);
        return;
      }

      // 2. 작업지시서 생성
      setSaveProgress({ current: 2, total: 5, step: '작업지시서 생성 중...' });
      const { data: wo, error: woErr } = await supabase
        .from('work_order')
        .insert({ download_date: result.downloadDate, status: '업로드됨' })
        .select()
        .single();

      if (woErr) throw woErr;

      // 3. SKU 자동 등록 (없는 경우)
      setSaveProgress({ current: 3, total: 5, step: `SKU 등록 중... (${newLines.length}건)` });
      const skuUpserts = newLines.map((l) => ({
        sku_id: l.skuId,
        sku_name: l.skuName,
        barcode: l.barcode || null,
        berriz_id: l.berrizId || null,
        type: '완제품',
      }));

      await supabase.from('sku').upsert(skuUpserts, { onConflict: 'sku_id' });

      // 단품(유니폼+마킹) berriz_id 업데이트
      if (result.berrizIdMap) {
        const entries = Object.entries(result.berrizIdMap);
        const BATCH = 20;
        for (let i = 0; i < entries.length; i += BATCH) {
          const batch = entries.slice(i, i + BATCH);
          await Promise.all(
            batch.map(([code, berrizId]) =>
              supabase.from('sku').update({ berriz_id: berrizId })
                .eq('sku_id', code).is('berriz_id', null)
            )
          );
          setSaveProgress({
            current: 3, total: 5,
            step: `SKU 등록 중... (${Math.min(i + BATCH, entries.length)}/${entries.length})`,
          });
        }
      }

      // 4. 작업지시서 라인 생성 (신규만)
      setSaveProgress({ current: 4, total: 5, step: `라인 등록 중... (${newLines.length}건, 중복 ${skippedCount}건 제외)` });
      const markingSkuIdSet = new Set(result.markingLines.map((l) => l.skuId));
      const lines = newLines.map((l) => ({
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

      // 5. 상태 업데이트
      setSaveProgress({ current: 5, total: 5, step: '상태 업데이트 중...' });
      await supabase
        .from('work_order')
        .update({ status: '이관준비' })
        .eq('id', wo.id);

      setSavedWorkOrderId(wo.id);
      setDupStats({ total: result.lines.length, added: newLines.length, skipped: skippedCount });
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
                <p className="text-lg font-bold text-purple-700">
                  {result.markingLines.length}<span className="text-sm font-medium">품목</span>
                  {' / '}
                  {result.markingLines.reduce((s, l) => s + l.quantity, 0).toLocaleString()}<span className="text-sm font-medium">수량</span>
                </p>
                <p className="text-xs text-purple-500 mt-0.5">마킹 필요</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <p className="text-lg font-bold text-blue-700">
                  {result.nonMarkingLines.length}<span className="text-sm font-medium">품목</span>
                  {' / '}
                  {result.nonMarkingLines.reduce((s, l) => s + l.quantity, 0).toLocaleString()}<span className="text-sm font-medium">수량</span>
                </p>
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

      {/* 전체 중복 — 신규 라인 없음 */}
      {dupStats && dupStats.added === 0 && !savedWorkOrderId && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <AlertTriangle size={24} className="text-yellow-600" />
            <div>
              <p className="font-semibold text-yellow-900">모든 라인이 이미 등록되어 있습니다</p>
              <p className="text-sm text-yellow-700">
                전체 {dupStats.total}건 중 {dupStats.skipped}건이 기존 작업지시서에 이미 존재합니다. 새로 추가할 항목이 없습니다.
              </p>
            </div>
          </div>
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
                {dupStats && dupStats.skipped > 0
                  ? `전체 ${dupStats.total}건 중 신규 ${dupStats.added}건 등록, 중복 ${dupStats.skipped}건 제외`
                  : '양식 다운로드 페이지에서 이관지시서와 재고조정양식을 다운로드하세요.'}
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
