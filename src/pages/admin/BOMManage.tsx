import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { useReadOnly } from '../../contexts/ReadOnlyContext';
import { parseBomExcel, parseBerrizBomExcel, type RawBomRow } from '../../lib/excelParser';
import { Upload, Database, Trash2, AlertTriangle, CheckCircle, FileSpreadsheet, Search } from 'lucide-react';

interface BomEntry {
  id: string;
  finished_sku_id: string;
  finished_sku: { sku_name: string; barcode: string | null } | null;
  component_sku_id: string;
  component: { sku_name: string; barcode: string | null } | null;
  quantity: number;
}

type UploadMode = 'berriz' | 'manual';

export default function BOMManage() {
  const isStale = useStaleGuard();
  const readOnly = useReadOnly();
  const [boms, setBoms] = useState<BomEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; step: string } | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mode, setMode] = useState<UploadMode>('berriz');
  const [isDragging, setIsDragging] = useState(false);
  const [searchText, setSearchText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  useLoadingTimeout(loading, setLoading);

  useEffect(() => {
    loadBoms();
  }, []);

  const loadBoms = async () => {
    setLoading(true);
    try {
      // 1,000행 제한 우회: 페이지네이션으로 전체 로드
      const PAGE_SIZE = 1000;
      const allRows: any[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from('bom')
          .select(
            'id, finished_sku_id, finished_sku:sku!bom_finished_sku_id_fkey(sku_name, barcode), component_sku_id, component:sku!bom_component_sku_id_fkey(sku_name, barcode), quantity'
          )
          .order('finished_sku_id')
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows.push(...data);
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      if (!isStale()) setBoms(allRows as BomEntry[]);
    } catch (err) {
      console.error('loadBoms error:', err);
    } finally {
      setLoading(false);
    }
  };

  const uploadBomRows = async (rows: RawBomRow[]) => {
    // SKU 등록 (완제품 + 단품) — 500개씩 배치
    const allSkus = [
      ...rows.map((r) => ({ sku_id: r.finishedSkuId, sku_name: r.finishedSkuName, barcode: null, type: '완제품' })),
      ...rows.map((r) => ({
        sku_id: r.componentSkuId,
        sku_name: r.componentSkuName,
        barcode: null,
        type: r.componentSkuName.includes('마킹') ? '마킹단품' : '유니폼단품',
      })),
    ];
    const uniqueSkus = Array.from(new Map(allSkus.map((s) => [s.sku_id, s])).values());

    const SKU_BATCH = 500;
    const skuBatchCount = Math.ceil(uniqueSkus.length / SKU_BATCH);
    for (let i = 0; i < uniqueSkus.length; i += SKU_BATCH) {
      const batchNum = Math.floor(i / SKU_BATCH) + 1;
      setProgress({ current: batchNum, total: skuBatchCount, step: `SKU 등록 중 (${i + 1}~${Math.min(i + SKU_BATCH, uniqueSkus.length)} / ${uniqueSkus.length})` });
      await supabase
        .from('sku')
        .upsert(uniqueSkus.slice(i, i + SKU_BATCH), { onConflict: 'sku_id', ignoreDuplicates: true });
    }

    // BOM 등록 — 500개씩 배치
    const bomRows = rows.map((r) => ({
      finished_sku_id: r.finishedSkuId,
      component_sku_id: r.componentSkuId,
      quantity: r.quantity,
    }));

    const BOM_BATCH = 500;
    const bomBatchCount = Math.ceil(bomRows.length / BOM_BATCH);
    for (let i = 0; i < bomRows.length; i += BOM_BATCH) {
      const batchNum = Math.floor(i / BOM_BATCH) + 1;
      setProgress({ current: batchNum, total: bomBatchCount, step: `BOM 등록 중 (${i + 1}~${Math.min(i + BOM_BATCH, bomRows.length)} / ${bomRows.length})` });
      const { error } = await supabase
        .from('bom')
        .upsert(bomRows.slice(i, i + BOM_BATCH), { onConflict: 'finished_sku_id,component_sku_id' });
      if (error) throw error;
    }

    return rows.length;
  };

  const processFile = async (file: File) => {
    setUploading(true);
    setMessage(null);
    setProgress(null);

    try {
      setProgress({ current: 0, total: 1, step: '엑셀 파일 파싱 중...' });
      const rows = mode === 'berriz'
        ? await parseBerrizBomExcel(file, (p) => setProgress(p))
        : await parseBomExcel(file, (p) => setProgress(p));
      const count = await uploadBomRows(rows);
      setMessage({ type: 'success', text: `완료! BOM ${count}건 (SKU 포함) 등록되었습니다.` });
      loadBoms();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'BOM 업로드 중 오류가 발생했습니다.' });
    } finally {
      setUploading(false);
      setProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      setMessage({ type: 'error', text: '.xlsx 또는 .xls 파일만 업로드 가능합니다.' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('이 BOM 항목을 삭제하시겠습니까?')) return;
    try {
      const { error } = await supabase.from('bom').delete().eq('id', id);
      if (error) throw error;
      loadBoms();
    } catch (err) {
      console.error('handleDelete error:', err);
      alert('삭제 중 오류가 발생했습니다.');
    }
  };

  // 검색 필터링 후 완제품별 그룹화
  const filtered = searchText
    ? boms.filter((bom) => {
        const q = searchText.toLowerCase();
        return (
          bom.finished_sku_id.toLowerCase().includes(q) ||
          (bom.finished_sku?.sku_name || '').toLowerCase().includes(q) ||
          bom.component_sku_id.toLowerCase().includes(q) ||
          (bom.component?.sku_name || '').toLowerCase().includes(q)
        );
      })
    : boms;

  const grouped: Record<string, BomEntry[]> = {};
  for (const bom of filtered) {
    if (!grouped[bom.finished_sku_id]) grouped[bom.finished_sku_id] = [];
    grouped[bom.finished_sku_id].push(bom);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold text-gray-900">BOM 관리</h2>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="완제품명, 단품명, SKU코드 검색"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={readOnly || uploading}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors shrink-0"
        >
          <Upload size={16} />
          {uploading ? '업로드 중...' : 'BOM 엑셀 업로드'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileUpload}
          disabled={readOnly}
          className="hidden"
        />
      </div>

      {/* 업로드 모드 선택 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <p className="text-sm font-semibold text-gray-700">업로드 양식 선택</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setMode('berriz')}
            className={`p-3 rounded-lg border-2 text-left transition-colors ${
              mode === 'berriz'
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <p className={`text-sm font-medium ${mode === 'berriz' ? 'text-blue-700' : 'text-gray-700'}`}>
              BERRIZ 양식 (자동 인식)
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              sku_excel_upload_template.xlsx · stock_status_*.xlsx
            </p>
            <p className="text-xs text-gray-400 mt-1">
              헤더 기반 자동 매핑: SKU코드 · 구성유형 · BOM구성(품)
            </p>
          </button>
          <button
            onClick={() => setMode('manual')}
            className={`p-3 rounded-lg border-2 text-left transition-colors ${
              mode === 'manual'
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <p className={`text-sm font-medium ${mode === 'manual' ? 'text-blue-700' : 'text-gray-700'}`}>
              수동 5컬럼 양식
            </p>
            <p className="text-xs text-gray-500 mt-0.5">직접 작성한 BOM 파일</p>
            <p className="text-xs text-gray-400 mt-1">
              완제품ID · 완제품명 · 단품ID · 단품명 · 수량
            </p>
          </button>
        </div>
        {mode === 'berriz' && (
          <p className="text-xs text-blue-600 bg-blue-50 rounded px-3 py-2">
            BERRIZ에서 다운로드한 SKU 업로드 양식 또는 재고 현황 파일을 그대로 업로드하세요. 헤더(SKU코드·구성유형·BOM구성/BOM구성품)로 컬럼을 자동 인식합니다. 수천 행도 자동 배치 처리.
          </p>
        )}
      </div>

      {/* 드래그앤드롭 업로드 영역 */}
      <div
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
          readOnly ? 'opacity-50 cursor-not-allowed' :
          isDragging
            ? 'border-blue-500 bg-blue-100 cursor-pointer'
            : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50 cursor-pointer'
        }`}
        onClick={() => !readOnly && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <FileSpreadsheet size={32} className={`mx-auto mb-2 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
        <p className={`text-sm font-medium ${isDragging ? 'text-blue-700' : 'text-gray-600'}`}>
          {isDragging ? '여기에 파일을 놓으세요' : 'BOM 엑셀 파일을 선택하거나 드래그하세요'}
        </p>
        <p className="text-xs text-gray-400 mt-1">.xlsx, .xls 파일 지원</p>
      </div>

      {message && (
        <div
          className={`flex items-center gap-3 p-4 rounded-xl border ${
            message.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {message.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
          <p className="text-sm">{message.text}</p>
        </div>
      )}

      {uploading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-blue-700 font-medium text-center">
            {progress?.step ?? 'BOM 데이터를 등록하는 중입니다...'}
          </p>
          {progress && (
            <>
              <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-blue-500 text-center">
                {progress.current} / {progress.total} 배치 완료
                ({Math.round((progress.current / progress.total) * 100)}%)
              </p>
            </>
          )}
        </div>
      )}

      {/* 데이터 갱신 중 표시 */}
      {loading && boms.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-blue-700">데이터 갱신 중...</span>
        </div>
      )}

      {loading && boms.length === 0 ? (
        <div className="text-center text-gray-400 py-8">불러오는 중...</div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <Database size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">등록된 BOM이 없습니다.</p>
          <p className="text-sm text-gray-400 mt-1">BERRIZ SKU 업로드 양식 또는 재고 현황 파일을 업로드하세요.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500">
            완제품 <span className="font-semibold text-gray-800">{Object.keys(grouped).length}</span>종 ·
            BOM 엔트리 <span className="font-semibold text-gray-800">{filtered.length}</span>건
            {searchText && filtered.length !== boms.length && (
              <span className="text-blue-600 ml-1">(전체 {boms.length}건 중)</span>
            )}
          </p>
          <div className="space-y-3">
            {Object.entries(grouped).map(([finishedSkuId, items]) => (
              <div
                key={finishedSkuId}
                className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden"
              >
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
                  <p className="font-medium text-gray-900 text-sm">
                    {items[0].finished_sku?.sku_name || finishedSkuId}
                  </p>
                  <p className="text-xs text-gray-500 font-mono">{finishedSkuId}</p>
                  {items[0].finished_sku?.barcode && (
                    <p className="text-xs text-gray-400 font-mono">{items[0].finished_sku.barcode}</p>
                  )}
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((bom) => (
                      <tr key={bom.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <p className="text-gray-700">{bom.component?.sku_name || bom.component_sku_id}</p>
                          <p className="text-xs text-gray-400 font-mono">{bom.component_sku_id}{bom.component?.barcode ? ` · ${bom.component.barcode}` : ''}</p>
                        </td>
                        <td className="px-4 py-2.5 text-gray-900 font-medium text-right">
                          ×{bom.quantity}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => handleDelete(bom.id)}
                            disabled={readOnly}
                            className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
