import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouses } from '../../lib/warehouseStore';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { useReadOnly } from '../../contexts/ReadOnlyContext';
import { recordTransaction } from '../../lib/inventoryTransaction';
import * as XLSX from 'xlsx';
import {
  Search, Pencil, Check, X, Upload, FileUp, AlertTriangle,
  ChevronDown, ChevronUp, Download,
} from 'lucide-react';

interface RawInventory {
  warehouse_id: string;
  sku_id: string;
  needs_marking: boolean;
  quantity: number;
}

interface SkuInfo {
  name: string;
  barcode: string;
  baseBarcode: string;
}

interface InventoryPivot {
  skuId: string;               // 대표 SKU (그룹 키)
  skuName: string;
  barcode: string;
  warehouses: Record<string, number>;  // warehouseId → 수량
  total: number;
}

interface ParsedStockItem {
  inputCode: string;
  skuId: string | null;
  skuName: string;
  newQty: number;
  currentQty: number;
  diff: number;
  matched: boolean;
}

export default function InventoryManage({ currentUserId }: { currentUserId: string }) {
  const isStale = useStaleGuard();
  const readOnly = useReadOnly();

  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [inventory, setInventory] = useState<RawInventory[]>([]);
  const [skuLookup, setSkuLookup] = useState<Record<string, SkuInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useLoadingTimeout(loading, setLoading, setError);

  const [search, setSearch] = useState('');
  const [hideZero, setHideZero] = useState(true);

  // 인라인 수정 상태 (키: `${skuId}|${warehouseId}`)
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 기초재고 업로드
  const [showUpload, setShowUpload] = useState(false);
  const [uploadWhId, setUploadWhId] = useState<string>('');
  const [parsing, setParsing] = useState(false);
  const [parsedItems, setParsedItems] = useState<ParsedStockItem[]>([]);
  const [uploadDate, setUploadDate] = useState(new Date().toISOString().slice(0, 10));
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  // 초기 로드
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    setEditingKey(null);
    try {
      // 1. 창고 목록
      const whList = await getWarehouses();
      if (isStale()) return;
      setWarehouses(whList);
      if (!uploadWhId && whList.length > 0) {
        setUploadWhId(whList[0].id);
      }

      // 2. inventory 전체 조회 (페이지네이션 우회)
      const all: RawInventory[] = [];
      let offset = 0;
      while (true) {
        const { data, error: invErr } = await supabase
          .from('inventory')
          .select('warehouse_id, sku_id, needs_marking, quantity')
          .range(offset, offset + 999);
        if (invErr) throw invErr;
        if (!data || data.length === 0) break;
        all.push(...(data as RawInventory[]));
        if (data.length < 1000) break;
        offset += 1000;
      }
      if (isStale()) return;
      setInventory(all);

      // 3. 관련 SKU 정보 조회
      const allSkuIds = [...new Set(all.map((r) => r.sku_id))];
      const lookup: Record<string, SkuInfo> = {};
      for (let i = 0; i < allSkuIds.length; i += 500) {
        const batch = allSkuIds.slice(i, i + 500);
        const { data: skuData } = await supabase
          .from('sku')
          .select('sku_id, sku_name, barcode')
          .in('sku_id', batch);
        if (skuData) {
          for (const s of skuData) {
            const base = s.barcode ? s.barcode.split('_')[0] : '';
            lookup[s.sku_id] = {
              name: s.sku_name || s.sku_id,
              barcode: s.barcode || '',
              baseBarcode: base,
            };
          }
        }
      }
      if (isStale()) return;
      setSkuLookup(lookup);
    } catch (err: any) {
      setError(err.message || '데이터 조회 실패');
    } finally {
      setLoading(false);
    }
  };

  // 피벗: SKU별 창고별 수량 (needs_marking 전체 합산)
  const pivotRows: InventoryPivot[] = useMemo(() => {
    const map = new Map<string, InventoryPivot>();

    for (const r of inventory) {
      const info = skuLookup[r.sku_id];
      // 마킹 완성품(_선수명 접미사)은 개별 유지, 나머지는 sku_id 그대로 (inventory는 이미 sku_id별)
      const key = r.sku_id;
      if (!map.has(key)) {
        map.set(key, {
          skuId: r.sku_id,
          skuName: info?.name || r.sku_id,
          barcode: info?.barcode || '',
          warehouses: {},
          total: 0,
        });
      }
      const row = map.get(key)!;
      row.warehouses[r.warehouse_id] = (row.warehouses[r.warehouse_id] || 0) + r.quantity;
      row.total += r.quantity;
    }

    return Array.from(map.values()).sort((a, b) => a.skuName.localeCompare(b.skuName));
  }, [inventory, skuLookup]);

  // 검색/필터
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pivotRows.filter((r) => {
      if (hideZero && r.total === 0) return false;
      if (!q) return true;
      return (
        r.skuId.toLowerCase().includes(q) ||
        r.skuName.toLowerCase().includes(q) ||
        r.barcode.toLowerCase().includes(q)
      );
    });
  }, [pivotRows, search, hideZero]);

  // 인라인 수정
  const startEdit = (skuId: string, whId: string, qty: number) => {
    setEditingKey(`${skuId}|${whId}`);
    setEditQty(qty);
    setSuccessMsg(null);
  };

  const cancelEdit = () => { setEditingKey(null); };

  const saveEdit = async (skuId: string, whId: string, oldQty: number) => {
    if (editQty < 0) {
      setError('수량은 0 이상이어야 합니다.');
      return;
    }
    if (editQty === oldQty) {
      setEditingKey(null);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // needs_marking=false(일반 재고) 기준으로 upsert
      const { error: upErr } = await supabaseAdmin
        .from('inventory')
        .upsert(
          { warehouse_id: whId, sku_id: skuId, needs_marking: false, quantity: editQty },
          { onConflict: 'warehouse_id,sku_id,needs_marking' }
        );
      if (upErr) throw upErr;

      const diff = editQty - oldQty;
      if (diff !== 0) {
        recordTransaction({
          warehouseId: whId,
          skuId: skuId,
          txType: '재고조정',
          quantity: diff,
          source: 'manual',
          memo: `재고수정: ${oldQty} → ${editQty}`,
        });
      }

      const whName = warehouses.find((w) => w.id === whId)?.name || '';
      const skuName = skuLookup[skuId]?.name || skuId;

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'inventory_adjust',
        work_order_id: null,
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          warehouse: whName,
          skuId,
          skuName,
          before: oldQty,
          after: editQty,
          items: [],
          totalQty: editQty,
        },
      }).then(({ error: logErr }) => { if (logErr) console.warn('activity_log insert failed:', logErr.message); });

      // state 업데이트: inventory 배열 수정
      setInventory((prev) => {
        const idx = prev.findIndex((r) => r.sku_id === skuId && r.warehouse_id === whId && !r.needs_marking);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], quantity: editQty };
          return next;
        } else {
          return [...prev, { warehouse_id: whId, sku_id: skuId, needs_marking: false, quantity: editQty }];
        }
      });
      setEditingKey(null);
      setSuccessMsg(`${skuName} @ ${whName}: ${oldQty} → ${editQty}개로 변경됨`);
    } catch (err: any) {
      setError(`수정 실패: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // 엑셀 다운로드
  const handleDownload = () => {
    const header = ['SKU ID', '상품명', '바코드', ...warehouses.map((w) => w.name), '합계'];
    const rows = filtered.map((r) => [
      r.skuId,
      r.skuName,
      r.barcode,
      ...warehouses.map((w) => r.warehouses[w.id] || 0),
      r.total,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '재고현황');
    XLSX.writeFile(wb, `재고현황_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // 기초재고 업로드
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadWhId) return;
    e.target.value = '';

    setParsing(true);
    setError(null);
    setParsedItems([]);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows: any[] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      if (rawRows.length < 2) {
        setError('엑셀에 데이터가 없습니다. 첫 행은 헤더, 둘째 행부터 데이터여야 합니다.');
        setParsing(false);
        return;
      }

      const dataRows = rawRows.slice(1).filter((r: any[]) => r[0] && r[1] !== undefined && r[1] !== '');
      if (dataRows.length === 0) {
        setError('유효한 데이터가 없습니다. A열: SKU코드 또는 바코드, B열: 수량');
        setParsing(false);
        return;
      }

      // SKU 전체 목록
      const allSkus: { sku_id: string; sku_name: string; barcode: string | null }[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabaseAdmin.from('sku').select('sku_id, sku_name, barcode').range(from, from + 999);
        if (!data || data.length === 0) break;
        allSkus.push(...data);
        if (data.length < 1000) break;
        from += 1000;
      }

      const skuById = new Map(allSkus.map((s) => [s.sku_id, s]));
      const skuByBarcode = new Map<string, typeof allSkus[0]>();
      for (const s of allSkus) if (s.barcode) skuByBarcode.set(s.barcode, s);

      // 해당 창고 현재 재고
      const currentQtyMap = new Map<string, number>();
      for (const r of inventory) {
        if (r.warehouse_id === uploadWhId) {
          currentQtyMap.set(r.sku_id, (currentQtyMap.get(r.sku_id) || 0) + r.quantity);
        }
      }

      const items: ParsedStockItem[] = [];
      for (const row of dataRows) {
        const inputCode = String(row[0]).trim();
        const qty = Math.max(0, parseInt(row[1]) || 0);
        let sku = skuById.get(inputCode);
        if (!sku) sku = skuByBarcode.get(inputCode);
        const currentQty = sku ? (currentQtyMap.get(sku.sku_id) || 0) : 0;
        items.push({
          inputCode,
          skuId: sku?.sku_id || null,
          skuName: sku?.sku_name || '(미매칭)',
          newQty: qty,
          currentQty,
          diff: qty - currentQty,
          matched: !!sku,
        });
      }

      if (isStale()) return;
      setParsedItems(items);
    } catch (err: any) {
      setError(`엑셀 파싱 실패: ${err.message}`);
    } finally {
      setParsing(false);
    }
  };

  const matchedItems = parsedItems.filter((i) => i.matched);
  const unmatchedItems = parsedItems.filter((i) => !i.matched);
  const changedItems = matchedItems.filter((i) => i.diff !== 0);

  const handleApplyStock = async () => {
    if (!uploadWhId || changedItems.length === 0) return;
    const whName = warehouses.find((w) => w.id === uploadWhId)?.name || '';
    const ok = window.confirm(
      `${uploadDate} 기준 ${whName} 창고에 ${changedItems.length}종의 기초재고를 반영합니다.\n변동 없는 ${matchedItems.length - changedItems.length}종은 건너뜁니다.\n\n진행하시겠습니까?`
    );
    if (!ok) return;

    setUploading(true);
    setError(null);
    setUploadProgress('재고 반영 중...');

    try {
      let success = 0;
      const total = changedItems.length;

      for (let i = 0; i < changedItems.length; i += 50) {
        const batch = changedItems.slice(i, i + 50);

        const upsertRows = batch.map((item) => ({
          warehouse_id: uploadWhId,
          sku_id: item.skuId!,
          needs_marking: false,
          quantity: item.newQty,
        }));
        const { error: upsertErr } = await supabaseAdmin
          .from('inventory')
          .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id,needs_marking' });
        if (upsertErr) throw upsertErr;

        const txRows = batch.map((item) => ({
          warehouse_id: uploadWhId,
          sku_id: item.skuId!,
          tx_type: '기초재고',
          quantity: item.newQty,
          source: 'initial_stock',
          tx_date: uploadDate,
          memo: `기초재고: ${item.newQty}`,
        }));
        await supabase.from('inventory_transaction').insert(txRows);

        success += batch.length;
        setUploadProgress(`재고 반영 중... ${success}/${total}`);
      }

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'inventory_adjust',
        work_order_id: null,
        action_date: uploadDate,
        summary: {
          warehouse: whName,
          type: '기초재고 업로드',
          date: uploadDate,
          items: changedItems.slice(0, 10).map((i) => ({ skuId: i.skuId, skuName: i.skuName, before: i.currentQty, after: i.newQty })),
          totalQty: changedItems.reduce((s, i) => s + i.newQty, 0),
          changedCount: changedItems.length,
        },
      }).then(({ error: logErr }) => { if (logErr) console.warn('activity_log insert failed:', logErr.message); });

      setSuccessMsg(`${whName} 창고 기초재고 반영 완료: ${success}종 변경됨 (${uploadDate} 기준)`);
      setParsedItems([]);
      setShowUpload(false);
      loadData();
    } catch (err: any) {
      setError(`기초재고 반영 실패: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">재고 관리</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownload}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            title="현재 뷰 엑셀 다운로드"
          >
            <Download size={14} /> 엑셀 다운로드
          </button>
          <button
            onClick={() => { setShowUpload(!showUpload); setParsedItems([]); }}
            disabled={readOnly}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
              showUpload
                ? 'bg-amber-600 text-white'
                : 'bg-white text-amber-600 border border-amber-200 hover:bg-amber-50'
            } disabled:opacity-50`}
          >
            <Upload size={14} />
            기초재고 업로드
            {showUpload ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {/* 기초재고 업로드 패널 */}
      {showUpload && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-amber-800">기초재고 엑셀 업로드</h3>
          <p className="text-xs text-amber-700">
            A열: SKU코드 또는 바코드, B열: 수량 (첫 행은 헤더). 엑셀 수량으로 현재 재고를 덮어씁니다.
          </p>

          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm text-amber-800 font-medium">창고:</span>
              <select
                value={uploadWhId}
                onChange={(e) => setUploadWhId(e.target.value)}
                className="border border-amber-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-amber-800 font-medium">기준일:</span>
              <input
                type="date"
                value={uploadDate}
                onChange={(e) => setUploadDate(e.target.value)}
                className="border border-amber-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <label className={`cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              parsing || !uploadWhId
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-amber-600 text-white hover:bg-amber-700'
            }`}>
              <FileUp size={16} />
              {parsing ? '파싱 중...' : '엑셀 파일 선택'}
              <input type="file" accept=".xls,.xlsx" onChange={handleFileSelect} disabled={readOnly || parsing || !uploadWhId} className="hidden" />
            </label>
          </div>

          {parsedItems.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white rounded-lg p-3 border border-amber-100">
                  <div className="text-xs text-gray-500">전체</div>
                  <div className="text-lg font-bold text-gray-900">{parsedItems.length}종</div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-amber-100">
                  <div className="text-xs text-gray-500">매칭 성공</div>
                  <div className="text-lg font-bold text-green-600">{matchedItems.length}종</div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-amber-100">
                  <div className="text-xs text-gray-500">변동 있음</div>
                  <div className="text-lg font-bold text-blue-600">{changedItems.length}종</div>
                </div>
                {unmatchedItems.length > 0 && (
                  <div className="bg-white rounded-lg p-3 border border-red-200">
                    <div className="text-xs text-red-500">매칭 실패</div>
                    <div className="text-lg font-bold text-red-600">{unmatchedItems.length}종</div>
                  </div>
                )}
              </div>

              {unmatchedItems.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle size={14} className="text-red-600" />
                    <span className="text-sm font-semibold text-red-800">매칭 실패 {unmatchedItems.length}건 (반영 제외)</span>
                  </div>
                  <div className="text-xs text-red-700 space-y-0.5 max-h-24 overflow-y-auto">
                    {unmatchedItems.map((item, i) => (
                      <div key={i}>• {item.inputCode} (수량: {item.newQty})</div>
                    ))}
                  </div>
                </div>
              )}

              <details open={changedItems.length <= 30}>
                <summary className="cursor-pointer text-sm font-medium text-amber-800 mb-2">
                  변동 내역 상세 ({changedItems.length}건)
                </summary>
                <div className="bg-white rounded-lg border border-amber-100 overflow-hidden max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-amber-50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">SKU코드</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">상품명</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">현재</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">변경</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">변동</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {changedItems.map((item, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono">{item.skuId}</td>
                          <td className="px-3 py-2 text-gray-900">{item.skuName}</td>
                          <td className="px-3 py-2 text-right text-gray-500">{item.currentQty.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right font-semibold">{item.newQty.toLocaleString()}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${item.diff > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                            {item.diff > 0 ? '+' : ''}{item.diff.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              <div className="flex justify-end gap-2">
                <button onClick={() => setParsedItems([])} className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50" disabled={uploading}>
                  취소
                </button>
                <button
                  onClick={handleApplyStock}
                  disabled={readOnly || uploading || changedItems.length === 0}
                  className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
                >
                  {uploading ? uploadProgress || '반영 중...' : `${changedItems.length}종 기초재고 반영 (${uploadDate})`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 성공 메시지 */}
      {successMsg && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-2.5">
          <Check size={14} className="text-green-600" />
          <span className="text-sm text-green-800">{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="ml-auto text-xs text-green-600 underline">닫기</button>
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
          <p className="text-sm text-red-800">{error}</p>
          <button onClick={loadData} className="text-xs text-red-600 underline mt-1">다시 시도</button>
        </div>
      )}

      {/* 검색 + 필터 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="SKU ID / 상품명 / 바코드 검색..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap">
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(e) => setHideZero(e.target.checked)}
            className="rounded border-gray-300"
          />
          0 재고 숨김
        </label>
      </div>

      {/* 로딩 */}
      {loading && inventory.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-blue-700">데이터 갱신 중...</span>
        </div>
      )}

      {/* 테이블 */}
      {loading && inventory.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-gray-400">불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl p-8 text-center text-gray-400 shadow-sm border border-gray-100">
          {search ? '검색 결과가 없습니다' : '재고 데이터가 없습니다'}
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 sticky left-0 bg-gray-50">상품명</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">바코드</th>
                    {warehouses.map((w) => (
                      <th key={w.id} className="text-right px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                        {w.name}
                      </th>
                    ))}
                    <th className="text-right px-4 py-3 font-medium text-gray-600 bg-blue-50">합계</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map((row) => (
                    <tr key={row.skuId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 sticky left-0 bg-white hover:bg-gray-50">
                        <div className="text-gray-900 font-medium max-w-[280px] truncate" title={row.skuName}>{row.skuName}</div>
                        <div className="text-xs text-gray-400 font-mono">{row.skuId}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono">{row.barcode || '-'}</td>
                      {warehouses.map((w) => {
                        const qty = row.warehouses[w.id] || 0;
                        const key = `${row.skuId}|${w.id}`;
                        const isEditing = editingKey === key;
                        return (
                          <td key={w.id} className="px-4 py-3 text-right">
                            {isEditing ? (
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  type="number"
                                  min={0}
                                  value={editQty}
                                  onChange={(e) => setEditQty(Math.max(0, parseInt(e.target.value) || 0))}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit(row.skuId, w.id, qty);
                                    if (e.key === 'Escape') cancelEdit();
                                  }}
                                  autoFocus
                                  className="w-20 text-right border border-blue-300 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                />
                                <button
                                  onClick={() => saveEdit(row.skuId, w.id, qty)}
                                  disabled={readOnly || saving}
                                  className="p-1 text-green-600 hover:bg-green-50 rounded disabled:opacity-50"
                                  title="저장"
                                >
                                  <Check size={13} />
                                </button>
                                <button onClick={cancelEdit} disabled={saving} className="p-1 text-gray-400 hover:bg-gray-100 rounded disabled:opacity-50" title="취소">
                                  <X size={13} />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => !readOnly && startEdit(row.skuId, w.id, qty)}
                                disabled={readOnly}
                                className={`group inline-flex items-center gap-1 ${qty === 0 ? 'text-gray-300' : 'text-gray-900 font-semibold'} ${!readOnly ? 'hover:text-blue-600 hover:bg-blue-50 rounded px-2 py-0.5 -my-0.5 cursor-pointer' : 'cursor-default'} disabled:opacity-50`}
                                title={readOnly ? '' : '클릭하여 수정'}
                              >
                                {qty.toLocaleString()}
                                {!readOnly && <Pencil size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className={`px-4 py-3 text-right font-bold bg-blue-50 ${row.total === 0 ? 'text-gray-300' : 'text-blue-700'}`}>
                        {row.total.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 합계 */}
          <div className="text-sm text-gray-500 text-right">
            총 <span className="font-semibold text-gray-700">{filtered.length}개</span> SKU ·{' '}
            <span className="font-semibold text-gray-700">{filtered.reduce((s, r) => s + r.total, 0).toLocaleString()}개</span>
          </div>
        </>
      )}
    </div>
  );
}
