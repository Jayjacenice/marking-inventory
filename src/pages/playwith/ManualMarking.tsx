import { useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { recordTransactionBatch } from '../../lib/inventoryTransaction';
import type { RecordTxParams } from '../../lib/inventoryTransaction';
import { parseQtyExcel, generateTemplate } from '../../lib/excelUtils';
import type { AppUser } from '../../types';
import { AlertTriangle, CheckCircle, FileUp, Search, Hammer } from 'lucide-react';

interface ManualMarkingItem {
  finishedSkuId: string;
  skuName: string;
  barcode: string | null;
  qty: number; // 마킹할 수량
  components: { skuId: string; skuName: string; needed: number; available: number }[];
  canMark: boolean; // 구성품 재고 충분한지
}

export default function ManualMarking({ currentUser }: { currentUser: AppUser }) {
  const [items, setItems] = useState<ManualMarkingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const today = new Date().toISOString().split('T')[0];

  // 엑셀 업로드 → 완제품 SKU + 수량 파싱 → BOM 조회 → 구성품 재고 확인
  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setLoading(true);
    setSaved(false);

    try {
      // 1. 엑셀 파싱 — 직접 XLSX로 SKU + 수량 추출
      // 직접 XLSX 파싱
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

      if (rows.length < 2) { setError('데이터가 없습니다.'); setLoading(false); return; }

      const headers = rows[0] as string[];
      const skuCol = headers.findIndex((h) => String(h || '').toLowerCase().includes('sku'));
      const qtyCol = headers.findIndex((h) => ['수량', 'qty', 'quantity'].includes(String(h || '').toLowerCase().trim()));

      if (skuCol === -1 || qtyCol === -1) {
        setError('SKU ID와 수량 컬럼을 찾을 수 없습니다.');
        setLoading(false);
        return;
      }

      const skuQtyMap: Record<string, number> = {};
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        if (!row || !row[skuCol]) continue;
        const sku = String(row[skuCol]).trim();
        const qty = Number(row[qtyCol]) || 0;
        if (qty > 0) skuQtyMap[sku] = (skuQtyMap[sku] || 0) + qty;
      }

      const skuIds = Object.keys(skuQtyMap);
      if (skuIds.length === 0) { setError('유효한 SKU가 없습니다.'); setLoading(false); return; }

      // 2. BOM 조회
      const { data: boms } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_name)')
        .in('finished_sku_id', skuIds);

      // 3. SKU 이름 조회
      const { data: skuInfos } = await supabase
        .from('sku')
        .select('sku_id, sku_name, barcode')
        .in('sku_id', skuIds);
      const skuMap = new Map((skuInfos || []).map((s: any) => [s.sku_id, s]));

      // 4. 플레이위즈 구성품 재고 조회
      const { data: wh } = await supabase.from('warehouse').select('id').eq('name', '플레이위즈').maybeSingle();
      const allCompSkus = new Set<string>();
      for (const b of (boms || []) as any[]) allCompSkus.add(b.component_sku_id);
      const compSkuArr = [...allCompSkus];

      let invMap: Record<string, number> = {};
      if (wh && compSkuArr.length > 0) {
        const { data: inv } = await supabase
          .from('inventory')
          .select('sku_id, quantity, needs_marking')
          .eq('warehouse_id', (wh as any).id)
          .eq('needs_marking', true)
          .in('sku_id', compSkuArr);
        for (const i of (inv || []) as any[]) {
          invMap[i.sku_id] = (invMap[i.sku_id] || 0) + i.quantity;
        }
      }

      // 5. 아이템 구성
      const bomMap: Record<string, { skuId: string; skuName: string; qty: number }[]> = {};
      for (const b of (boms || []) as any[]) {
        if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
        bomMap[b.finished_sku_id].push({
          skuId: b.component_sku_id,
          skuName: b.component?.sku_name || b.component_sku_id,
          qty: b.quantity || 1,
        });
      }

      const markingItems: ManualMarkingItem[] = [];
      for (const [skuId, qty] of Object.entries(skuQtyMap)) {
        const info = skuMap.get(skuId);
        const comps = bomMap[skuId] || [];
        const components = comps.map((c) => ({
          skuId: c.skuId,
          skuName: c.skuName,
          needed: c.qty * qty,
          available: invMap[c.skuId] || 0,
        }));
        const canMark = comps.length > 0 && components.every((c) => c.available >= c.needed);
        markingItems.push({
          finishedSkuId: skuId,
          skuName: info?.sku_name || skuId,
          barcode: info?.barcode || null,
          qty,
          components,
          canMark,
        });
      }

      // 가능한 것 먼저
      markingItems.sort((a, b) => (a.canMark === b.canMark ? 0 : a.canMark ? -1 : 1));
      setItems(markingItems);
    } catch (err: any) {
      setError(err.message || '엑셀 파싱 실패');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 수량 변경
  const handleQtyChange = (skuId: string, value: number) => {
    setItems((prev) =>
      prev.map((item) => (item.finishedSkuId === skuId ? { ...item, qty: Math.max(0, value) } : item))
    );
  };

  // 마킹 저장
  const handleSave = async () => {
    const activeItems = items.filter((i) => i.qty > 0 && i.canMark);
    if (activeItems.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const { data: wh } = await supabase.from('warehouse').select('id').eq('name', '플레이위즈').maybeSingle();
      if (!wh) throw new Error('플레이위즈 창고를 찾을 수 없습니다.');
      const pwWhId = (wh as any).id;

      // BOM 재조회 (최신)
      const finSkuIds = activeItems.map((i) => i.finishedSkuId);
      const { data: boms } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity')
        .in('finished_sku_id', finSkuIds);
      const bomMap: Record<string, { componentSkuId: string; quantity: number }[]> = {};
      for (const b of (boms || []) as any[]) {
        if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
        bomMap[b.finished_sku_id].push({ componentSkuId: b.component_sku_id, quantity: b.quantity || 1 });
      }

      // 트랜잭션 생성
      const txRows: RecordTxParams[] = [];
      for (const item of activeItems) {
        const comps = bomMap[item.finishedSkuId] || [];
        for (const comp of comps) {
          txRows.push({
            warehouseId: pwWhId,
            skuId: comp.componentSkuId,
            txType: '마킹출고',
            quantity: comp.quantity * item.qty,
            source: 'system',
            needsMarking: true,
            memo: `수기마킹 구성품 차감 (${item.finishedSkuId}) ${today}`,
          });
        }
        txRows.push({
          warehouseId: pwWhId,
          skuId: item.finishedSkuId,
          txType: '마킹입고',
          quantity: item.qty,
          source: 'system',
          needsMarking: false,
          memo: `수기마킹 완성품 증가 ${today}`,
        });
      }

      if (txRows.length > 0) {
        await recordTransactionBatch(txRows);
      }

      // Activity log
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'marking_work',
        work_order_id: null,
        action_date: today,
        summary: {
          manualMarking: true,
          items: activeItems.map((i) => ({
            skuId: i.finishedSkuId,
            skuName: i.skuName,
            completedQty: i.qty,
          })),
          totalQty: activeItems.reduce((s, i) => s + i.qty, 0),
        },
      });

      setSaved(true);
      setItems([]);
    } catch (err: any) {
      setError(err.message || '마킹 저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const canMarkItems = items.filter((i) => i.qty > 0 && i.canMark);
  const cantMarkItems = items.filter((i) => !i.canMark);
  const totalQty = canMarkItems.reduce((s, i) => s + i.qty, 0);

  const filtered = items.filter((i) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return i.finishedSkuId.toLowerCase().includes(q) || i.skuName.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">수기 마킹 작업</h3>
          <p className="text-xs text-gray-500 mt-0.5">완제품 SKU + 수량 엑셀을 업로드하면 플레이위즈 재고를 확인합니다</p>
        </div>
      </div>

      {/* 엑셀 업로드 */}
      <div className="flex gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-indigo-300 rounded-lg text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
        >
          <FileUp size={15} />
          {loading ? '분석 중...' : '엑셀 업로드'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={handleExcelUpload}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {saved && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
          <CheckCircle size={24} className="mx-auto text-green-500 mb-2" />
          <p className="text-sm text-green-800 font-medium">수기 마킹 {totalQty}개 저장 완료!</p>
        </div>
      )}

      {/* 결과 목록 */}
      {items.length > 0 && !saved && (
        <>
          {/* 검색 */}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="SKU / 상품명 검색..."
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>

          {/* 소계 */}
          <div className="bg-indigo-50 rounded-xl p-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-indigo-700">마킹 가능</span>
              <span className="font-semibold text-indigo-800">{canMarkItems.length}종 / {totalQty}개</span>
            </div>
            {cantMarkItems.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-red-600">재고 부족</span>
                <span className="font-semibold text-red-700">{cantMarkItems.length}종</span>
              </div>
            )}
          </div>

          {/* 아이템 목록 */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
            {filtered.map((item) => (
              <div
                key={item.finishedSkuId}
                className={`px-4 py-3 ${!item.canMark ? 'bg-red-50/50' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-sm font-medium text-gray-800 truncate">{item.skuName}</p>
                    <p className="text-xs text-gray-400 font-mono">{item.finishedSkuId}</p>
                    {/* 구성품 */}
                    <div className="mt-1 space-y-0.5">
                      {item.components.map((c) => (
                        <p key={c.skuId} className={`text-xs ${c.available < c.needed ? 'text-red-500' : 'text-gray-500'}`}>
                          {c.skuName}: 필요 {c.needed} / 재고 {c.available}
                          {c.available < c.needed && ' ⚠️'}
                        </p>
                      ))}
                      {item.components.length === 0 && (
                        <p className="text-xs text-orange-500">BOM 미등록</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="0"
                      value={item.qty}
                      onChange={(e) => handleQtyChange(item.finishedSkuId, Number(e.target.value))}
                      disabled={!item.canMark}
                      className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:bg-gray-100"
                    />
                    <span className="text-xs text-gray-400">개</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 저장 버튼 */}
          <button
            onClick={handleSave}
            disabled={saving || canMarkItems.length === 0 || totalQty === 0}
            className="w-full bg-indigo-600 text-white py-3.5 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base"
          >
            <Hammer size={20} />
            {saving ? '저장 중...' : `수기 마킹 저장 (${canMarkItems.length}종 ${totalQty}개)`}
          </button>
        </>
      )}

      {items.length === 0 && !saved && !loading && (
        <div className="bg-gray-50 rounded-xl p-8 text-center text-gray-400 text-sm">
          완제품 SKU + 수량이 포함된 엑셀을 업로드하세요
        </div>
      )}
    </div>
  );
}
