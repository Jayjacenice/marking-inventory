import { useCallback, useEffect, useRef, useState } from 'react';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import * as XLSX from 'xlsx';
import {
  Database, Search, Download, Upload, Pencil, Trash2, Check, X,
  AlertTriangle, CheckCircle,
} from 'lucide-react';

interface SKU {
  sku_id: string;
  sku_name: string;
  barcode: string | null;
  type: string;
  created_at: string;
}

const SKU_TYPES = ['완제품', '유니폼단품', '마킹단품'] as const;

export default function SKUMaster({ currentUserId }: { currentUserId: string }) {
  const isStale = useStaleGuard();
  const [skus, setSkus] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [typeFilter, setTypeFilter] = useState('전체');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 인라인 편집
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editType, setEditType] = useState('');
  const [saving, setSaving] = useState(false);

  // 삭제
  const [deleteTarget, setDeleteTarget] = useState<SKU | null>(null);

  // 엑셀 업로드
  const [uploadPreview, setUploadPreview] = useState<{ changes: { skuId: string; field: string; from: string; to: string }[]; total: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [uploadData, setUploadData] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 데이터 로딩 (1000건씩 페이지네이션) ──
  const loadSkus = useCallback(async () => {
    setLoading(true);
    try {
      const all: SKU[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabaseAdmin
          .from('sku')
          .select('sku_id, sku_name, barcode, type, created_at')
          .order('sku_name', { ascending: true })
          .range(offset, offset + 999);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as SKU[]));
        if (data.length < 1000) break;
        offset += 1000;
      }
      if (!isStale()) setSkus(all);
    } catch (err: any) {
      setMessage({ type: 'error', text: `로딩 실패: ${err.message}` });
    } finally {
      setLoading(false);
    }
  }, [isStale]);

  useEffect(() => { loadSkus(); }, [loadSkus]);

  // ── 필터링 ──
  const filtered = skus.filter((s) => {
    if (typeFilter !== '전체' && s.type !== typeFilter) return false;
    if (searchText) {
      const q = searchText.toLowerCase();
      return (
        s.sku_id.toLowerCase().includes(q) ||
        s.sku_name.toLowerCase().includes(q) ||
        (s.barcode || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ── 통계 ──
  const stats = {
    total: skus.length,
    byType: SKU_TYPES.map((t) => ({ type: t, count: skus.filter((s) => s.type === t).length })),
    withBarcode: skus.filter((s) => s.barcode).length,
    withoutBarcode: skus.filter((s) => !s.barcode).length,
  };

  // ── 인라인 편집 ──
  const startEdit = (sku: SKU) => {
    setEditingId(sku.sku_id);
    setEditName(sku.sku_name);
    setEditBarcode(sku.barcode || '');
    setEditType(sku.type);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    setSaving(true);
    try {
      const updates: any = {
        sku_name: editName.trim(),
        barcode: editBarcode.trim() || null,
        type: editType,
      };
      const { error } = await supabaseAdmin
        .from('sku')
        .update(updates)
        .eq('sku_id', editingId);
      if (error) throw error;

      // activity_log
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'sku_edit',
        action_date: new Date().toISOString().split('T')[0],
        summary: { sku_id: editingId, changes: updates },
      }).then(() => {});

      setEditingId(null);
      setMessage({ type: 'success', text: `${editingId} 수정 완료` });
      loadSkus();
    } catch (err: any) {
      setMessage({ type: 'error', text: `수정 실패: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  // ── 삭제 ──
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      // 참조 체크
      const { count: invCount } = await supabaseAdmin
        .from('inventory')
        .select('*', { count: 'exact', head: true })
        .eq('sku_id', deleteTarget.sku_id);
      const { count: txCount } = await supabaseAdmin
        .from('inventory_transaction')
        .select('*', { count: 'exact', head: true })
        .eq('sku_id', deleteTarget.sku_id);

      if ((invCount || 0) > 0 || (txCount || 0) > 0) {
        setMessage({
          type: 'error',
          text: `삭제 불가: 재고(${invCount}건) 또는 트랜잭션(${txCount}건)에서 참조 중입니다.`,
        });
        setDeleteTarget(null);
        return;
      }

      const { error } = await supabaseAdmin
        .from('sku')
        .delete()
        .eq('sku_id', deleteTarget.sku_id);
      if (error) throw error;

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'sku_delete',
        action_date: new Date().toISOString().split('T')[0],
        summary: { sku_id: deleteTarget.sku_id, sku_name: deleteTarget.sku_name },
      }).then(() => {});

      setMessage({ type: 'success', text: `${deleteTarget.sku_id} 삭제 완료` });
      setDeleteTarget(null);
      loadSkus();
    } catch (err: any) {
      setMessage({ type: 'error', text: `삭제 실패: ${err.message}` });
      setDeleteTarget(null);
    }
  };

  // ── 엑셀 다운로드 ──
  const handleDownload = () => {
    const data = filtered.map((s) => ({
      SKU코드: s.sku_id,
      바코드: s.barcode || '',
      상품명: s.sku_name,
      타입: s.type,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 25 }, { wch: 18 }, { wch: 45 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '품목마스터');
    XLSX.writeFile(wb, `품목마스터_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ── 엑셀 업로드 (일괄수정) ──
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(ws);

      if (rows.length === 0) throw new Error('데이터가 없습니다.');

      // 현재 SKU 맵
      const skuMap = new Map(skus.map((s) => [s.sku_id, s]));

      // 변경 감지
      const changes: { skuId: string; field: string; from: string; to: string }[] = [];
      const validRows: any[] = [];

      for (const row of rows) {
        const skuId = String(row['SKU코드'] || row['sku_id'] || '').trim();
        if (!skuId) continue;

        const existing = skuMap.get(skuId);
        if (!existing) continue; // 존재하지 않는 SKU는 skip

        const newName = String(row['상품명'] || row['sku_name'] || '').trim();
        const newBarcode = String(row['바코드'] || row['barcode'] || '').trim() || null;
        const newType = String(row['타입'] || row['type'] || '').trim();

        let hasChange = false;
        if (newName && newName !== existing.sku_name) {
          changes.push({ skuId, field: '상품명', from: existing.sku_name, to: newName });
          hasChange = true;
        }
        if (newBarcode !== (existing.barcode || null) && (newBarcode || existing.barcode)) {
          changes.push({ skuId, field: '바코드', from: existing.barcode || '', to: newBarcode || '' });
          hasChange = true;
        }
        if (newType && SKU_TYPES.includes(newType as any) && newType !== existing.type) {
          changes.push({ skuId, field: '타입', from: existing.type, to: newType });
          hasChange = true;
        }
        if (hasChange) validRows.push(row);
      }

      setUploadData(validRows);
      setUploadPreview({ changes, total: validRows.length });
    } catch (err: any) {
      setMessage({ type: 'error', text: `파싱 오류: ${err.message}` });
    }
  };

  const handleUploadSave = async () => {
    if (!uploadPreview || uploadData.length === 0) return;
    setUploading(true);
    setUploadProgress({ current: 0, total: uploadData.length });

    try {
      let ok = 0;
      let failed = 0;
      for (let idx = 0; idx < uploadData.length; idx++) {
        const row = uploadData[idx];
        const skuId = String(row['SKU코드'] || row['sku_id'] || '').trim();
        const newName = String(row['상품명'] || row['sku_name'] || '').trim();
        const newBarcode = String(row['바코드'] || row['barcode'] || '').trim() || null;
        const newType = String(row['타입'] || row['type'] || '').trim();

        const updates: any = {};
        if (newName) updates.sku_name = newName;
        if (newBarcode !== undefined) updates.barcode = newBarcode;
        if (newType && SKU_TYPES.includes(newType as any)) updates.type = newType;

        if (Object.keys(updates).length === 0) continue;

        const { error } = await supabaseAdmin
          .from('sku')
          .update(updates)
          .eq('sku_id', skuId);
        if (!error) ok++; else failed++;
        setUploadProgress({ current: idx + 1, total: uploadData.length });
      }

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'sku_bulk_edit',
        action_date: new Date().toISOString().split('T')[0],
        summary: { count: ok, changes: uploadPreview.changes.length },
      }).then(() => {});

      setMessage({ type: 'success', text: `일괄수정 완료: ${ok}건 성공${failed > 0 ? `, ${failed}건 실패` : ''}` });
      setUploadPreview(null);
      setUploadData([]);
      loadSkus();
    } catch (err: any) {
      setMessage({ type: 'error', text: `일괄수정 실패: ${err.message}` });
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center gap-3 mb-6">
        <Database className="w-7 h-7 text-indigo-600" />
        <h1 className="text-2xl font-bold text-gray-900">품목 마스터</h1>
        <span className="text-sm text-gray-400 ml-2">{stats.total.toLocaleString()}건</span>
      </div>

      {/* 알림 */}
      {message && (
        <div className={`mb-4 px-4 py-3 rounded-xl flex items-center justify-between ${
          message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'
        }`}>
          <div className="flex items-center gap-2 text-sm">
            {message.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            {message.text}
          </div>
          <button onClick={() => setMessage(null)}><X size={14} /></button>
        </div>
      )}

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xs text-gray-500">전체</p>
          <p className="text-xl font-bold text-gray-900">{stats.total.toLocaleString()}</p>
        </div>
        {stats.byType.map((t) => (
          <div key={t.type} className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xs text-gray-500">{t.type}</p>
            <p className="text-xl font-bold text-gray-900">{t.count.toLocaleString()}</p>
          </div>
        ))}
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xs text-gray-500">바코드 있음</p>
          <p className="text-xl font-bold text-indigo-600">{stats.withBarcode.toLocaleString()}</p>
        </div>
      </div>

      {/* 검색 + 필터 + 엑셀 */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="SKU코드 / 상품명 / 바코드 검색"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white"
        >
          <option value="전체">전체 타입</option>
          {SKU_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-green-600 text-white rounded-xl text-sm hover:bg-green-700"
        >
          <Download size={14} /> 엑셀 다운로드
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm hover:bg-indigo-700"
        >
          <Upload size={14} /> 엑셀 일괄수정
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} className="hidden" />
      </div>

      {/* 엑셀 업로드 미리보기 */}
      {uploadPreview && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-4">
          <h3 className="font-semibold text-yellow-800 mb-2">일괄수정 미리보기</h3>
          <p className="text-sm text-yellow-700 mb-2">
            {uploadPreview.total}건 SKU, {uploadPreview.changes.length}건 변경사항
          </p>
          <div className="max-h-[200px] overflow-y-auto text-xs">
            <table className="w-full">
              <thead>
                <tr className="bg-yellow-100">
                  <th className="px-2 py-1 text-left">SKU코드</th>
                  <th className="px-2 py-1 text-left">필드</th>
                  <th className="px-2 py-1 text-left">기존값</th>
                  <th className="px-2 py-1 text-left">변경값</th>
                </tr>
              </thead>
              <tbody>
                {uploadPreview.changes.slice(0, 50).map((c, i) => (
                  <tr key={i} className="border-t border-yellow-100">
                    <td className="px-2 py-1 font-mono">{c.skuId}</td>
                    <td className="px-2 py-1">{c.field}</td>
                    <td className="px-2 py-1 text-gray-500">{c.from || '(없음)'}</td>
                    <td className="px-2 py-1 font-semibold text-indigo-700">{c.to || '(없음)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {uploadPreview.changes.length > 50 && (
              <p className="text-center text-yellow-600 mt-1">... 외 {uploadPreview.changes.length - 50}건</p>
            )}
          </div>
          {/* 진행 현황 */}
          {uploadProgress && (
            <div className="mt-3 space-y-1">
              <div className="flex items-center justify-between text-xs text-yellow-700">
                <span>처리 중... {uploadProgress.current} / {uploadProgress.total}</span>
                <span>{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
              </div>
              <div className="w-full bg-yellow-200 rounded-full h-2.5">
                <div
                  className="bg-indigo-600 h-2.5 rounded-full transition-all"
                  style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleUploadSave}
              disabled={uploading}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:bg-gray-300"
            >
              {uploading
                ? `처리 중 (${uploadProgress?.current || 0}/${uploadProgress?.total || 0})`
                : `${uploadPreview.total}건 일괄수정`}
            </button>
            <button
              onClick={() => { setUploadPreview(null); setUploadData([]); }}
              disabled={uploading}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 disabled:opacity-50"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 결과 수 */}
      <p className="text-sm text-gray-500 mb-2">
        검색 결과: {filtered.length.toLocaleString()}건
      </p>

      {/* 테이블 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-2.5 text-left font-semibold text-gray-700 w-[200px]">SKU코드</th>
                <th className="px-3 py-2.5 text-left font-semibold text-gray-700 w-[150px]">바코드</th>
                <th className="px-3 py-2.5 text-left font-semibold text-gray-700">상품명</th>
                <th className="px-3 py-2.5 text-left font-semibold text-gray-700 w-[90px]">타입</th>
                <th className="px-3 py-2.5 text-center font-semibold text-gray-700 w-[80px]">액션</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">불러오는 중...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">검색 결과가 없습니다</td></tr>
              ) : (
                filtered.slice(0, 500).map((sku) => (
                  <tr key={sku.sku_id} className="border-t border-gray-50 hover:bg-gray-50">
                    {editingId === sku.sku_id ? (
                      <>
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs text-gray-500">{sku.sku_id}</span>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={editBarcode}
                            onChange={(e) => setEditBarcode(e.target.value)}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-indigo-400"
                            placeholder="바코드"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-indigo-400"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={editType}
                            onChange={(e) => setEditType(e.target.value)}
                            className="w-full border border-gray-300 rounded px-1 py-1 text-xs"
                          >
                            {SKU_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={saveEdit} disabled={saving} className="p-1 text-green-600 hover:bg-green-50 rounded">
                              <Check size={16} />
                            </button>
                            <button onClick={cancelEdit} className="p-1 text-gray-400 hover:bg-gray-100 rounded">
                              <X size={16} />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 font-mono text-xs text-gray-600">{sku.sku_id}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{sku.barcode || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-2 text-gray-900">{sku.sku_name}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            sku.type === '완제품' ? 'bg-blue-50 text-blue-700' :
                            sku.type === '유니폼단품' ? 'bg-green-50 text-green-700' :
                            'bg-purple-50 text-purple-700'
                          }`}>{sku.type}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => startEdit(sku)} className="p-1 text-indigo-500 hover:bg-indigo-50 rounded">
                              <Pencil size={14} />
                            </button>
                            <button onClick={() => setDeleteTarget(sku)} className="p-1 text-red-400 hover:bg-red-50 rounded">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 500 && (
          <div className="px-4 py-3 bg-gray-50 text-center text-sm text-gray-500 border-t">
            상위 500건만 표시 중 (전체 {filtered.length.toLocaleString()}건) — 검색으로 범위를 좁혀주세요
          </div>
        )}
      </div>

      {/* 삭제 확인 모달 */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">SKU 삭제</h3>
            <p className="text-sm text-gray-600 mb-1">
              <span className="font-mono">{deleteTarget.sku_id}</span>
            </p>
            <p className="text-sm text-gray-600 mb-4">{deleteTarget.sku_name}</p>
            <p className="text-sm text-red-600 mb-4">
              삭제하면 되돌릴 수 없습니다. 재고/트랜잭션에서 참조 중이면 삭제가 불가합니다.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700"
              >
                삭제
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm hover:bg-gray-200"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
