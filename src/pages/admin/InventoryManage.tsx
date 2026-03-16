import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { recordTransaction } from '../../lib/inventoryTransaction';
import { Search, Pencil, Check, X, Package, ClipboardList } from 'lucide-react';

interface InventoryRow {
  sku_id: string;
  quantity: number;
  sku: { sku_name: string; barcode: string | null } | null;
}

const TABS = [
  { key: 'offline', label: '오프라인샵', warehouseName: '오프라인샵', color: 'blue', icon: Package },
  { key: 'playwith', label: '플레이위즈', warehouseName: '플레이위즈', color: 'purple', icon: ClipboardList },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function InventoryManage() {
  const [activeTab, setActiveTab] = useState<TabKey>('offline');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // 인라인 수정 상태
  const [editingSkuId, setEditingSkuId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

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
      // 창고 ID 조회
      const { data: wh, error: whErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('name', currentTab.warehouseName)
        .single();
      if (whErr) throw whErr;
      if (!wh) throw new Error(`${currentTab.warehouseName} 창고를 찾을 수 없습니다.`);
      setWarehouseId(wh.id);

      // 재고 조회
      const { data, error: invErr } = await supabase
        .from('inventory')
        .select('sku_id, quantity, sku(sku_name, barcode)')
        .eq('warehouse_id', wh.id)
        .gt('quantity', 0)
        .order('sku_id');
      if (invErr) throw invErr;
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

  // 수정 시작
  const startEdit = (row: InventoryRow) => {
    setEditingSkuId(row.sku_id);
    setEditQty(row.quantity);
    setSuccessMsg(null);
  };

  // 수정 취소
  const cancelEdit = () => {
    setEditingSkuId(null);
  };

  // 수정 저장
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

      // 수불부 트랜잭션 기록
      const diff = editQty - row.quantity;
      if (diff !== 0) {
        recordTransaction({
          warehouseId: warehouseId!,
          skuId: row.sku_id,
          txType: '재고조정',
          quantity: Math.abs(diff),
          source: 'manual',
          memo: `재고수정: ${row.quantity} → ${editQty}`,
        });
      }

      // activity_log 기록 (실패해도 재고 수정에 영향 없음)
      supabase.auth.getUser().then(({ data: userData }) => {
        supabase.from('activity_log').insert({
          user_id: userData.user?.id,
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
      });

      // 로컬 상태 업데이트
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

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-gray-900">재고 관리</h2>

      {/* 탭 */}
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
