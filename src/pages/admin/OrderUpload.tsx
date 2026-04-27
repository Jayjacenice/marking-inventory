import { useCallback, useEffect, useRef, useState } from 'react';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { supabase } from '../../lib/supabase';
import { getWarehouseId } from '../../lib/warehouseStore';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { useReadOnly } from '../../contexts/ReadOnlyContext';
import { parseOrderExcel } from '../../lib/orderParser';
import type { ParsedOrder } from '../../lib/orderParser';
import { getLedgerInventory } from '../../lib/ledgerInventory';
import {
  analyzePlaysBasedOrders,
  createPlaysWorkOrder,
  type PlaysAnalysisResult,
} from '../../lib/createPlaysWorkOrder';
import {
  parseCjStockExcel,
  uploadCjAvailableStock,
  getCjAvailableStock,
  toQtyMap,
  cjAssignOrdersRpc,
  type CjStockSnapshot,
} from '../../lib/cjAvailableStock';
import type { OnlineOrder } from '../../types';
import * as XLSX from 'xlsx';
import {
  ShoppingCart, Upload, Download, Search, AlertTriangle, CheckCircle,
  Package, X, FileUp, XCircle, BarChart3,
} from 'lucide-react';

interface MarkingAnalysisResult {
  orderId: string;
  orderNumber: string;
  orderDate: string;
  skuId: string;
  skuName: string;
  optionText: string;
  quantity: number;
  canMark: boolean;
  missingComponents: { skuId: string; skuName: string; needed: number; available: number }[];
}

export default function OrderUpload({ currentUserId }: { currentUserId: string }) {
  const isStale = useStaleGuard();
  const readOnly = useReadOnly();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 업로드
  const [parsed, setParsed] = useState<ParsedOrder[] | null>(null);
  const [parseSummary, setParseSummary] = useState<any>(null);
  const [newOrders, setNewOrders] = useState<ParsedOrder[]>([]);
  const [autoCompleteOrders, setAutoCompleteOrders] = useState<{ orderNumber: string; skuId: string; id: string }[]>([]); // 자동 출고완료 대상
  const [reworkOrders, setReworkOrders] = useState<{ orderNumber: string; skuId: string; id: string }[]>([]); // 재작업 대상 (출고완료 → 신규)
  const [cancelOrders, setCancelOrders] = useState<{ orderNumber: string; skuId: string; id: string }[]>([]); // 취소 대상 (엑셀 배송취소)
  // revertOrders 제거됨: 출고완료/마킹중/마킹완료 주문은 스킵 처리
  const [skipCount, setSkipCount] = useState(0); // 작업 진행중/중복 스킵
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
  useLoadingTimeout(dashLoading, setDashLoading);
  const [statusFilter, setStatusFilter] = useState('전체');
  const [categoryFilter, setCategoryFilter] = useState<'전체' | '완제품' | '유니폼단품' | '마킹키트단품' | '기타'>('전체');
  const [searchText, setSearchText] = useState('');

  // 취소 (개별 라인)
  const [cancelTarget, setCancelTarget] = useState<{ item: OnlineOrder } | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // 등록일 기준 삭제
  const [deleteDate, setDeleteDate] = useState('');
  const [deletePreview, setDeletePreview] = useState<{ date: string; count: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 작업지시서 생성
  const [creatingWo, setCreatingWo] = useState(false);
  const [woResult, setWoResult] = useState<string | null>(null);

  // 플레이위즈 재고 기반 보완 WO
  const [playsAnalyzing, setPlaysAnalyzing] = useState(false);
  const [playsCreating, setPlaysCreating] = useState(false);
  const [playsModal, setPlaysModal] = useState<PlaysAnalysisResult | null>(null);

  // CJ 가용재고
  const [cjSnapshot, setCjSnapshot] = useState<CjStockSnapshot>({ rows: [], uploadedAt: null });
  const [cjUploadModal, setCjUploadModal] = useState<{
    parsed: { skuId: string; skuName?: string; quantity: number }[] | null;
    error: string | null;
    uploading: boolean;
  } | null>(null);
  const cjFileInputRef = useRef<HTMLInputElement>(null);
  // 이중 제출 방지 가드 (React 18 fast-double-click race 회피)
  const creatingWoRef = useRef(false);
  const cjUploadingRef = useRef(false);

  // 마킹 가능 주문 분석
  const [markingAnalysis, setMarkingAnalysis] = useState<{
    loading: boolean;
    results: MarkingAnalysisResult[] | null;
    summary: { total: number; possible: number; shortage: number; possibleQty: number; shortageQty: number } | null;
    analysisTime: string | null;
  }>({ loading: false, results: null, summary: null, analysisTime: null });

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

  // CJ 가용재고 스냅샷 초기 로드
  useEffect(() => {
    getCjAvailableStock()
      .then((s) => setCjSnapshot(s))
      .catch((e) => console.error('[CJ stock load]', e));
  }, []);

  // ── 상태별 통계 ──
  const statusCounts = orders.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalCount = orders.length;

  // ── 카테고리 분류 (sku_id 패턴 기반) ──
  // 완제품(마킹완제품): 26UN-*_선수명 형태
  // 유니폼단품: 26UN-* (접미사 없음)
  // 마킹키트단품: 26MK-* / 26MK2-*
  // 기타: 그 외 (26AC, 26AP, 26CL 등)
  const getOrderCategory = (skuId: string): '완제품' | '유니폼단품' | '마킹키트단품' | '기타' => {
    if (!skuId) return '기타';
    if (skuId.startsWith('26UN-') && skuId.includes('_')) return '완제품';
    if (skuId.startsWith('26UN-')) return '유니폼단품';
    if (/^26MK\d*-/.test(skuId)) return '마킹키트단품';
    return '기타';
  };

  const categoryCounts = orders.reduce((acc, o) => {
    const cat = getOrderCategory(o.sku_id);
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // ── 필터링 ──
  const filtered = orders.filter(o => {
    if (statusFilter !== '전체' && o.status !== statusFilter) return false;
    if (categoryFilter !== '전체' && getOrderCategory(o.sku_id) !== categoryFilter) return false;
    if (searchText) {
      const q = searchText.toLowerCase();
      return o.order_number.includes(q) || (o.delivery_number || '').includes(q) || (o.sku_id || '').toLowerCase().includes(q) || (o.sku_name || '').toLowerCase().includes(q) || (o.option_text || '').toLowerCase().includes(q);
    }
    return true;
  });

  // ── 엑셀 파싱 (3-case 로직) ──
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setMessage(null);
    setAutoCompleteOrders([]);
    setSkipCount(0);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const result = parseOrderExcel(wb);

      // 유니폼/마킹만 필터 (액세서리/의류 제외)
      const uniformOnly = result.orders.filter(o => o.needsOfflineShipment);
      setParsed(uniformOnly);
      setParseSummary({ ...result.summary, total: uniformOnly.length, noMarking: uniformOnly.filter(o => !o.needsMarking).length });

      // ── 배송상태 정규화 헬퍼 (파서에서 정규화했지만 2중 방어) ──
      const normalizeStatus = (s: string) => (s || '').replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]/g, '').trim();
      const isCompleted = (s: string) => {
        const n = normalizeStatus(s);
        return n === '배송완료' || n === '배송중' || n === '배송준비중';
      };
      const isCanceled = (s: string) => normalizeStatus(s) === '배송취소';
      const isPending = (s: string) => {
        const n = normalizeStatus(s);
        return n === '배송대기' || (n !== '배송완료' && n !== '배송중' && n !== '배송준비중' && n !== '배송취소');
      };

      // ── Case 1: 배송준비중/배송중/배송완료 → 물류센터 처리됨 → 자동 출고완료 ──
      const caseAutoComplete = uniformOnly.filter(o => isCompleted(o.deliveryStatus));
      // ── Case 4-C: 배송취소 → 취소 처리 ──
      const caseCancel = uniformOnly.filter(o => isCanceled(o.deliveryStatus));
      // 배송대기 (Case 2/3/4-A 대상)
      const casePending = uniformOnly.filter(o => isPending(o.deliveryStatus));

      // [디버그] 실제 파싱된 배송상태 분포 확인 — 문제 해결 후 제거
      const statusDist: Record<string, number> = {};
      for (const o of uniformOnly) {
        const raw = o.deliveryStatus;
        const key = `[${raw}] → norm:[${normalizeStatus(raw)}]`;
        statusDist[key] = (statusDist[key] || 0) + 1;
      }
      console.log('[DEBUG] 배송상태 분포:', statusDist);
      console.log('[DEBUG] caseAutoComplete:', caseAutoComplete.length, '/ casePending:', casePending.length, '/ caseCancel:', caseCancel.length);
      console.log('[DEBUG] orders(DB기존) count:', orders.length);

      // 자동 출고완료 대상: 우리 시스템에 존재하면서 아직 출고완료/취소 아닌 주문
      const autoCompleteTargets: typeof autoCompleteOrders = [];
      if (caseAutoComplete.length > 0) {
        const existingMap = new Map(orders.map(o => [`${o.order_number}|${o.sku_id}`, o]));
        for (const o of caseAutoComplete) {
          const key = `${o.orderNumber}|${o.skuId}`;
          const existing = existingMap.get(key);
          if (existing && existing.status !== '출고완료' && existing.status !== '취소') {
            autoCompleteTargets.push({ orderNumber: o.orderNumber, skuId: o.skuId, id: existing.id });
          }
        }
      }
      setAutoCompleteOrders(autoCompleteTargets);

      // ── Case 2 & 3 & 역방향 보정: 배송대기 주문 분류 ──
      const existingMap = new Map(orders.map(o => [`${o.order_number}|${o.sku_id}`, o]));
      // 활성 작업지시서에 연결된 주문 (발송대기/이관중/마킹중 상태)
      const activeWoOrderSet = new Set(
        orders
          .filter(o => o.work_order_id && ['발송대기', '이관중', '마킹중', '마킹완료'].includes(o.status))
          .map(o => `${o.order_number}|${o.sku_id}`)
      );

      let skipCnt = 0;
      const newOnes: ParsedOrder[] = [];
      const reworkTargets: { orderNumber: string; skuId: string; id: string }[] = [];
      for (const o of casePending) {
        const key = `${o.orderNumber}|${o.skuId}`;
        const existing = existingMap.get(key);
        if (activeWoOrderSet.has(key)) {
          // Case 2: 작업 진행중 → 스킵
          skipCnt++;
        } else if (existing && existing.status === '출고완료') {
          // Case 4-A: 엑셀 배송대기 + DB 출고완료 → 재작업 (신규로 복귀)
          reworkTargets.push({ orderNumber: o.orderNumber, skuId: o.skuId, id: existing.id });
        } else if (existing && ['마킹중', '마킹완료'].includes(existing.status)) {
          // 마킹중/마킹완료 → 스킵 (이미 작업지시서에 있음)
          skipCnt++;
        } else if (existing) {
          // 이미 존재 (신규/재고부족 등) → 중복이므로 스킵
          skipCnt++;
        } else {
          // Case 3: 완전 신규 → 등록 대상
          newOnes.push(o);
        }
      }

      // Case 4-C: 배송취소 처리 대상 (DB status != '취소' 인 기존 주문)
      const cancelTargets: { orderNumber: string; skuId: string; id: string }[] = [];
      for (const o of caseCancel) {
        const key = `${o.orderNumber}|${o.skuId}`;
        const existing = existingMap.get(key);
        if (existing && existing.status !== '취소') {
          cancelTargets.push({ orderNumber: o.orderNumber, skuId: o.skuId, id: existing.id });
        }
      }

      setNewOrders(newOnes);
      setSkipCount(skipCnt);
      setReworkOrders(reworkTargets);
      setCancelOrders(cancelTargets);

      // 재고 부족 체크 (오프라인 매장)
      await checkInventoryShortage(newOnes);

      // BOM 미등록 체크
      await checkBomMissing(newOnes);

    } catch (err: any) {
      setMessage({ type: 'error', text: `파싱 오류: ${err.message}` });
    }
  };

  // ── 재고 부족 체크 (오프라인 출고 대상만, BOM 전개 포함) ──
  const checkInventoryShortage = async (items: ParsedOrder[]) => {
    // 오프라인 출고 대상(유니폼/마킹키트)만 필터
    const offlineItems = items.filter(i => i.needsOfflineShipment);
    // SKU별 주문 수량 합산 (원본)
    const orderDemand: Record<string, { skuName: string; qty: number }> = {};
    for (const item of offlineItems) {
      if (!orderDemand[item.skuId]) orderDemand[item.skuId] = { skuName: item.skuName, qty: 0 };
      orderDemand[item.skuId].qty += item.quantity;
    }

    // 오프라인 매장 재고 조회
    const offId = await getWarehouseId('오프라인샵');
    if (!offId) return;
    const wh = { id: offId };

    // BOM 조회: 마킹 완제품(26UN-xxx_YYY) → 구성품 전개
    const markingSkuIds = Object.keys(orderDemand).filter(s => s.startsWith('26UN-') && s.includes('_'));
    const bomMap: Record<string, { components: { skuId: string; qty: number }[] }> = {};
    if (markingSkuIds.length > 0) {
      for (let i = 0; i < markingSkuIds.length; i += 500) {
        const { data: boms } = await supabaseAdmin
          .from('bom')
          .select('finished_sku_id, component_sku_id, quantity')
          .in('finished_sku_id', markingSkuIds.slice(i, i + 500));
        if (boms) for (const b of boms as any[]) {
          if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = { components: [] };
          bomMap[b.finished_sku_id].components.push({ skuId: b.component_sku_id, qty: b.quantity || 1 });
        }
      }
    }

    // 구성품 기준 소요량 계산
    const componentDemand: Record<string, number> = {};
    const skuToComponents: Record<string, string[]> = {}; // 원본SKU → 체크할 구성품 목록
    for (const [skuId, demand] of Object.entries(orderDemand)) {
      if (skuId.startsWith('26UN-') && skuId.includes('_')) {
        // 마킹 완제품 → BOM 전개
        const bom = bomMap[skuId];
        if (bom) {
          skuToComponents[skuId] = bom.components.map(c => c.skuId);
          for (const c of bom.components) {
            componentDemand[c.skuId] = (componentDemand[c.skuId] || 0) + c.qty * demand.qty;
          }
        } else {
          // BOM 미등록 → SKU 패턴으로 추정 (유니폼 + 마킹)
          const baseSku = skuId.split('_')[0];
          const mkSku = baseSku.replace('26UN-', '26MK-');
          skuToComponents[skuId] = [baseSku, mkSku];
          componentDemand[baseSku] = (componentDemand[baseSku] || 0) + demand.qty;
          componentDemand[mkSku] = (componentDemand[mkSku] || 0) + demand.qty;
        }
      } else {
        // 단품 → 직접 체크
        skuToComponents[skuId] = [skuId];
        componentDemand[skuId] = (componentDemand[skuId] || 0) + demand.qty;
      }
    }

    // 구성품 기준 재고 조회
    const allComponentSkus = [...new Set(Object.keys(componentDemand))];
    const invMap: Record<string, number> = {};
    for (let i = 0; i < allComponentSkus.length; i += 500) {
      const batch = allComponentSkus.slice(i, i + 500);
      const { data: inv } = await supabaseAdmin
        .from('inventory')
        .select('sku_id, quantity')
        .eq('warehouse_id', wh.id)
        .in('sku_id', batch);
      if (inv) for (const r of inv) invMap[r.sku_id] = (invMap[r.sku_id] || 0) + r.quantity;
    }

    // 구성품 부족 여부 판별
    const shortageComponents: Record<string, boolean> = {};
    for (const [compSku, demand] of Object.entries(componentDemand)) {
      const stock = invMap[compSku] || 0;
      if (stock < demand) shortageComponents[compSku] = true;
    }

    // 원본 SKU 기준으로 부족 목록 생성
    const shortages: typeof shortageItems = [];
    for (const [skuId, demand] of Object.entries(orderDemand)) {
      const components = skuToComponents[skuId] || [skuId];
      const hasShortage = components.some(c => shortageComponents[c]);
      if (hasShortage) {
        // 구성품 중 부족한 것의 재고 정보 표시
        const minStock = Math.min(...components.map(c => invMap[c] || 0));
        shortages.push({
          skuId,
          skuName: demand.skuName,
          ordered: demand.qty,
          stock: minStock,
          shortage: demand.qty - minStock,
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
    if (newOrders.length === 0 && autoCompleteOrders.length === 0 && reworkOrders.length === 0 && cancelOrders.length === 0) return;
    setSaving(true);
    const totalWork = newOrders.length + autoCompleteOrders.length + reworkOrders.length + cancelOrders.length;
    setSaveProgress({ current: 0, total: totalWork });

    try {
      let ok = 0;
      let autoOk = 0;
      let reworkOk = 0;
      let cancelOk = 0;

      // ── Case 1 처리: 배송준비중/배송중/배송완료 → 출고완료 자동 처리 ──
      if (autoCompleteOrders.length > 0) {
        const ids = autoCompleteOrders.map(o => o.id);
        for (let i = 0; i < ids.length; i += 100) {
          await supabaseAdmin
            .from('online_order')
            .update({ status: '출고완료' })
            .in('id', ids.slice(i, i + 100));
          autoOk += Math.min(100, ids.length - i);
          setSaveProgress({ current: autoOk, total: totalWork });
        }
      }

      // ── Case 4-A 처리: 엑셀 배송대기 + DB 출고완료 → 재작업 (신규로 복귀) ──
      if (reworkOrders.length > 0) {
        const ids = reworkOrders.map(o => o.id);
        for (let i = 0; i < ids.length; i += 100) {
          await supabaseAdmin
            .from('online_order')
            .update({ status: '신규', work_order_id: null })
            .in('id', ids.slice(i, i + 100));
          reworkOk += Math.min(100, ids.length - i);
          setSaveProgress({ current: autoOk + reworkOk, total: totalWork });
        }
      }

      // ── Case 4-C 처리: 엑셀 배송취소 → 취소 ──
      if (cancelOrders.length > 0) {
        const ids = cancelOrders.map(o => o.id);
        for (let i = 0; i < ids.length; i += 100) {
          await supabaseAdmin
            .from('online_order')
            .update({ status: '취소' })
            .in('id', ids.slice(i, i + 100));
          cancelOk += Math.min(100, ids.length - i);
          setSaveProgress({ current: autoOk + reworkOk + cancelOk, total: totalWork });
        }
      }

      // ── Case 3 처리: 신규 주문 등록 ──
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
        setSaveProgress({ current: autoOk + Math.min(i + 100, newOrders.length), total: totalWork });
      }

      // activity_log
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'order_upload',
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          total: ok,
          autoComplete: autoOk,
          rework: reworkOk,
          cancel: cancelOk,
          skipped: skipCount,
          marking: newOrders.filter(o => o.needsMarking).length,
        },
      }).then(() => {});

      const parts: string[] = [];
      if (ok > 0) parts.push(`신규 ${ok}건 등록`);
      if (autoOk > 0) parts.push(`출고완료 ${autoOk}건 자동 처리`);
      if (reworkOk > 0) parts.push(`재작업 ${reworkOk}건 (출고완료→신규)`);
      if (cancelOk > 0) parts.push(`취소 ${cancelOk}건`);
      if (skipCount > 0) parts.push(`진행중/중복 ${skipCount}건 제외`);
      setMessage({ type: 'success', text: parts.join(' / ') });
      setParsed(null);
      setNewOrders([]);
      setAutoCompleteOrders([]);
      setReworkOrders([]);
      setCancelOrders([]);
      setSkipCount(0);
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

  // ── 주문 현황 엑셀 다운로드 (현재 상태/검색 필터 반영) ──
  const handleOrderListDownload = () => {
    if (filtered.length === 0) return;
    const data = filtered.map(o => ({
      '주문일시': o.order_date ? o.order_date.slice(0, 16).replace('T', ' ') : '',
      '주문번호': o.order_number || '',
      '배송번호': o.delivery_number || '',
      'SKU': o.sku_id || '',
      '상품명': o.sku_name || '',
      '옵션': o.option_text || '',
      '수량': o.quantity || 0,
      '마킹': o.needs_marking ? 'O' : '',
      '상태': o.status || '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 17 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 40 }, { wch: 24 }, { wch: 6 }, { wch: 6 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '주문현황');
    const today = new Date().toISOString().slice(0, 10);
    const statusTag = statusFilter !== '전체' ? `_${statusFilter}` : '';
    XLSX.writeFile(wb, `주문현황${statusTag}_${today}.xlsx`);
  };

  // ── 주문 취소 (개별 라인) ──
  const openCancelModal = (item: OnlineOrder) => {
    setCancelTarget({ item });
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    const item = cancelTarget.item;
    try {
      // 해당 라인 1건만 취소
      const { error } = await supabaseAdmin
        .from('online_order')
        .update({ status: '취소' })
        .eq('id', item.id);
      if (error) throw error;

      // 작업지시서에 연결된 경우 → work_order_line 수량 차감
      if (item.work_order_id) {
        const { data: wol } = await supabaseAdmin
          .from('work_order_line')
          .select('id, ordered_qty')
          .eq('work_order_id', item.work_order_id)
          .eq('finished_sku_id', item.sku_id)
          .single();

        if (wol) {
          const newQty = Math.max(0, (wol.ordered_qty || 0) - item.quantity);
          if (newQty === 0) {
            // 수량 0이면 라인 삭제
            await supabaseAdmin.from('work_order_line').delete().eq('id', wol.id);
          } else {
            await supabaseAdmin.from('work_order_line').update({ ordered_qty: newQty }).eq('id', wol.id);
          }
        }
      }

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'order_cancel',
        action_date: new Date().toISOString().split('T')[0],
        summary: { order_number: item.order_number, sku_id: item.sku_id, quantity: item.quantity },
      }).then(() => {});

      setMessage({ type: 'success', text: `${item.sku_name} ${item.quantity}개 취소 완료` });
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

  // ── CJ 가용재고 엑셀 선택 (파싱만, 저장 전 미리보기) ──
  const handleCjFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setCjUploadModal({ parsed: null, error: null, uploading: false });
    try {
      const { rows, stats } = await parseCjStockExcel(file);
      if (rows.length === 0) {
        setCjUploadModal({
          parsed: null,
          error: `매칭 행 0건. (행 ${stats.totalRows} / 창고 제외 ${stats.warehouseSkipped} / 제조사 제외 ${stats.partnerSkipped} / 가용 0 ${stats.zeroSkipped})`,
          uploading: false,
        });
        return;
      }
      setCjUploadModal({ parsed: rows, error: null, uploading: false });
    } catch (err: any) {
      setCjUploadModal({ parsed: null, error: err.message || '파싱 실패', uploading: false });
    }
  };

  const handleCjUploadConfirm = async () => {
    if (!cjUploadModal?.parsed) return;
    if (cjUploadingRef.current) return;
    cjUploadingRef.current = true;
    setCjUploadModal({ ...cjUploadModal, uploading: true });
    try {
      const r = await uploadCjAvailableStock(cjUploadModal.parsed);
      const fresh = await getCjAvailableStock();
      setCjSnapshot(fresh);
      setCjUploadModal(null);
      setMessage({ type: 'success', text: `CJ 가용재고 ${r.inserted}종 갱신 완료${r.skuRegistered > 0 ? ` (SKU 자동 등록 ${r.skuRegistered})` : ''}` });
    } catch (err: any) {
      setCjUploadModal({ ...cjUploadModal, error: err.message, uploading: false });
    } finally {
      cjUploadingRef.current = false;
    }
  };

  // ── 작업지시서 생성 (신규 주문 → work_order, 재고 체크 포함) ──
  // CJ 가용재고 우선: FIFO(주문일시 빠른 순) 차감, 매칭되면 status='CJ대기' 처리
  // 못 맞춘 주문만 매장 재고 평가 후 이관 WO 생성
  const handleCreateWorkOrder = async () => {
    if (creatingWoRef.current) return;
    const allEligible = orders.filter(o => (o.status === '신규' || o.status === '재고부족') && !o.work_order_id);
    if (allEligible.length === 0) {
      setMessage({ type: 'error', text: '작업지시서를 생성할 주문이 없습니다. (신규/재고부족)' });
      return;
    }

    creatingWoRef.current = true;
    setCreatingWo(true);
    setWoResult(null);
    try {
      // ── 0단계: CJ 가용재고 우선 매칭 ──
      // 주문일시 오름차순 FIFO. finished_sku 자체로 매칭 (BOM 분해 없음)
      const cjPool: Record<string, number> = { ...toQtyMap(cjSnapshot) };
      const sortedByDate = [...allEligible].sort((a, b) => (a.order_date || '').localeCompare(b.order_date || ''));
      const cjAssigned: typeof allEligible = [];
      const remaining: typeof allEligible = [];
      for (const o of sortedByDate) {
        const need = o.quantity || 0;
        const have = cjPool[o.sku_id] || 0;
        if (need > 0 && have >= need) {
          cjPool[o.sku_id] = have - need;
          cjAssigned.push(o);
        } else {
          remaining.push(o);
        }
      }

      // 한 트랜잭션 RPC 로 (a) 가용재고 차감, (b) status='CJ대기', (c) activity_log 처리
      // CHECK(quantity>=0) 위반 또는 매칭 불일치 시 자동 rollback → double-counting 방지
      if (cjAssigned.length > 0) {
        // SKU별 차감량 산출 (양수만)
        const skuDeltas: Record<string, number> = {};
        for (const o of cjAssigned) {
          skuDeltas[o.sku_id] = (skuDeltas[o.sku_id] || 0) + (o.quantity || 0);
        }
        await cjAssignOrdersRpc({
          orderIds: cjAssigned.map(o => o.id),
          skuDeltas,
          userId: currentUserId,
        });
        // 메모리 스냅샷 동기화 (DB는 RPC 내에서 이미 차감됨 — 추가 라운드트립 없이 메모리만 갱신)
        setCjSnapshot((prev) => ({
          rows: prev.rows.map((r) => ({ ...r, quantity: cjPool[r.sku_id] ?? r.quantity })),
          uploadedAt: prev.uploadedAt,
        }));
      }

      // CJ 충당 후 남은 주문이 없으면 종료
      if (remaining.length === 0) {
        setWoResult(`CJ 가용재고로 ${cjAssigned.length}건 / ${cjAssigned.reduce((s, o) => s + (o.quantity || 0), 0)}개 모두 충당. 작업지시서 생성 안 됨.`);
        setMessage({ type: 'success', text: 'CJ 가용재고로 전량 충당되어 작업지시서가 필요 없습니다.' });
        loadDashboard();
        setCreatingWo(false);
        return;
      }

      // ── 1단계: 오프라인 매장 재고 조회 (수불부 공식 기반) ──
      // inventory 테이블의 Math.max 클램핑·비원자 upsert drift를 회피하기 위해
      // inventory_transaction 누적으로 현재 잔량을 계산.
      const whId = await getWarehouseId('오프라인샵');
      // 매장 발송용 재고는 needs_marking=false 단품만 (ShipmentConfirm 와 동일 기준)
      const invMap: Record<string, number> = whId ? await getLedgerInventory(whId, undefined, false) : {};

      // ── 1.5단계: BOM 조회 (마킹 완제품 → 구성품, 이후 차감에 사용) ──
      // CJ 충당 후 남은 주문 + 기존 작업지시서 라인 모두에서 마킹 완제품 SKU 수집
      const allMarkingCandidates = new Set(
        remaining.filter(o => o.sku_id.startsWith('26UN-') && o.sku_id.includes('_')).map(o => o.sku_id)
      );

      const activeStatuses = ['이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료'];
      const { data: activeWos } = await supabaseAdmin
        .from('work_order')
        .select('id')
        .in('status', activeStatuses);

      // 기존 작업지시서 라인 조회
      const activeWoLines: { finished_sku_id: string; ordered_qty: number; needs_marking: boolean }[] = [];
      if (activeWos && activeWos.length > 0) {
        const woIds = activeWos.map(w => w.id);
        for (let i = 0; i < woIds.length; i += 50) {
          const batchIds = woIds.slice(i, i + 50);
          const { data: woLines } = await supabaseAdmin
            .from('work_order_line')
            .select('finished_sku_id, ordered_qty, needs_marking')
            .in('work_order_id', batchIds);
          if (woLines) {
            for (const line of woLines as any[]) {
              activeWoLines.push(line);
              // 기존 작업지시서의 마킹 완제품도 BOM 조회 대상에 추가
              if (line.needs_marking && line.finished_sku_id.startsWith('26UN-') && line.finished_sku_id.includes('_')) {
                allMarkingCandidates.add(line.finished_sku_id);
              }
            }
          }
        }
      }

      // BOM 일괄 조회
      const markingSkuIds = [...allMarkingCandidates];
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

      // ── 1.6단계: 기존 작업지시서 할당분 차감 (BOM 전개 후 구성품 기준) ──
      for (const line of activeWoLines) {
        const skuId = line.finished_sku_id;
        const qty = line.ordered_qty || 0;

        if (skuId.startsWith('26UN-') && skuId.includes('_')) {
          // 마킹 완제품 → 구성품별로 차감
          const bom = bomMap[skuId];
          if (bom) {
            for (const c of bom.components) {
              invMap[c.skuId] = (invMap[c.skuId] || 0) - c.qty * qty;
            }
          } else {
            // BOM 미등록 → 패턴 추정
            const baseSku = skuId.split('_')[0];
            const mkSku = baseSku.replace('26UN-', '26MK-');
            invMap[baseSku] = (invMap[baseSku] || 0) - qty;
            invMap[mkSku] = (invMap[mkSku] || 0) - qty;
          }
        } else {
          // 단품 → 직접 차감
          invMap[skuId] = (invMap[skuId] || 0) - qty;
        }
      }

      // ── 3단계: 선착순 배분 (오래된 주문부터 재고 차감) ──
      // CJ 충당 후 남은 주문을 주문일시 빠른 순 정렬
      remaining.sort((a, b) => (a.order_date || '').localeCompare(b.order_date || ''));

      // 가용 재고 복사본 (차감용)
      const availableStock: Record<string, number> = { ...invMap };

      const canShip: typeof remaining = [];
      const cannotShip: typeof remaining = [];

      // 주문별로 구성품 확인 → 재고 있으면 차감 후 발송가능, 없으면 재고부족
      for (const o of remaining) {
        const skuId = o.sku_id;
        const qty = o.quantity;

        // 구성품 목록 산출
        let components: { skuId: string; qty: number }[];
        if (skuId.startsWith('26UN-') && skuId.includes('_')) {
          // 마킹 완제품 → BOM 전개
          const bom = bomMap[skuId];
          if (bom) {
            components = bom.components.map(c => ({ skuId: c.skuId, qty: c.qty * qty }));
          } else {
            // BOM 미등록 → SKU 패턴으로 추정 (유니폼 + 마킹)
            const baseSku = skuId.split('_')[0];
            const mkSku = baseSku.replace('26UN-', '26MK-');
            components = [{ skuId: baseSku, qty }, { skuId: mkSku, qty }];
          }
        } else {
          // 단품 → 직접 체크
          components = [{ skuId, qty }];
        }

        // 구성품 전부 가용한지 확인
        const canFulfill = components.every(c => (availableStock[c.skuId] || 0) >= c.qty);

        if (canFulfill) {
          // 재고 차감
          for (const c of components) {
            availableStock[c.skuId] = (availableStock[c.skuId] || 0) - c.qty;
          }
          canShip.push(o);
        } else {
          cannotShip.push(o);
        }
      }

      // 부족 구성품 요약 (확인 팝업용)
      const shortageSkus: Record<string, { demand: number; stock: number }> = {};
      for (const o of cannotShip) {
        const skuId = o.sku_id;
        const qty = o.quantity;
        if (skuId.startsWith('26UN-') && skuId.includes('_')) {
          const bom = bomMap[skuId];
          if (bom) {
            for (const c of bom.components) {
              if (!shortageSkus[c.skuId]) shortageSkus[c.skuId] = { demand: 0, stock: invMap[c.skuId] || 0 };
              shortageSkus[c.skuId].demand += c.qty * qty;
            }
          } else {
            const baseSku = skuId.split('_')[0];
            const mkSku = baseSku.replace('26UN-', '26MK-');
            if (!shortageSkus[baseSku]) shortageSkus[baseSku] = { demand: 0, stock: invMap[baseSku] || 0 };
            shortageSkus[baseSku].demand += qty;
            if (!shortageSkus[mkSku]) shortageSkus[mkSku] = { demand: 0, stock: invMap[mkSku] || 0 };
            shortageSkus[mkSku].demand += qty;
          }
        } else {
          if (!shortageSkus[skuId]) shortageSkus[skuId] = { demand: 0, stock: invMap[skuId] || 0 };
          shortageSkus[skuId].demand += qty;
        }
      }

      // 확인 팝업
      const fromNew = canShip.filter(o => o.status === '신규').length;
      const fromShortage = canShip.filter(o => o.status === '재고부족').length;

      const cjLine = cjAssigned.length > 0 ? `CJ 가용재고로 ${cjAssigned.length}건 → CJ대기 처리\n` : '';
      const confirmMsg = canShip.length > 0
        ? cjLine +
          `발송 가능 ${canShip.length}건 → 작업지시서 생성\n` +
          (fromNew > 0 ? `  - 신규: ${fromNew}건\n` : '') +
          (fromShortage > 0 ? `  - 재고부족→해소: ${fromShortage}건\n` : '') +
          (cannotShip.length > 0 ? `재고 부족 유지 ${cannotShip.length}건 → 제외\n\n` : '\n') +
          `부족 구성품: ${Object.keys(shortageSkus).length}종\n` +
          Object.entries(shortageSkus).slice(0, 5).map(([s, v]) => `  ${s}: 필요${v.demand} / 재고${v.stock}`).join('\n') +
          (Object.keys(shortageSkus).length > 5 ? `\n  ... 외 ${Object.keys(shortageSkus).length - 5}종` : '') +
          '\n\n진행하시겠습니까?'
        : cjLine + `매장 발송 대상 ${remaining.length}건 모두 재고 부족입니다. 작업지시서를 생성할 수 없습니다.`;

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

      // 주문일시 빠른 순 정렬 (오래된 주문부터 처리)
      canShip.sort((a, b) => (a.order_date || '').localeCompare(b.order_date || ''));

      // SKU별 합산 (첫 등장 순서 = 주문일시 빠른 순)
      const skuMap: Record<string, { qty: number; needsMarking: boolean; skuName: string; firstOrderDate: string }> = {};
      for (const o of canShip) {
        if (!skuMap[o.sku_id]) skuMap[o.sku_id] = { qty: 0, needsMarking: o.needs_marking, skuName: o.sku_name || '', firstOrderDate: o.order_date || '' };
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

      // work_order_line 삽입 (주문일시 빠른 순)
      const lines = Object.entries(skuMap)
        .sort((a, b) => (a[1].firstOrderDate).localeCompare(b[1].firstOrderDate))
        .map(([skuId, v]) => ({
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
        summary: {
          lines: lines.length,
          orders: canShip.length,
          shortage: cannotShip.length,
          cjAssigned: cjAssigned.length,
          totalQty: canShip.reduce((s, o) => s + o.quantity, 0),
        },
      }).then(() => {});

      const cjMsg = cjAssigned.length > 0 ? `CJ대기 ${cjAssigned.length}건 / ` : '';
      const shortageMsg = cannotShip.length > 0 ? ` / 재고부족 ${cannotShip.length}건 제외` : '';
      setWoResult(`${cjMsg}작업지시서 생성 완료! ${lines.length}종 ${canShip.reduce((s, o) => s + o.quantity, 0)}개 (주문 ${canShip.length}건 연결${shortageMsg})`);
      setMessage({ type: 'success', text: `작업지시서 생성 완료 — 오프라인 매장 발송 화면에서 확인하세요` });
      loadDashboard();
    } catch (err: any) {
      setMessage({ type: 'error', text: `작업지시서 생성 실패: ${err.message}` });
    } finally {
      setCreatingWo(false);
      creatingWoRef.current = false;
    }
  };

  // ── 플레이위즈 재고 기반 보완 WO ──
  const handlePlaysAnalyze = async () => {
    setPlaysAnalyzing(true);
    try {
      const result = await analyzePlaysBasedOrders();
      setPlaysModal(result);
    } catch (e: any) {
      setMessage({ type: 'error', text: `플레이위즈 재고 분석 실패: ${e.message}` });
    } finally {
      setPlaysAnalyzing(false);
    }
  };

  const handlePlaysCreate = async () => {
    if (!playsModal) return;
    if (playsModal.possibleOrders.length === 0) return;
    setPlaysCreating(true);
    try {
      const out = await createPlaysWorkOrder(playsModal.possibleOrders, currentUserId);
      setPlaysModal(null);
      setWoResult(
        `플레이위즈 재고 기반 작업지시서 생성 완료! ${out.lineCount}종 ${out.totalQty}개 (주문 ${out.orderCount}건 재할당)`,
      );
      setMessage({ type: 'success', text: '보완 작업지시서가 생성되었습니다. 마킹/출고 단계로 바로 진입합니다.' });
      loadDashboard();
    } catch (e: any) {
      setMessage({ type: 'error', text: `보완 작업지시서 생성 실패: ${e.message}` });
    } finally {
      setPlaysCreating(false);
    }
  };

  // ── 마킹 가능 주문 분석 ──
  const analyzeMarkingPossible = async () => {
    setMarkingAnalysis({ loading: true, results: null, summary: null, analysisTime: null });
    try {
      // 1. 활성 작업지시서 조회
      const { data: activeWos } = await supabaseAdmin
        .from('work_order')
        .select('id')
        .in('status', ['이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료']);
      const woIds = (activeWos || []).map((w: any) => w.id);
      if (woIds.length === 0) {
        setMarkingAnalysis({ loading: false, results: [], summary: { total: 0, possible: 0, shortage: 0, possibleQty: 0, shortageQty: 0 }, analysisTime: new Date().toLocaleString('ko-KR') });
        return;
      }

      // 2. 마킹 주문 조회 (주문일 순)
      const markingOrders: any[] = [];
      for (let i = 0; i < woIds.length; i += 50) {
        let offset = 0;
        while (true) {
          const { data } = await supabaseAdmin
            .from('online_order')
            .select('id, order_number, order_date, sku_id, sku_name, option_text, quantity, work_order_id')
            .eq('needs_marking', true)
            .in('status', ['발송대기', '이관중', '마킹중'])
            .in('work_order_id', woIds.slice(i, i + 50))
            .order('order_date', { ascending: true })
            .range(offset, offset + 999);
          if (!data || data.length === 0) break;
          markingOrders.push(...data);
          if (data.length < 1000) break;
          offset += 1000;
        }
      }
      markingOrders.sort((a, b) => (a.order_date || '').localeCompare(b.order_date || ''));

      if (markingOrders.length === 0) {
        setMarkingAnalysis({ loading: false, results: [], summary: { total: 0, possible: 0, shortage: 0, possibleQty: 0, shortageQty: 0 }, analysisTime: new Date().toLocaleString('ko-KR') });
        return;
      }

      // 3. 플레이위즈 재고 조회 (수불부 공식 기반)
      const pwWhId = await getWarehouseId('플레이위즈');
      const pwInvMap: Record<string, number> = pwWhId ? await getLedgerInventory(pwWhId) : {};

      // 4. BOM 조회
      const finishedSkuIds = [...new Set(markingOrders.map(o => o.sku_id))];
      const bomMap: Record<string, { skuId: string; skuName: string; qty: number }[]> = {};
      for (let i = 0; i < finishedSkuIds.length; i += 500) {
        const { data: boms } = await supabaseAdmin
          .from('bom')
          .select('finished_sku_id, component_sku_id, quantity, component_sku:sku!bom_component_sku_id_fkey(sku_name)')
          .in('finished_sku_id', finishedSkuIds.slice(i, i + 500));
        if (boms) for (const b of boms as any[]) {
          if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
          bomMap[b.finished_sku_id].push({
            skuId: b.component_sku_id,
            skuName: b.component_sku?.sku_name || b.component_sku_id,
            qty: b.quantity || 1,
          });
        }
      }

      // 5. FIFO 할당
      const availablePool = { ...pwInvMap };
      const results: MarkingAnalysisResult[] = [];

      for (const order of markingOrders) {
        // BOM 분해
        let components = bomMap[order.sku_id];
        if (!components) {
          // BOM 미등록 → 패턴 추정
          const baseSku = order.sku_id.split('_')[0];
          const mkSku = baseSku.replace('26UN-', '26MK-');
          components = [
            { skuId: baseSku, skuName: baseSku, qty: 1 },
            { skuId: mkSku, skuName: mkSku, qty: 1 },
          ];
        }

        let canMark = true;
        const missingComponents: MarkingAnalysisResult['missingComponents'] = [];

        for (const comp of components) {
          const needed = comp.qty * order.quantity;
          const available = availablePool[comp.skuId] || 0;
          if (available < needed) {
            canMark = false;
            missingComponents.push({ skuId: comp.skuId, skuName: comp.skuName, needed, available });
          }
        }

        if (canMark) {
          // 재고 차감
          for (const comp of components) {
            availablePool[comp.skuId] = (availablePool[comp.skuId] || 0) - comp.qty * order.quantity;
          }
        }

        results.push({
          orderId: order.id,
          orderNumber: order.order_number,
          orderDate: order.order_date || '',
          skuId: order.sku_id,
          skuName: order.sku_name || '',
          optionText: order.option_text || '',
          quantity: order.quantity,
          canMark,
          missingComponents,
        });
      }

      const possible = results.filter(r => r.canMark);
      const shortage = results.filter(r => !r.canMark);
      setMarkingAnalysis({
        loading: false,
        results,
        summary: {
          total: results.length,
          possible: possible.length,
          shortage: shortage.length,
          possibleQty: possible.reduce((s, r) => s + r.quantity, 0),
          shortageQty: shortage.reduce((s, r) => s + r.quantity, 0),
        },
        analysisTime: new Date().toLocaleString('ko-KR'),
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: `마킹 분석 실패: ${err.message}` });
      setMarkingAnalysis({ loading: false, results: null, summary: null, analysisTime: null });
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
    'CJ대기': 'bg-emerald-50 text-emerald-700',
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
        <p className="text-sm text-gray-500 mb-3">FulfillmentShipping 엑셀을 업로드하면 배송상태별 자동 분류됩니다. (배송대기→신규등록, 배송준비중/중/완료→자동출고완료, 진행중→스킵)</p>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={readOnly}
          className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm hover:bg-indigo-700 flex items-center gap-2 disabled:opacity-50"
        >
          <Upload size={14} /> 엑셀 파일 선택
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileSelect} disabled={readOnly} className="hidden" />
      </div>

      {/* ── 파싱 미리보기 ── */}
      {parsed && parseSummary && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-5 space-y-4">
          <h2 className="font-semibold text-gray-900">업로드 미리보기</h2>

          {/* 요약 카드 — 분류 결과 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">엑셀 전체</p>
              <p className="text-lg font-bold">{parseSummary.total}</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <p className="text-xs text-blue-600">신규 등록</p>
              <p className="text-lg font-bold text-blue-700">{newOrders.length}</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <p className="text-xs text-green-600">자동 출고완료</p>
              <p className="text-lg font-bold text-green-700">{autoCompleteOrders.length}</p>
            </div>
            <div className="bg-yellow-50 rounded-lg p-3 text-center">
              <p className="text-xs text-yellow-700">재작업</p>
              <p className="text-lg font-bold text-yellow-700">{reworkOrders.length}</p>
            </div>
            <div className="bg-red-50 rounded-lg p-3 text-center">
              <p className="text-xs text-red-600">취소</p>
              <p className="text-lg font-bold text-red-700">{cancelOrders.length}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">진행중/중복</p>
              <p className="text-lg font-bold text-gray-400">{skipCount}</p>
            </div>
          </div>
          {/* 추가 정보 */}
          {newOrders.filter(o => o.needsMarking).length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="bg-purple-50 rounded-lg p-3 text-center">
                <p className="text-xs text-purple-600">마킹 필요</p>
                <p className="text-lg font-bold text-purple-700">{newOrders.filter(o => o.needsMarking).length}</p>
              </div>
              <div className="bg-orange-50 rounded-lg p-3 text-center">
                <p className="text-xs text-orange-600">물류센터 처리</p>
                <p className="text-lg font-bold text-orange-700">{(parsed || []).filter(o => ['배송준비중', '배송중', '배송완료'].includes(o.deliveryStatus)).length}</p>
              </div>
            </div>
          )}

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
              disabled={readOnly || saving || (newOrders.length === 0 && autoCompleteOrders.length === 0 && reworkOrders.length === 0 && cancelOrders.length === 0)}
              className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:bg-gray-300"
            >
              {saving ? '저장 중...' : (() => {
                const parts = [];
                if (newOrders.length > 0) parts.push(`신규 ${newOrders.length}`);
                if (autoCompleteOrders.length > 0) parts.push(`자동완료 ${autoCompleteOrders.length}`);
                if (reworkOrders.length > 0) parts.push(`재작업 ${reworkOrders.length}`);
                if (cancelOrders.length > 0) parts.push(`취소 ${cancelOrders.length}`);
                return `처리 (${parts.join(' + ')}건)`;
              })()}
            </button>
            <button
              onClick={() => { setParsed(null); setNewOrders([]); setAutoCompleteOrders([]); setReworkOrders([]); setCancelOrders([]); setSkipCount(0); setShortageItems([]); setBomMissing([]); }}
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
              onClick={analyzeMarkingPossible}
              disabled={readOnly || markingAnalysis.loading}
              className="px-4 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 disabled:bg-gray-300 flex items-center gap-1"
            >
              <BarChart3 size={13} />
              {markingAnalysis.loading ? '분석 중...' : '마킹 가능 분석'}
            </button>
            <button
              onClick={() => cjFileInputRef.current?.click()}
              disabled={readOnly}
              className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 disabled:bg-gray-300 flex items-center gap-1"
              title={cjSnapshot.uploadedAt ? `최근 업로드: ${new Date(cjSnapshot.uploadedAt).toLocaleString('ko-KR')}` : 'CJ 가용재고 미업로드'}
            >
              <Upload size={13} />
              CJ 가용재고 업로드 {cjSnapshot.rows.length > 0 && `(${cjSnapshot.rows.length}종)`}
            </button>
            <input ref={cjFileInputRef} type="file" accept=".xlsx,.xls" onChange={handleCjFileSelect} className="hidden" />
            <button
              onClick={handleCreateWorkOrder}
              disabled={readOnly || creatingWo || orders.filter(o => (o.status === '신규' || o.status === '재고부족') && !o.work_order_id).length === 0}
              className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 disabled:bg-gray-300"
            >
              {creatingWo ? '생성 중...' : `작업지시서 생성 (${orders.filter(o => (o.status === '신규' || o.status === '재고부족') && !o.work_order_id).length}건)`}
            </button>
            <button
              onClick={handlePlaysAnalyze}
              disabled={readOnly || playsAnalyzing}
              className="px-4 py-1.5 bg-teal-600 text-white rounded-lg text-xs font-semibold hover:bg-teal-700 disabled:bg-gray-300 flex items-center gap-1"
              title="플레이위즈 현재 재고로 처리 가능한 취소·재고부족·신규 주문을 별도 WO로 생성"
            >
              <Package size={13} />
              {playsAnalyzing ? '분석 중...' : '플레이위즈 재고 기반 보완 WO'}
            </button>
            <input
              type="date"
              value={deleteDate}
              onChange={(e) => { setDeleteDate(e.target.value); setDeletePreview(null); }}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs"
            />
            <button
              onClick={handleDeleteByDate}
              disabled={readOnly || !deleteDate}
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
              <button onClick={confirmDeleteByDate} disabled={readOnly || deleting || deletePreview.count === 0}
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

        {/* 마킹 가능 주문 분석 결과 */}
        {markingAnalysis.results !== null && (
          <div className="mb-4 bg-purple-50 border border-purple-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-purple-900 flex items-center gap-2">
                <BarChart3 size={16} /> 마킹 가능 주문 분석
              </h3>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-purple-400">{markingAnalysis.analysisTime} 기준 (플레이위즈 재고)</span>
                <button onClick={() => setMarkingAnalysis({ loading: false, results: null, summary: null, analysisTime: null })} className="text-purple-400 hover:text-purple-600"><X size={14} /></button>
              </div>
            </div>

            {/* 요약 카드 */}
            {markingAnalysis.summary && (
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-white rounded-lg p-3 text-center border border-purple-100">
                  <p className="text-[10px] text-gray-500">전체 마킹 주문</p>
                  <p className="text-lg font-bold text-gray-900">{markingAnalysis.summary.total.toLocaleString()}<span className="text-xs font-normal text-gray-400">건</span></p>
                </div>
                <div className="bg-green-50 rounded-lg p-3 text-center border border-green-200">
                  <p className="text-[10px] text-green-600">마킹 가능</p>
                  <p className="text-lg font-bold text-green-700">{markingAnalysis.summary.possible.toLocaleString()}<span className="text-xs font-normal text-green-400">건</span></p>
                  <p className="text-[10px] text-green-500">{markingAnalysis.summary.possibleQty}개</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center border border-red-200">
                  <p className="text-[10px] text-red-600">재고 부족</p>
                  <p className="text-lg font-bold text-red-700">{markingAnalysis.summary.shortage.toLocaleString()}<span className="text-xs font-normal text-red-400">건</span></p>
                  <p className="text-[10px] text-red-500">{markingAnalysis.summary.shortageQty}개</p>
                </div>
              </div>
            )}

            {/* 부족 구성품 요약 */}
            {markingAnalysis.results.some(r => !r.canMark) && (() => {
              const shortageMap: Record<string, { skuName: string; totalShort: number }> = {};
              for (const r of markingAnalysis.results!) {
                for (const m of r.missingComponents) {
                  if (!shortageMap[m.skuId]) shortageMap[m.skuId] = { skuName: m.skuName, totalShort: 0 };
                  shortageMap[m.skuId].totalShort += (m.needed - m.available);
                }
              }
              const sorted = Object.entries(shortageMap).sort((a, b) => b[1].totalShort - a[1].totalShort);
              return (
                <div className="mb-3 bg-white rounded-lg p-3 border border-red-100">
                  <p className="text-xs font-semibold text-red-800 mb-1">부족 구성품 TOP {Math.min(sorted.length, 10)}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 text-[11px]">
                    {sorted.slice(0, 10).map(([skuId, v]) => (
                      <div key={skuId} className="flex justify-between bg-red-50 px-2 py-1 rounded">
                        <span className="text-gray-700 truncate mr-2" title={v.skuName}>{skuId.includes('MK') ? '🏷️' : '👕'} {v.skuName.length > 20 ? v.skuName.slice(0, 20) + '...' : v.skuName}</span>
                        <span className="text-red-600 font-semibold whitespace-nowrap">-{v.totalShort}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* 주문 목록 (가능→부족 순) */}
            <div className="max-h-[400px] overflow-y-auto bg-white rounded-lg border border-purple-100">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-purple-100">
                  <tr>
                    <th className="px-2 py-1.5 text-left">주문일시</th>
                    <th className="px-2 py-1.5 text-left">주문번호</th>
                    <th className="px-2 py-1.5 text-left">SKU</th>
                    <th className="px-2 py-1.5 text-left">옵션</th>
                    <th className="px-2 py-1.5 text-right">수량</th>
                    <th className="px-2 py-1.5 text-center">상태</th>
                    <th className="px-2 py-1.5 text-left">부족 구성품</th>
                  </tr>
                </thead>
                <tbody>
                  {markingAnalysis.results.slice(0, 300).map((r) => (
                    <tr key={r.orderId} className={`border-t ${r.canMark ? 'bg-green-50/30' : 'bg-red-50/30'}`}>
                      <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{r.orderDate ? r.orderDate.slice(0, 16).replace('T', ' ') : '-'}</td>
                      <td className="px-2 py-1 font-mono text-gray-600">{r.orderNumber}</td>
                      <td className="px-2 py-1 font-mono text-gray-500" title={r.skuName}>{r.skuId.length > 25 ? r.skuId.slice(0, 25) + '...' : r.skuId}</td>
                      <td className="px-2 py-1 text-gray-500">{r.optionText}</td>
                      <td className="px-2 py-1 text-right">{r.quantity}</td>
                      <td className="px-2 py-1 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${r.canMark ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {r.canMark ? '가능' : '부족'}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-red-600">
                        {r.missingComponents.map(m => (
                          <span key={m.skuId} className="mr-1" title={m.skuName}>
                            {m.skuId.includes('MK') ? '🏷️' : '👕'}{m.available}/{m.needed}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {markingAnalysis.results.length > 300 && (
                <p className="text-center text-[10px] text-gray-400 py-1">상위 300건 표시 (전체 {markingAnalysis.results.length}건)</p>
              )}
            </div>
          </div>
        )}

        {/* 상태별 카드 */}
        <div className="grid grid-cols-3 sm:grid-cols-7 gap-2 mb-3">
          {['신규', '발송대기', 'CJ대기', '이관중', '마킹중', '출고완료', '재고부족', '취소'].map(status => (
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

        {/* 카테고리 필터 */}
        <div className="flex flex-wrap gap-2 mb-4">
          <span className="text-xs text-gray-500 self-center">카테고리:</span>
          {(['전체', '완제품', '유니폼단품', '마킹키트단품', '기타'] as const).map(cat => {
            const count = cat === '전체' ? totalCount : (categoryCounts[cat] || 0);
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white font-semibold'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat} <span className={active ? 'text-indigo-100' : 'text-gray-400'}>({count.toLocaleString()})</span>
              </button>
            );
          })}
        </div>

        {/* 검색 + 다운로드 */}
        <div className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="주문번호 / 배송번호 / SKU / 상품명 / 옵션 검색"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          </div>
          <button
            onClick={handleOrderListDownload}
            disabled={filtered.length === 0}
            className="px-3 py-2 bg-emerald-600 text-white rounded-xl text-xs font-medium hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-1 shrink-0"
            title={`현재 ${filtered.length.toLocaleString()}건 다운로드`}
          >
            <Download size={13} />
            엑셀 다운로드 ({filtered.length.toLocaleString()})
          </button>
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
                          onClick={() => openCancelModal(o)}
                          className="p-1 text-red-400 hover:bg-red-50 rounded"
                          title="이 라인 취소"
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

      {/* 취소 확인 모달 (개별 라인) */}
      {cancelTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setCancelTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">주문 라인 취소</h3>
            <div className="text-sm text-gray-600 mb-3 space-y-1">
              <p>주문번호: <span className="font-mono font-semibold">{cancelTarget.item.order_number}</span></p>
              <p>상품: <span className="font-semibold">{cancelTarget.item.sku_name}</span></p>
              <p>SKU: <span className="font-mono text-xs">{cancelTarget.item.sku_id}</span></p>
              <p>수량: <span className="font-semibold">{cancelTarget.item.quantity}개</span></p>
              {cancelTarget.item.work_order_id && (
                <p className="text-orange-600 text-xs mt-1">⚠ 작업지시서 연결됨 — 발송 수량도 함께 차감됩니다</p>
              )}
            </div>
            <p className="text-sm text-red-600 mb-4">이 상품 라인만 취소됩니다. 같은 주문의 다른 상품은 영향 없습니다.</p>
            <div className="flex gap-2">
              <button
                onClick={handleCancel}
                disabled={readOnly || cancelling}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:bg-gray-300"
              >
                {cancelling ? '처리 중...' : '이 라인 취소'}
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

      {/* CJ 가용재고 업로드 미리보기 모달 */}
      {cjUploadModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">CJ 가용재고 업로드</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  BERRIZ 재고 현황 양식에서 SKU코드·가용재고 컬럼을 자동 인식. 저장 시 기존 스냅샷 전체 갱신.
                </p>
              </div>
              <button onClick={() => setCjUploadModal(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3 text-xs">
              {cjUploadModal.error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-red-800">
                  {cjUploadModal.error}
                </div>
              )}
              {cjUploadModal.parsed && (
                <>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-2.5">
                      <div className="text-xs text-emerald-700">SKU 종</div>
                      <div className="font-bold text-emerald-900">{cjUploadModal.parsed.length.toLocaleString()}</div>
                    </div>
                    <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-2.5">
                      <div className="text-xs text-emerald-700">합계 수량</div>
                      <div className="font-bold text-emerald-900">{cjUploadModal.parsed.reduce((s, r) => s + r.quantity, 0).toLocaleString()}</div>
                    </div>
                    <div className="bg-blue-50 border border-blue-100 rounded-lg p-2.5">
                      <div className="text-xs text-blue-700">현 스냅샷</div>
                      <div className="font-bold text-blue-900">{cjSnapshot.rows.length.toLocaleString()} 종</div>
                    </div>
                  </div>
                  <div className="text-xs font-semibold text-gray-600 mb-1.5">상위 30건 미리보기</div>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-2 py-1.5 font-medium">SKU</th>
                          <th className="text-left px-2 py-1.5 font-medium">상품명</th>
                          <th className="text-right px-2 py-1.5 font-medium">가용재고</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {cjUploadModal.parsed.slice(0, 30).map((r) => (
                          <tr key={r.skuId}>
                            <td className="px-2 py-1 font-mono">{r.skuId}</td>
                            <td className="px-2 py-1 truncate max-w-[280px]">{r.skuName || '-'}</td>
                            <td className="px-2 py-1 text-right">{r.quantity.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50">
              <p className="text-xs text-gray-500">
                저장하면 기존 CJ 가용재고 스냅샷이 <strong>전체 덮어쓰기</strong> 됩니다.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setCjUploadModal(null)}
                  disabled={cjUploadModal.uploading}
                  className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200"
                >
                  취소
                </button>
                <button
                  onClick={handleCjUploadConfirm}
                  disabled={!cjUploadModal.parsed || cjUploadModal.uploading || readOnly}
                  className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 disabled:bg-gray-300"
                >
                  {cjUploadModal.uploading ? '저장 중...' : `저장 (${cjUploadModal.parsed?.length || 0}종)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 플레이위즈 재고 기반 보완 WO 미리보기 모달 */}
      {playsModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">플레이위즈 재고 기반 보완 WO</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  현재 플레이위즈 재고(수불부 기준) − 진행중 WO 예약분 = 가용. 완결 매칭되는 주문만 별도 WO로 생성.
                </p>
              </div>
              <button onClick={() => setPlaysModal(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-gray-100 flex gap-4 text-sm">
              <div className="flex-1 bg-green-50 border border-green-100 rounded-lg p-2.5">
                <div className="text-xs text-green-700">가능 주문</div>
                <div className="font-bold text-green-900">
                  {playsModal.possibleOrders.length}건 · {playsModal.possibleOrders.reduce((s, p) => s + p.quantity, 0)}개
                </div>
              </div>
              <div className="flex-1 bg-red-50 border border-red-100 rounded-lg p-2.5">
                <div className="text-xs text-red-700">불가 주문 (BOM 불완전)</div>
                <div className="font-bold text-red-900">
                  {playsModal.impossibleOrders.length}건 · {playsModal.impossibleOrders.reduce((s, p) => s + p.quantity, 0)}개
                </div>
              </div>
              <div className="flex-1 bg-blue-50 border border-blue-100 rounded-lg p-2.5">
                <div className="text-xs text-blue-700">차감될 재고 SKU</div>
                <div className="font-bold text-blue-900">{Object.keys(playsModal.consumedBySkuId).length}종</div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3 text-xs space-y-4">
              {playsModal.possibleOrders.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-600 mb-1.5">가능 주문 (상위 50건)</div>
                  <div className="border border-green-200 rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-green-50">
                        <tr>
                          <th className="text-left px-2 py-1.5 font-medium text-green-800">주문번호</th>
                          <th className="text-left px-2 py-1.5 font-medium text-green-800">SKU</th>
                          <th className="text-left px-2 py-1.5 font-medium text-green-800">상품명</th>
                          <th className="text-right px-2 py-1.5 font-medium text-green-800">수량</th>
                          <th className="text-center px-2 py-1.5 font-medium text-green-800">마킹</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-green-100">
                        {playsModal.possibleOrders.slice(0, 50).map((p) => (
                          <tr key={p.orderId}>
                            <td className="px-2 py-1 font-mono">{p.orderNumber}</td>
                            <td className="px-2 py-1 font-mono">{p.skuId}</td>
                            <td className="px-2 py-1 truncate max-w-[240px]">{p.skuName}</td>
                            <td className="px-2 py-1 text-right">{p.quantity}</td>
                            <td className="px-2 py-1 text-center">{p.needsMarking ? '✓' : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {playsModal.possibleOrders.length > 50 && (
                    <div className="text-[11px] text-gray-400 mt-1">… 외 {playsModal.possibleOrders.length - 50}건</div>
                  )}
                </div>
              )}

              {playsModal.impossibleOrders.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-600 mb-1.5">불가 주문 (상위 20건)</div>
                  <div className="border border-red-200 rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-red-50">
                        <tr>
                          <th className="text-left px-2 py-1.5 font-medium text-red-800">주문번호</th>
                          <th className="text-left px-2 py-1.5 font-medium text-red-800">SKU</th>
                          <th className="text-right px-2 py-1.5 font-medium text-red-800">수량</th>
                          <th className="text-left px-2 py-1.5 font-medium text-red-800">부족 구성품</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-100">
                        {playsModal.impossibleOrders.slice(0, 20).map((p) => (
                          <tr key={p.orderId}>
                            <td className="px-2 py-1 font-mono">{p.orderNumber}</td>
                            <td className="px-2 py-1 font-mono">{p.skuId}</td>
                            <td className="px-2 py-1 text-right">{p.quantity}</td>
                            <td className="px-2 py-1 text-red-700">
                              {p.missingComponents.map((m) => `${m.skuId}(${m.available}/${m.needed})`).join(', ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50">
              <p className="text-xs text-gray-500">
                생성 시 <strong>sent_qty = received_qty = ordered_qty</strong>, 이관·입고 단계 자동 완료. 재고 tx는 생성하지 않음.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPlaysModal(null)}
                  className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200"
                >
                  취소
                </button>
                <button
                  onClick={handlePlaysCreate}
                  disabled={readOnly || playsCreating || playsModal.possibleOrders.length === 0}
                  className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-xs font-semibold hover:bg-teal-700 disabled:bg-gray-300"
                >
                  {playsCreating ? '생성 중...' : `확인하여 보완 WO 생성 (${playsModal.possibleOrders.length}건)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
