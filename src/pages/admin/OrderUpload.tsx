import { useCallback, useEffect, useRef, useState } from 'react';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { parseOrderExcel } from '../../lib/orderParser';
import type { ParsedOrder } from '../../lib/orderParser';
import type { OnlineOrder } from '../../types';
import * as XLSX from 'xlsx';
import {
  ShoppingCart, Upload, Download, Search, AlertTriangle, CheckCircle,
  Package, X, FileUp, XCircle,
} from 'lucide-react';

export default function OrderUpload({ currentUserId }: { currentUserId: string }) {
  const isStale = useStaleGuard();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 업로드
  const [parsed, setParsed] = useState<ParsedOrder[] | null>(null);
  const [parseSummary, setParseSummary] = useState<any>(null);
  const [newOrders, setNewOrders] = useState<ParsedOrder[]>([]);
  const [dupCount, setDupCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 재고 부족
  const [shortageItems, setShortageItems] = useState<{ skuId: string; skuName: string; ordered: number; stock: number; shortage: number }[]>([]);

  // BOM 미등록
  const [bomMissing, setBomMissing] = useState<{ skuId: string; skuName: string; count: number }[]>([]);

  // 대시보드
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [dashLoading, setDashLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('전체');
  const [searchText, setSearchText] = useState('');

  // 취소
  const [cancelTarget, setCancelTarget] = useState<{ orderNumber: string; deliveryNumber: string | null; items: OnlineOrder[] } | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // ── 대시보드 로딩 ──
  const loadDashboard = useCallback(async () => {
    setDashLoading(true);
    try {
      const all: OnlineOrder[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabaseAdmin
          .from('online_order')
          .select('*')
          .order('created_at', { ascending: false })
          .range(offset, offset + 999);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as OnlineOrder[]));
        if (data.length < 1000) break;
        offset += 1000;
      }
      if (!isStale()) setOrders(all);
    } catch (err: any) {
      console.error('주문 로딩 실패:', err);
    } finally {
      setDashLoading(false);
    }
  }, [isStale]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // ── 상태별 통계 ──
  const statusCounts = orders.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalCount = orders.length;

  // ── 필터링 ──
  const filtered = orders.filter(o => {
    if (statusFilter !== '전체' && o.status !== statusFilter) return false;
    if (searchText) {
      const q = searchText.toLowerCase();
      return o.order_number.includes(q) || (o.delivery_number || '').includes(q) || (o.sku_id || '').toLowerCase().includes(q) || (o.sku_name || '').toLowerCase().includes(q) || (o.option_text || '').toLowerCase().includes(q);
    }
    return true;
  });

  // ── 엑셀 파싱 ──
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setMessage(null);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const result = parseOrderExcel(wb);

      // 유니폼/마킹만 필터 (액세서리/의류 제외)
      const uniformOnly = result.orders.filter(o => o.needsOfflineShipment);
      setParsed(uniformOnly);
      setParseSummary({ ...result.summary, total: uniformOnly.length, noMarking: uniformOnly.filter(o => !o.needsMarking).length });

      // 기존 주문 중복 체크
      const existingSet = new Set(orders.map(o => `${o.order_number}|${o.sku_id}`));
      const newOnes = uniformOnly.filter(o => !existingSet.has(`${o.orderNumber}|${o.skuId}`));
      const dups = uniformOnly.length - newOnes.length;
      setNewOrders(newOnes);
      setDupCount(dups);

      // 재고 부족 체크 (오프라인 매장)
      await checkInventoryShortage(newOnes);

      // BOM 미등록 체크
      await checkBomMissing(newOnes);

    } catch (err: any) {
      setMessage({ type: 'error', text: `파싱 오류: ${err.message}` });
    }
  };

  // ── 재고 부족 체크 (오프라인 출고 대상만) ──
  const checkInventoryShortage = async (items: ParsedOrder[]) => {
    // 오프라인 출고 대상(유니폼/마킹키트)만 필터
    const offlineItems = items.filter(i => i.needsOfflineShipment);
    // SKU별 주문 수량 합산
    const demandMap: Record<string, { skuName: string; qty: number }> = {};
    for (const item of offlineItems) {
      if (!demandMap[item.skuId]) demandMap[item.skuId] = { skuName: item.skuName, qty: 0 };
      demandMap[item.skuId].qty += item.quantity;
    }

    // 오프라인 매장 재고 조회
    const { data: wh } = await supabaseAdmin.from('warehouse').select('id').eq('name', '오프라인샵').single();
    if (!wh) return;

    const skuIds = Object.keys(demandMap);
    const invMap: Record<string, number> = {};
    for (let i = 0; i < skuIds.length; i += 500) {
      const batch = skuIds.slice(i, i + 500);
      const { data: inv } = await supabaseAdmin
        .from('inventory')
        .select('sku_id, quantity')
        .eq('warehouse_id', wh.id)
        .in('sku_id', batch);
      if (inv) for (const r of inv) invMap[r.sku_id] = r.quantity;
    }

    const shortages: typeof shortageItems = [];
    for (const [skuId, demand] of Object.entries(demandMap)) {
      const stock = invMap[skuId] || 0;
      if (stock < demand.qty) {
        shortages.push({
          skuId,
          skuName: demand.skuName,
          ordered: demand.qty,
          stock,
          shortage: demand.qty - stock,
        });
      }
    }
    setShortageItems(shortages.sort((a, b) => b.shortage - a.shortage));
  };

  // ── BOM 미등록 체크 ──
  const checkBomMissing = async (items: ParsedOrder[]) => {
    const markingCompleted = items.filter(o => o.markingType === 'completed');
    if (markingCompleted.length === 0) { setBomMissing([]); return; }

    const finishedSkuIds = [...new Set(markingCompleted.map(o => o.skuId))];
    const { data: boms } = await supabaseAdmin
      .from('bom')
      .select('finished_sku_id')
      .in('finished_sku_id', finishedSkuIds.slice(0, 500));

    const bomSet = new Set((boms || []).map((b: any) => b.finished_sku_id));
    const missing: Record<string, { skuName: string; count: number }> = {};
    for (const o of markingCompleted) {
      if (!bomSet.has(o.skuId)) {
        if (!missing[o.skuId]) missing[o.skuId] = { skuName: o.skuName, count: 0 };
        missing[o.skuId].count += o.quantity;
      }
    }
    setBomMissing(Object.entries(missing).map(([skuId, v]) => ({ skuId, ...v })).sort((a, b) => b.count - a.count));
  };

  // ── 저장 ──
  const handleSave = async () => {
    if (newOrders.length === 0) return;
    setSaving(true);
    setSaveProgress({ current: 0, total: newOrders.length });

    try {
      let ok = 0;
      for (let i = 0; i < newOrders.length; i += 100) {
        const batch = newOrders.slice(i, i + 100).map(o => ({
          order_number: o.orderNumber,
          delivery_number: o.deliveryNumber || null,
          order_date: o.orderDate || null,
          sku_id: o.skuId,
          sku_name: o.skuName,
          option_text: o.optionText || null,
          quantity: o.quantity,
          needs_marking: o.needsMarking,
          status: '신규',
        }));

        const { error } = await supabaseAdmin
          .from('online_order')
          .upsert(batch, { onConflict: 'order_number,sku_id', ignoreDuplicates: true });
        if (!error) ok += batch.length;
        setSaveProgress({ current: Math.min(i + 100, newOrders.length), total: newOrders.length });
      }

      // activity_log
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'order_upload',
        action_date: new Date().toISOString().split('T')[0],
        summary: { total: ok, marking: newOrders.filter(o => o.needsMarking).length },
      }).then(() => {});

      setMessage({ type: 'success', text: `주문 ${ok}건 등록 완료 (중복 제외 ${dupCount}건)` });
      setParsed(null);
      setNewOrders([]);
      loadDashboard();
    } catch (err: any) {
      setMessage({ type: 'error', text: `저장 실패: ${err.message}` });
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  // ── BOM 미등록 다운로드 ──
  const handleBomMissingDownload = () => {
    const data = bomMissing.map(b => ({
      'SKU코드 (완제품)': b.skuId,
      '상품명': b.skuName,
      '주문수량': b.count,
      '유니폼단품 (component_sku_id)': '',
      '마킹키트 (component_sku_id)': '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 28 }, { wch: 45 }, { wch: 10 }, { wch: 30 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BOM미등록');
    XLSX.writeFile(wb, `BOM미등록_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ── 주문 취소 ──
  const openCancelModal = (orderNumber: string) => {
    const items = orders.filter(o => o.order_number === orderNumber);
    if (items.length === 0) return;
    setCancelTarget({ orderNumber, deliveryNumber: items[0].delivery_number, items });
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const { error } = await supabaseAdmin
        .from('online_order')
        .update({ status: '취소' })
        .eq('order_number', cancelTarget.orderNumber);
      if (error) throw error;

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'order_cancel',
        action_date: new Date().toISOString().split('T')[0],
        summary: { order_number: cancelTarget.orderNumber, items: cancelTarget.items.length },
      }).then(() => {});

      setMessage({ type: 'success', text: `주문 ${cancelTarget.orderNumber} 취소 완료 (${cancelTarget.items.length}건)` });
      setCancelTarget(null);
      loadDashboard();
    } catch (err: any) {
      setMessage({ type: 'error', text: `취소 실패: ${err.message}` });
    } finally {
      setCancelling(false);
    }
  };

  // ── 상태 색상 ──
  const statusColor: Record<string, string> = {
    '신규': 'bg-blue-50 text-blue-700',
    '발송대기': 'bg-yellow-50 text-yellow-700',
    '이관중': 'bg-indigo-50 text-indigo-700',
    '마킹중': 'bg-purple-50 text-purple-700',
    '출고완료': 'bg-green-50 text-green-700',
    '재고부족': 'bg-red-50 text-red-700',
    '하자재발송': 'bg-orange-50 text-orange-700',
    '취소': 'bg-gray-100 text-gray-500 line-through',
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center gap-3 mb-6">
        <ShoppingCart className="w-7 h-7 text-indigo-600" />
        <h1 className="text-2xl font-bold text-gray-900">주문 관리</h1>
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

      {/* ── 업로드 영역 ── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-5">
        <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <FileUp size={18} /> 주문 엑셀 업로드
        </h2>
        <p className="text-sm text-gray-500 mb-3">FulfillmentShipping 배송대기 엑셀을 업로드하면 신규 주문을 자동 등록합니다.</p>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm hover:bg-indigo-700 flex items-center gap-2"
        >
          <Upload size={14} /> 엑셀 파일 선택
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileSelect} className="hidden" />
      </div>

      {/* ── 파싱 미리보기 ── */}
      {parsed && parseSummary && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-5 space-y-4">
          <h2 className="font-semibold text-gray-900">업로드 미리보기</h2>

          {/* 요약 카드 */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">전체</p>
              <p className="text-lg font-bold">{parseSummary.total}</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <p className="text-xs text-blue-600">신규 등록</p>
              <p className="text-lg font-bold text-blue-700">{newOrders.length}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">중복 제외</p>
              <p className="text-lg font-bold text-gray-400">{dupCount}</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-3 text-center">
              <p className="text-xs text-purple-600">마킹 필요</p>
              <p className="text-lg font-bold text-purple-700">{newOrders.filter(o => o.needsMarking).length}</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <p className="text-xs text-green-600">오프라인 출고</p>
              <p className="text-lg font-bold text-green-700">{newOrders.filter(o => o.needsOfflineShipment).length}</p>
            </div>
          </div>

          {/* 재고 부족 알림 */}
          {shortageItems.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <h3 className="font-semibold text-red-800 mb-2 flex items-center gap-1">
                <AlertTriangle size={16} /> 재고 부족 ({shortageItems.length}종)
              </h3>
              <div className="max-h-[200px] overflow-y-auto text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="bg-red-100">
                      <th className="px-2 py-1 text-left">SKU</th>
                      <th className="px-2 py-1 text-left">상품명</th>
                      <th className="px-2 py-1 text-right">주문</th>
                      <th className="px-2 py-1 text-right">재고</th>
                      <th className="px-2 py-1 text-right font-bold">부족</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortageItems.map(s => (
                      <tr key={s.skuId} className="border-t border-red-100">
                        <td className="px-2 py-1 font-mono">{s.skuId}</td>
                        <td className="px-2 py-1">{s.skuName}</td>
                        <td className="px-2 py-1 text-right">{s.ordered}</td>
                        <td className="px-2 py-1 text-right">{s.stock}</td>
                        <td className="px-2 py-1 text-right font-bold text-red-700">-{s.shortage}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* BOM 미등록 알림 */}
          {bomMissing.length > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-orange-800 flex items-center gap-1">
                  <AlertTriangle size={16} /> BOM 미등록 ({bomMissing.length}종)
                </h3>
                <button onClick={handleBomMissingDownload} className="text-xs px-3 py-1 bg-orange-600 text-white rounded-lg hover:bg-orange-700 flex items-center gap-1">
                  <Download size={12} /> 다운로드
                </button>
              </div>
              <p className="text-xs text-orange-700 mb-2">마킹 완제품인데 BOM이 등록되지 않아 구성품 전개가 불가합니다.</p>
              <div className="max-h-[150px] overflow-y-auto text-xs">
                {bomMissing.slice(0, 20).map(b => (
                  <div key={b.skuId} className="flex justify-between py-0.5">
                    <span className="font-mono text-orange-600">{b.skuId}</span>
                    <span>{b.count}건</span>
                  </div>
                ))}
                {bomMissing.length > 20 && <p className="text-center text-orange-500 mt-1">... 외 {bomMissing.length - 20}종</p>}
              </div>
            </div>
          )}

          {/* 진행 바 */}
          {saveProgress && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-gray-500">
                <span>저장 중... {saveProgress.current}/{saveProgress.total}</span>
                <span>{Math.round((saveProgress.current / saveProgress.total) * 100)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div className="bg-indigo-600 h-2 rounded-full transition-all" style={{ width: `${(saveProgress.current / saveProgress.total) * 100}%` }} />
              </div>
            </div>
          )}

          {/* 저장/취소 */}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || newOrders.length === 0}
              className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:bg-gray-300"
            >
              {saving ? '저장 중...' : `${newOrders.length}건 등록`}
            </button>
            <button
              onClick={() => { setParsed(null); setNewOrders([]); setShortageItems([]); setBomMissing([]); }}
              disabled={saving}
              className="px-5 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm hover:bg-gray-200 disabled:opacity-50"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* ── 대시보드 ── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Package size={18} /> 주문 현황
          <span className="text-sm font-normal text-gray-400 ml-1">{totalCount.toLocaleString()}건</span>
        </h2>

        {/* 상태별 카드 */}
        <div className="grid grid-cols-3 sm:grid-cols-7 gap-2 mb-4">
          {['신규', '발송대기', '이관중', '마킹중', '출고완료', '재고부족', '취소'].map(status => (
            <button
              key={status}
              onClick={() => setStatusFilter(statusFilter === status ? '전체' : status)}
              className={`rounded-lg p-2 text-center transition-all ${
                statusFilter === status ? 'ring-2 ring-indigo-500' : ''
              } ${statusColor[status] || 'bg-gray-50'}`}
            >
              <p className="text-[10px]">{status}</p>
              <p className="text-sm font-bold">{(statusCounts[status] || 0).toLocaleString()}</p>
            </button>
          ))}
        </div>

        {/* 검색 */}
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="주문번호 / 배송번호 / SKU / 상품명 / 옵션 검색"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
        </div>

        {/* 주문 테이블 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-2 py-2 text-left">주문번호</th>
                <th className="px-2 py-2 text-left">배송번호</th>
                <th className="px-2 py-2 text-left">SKU</th>
                <th className="px-2 py-2 text-left">상품명</th>
                <th className="px-2 py-2 text-left">옵션</th>
                <th className="px-2 py-2 text-right">수량</th>
                <th className="px-2 py-2 text-center">마킹</th>
                <th className="px-2 py-2 text-center">상태</th>
                <th className="px-2 py-2 text-center w-[60px]">액션</th>
              </tr>
            </thead>
            <tbody>
              {dashLoading ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">불러오는 중...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                  {totalCount === 0 ? '등록된 주문이 없습니다. 엑셀을 업로드하세요.' : '검색 결과가 없습니다.'}
                </td></tr>
              ) : (
                filtered.slice(0, 200).map(o => (
                  <tr key={o.id} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-mono text-xs text-gray-600">{o.order_number}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-gray-400">{o.delivery_number}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-gray-500">{o.sku_id}</td>
                    <td className="px-2 py-1.5 text-gray-900 max-w-[200px] truncate">{o.sku_name}</td>
                    <td className="px-2 py-1.5 text-xs text-gray-500">{o.option_text}</td>
                    <td className="px-2 py-1.5 text-right">{o.quantity}</td>
                    <td className="px-2 py-1.5 text-center">
                      {o.needs_marking ? <span className="text-purple-600 font-semibold">O</span> : <span className="text-gray-300">-</span>}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${statusColor[o.status] || 'bg-gray-50'}`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {o.status !== '취소' && o.status !== '출고완료' && (
                        <button
                          onClick={() => openCancelModal(o.order_number)}
                          className="p-1 text-red-400 hover:bg-red-50 rounded"
                          title="주문 취소"
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 200 && (
          <p className="text-center text-sm text-gray-400 mt-2">상위 200건 표시 (전체 {filtered.length.toLocaleString()}건)</p>
        )}
      </div>

      {/* 취소 확인 모달 */}
      {cancelTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setCancelTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">주문 취소</h3>
            <div className="text-sm text-gray-600 mb-3 space-y-1">
              <p>주문번호: <span className="font-mono font-semibold">{cancelTarget.orderNumber}</span></p>
              {cancelTarget.deliveryNumber && (
                <p>배송번호: <span className="font-mono">{cancelTarget.deliveryNumber}</span></p>
              )}
              <p>포함 상품: <span className="font-semibold">{cancelTarget.items.length}건</span></p>
            </div>
            <div className="max-h-[150px] overflow-y-auto text-xs mb-4 bg-gray-50 rounded-lg p-2">
              {cancelTarget.items.map(item => (
                <div key={item.id} className="flex justify-between py-0.5">
                  <span className="truncate max-w-[250px]">{item.sku_name}</span>
                  <span className="text-gray-500">{item.quantity}개</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-red-600 mb-4">이 주문의 모든 상품이 취소 처리됩니다.</p>
            <div className="flex gap-2">
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:bg-gray-300"
              >
                {cancelling ? '처리 중...' : '주문 취소'}
              </button>
              <button
                onClick={() => setCancelTarget(null)}
                className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm hover:bg-gray-200"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
