import { useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { parseStockExcel, type StockRow } from '../../lib/excelParser';
import { Upload, CheckCircle, AlertTriangle, FileSpreadsheet, RotateCcw } from 'lucide-react';

interface ParseResult {
  rows: StockRow[];
  summary: Record<string, { count: number; totalQty: number }>;
}

const WAREHOUSE_ICONS: Record<string, string> = {
  오프라인샵: '📦',
  플레이위즈: '🏭',
  CJ창고: '🚚',
};

export default function InventoryUpload() {
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    setParsing(true);
    setError('');
    setResult(null);
    setSaved(false);
    try {
      const rows = await parseStockExcel(file);

      if (rows.length === 0) {
        setError('매핑된 창고 데이터가 없습니다. K열(창고) 값이 올바른지 확인하세요.');
        return;
      }

      const summary: Record<string, { count: number; totalQty: number }> = {};
      for (const row of rows) {
        if (!summary[row.warehouseName]) {
          summary[row.warehouseName] = { count: 0, totalQty: 0 };
        }
        summary[row.warehouseName].count++;
        summary[row.warehouseName].totalQty += row.qty;
      }

      setResult({ rows, summary });
    } catch (err: any) {
      setError(err.message || '파일 파싱 중 오류가 발생했습니다.');
    } finally {
      setParsing(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    e.target.value = '';
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
      // 1. 창고 ID 조회
      setSaveProgress({ current: 1, total: 5, step: '창고 정보 조회 중...' });
      const { data: warehouses, error: whErr } = await supabase
        .from('warehouse')
        .select('id, name');
      if (whErr) throw whErr;

      const warehouseMap: Record<string, string> = {};
      for (const wh of (warehouses || []) as any[]) {
        warehouseMap[wh.name] = wh.id;
      }

      // 2. 파일에 포함된 창고 목록 확인
      const affectedWarehouses = [...new Set(result.rows.map((r) => r.warehouseName))];

      // 3. Q2→B: 해당 창고 기존 재고 전체 초기화
      setSaveProgress({ current: 2, total: 5, step: '기존 재고 초기화 중...' });
      for (const whName of affectedWarehouses) {
        const whId = warehouseMap[whName];
        if (!whId) continue;
        const { error: clearErr } = await supabase
          .from('inventory')
          .update({ quantity: 0 })
          .eq('warehouse_id', whId);
        if (clearErr) throw clearErr;
      }

      // 4. SKU 자동 등록 (없는 SKU만, 기존 건 무시)
      setSaveProgress({ current: 3, total: 5, step: `SKU 등록 중...` });
      const uniqueSkus = [
        ...new Map(
          result.rows.map((r) => [
            r.skuId,
            { sku_id: r.skuId, sku_name: r.skuName, type: '완제품' as const },
          ])
        ).values(),
      ];

      for (let i = 0; i < uniqueSkus.length; i += 500) {
        const chunk = uniqueSkus.slice(i, i + 500);
        const { error: skuErr } = await supabase
          .from('sku')
          .upsert(chunk, { onConflict: 'sku_id', ignoreDuplicates: true });
        if (skuErr) throw skuErr;
      }

      // 5. inventory upsert (500건씩 배치)
      const inventoryRows = result.rows
        .filter((r) => warehouseMap[r.warehouseName])
        .map((r) => ({
          warehouse_id: warehouseMap[r.warehouseName],
          sku_id: r.skuId,
          quantity: r.qty,
        }));

      const totalChunks = Math.ceil(inventoryRows.length / 500);
      for (let i = 0; i < inventoryRows.length; i += 500) {
        const chunkIdx = Math.floor(i / 500) + 1;
        setSaveProgress({
          current: 4,
          total: 5,
          step: `재고 업데이트 중... (${chunkIdx} / ${totalChunks} 배치)`,
        });
        const chunk = inventoryRows.slice(i, i + 500);
        const { error: invErr } = await supabase
          .from('inventory')
          .upsert(chunk, { onConflict: 'warehouse_id,sku_id' });
        if (invErr) throw invErr;
      }

      setSaveProgress({ current: 5, total: 5, step: '완료!' });
      setSaved(true);
    } catch (err: any) {
      setError(`저장 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  const handleReset = () => {
    setResult(null);
    setSaved(false);
    setError('');
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-xl font-bold text-gray-900">재고 업로드</h2>

      {/* 파일 업로드 영역 */}
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
          {isDragging ? '여기에 파일을 놓으세요' : 'BERRIZ 재고현황 엑셀 파일을 선택하거나 드래그하세요'}
        </p>
        <p className="text-sm text-gray-400 mt-1">stock_status_YYYYMMDD.xlsx</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFile}
          className="hidden"
        />
      </div>

      {parsing && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
          <p className="text-sm text-blue-700 font-medium">파일 분석 중...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* 파싱 결과 미리보기 */}
      {result && !saved && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">파싱 결과</h3>
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600"
              >
                <RotateCcw size={12} />
                다시 선택
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              {['오프라인샵', '플레이위즈', 'CJ창고'].map((wh) => {
                const data = result.summary[wh];
                return (
                  <div key={wh} className="bg-gray-50 rounded-lg p-3">
                    <p className="text-sm font-medium text-gray-700">
                      {WAREHOUSE_ICONS[wh]} {wh}
                    </p>
                    {data ? (
                      <>
                        <p className="text-xl font-bold text-gray-900 mt-1">
                          {data.totalQty.toLocaleString()}개
                        </p>
                        <p className="text-xs text-gray-500">{data.count.toLocaleString()}개 SKU</p>
                      </>
                    ) : (
                      <p className="text-sm text-gray-400 mt-1">파일에 없음</p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-800">
                ⚠️ 재고 반영 시 위 창고들의{' '}
                <strong>기존 재고 전체가 초기화</strong>된 후 이 파일 기준으로 재설정됩니다.
                (가용재고 0 항목 제외)
              </p>
            </div>
          </div>

          {saving && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
              <p className="text-sm text-blue-700 font-medium text-center">
                {saveProgress?.step ?? '처리 중...'}
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
                    {saveProgress.current} / {saveProgress.total} 단계
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
            {saving ? '반영 중...' : '재고 반영'}
          </button>
        </div>
      )}

      {/* 저장 완료 */}
      {saved && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle size={24} className="text-green-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-green-900">재고가 반영되었습니다</p>
              <p className="text-sm text-green-700">대시보드에서 창고별 재고 현황을 확인하세요.</p>
            </div>
          </div>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 text-sm text-green-700 hover:text-green-900"
          >
            <RotateCcw size={14} />
            다른 파일 업로드
          </button>
        </div>
      )}
    </div>
  );
}
