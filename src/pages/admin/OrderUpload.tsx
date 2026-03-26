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

  // 등록일 기준 삭제
  const [deleteDate, setDeleteDate] = useState('');
  const [deletePreview, setDeletePreview] = useState<{ date: string; count: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 작업지시서 생성
  const [creatingWo, setCreatingWo] = useState(false);
  const [woResult, setWoResult] = useState<string | null>(null);

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
          .order('order_date', { ascending: true })
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

  // ── 등록일 기준 삭제 ──
  const handleDeleteByDate = async () => {
    if (!deleteDate) return;
    const { count: cnt, error } = await supabaseAdmin
      .from('online_order')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', `${deleteDate}T00:00:00`)
      .lt('created_at', `${deleteDate}T23:59:59.999`);
    if (error) { setMessage({ type: 'error', text: error.message }); return; }
    setDeletePreview({ date: deleteDate, count: cnt || 0 });
  };

  const confirmDeleteByDate = async () => {
    if (!deletePreview) return;
    setDeleting(true);
    try {
      // 1000건씩 반복 삭제
      let totalDeleted = 0;
      while (true) {
        const { data } = await supabaseAdmin
          .from('online_order')
          .delete()
          .gte('created_at', `${deletePreview.date}T00:00:00`)
          .lt('created_at', `${deletePreview.date}T23:59:59.999`)
          .select('id')
          .limit(1000);
        if (!data || data.length === 0) break;
        totalDeleted += data.length;
      }

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'order_delete',
        action_date: new Date().toISOString().split('T')[0],
        summary: { date: deletePreview.date, deleted: totalDeleted },
      }).then(() => {});

      setMessage({ type: 'success', text: `${deletePreview.date} 등록분 ${totalDeleted}건 삭제 완료` });
      setDeletePreview(null);
      setDeleteDate('');
      loadDashboard();
    } catch (err: any) {
      setMessage({ type: 'error', text: `삭제 실패: ${err.message}` });
    } finally {
      setDeleting(false);
    }
  };

  // ── 작업지시서 생성 (신규 주문 → work_order, 재고 체크 포함) ──
  const handleCreateWorkOrder = async () => {
    const allEligible = orders.filter(o => o.status === '신규' && !o.work_order_id);
    if (allEligible.length === 0) {
      setMessage({ type: 'error', text: '작업지시서를 생성할 신규 주문이 없습니다.' });
      return;
    }

    setCreatingWo(true);
    setWoResult(null);
    try {
      // ── 1단계: 오프라인 매장 재고 조회 ──
      const { data: wh } = await supabaseAdmin.from('warehouse').select('id').eq('name', '오프라인샵').single();
      const whId = wh?.id;
      const invMap: Record<string, number> = {};
      if (whId) {
        let offset = 0;
        while (true) {
          const { data: inv } = await supabaseAdmin.from('inventory').select('sku_id, quantity').eq('warehouse_id', whId).range(offset, offset + 999);
          if (!inv || inv.length === 0) break;
          for (const r of inv) invMap[r.sku_id] = r.quantity;
          if (inv.length < 1000) break;
          offset += 1000;
        }
      }

      // ── 2단계: BOM 조회 (마킹 완제품 → 구성품) ──
      const markingSkuIds = [...new Set(allEligible.filter(o => o.sku_id.startsWith('26UN-') && o.sku_id.includes('_')).map(o => o.sku_id))];
      const bomMap: Record<string, { components: { skuId: string; qty: number }[] }> = {};
      if (markingSkuIds.length > 0) {
        for (let i = 0; i < markingSkuIds.length; i += 500) {
          const { data: boms } = await supabaseAdmin.from('bom').select('finished_sku_id, component_sku_id, quantity').in('finished_sku_id', markingSkuIds.slice(i, i + 500));
          if (boms) for (const b of boms as any[]) {
            if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = { components: [] };
            bomMap[b.finished_sku_id].components.push({ skuId: b.component_sku_id, qty: b.quantity || 1 });
          }
        }
      }

      // ── 3단계: 구성품 재고 소요 계산 + 부족 판별 ──
      // SKU별 주문 수량 합산
      const demandBySku: Record<string, number> = {};
      for (const o of allEligible) {
        const skuId = o.sku_id;
        const qty = o.quantity;
        if (skuId.startsWith('26UN-') && skuId.includes('_')) {
          // 마킹 완제품 → BOM 전개
          const bom = bomMap[skuId];
          if (bom) {
            for (const c of bom.components) {
              demandBySku[c.skuId] = (demandBySku[c.skuId] || 0) + c.qty * qty;
            }
          } else {
            // BOM 미등록 → SKU 패턴으로 추정
            const baseSku = skuId.split('_')[0];
            const mkSku = baseSku.replace('26UN-', '26MK-');
            demandBySku[baseSku] = (demandBySku[baseSku] || 0) + qty;
            demandBySku[mkSku] = (demandBySku[mkSku] || 0) + qty;
          }
        } else {
          // 단품 → 직접 재고 체크
          demandBySku[skuId] = (demandBySku[skuId] || 0) + qty;
        }
      }

      // 부족 SKU 판별
      const shortageSkus: Record<string, { demand: number; stock: number }> = {};
      for (const [skuId, demand] of Object.entries(demandBySku)) {
        const stock = invMap[skuId] || 0;
        if (stock < demand) shortageSkus[skuId] = { demand, stock };
      }

      // ── 4단계: 주문 분류 (발송가능 vs 재고부족) ──
      const canShip: typeof allEligible = [];
      const cannotShip: typeof allEligible = [];

      for (const o of allEligible) {
        const skuId = o.sku_id;
        let hasShortage = false;

        if (skuId.startsWith('26UN-') && skuId.includes('_')) {
          // 마킹 완제품: 구성품 모두 있어야 함
          const bom = bomMap[skuId];
          const components = bom ? bom.components.map(c => c.skuId) : [skuId.split('_')[0], skuId.split('_')[0].replace('26UN-', '26MK-')];
          hasShortage = components.some(c => shortageSkus[c]);
        } else {
          hasShortage = !!shortageSkus[skuId];
        }

        if (hasShortage) cannotShip.push(o);
        else canShip.push(o);
      }

      // 확인 팝업
      const confirmMsg = canShip.length > 0
        ? `발송 가능 ${canShip.length}건 → 작업지시서 생성\n` +
          (cannotShip.length > 0 ? `재고 부족 ${cannotShip.length}건 → 제외 (재고부족 상태)\n\n` : '\n') +
          `부족 구성품: ${Object.keys(shortageSkus).length}종\n` +
          Object.entries(shortageSkus).slice(0, 5).map(([s, v]) => `  ${s}: 필요${v.demand} / 재고${v.stock}`).join('\n') +
          (Object.keys(shortageSkus).length > 5 ? `\n  ... 외 ${Object.keys(shortageSkus).length - 5}종` : '') +
          '\n\n진행하시겠습니까?'
        : `전체 ${allEligible.length}건 모두 재고 부족입니다. 작업지시서를 생성할 수 없습니다.`;

      if (canShip.length === 0) {
        // 재고 부족 상태로 변경만
        const ids = cannotShip.map(o => o.id);
        for (let i = 0; i < ids.length; i += 100) {
          await supabaseAdmin.from('online_order').update({ status: '재고부족' }).in('id', ids.slice(i, i + 100));
        }
        setMessage({ type: 'error', text: `전체 ${cannotShip.length}건 재고 부족 → 상태 변경 완료` });
        loadDashboard();
        setCreatingWo(false);
        return;
      }

      if (!window.confirm(confirmMsg)) { setCreatingWo(false); return; }

      const today = new Date().toISOString().split('T')[0];

      // ── 5단계: 재고 부족 주문 상태 변경 ──
      if (cannotShip.length > 0) {
        const ids = cannotShip.map(o => o.id);
        for (let i = 0; i < ids.length; i += 100) {
          await supabaseAdmin.from('online_order').update({ status: '재고부족' }).in('id', ids.slice(i, i + 100));
        }
      }

      // ── 6단계: work_order 생성 ──
      const { data: wo, error: woErr } = await supabaseAdmin
        .from('work_order')
        .insert({ download_date: today, status: '이관준비' })
        .select('id')
        .single();
      if (woErr || !wo) throw woErr || new Error('작업지시서 생성 실패');
      const woId = wo.id;

      // SKU별 합산
      const skuMap: Record<string, { qty: number; needsMarking: boolean; skuName: string }> = {};
      for (const o of canShip) {
        if (!skuMap[o.sku_id]) skuMap[o.sku_id] = { qty: 0, needsMarking: o.needs_marking, skuName: o.sku_name || '' };
        skuMap[o.sku_id].qty += o.quantity;
      }

      // SKU 자동 등록
      const skuIds = Object.keys(skuMap);
      for (let i = 0; i < skuIds.length; i += 100) {
        const batch = skuIds.slice(i, i + 100).map(skuId => ({
          sku_id: skuId, sku_name: skuMap[skuId].skuName || skuId, type: '완제품',
        }));
        await supabaseAdmin.from('sku').upsert(batch, { onConflict: 'sku_id', ignoreDuplicates: true });
      }

      // work_order_line 삽입
      const lines = Object.entries(skuMap).map(([skuId, v]) => ({
        work_order_id: woId, finished_sku_id: skuId, ordered_qty: v.qty,
        sent_qty: 0, received_qty: 0, marked_qty: 0, needs_marking: v.needsMarking,
      }));
      for (let i = 0; i < lines.length; i += 100) {
        const { error } = await supabaseAdmin.from('work_order_line').insert(lines.slice(i, i + 100));
        if (error) throw error;
      }

      // online_order 업데이트
      const orderIds = canShip.map(o => o.id);
      for (let i = 0; i < orderIds.length; i += 100) {
        await supabaseAdmin.from('online_order').update({ work_order_id: woId, status: '발송대기' }).in('id', orderIds.slice(i, i + 100));
      }

      // activity_log
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'work_order_create',
        work_order_id: woId,
        action_date: today,
        summary: { lines: lines.length, orders: canShip.length, shortage: cannotShip.length, totalQty: canShip.reduce((s, o) => s + o.quantity, 0) },
      }).then(() => {});

      const shortageMsg = cannotShip.length > 0 ? ` / 재고부족 ${cannotShip.length}건 제외` : '';
      setWoResult(`작업지시서 생성 완료! ${lines.length}종 ${canShip.reduce((s, o) => s + o.quantity, 0)}개 (주문 ${canShip.length}건 연결${shortageMsg})`);
      setMessage({ type: 'success', text: `작업지시서 생성 완료 — 오프라인 매장 발송 화면에서 확인하세요` });
      loadDashboard();
    } catch (err: any) {
      setMessage({ type: 'error', text: `작업지시서 생성 실패: ${err.message}` });
    } finally {
      setCreatingWo(false);
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
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
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
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Package size={18} /> 주문 현황
            <span className="text-sm font-normal text-gray-400 ml-1">{totalCount.toLocaleString()}건</span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateWorkOrder}
              disabled={creatingWo || orders.filter(o => o.status === '신규' && !o.work_order_id).length === 0}
              className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 disabled:bg-gray-300"
            >
              {creatingWo ? '생성 중...' : `작업지시서 생성 (${orders.filter(o => o.status === '신규' && !o.work_order_id).length}건)`}
            </button>
            <input
              type="date"
              value={deleteDate}
              onChange={(e) => { setDeleteDate(e.target.value); setDeletePreview(null); }}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs"
            />
            <button
              onClick={handleDeleteByDate}
              disabled={!deleteDate}
              className="px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-xs hover:bg-red-100 disabled:opacity-40"
            >
              등록일 삭제
            </button>
          </div>
        </div>

        {/* 작업지시서 생성 결과 */}
        {woResult && (
          <div className="mb-4 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl text-sm text-indigo-800 flex items-center justify-between">
            <span>{woResult}</span>
            <button onClick={() => setWoResult(null)} className="text-indigo-400 hover:text-indigo-600"><X size={14} /></button>
          </div>
        )}

        {/* 등록일 삭제 확인 */}
        {deletePreview && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl flex items-center justify-between">
            <span className="text-sm text-red-800">
              {deletePreview.date} 등록분 <strong>{deletePreview.count}건</strong> 삭제하시겠습니까?
            </span>
            <div className="flex gap-2">
              <button onClick={confirmDeleteByDate} disabled={deleting || deletePreview.count === 0}
                className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs hover:bg-red-700 disabled:bg-gray-300">
                {deleting ? '삭제 중...' : '삭제 확인'}
              </button>
              <button onClick={() => setDeletePreview(null)}
                className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200">
                취소
              </button>
            </div>
          </div>
        )}

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
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-2 py-2 text-left whitespace-nowrap">주문일시</th>
                <th className="px-2 py-2 text-left whitespace-nowrap">주문번호</th>
                <th className="px-2 py-2 text-left whitespace-nowrap">배송번호</th>
                <th className="px-2 py-2 text-left whitespace-nowrap">SKU</th>
                <th className="px-2 py-2 text-left whitespace-nowrap">상품명</th>
                <th className="px-2 py-2 text-left whitespace-nowrap">옵션</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">수량</th>
                <th className="px-2 py-2 text-center whitespace-nowrap">마킹</th>
                <th className="px-2 py-2 text-center whitespace-nowrap">상태</th>
                <th className="px-2 py-2 text-center w-[50px]">액션</th>
              </tr>
            </thead>
            <tbody>
              {dashLoading ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">불러오는 중...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  {totalCount === 0 ? '등록된 주문이 없습니다. 엑셀을 업로드하세요.' : '검색 결과가 없습니다.'}
                </td></tr>
              ) : (
                filtered.slice(0, 200).map(o => (
                  <tr key={o.id} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{o.order_date ? o.order_date.slice(0, 16).replace('T', ' ') : '-'}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-600 whitespace-nowrap">{o.order_number}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-400 whitespace-nowrap">{o.delivery_number}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-500 whitespace-nowrap">{o.sku_id}</td>
                    <td className="px-2 py-1.5 text-gray-900 whitespace-nowrap">{o.sku_name}</td>
                    <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{o.option_text}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{o.quantity}</td>
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
