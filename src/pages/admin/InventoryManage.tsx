import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { recordTransaction } from '../../lib/inventoryTransaction';
import * as XLSX from 'xlsx';
import {
  Search, Pencil, Check, X, Package, ClipboardList,
  Upload, FileUp, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react';

interface InventoryRow {
  sku_id: string;
  quantity: number;
  sku: { sku_name: string; barcode: string | null } | null;
}

interface ParsedStockItem {
  inputCode: string;       // 엑셀에서 읽은 원본 코드 (SKU코드 또는 바코드)
  skuId: string | null;    // 매칭된 SKU ID
  skuName: string;         // 상품명
  newQty: number;          // 엑셀에 입력된 수량
  currentQty: number;      // 현재 재고 수량
  diff: number;            // 변동량 (newQty - currentQty)
  matched: boolean;        // SKU 매칭 성공 여부
}

const TABS = [
  { key: 'offline', label: '오프라인샵', warehouseName: '오프라인샵', color: 'blue', icon: Package },
  { key: 'playwith', label: '플레이위즈', warehouseName: '플레이위즈', color: 'purple', icon: ClipboardList },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function InventoryManage({ currentUserId }: { currentUserId: string }) {
  const isStale = useStaleGuard();
  const [activeTab, setActiveTab] = useState<TabKey>('offline');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useLoadingTimeout(loading, setLoading, setError);
  const [search, setSearch] = useState('');

  // 인라인 수정 상태
  const [editingSkuId, setEditingSkuId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 기초재고 업로드 상태
  const [showUpload, setShowUpload] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parsedItems, setParsedItems] = useState<ParsedStockItem[]>([]);
  const [uploadDate, setUploadDate] = useState(new Date().toISOString().slice(0, 10));
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  const currentTab = TABS.find((t) => t.key === activeTab)!;

  // 탭 전환 시 창고 ID 조회 + 재고 로드
  useEffect(() => {
    loadWarehouseAndInventory();
  }, [activeTab]);

  const loadWarehouseAndInventory = async () => {
    setLoading(true);
    setError(null);
    setEditingSkuId(null);
    try {
      const { data: wh, error: whErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', currentTab.warehouseName)
        .single();
      if (whErr) throw whErr;
      if (!wh) throw new Error(`${currentTab.warehouseName} 창고를 찾을 수 없습니다.`);
      if (isStale()) return;
      setWarehouseId(wh.id);

      const { data, error: invErr } = await supabase
        .from('inventory')
        .select('sku_id, quantity, sku(sku_name, barcode)')
        .eq('warehouse_id', wh.id)
        .gt('quantity', 0)
        .order('sku_id');
      if (invErr) throw invErr;
      if (isStale()) return;
      setRows(
        ((data || []) as any[]).map((r) => ({
          sku_id: r.sku_id,
          quantity: r.quantity,
          sku: Array.isArray(r.sku) ? r.sku[0] || null : r.sku,
        }))
      );
    } catch (err: any) {
      setError(err.message || '데이터 조회 실패');
    } finally {
      setLoading(false);
    }
  };

  // 검색 필터
  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      r.sku_id.toLowerCase().includes(q) ||
      (r.sku?.sku_name || '').toLowerCase().includes(q)
    );
  });

  const totalQty = filtered.reduce((s, r) => s + r.quantity, 0);

  // 인라인 수정
  const startEdit = (row: InventoryRow) => {
    setEditingSkuId(row.sku_id);
    setEditQty(row.quantity);
    setSuccessMsg(null);
  };

  const cancelEdit = () => {
    setEditingSkuId(null);
  };

  const saveEdit = async (row: InventoryRow) => {
    if (!warehouseId) return;
    if (editQty < 0) {
      setError('수량은 0 이상이어야 합니다.');
      return;
    }
    if (editQty === row.quantity) {
      setEditingSkuId(null);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from('inventory')
        .update({ quantity: editQty })
        .eq('warehouse_id', warehouseId)
        .eq('sku_id', row.sku_id);
      if (updErr) throw updErr;

      const diff = editQty - row.quantity;
      if (diff !== 0) {
        recordTransaction({
          warehouseId: warehouseId!,
          skuId: row.sku_id,
          txType: '재고조정',
          quantity: diff,
          source: 'manual',
          memo: `재고수정: ${row.quantity} → ${editQty}`,
        });
      }

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'inventory_adjust',
        work_order_id: null,
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          warehouse: currentTab.warehouseName,
          skuId: row.sku_id,
          skuName: row.sku?.sku_name || '',
          before: row.quantity,
          after: editQty,
          items: [],
          totalQty: editQty,
        },
      }).then(({ error: logErr }) => { if (logErr) console.warn('activity_log insert failed:', logErr.message); });

      setRows((prev) =>
        editQty === 0
          ? prev.filter((r) => r.sku_id !== row.sku_id)
          : prev.map((r) => (r.sku_id === row.sku_id ? { ...r, quantity: editQty } : r))
      );
      setEditingSkuId(null);
      setSuccessMsg(`${row.sku?.sku_name || row.sku_id}: ${row.quantity} → ${editQty}개로 변경됨`);
    } catch (err: any) {
      setError(`수정 실패: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // ── 기초재고 업로드 ──

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !warehouseId) return;
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

      // 첫 행은 헤더로 건너뛰고 데이터 파싱
      const dataRows = rawRows.slice(1).filter((r: any[]) => r[0] && r[1] !== undefined && r[1] !== '');
      if (dataRows.length === 0) {
        setError('유효한 데이터가 없습니다. A열: SKU코드 또는 바코드, B열: 수량');
        setParsing(false);
        return;
      }

      // SKU 전체 목록 조회 (바코드 매칭용)
      const allSkus: { sku_id: string; sku_name: string; barcode: string | null }[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabaseAdmin
          .from('sku')
          .select('sku_id, sku_name, barcode')
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        allSkus.push(...data);
        if (data.length < 1000) break;
        from += 1000;
      }

      const skuById = new Map(allSkus.map((s) => [s.sku_id, s]));
      const skuByBarcode = new Map<string, typeof allSkus[0]>();
      for (const s of allSkus) {
        if (s.barcode) skuByBarcode.set(s.barcode, s);
      }

      // 현재 재고 조회
      const { data: currentInv } = await supabase
        .from('inventory')
        .select('sku_id, quantity')
        .eq('warehouse_id', warehouseId);
      const currentQtyMap = new Map((currentInv || []).map((r) => [r.sku_id, r.quantity as number]));

      // 엑셀 데이터 매칭
      const items: ParsedStockItem[] = [];
      for (const row of dataRows) {
        const inputCode = String(row[0]).trim();
        const qty = Math.max(0, parseInt(row[1]) || 0);

        // SKU ID로 직접 매칭 시도
        let sku = skuById.get(inputCode);
        // 바코드로 매칭 시도
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
    if (!warehouseId || changedItems.length === 0) return;

    const ok = window.confirm(
      `${uploadDate} 기준으로 ${changedItems.length}종의 기초재고를 반영합니다.\n변동 없는 ${matchedItems.length - changedItems.length}종은 건너뜁니다.\n\n진행하시겠습니까?`
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

        // inventory upsert
        const upsertRows = batch.map((item) => ({
          warehouse_id: warehouseId,
          sku_id: item.skuId!,
          quantity: item.newQty,
        }));

        const { error: upsertErr } = await supabaseAdmin
          .from('inventory')
          .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id' });
        if (upsertErr) throw upsertErr;

        // 수불부 트랜잭션 기록
        const txRows = batch.map((item) => ({
          warehouse_id: warehouseId,
          sku_id: item.skuId!,
          tx_type: '기초재고',
          quantity: item.newQty,
          source: 'initial_stock',
          tx_date: uploadDate,
          memo: `기초재고: ${item.newQty}`,
        }));

        const { error: txErr } = await supabase
          .from('inventory_transaction')
          .insert(txRows);
        if (txErr) console.error('기초재고 트랜잭션 기록 실패:', txErr);

        success += batch.length;
        setUploadProgress(`재고 반영 중... ${success}/${total}`);
      }

      // activity_log 기록
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'inventory_adjust',
        work_order_id: null,
        action_date: uploadDate,
        summary: {
          warehouse: currentTab.warehouseName,
          type: '기초재고 업로드',
          date: uploadDate,
          items: changedItems.slice(0, 10).map((i) => ({
            skuId: i.skuId,
            skuName: i.skuName,
            before: i.currentQty,
            after: i.newQty,
          })),
          totalQty: changedItems.reduce((s, i) => s + i.newQty, 0),
          changedCount: changedItems.length,
        },
      }).then(({ error: logErr }) => { if (logErr) console.warn('activity_log insert failed:', logErr.message); });

      setSuccessMsg(`기초재고 반영 완료: ${success}종 변경됨 (${uploadDate} 기준)`);
      setParsedItems([]);
      setShowUpload(false);
      loadWarehouseAndInventory();
    } catch (err: any) {
      setError(`기초재고 반영 실패: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-gray-900">재고 관리</h2>

      {/* 탭 + 기초재고 버튼 */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            const base =
              tab.color === 'blue'
                ? isActive
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-blue-600 border border-blue-200 hover:bg-blue-50'
                : isActive
                ? 'bg-purple-600 text-white'
                : 'bg-white text-purple-600 border border-purple-200 hover:bg-purple-50';
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${base}`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => { setShowUpload(!showUpload); setParsedItems([]); }}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            showUpload
              ? 'bg-amber-600 text-white'
              : 'bg-white text-amber-600 border border-amber-200 hover:bg-amber-50'
          }`}
        >
          <Upload size={16} />
          기초재고 업로드
          {showUpload ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* 기초재고 업로드 패널 */}
      {showUpload && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-amber-800">기초재고 엑셀 업로드</h3>
          <p className="text-xs text-amber-700">
            A열: SKU코드 또는 바코드, B열: 수량 (첫 행은 헤더). 엑셀 수량으로 현재 재고를 덮어씁니다.
          </p>

          {/* 날짜 선택 + 파일 선택 */}
          <div className="flex items-center gap-4 flex-wrap">
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
              parsing || !warehouseId
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-amber-600 text-white hover:bg-amber-700'
            }`}>
              <FileUp size={16} />
              {parsing ? '파싱 중...' : '엑셀 파일 선택'}
              <input
                type="file"
                accept=".xls,.xlsx"
                onChange={handleFileSelect}
                disabled={parsing || !warehouseId}
                className="hidden"
              />
            </label>
          </div>

          {/* 파싱 결과 */}
          {parsedItems.length > 0 && (
            <div className="space-y-3">
              {/* 요약 */}
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

              {/* 미매칭 경고 */}
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

              {/* 미리보기 테이블 */}
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

              {/* 적용 버튼 */}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setParsedItems([])}
                  className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50"
                  disabled={uploading}
                >
                  취소
                </button>
                <button
                  onClick={handleApplyStock}
                  disabled={uploading || changedItems.length === 0}
                  className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
                >
                  {uploading
                    ? uploadProgress || '반영 중...'
                    : `${changedItems.length}종 기초재고 반영 (${uploadDate})`}
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
          <button onClick={() => setSuccessMsg(null)} className="ml-auto text-xs text-green-600 underline">
            닫기
          </button>
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
          <p className="text-sm text-red-800">{error}</p>
          <button onClick={loadWarehouseAndInventory} className="text-xs text-red-600 underline mt-1">
            다시 시도
          </button>
        </div>
      )}

      {/* 검색 */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="SKU ID 또는 상품명 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
        />
      </div>

      {/* 테이블 */}
      {loading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl p-8 text-center text-gray-400 shadow-sm border border-gray-100">
          {search ? '검색 결과가 없습니다' : '재고 데이터가 없습니다'}
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className={`border-b ${
                currentTab.color === 'blue' ? 'bg-blue-50' : 'bg-purple-50'
              }`}>
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">SKU ID</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">상품명</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">수량</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((row) => (
                  <tr key={row.sku_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{row.sku_id}</td>
                    <td className="px-4 py-3 text-gray-900">{row.sku?.sku_name || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      {editingSkuId === row.sku_id ? (
                        <input
                          type="number"
                          min={0}
                          value={editQty}
                          onChange={(e) => setEditQty(Math.max(0, parseInt(e.target.value) || 0))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(row);
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          autoFocus
                          className="w-20 text-right border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      ) : (
                        <span className="font-semibold text-gray-900">{row.quantity.toLocaleString()}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {editingSkuId === row.sku_id ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => saveEdit(row)}
                            disabled={saving}
                            className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg disabled:opacity-50"
                            title="저장"
                          >
                            <Check size={15} />
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg disabled:opacity-50"
                            title="취소"
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(row)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="수정"
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 합계 */}
          <div className="text-sm text-gray-500 text-right">
            총 <span className="font-semibold text-gray-700">{filtered.length}개</span> SKU ·{' '}
            <span className="font-semibold text-gray-700">{totalQty.toLocaleString()}개</span>
          </div>
        </>
      )}
    </div>
  );
}
