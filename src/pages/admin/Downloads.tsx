import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  exportAllForms,
  exportInventoryAdjustment,
  exportCjReceiptRequest,
  exportProductionReceiptRequest,
  type TransferLine,
  type InventoryAdjLine,
  type CjReceiptLine,
} from '../../lib/excelExporter';
import { Download, Lock, CheckCircle, ChevronDown, ChevronUp, AlertTriangle, Loader2 } from 'lucide-react';

// ── 인터페이스 ──────────────────────────────────

interface WorkOrderOption {
  id: string;
  download_date: string;
  status: string;
}

interface PreviewItem {
  skuId: string;
  skuName: string;
  qty: number;
}

interface StepPreviews {
  step1: { transfer: PreviewItem[]; adj: PreviewItem[] } | null;
  step2: { adj: PreviewItem[] } | null;
  step3: { mAdj: PreviewItem[]; production: PreviewItem[] } | null;
  step4: { mAdj: PreviewItem[]; cj: PreviewItem[] } | null;
}

// ── 컴포넌트 ────────────────────────────────────

export default function Downloads() {
  const [workOrders, setWorkOrders] = useState<WorkOrderOption[]>([]);
  const [selectedWoId, setSelectedWoId] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [warehouses, setWarehouses] = useState<Record<string, any>>({});
  const [previews, setPreviews] = useState<StepPreviews>({
    step1: null,
    step2: null,
    step3: null,
    step4: null,
  });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadWorkOrders();
    loadWarehouses();
  }, []);

  useEffect(() => {
    if (selectedWoId) loadPreviews();
  }, [selectedWoId]);

  // ── 작업지시서 목록 + 창고 로드 ──

  const loadWorkOrders = async () => {
    try {
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .order('uploaded_at', { ascending: false });
      if (err) throw err;
      setWorkOrders((data || []) as WorkOrderOption[]);
      if (data && data.length > 0) setSelectedWoId(data[0].id);
    } catch (err) {
      console.error('loadWorkOrders error:', err);
    }
  };

  const loadWarehouses = async () => {
    try {
      const { data, error: err } = await supabase.from('warehouse').select('*');
      if (err) throw err;
      const map: Record<string, any> = {};
      (data || []).forEach((w: any) => (map[w.name] = w));
      setWarehouses(map);
    } catch (err) {
      console.error('loadWarehouses error:', err);
    }
  };

  // ── 미리보기 데이터 로드 ──

  const loadPreviews = async () => {
    setPreviewLoading(true);
    setError(null);
    setExpandedStep(null);
    try {
      // 1. 전체 라인 조회
      const { data: lines, error: linesErr } = await supabase
        .from('work_order_line')
        .select(
          'id, finished_sku_id, ordered_qty, sent_qty, received_qty, marked_qty, needs_marking, finished_sku:sku!work_order_line_finished_sku_id_fkey(sku_id, sku_name)'
        )
        .eq('work_order_id', selectedWoId);
      if (linesErr) throw linesErr;
      const lineList = (lines || []) as any[];

      // 2. BOM 조회 (마킹 SKU만 필터링 — 1,000행 제한 우회)
      const markingSkuIds = lineList.filter((l) => l.needs_marking).map((l) => l.finished_sku_id);
      let bomList: any[] = [];
      if (markingSkuIds.length > 0) {
        const { data: bomData, error: bomErr } = await supabase
          .from('bom')
          .select(
            'finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name)'
          )
          .in('finished_sku_id', markingSkuIds);
        if (bomErr) throw bomErr;
        bomList = (bomData || []) as any[];
      }

      // 3. daily_marking 조회 (2단계 쿼리 — 임베디드 필터 버그 수정)
      const lineIds = lineList.map((l) => l.id);
      let markingList: any[] = [];
      if (lineIds.length > 0) {
        const { data: markings, error: markErr } = await supabase
          .from('daily_marking')
          .select('work_order_line_id, completed_qty')
          .in('work_order_line_id', lineIds);
        if (markErr) throw markErr;
        markingList = (markings || []) as any[];
      }

      // daily_marking 라인별 합산
      const markingTotals: Record<string, number> = {};
      for (const m of markingList) {
        markingTotals[m.work_order_line_id] =
          (markingTotals[m.work_order_line_id] || 0) + m.completed_qty;
      }

      // ── STEP 1: 이관지시서 + 오프라인 M차감 ──
      const s1Map: Record<string, PreviewItem> = {};
      for (const line of lineList) {
        const qty = line.sent_qty > 0 ? line.sent_qty : line.ordered_qty;
        if (qty <= 0) continue;
        if (line.needs_marking) {
          const boms = bomList.filter((b) => b.finished_sku_id === line.finished_sku_id);
          for (const bom of boms) {
            const key = bom.component_sku_id;
            if (!s1Map[key])
              s1Map[key] = { skuId: key, skuName: bom.component?.sku_name || key, qty: 0 };
            s1Map[key].qty += bom.quantity * qty;
          }
        } else {
          const key = line.finished_sku_id;
          if (!s1Map[key])
            s1Map[key] = {
              skuId: key,
              skuName: line.finished_sku?.sku_name || key,
              qty: 0,
            };
          s1Map[key].qty += qty;
        }
      }
      const s1Items = Object.values(s1Map);

      // ── STEP 2: 제작창고 P증가 (마킹 BOM + 단품 포함) ──
      const s2Map: Record<string, PreviewItem> = {};
      for (const line of lineList) {
        const qty = line.received_qty;
        if (!qty || qty <= 0) continue;
        if (line.needs_marking) {
          const boms = bomList.filter((b) => b.finished_sku_id === line.finished_sku_id);
          for (const bom of boms) {
            const key = bom.component_sku_id;
            if (!s2Map[key])
              s2Map[key] = { skuId: key, skuName: bom.component?.sku_name || key, qty: 0 };
            s2Map[key].qty += bom.quantity * qty;
          }
        } else {
          const key = line.finished_sku_id;
          if (!s2Map[key])
            s2Map[key] = {
              skuId: key,
              skuName: line.finished_sku?.sku_name || key,
              qty: 0,
            };
          s2Map[key].qty += qty;
        }
      }
      const s2Items = Object.values(s2Map);

      // ── STEP 3: 완성품 제작 (단품 M차감 + 생산입고) ──
      const s3MMap: Record<string, PreviewItem> = {};
      const s3PMap: Record<string, PreviewItem> = {};
      for (const line of lineList) {
        if (!line.needs_marking) continue;
        const totalMarked = markingTotals[line.id] || 0;
        if (totalMarked <= 0) continue;

        // M차감: BOM 전개 (단품 소모)
        const boms = bomList.filter((b) => b.finished_sku_id === line.finished_sku_id);
        for (const bom of boms) {
          const key = bom.component_sku_id;
          if (!s3MMap[key])
            s3MMap[key] = { skuId: key, skuName: bom.component?.sku_name || key, qty: 0 };
          s3MMap[key].qty += bom.quantity * totalMarked;
        }

        // 생산입고: 완성품 (P타입)
        const key = line.finished_sku_id;
        if (!s3PMap[key])
          s3PMap[key] = { skuId: key, skuName: line.finished_sku?.sku_name || key, qty: 0 };
        s3PMap[key].qty += totalMarked;
      }

      // ── STEP 4: 물류센터 출고 (플레이위즈 M차감 + CJ G입고) ──
      const s4Map: Record<string, PreviewItem> = {};
      for (const line of lineList) {
        if (line.needs_marking) {
          const totalMarked = markingTotals[line.id] || 0;
          if (totalMarked <= 0) continue;
          const key = line.finished_sku_id;
          if (!s4Map[key])
            s4Map[key] = { skuId: key, skuName: line.finished_sku?.sku_name || key, qty: 0 };
          s4Map[key].qty += totalMarked;
        } else {
          const qty = line.marked_qty > 0 ? line.marked_qty : 0;
          if (qty <= 0) continue;
          const key = line.finished_sku_id;
          if (!s4Map[key])
            s4Map[key] = { skuId: key, skuName: line.finished_sku?.sku_name || key, qty: 0 };
          s4Map[key].qty += qty;
        }
      }
      const s4Items = Object.values(s4Map);

      setPreviews({
        step1: { transfer: s1Items, adj: s1Items },
        step2: { adj: s2Items },
        step3: { mAdj: Object.values(s3MMap), production: Object.values(s3PMap) },
        step4: { mAdj: s4Items, cj: s4Items },
      });
    } catch (err: any) {
      setError(`데이터 조회 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── 다운로드 핸들러 ──

  const selectedWo = workOrders.find((w) => w.id === selectedWoId);
  const date = selectedWo?.download_date || new Date().toISOString().split('T')[0];

  const handleDownloadStep1 = () => {
    if (!previews.step1 || previews.step1.transfer.length === 0) return;
    setDownloading(true);
    try {
      const offlineWh = warehouses['오프라인샵'];
      const playwithWh = warehouses['플레이위즈'];
      const transferLines: TransferLine[] = previews.step1.transfer.map((p) => ({
        skuId: p.skuId,
        skuName: p.skuName,
        quantity: p.qty,
      }));
      const adjLines: InventoryAdjLine[] = previews.step1.adj.map((p) => ({
        warehouseId: offlineWh?.external_id || offlineWh?.id || '오프라인샵',
        skuId: p.skuId,
        skuName: p.skuName,
        quantity: p.qty,
        code: 'M' as const,
        reason: 'ETC',
      }));
      exportAllForms({
        transferLines,
        offlineAdjLines: adjLines,
        date,
        fromWarehouseName: offlineWh?.name || '오프라인샵',
        toWarehouseName: playwithWh?.name || '플레이위즈',
      });
    } catch {
      alert('다운로드 중 오류가 발생했습니다.');
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadStep2 = () => {
    if (!previews.step2 || previews.step2.adj.length === 0) return;
    setDownloading(true);
    try {
      const playwithWh = warehouses['플레이위즈'];
      const adjLines: InventoryAdjLine[] = previews.step2.adj.map((p) => ({
        warehouseId: playwithWh?.external_id || playwithWh?.id || '플레이위즈',
        skuId: p.skuId,
        skuName: p.skuName,
        quantity: p.qty,
        code: 'P' as const,
        reason: 'ETC',
      }));
      exportInventoryAdjustment(adjLines, date, '제작창고P증가');
    } catch {
      alert('다운로드 중 오류가 발생했습니다.');
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadStep3 = () => {
    if (!previews.step3) return;
    setDownloading(true);
    try {
      const playwithWh = warehouses['플레이위즈'];
      const cjWh = warehouses['CJ창고'];
      const today = new Date().toISOString().split('T')[0];

      if (previews.step3.mAdj.length > 0) {
        const mAdjLines: InventoryAdjLine[] = previews.step3.mAdj.map((p) => ({
          warehouseId: playwithWh?.external_id || playwithWh?.id || '플레이위즈',
          skuId: p.skuId,
          skuName: p.skuName,
          quantity: p.qty,
          code: 'M' as const,
          reason: 'ETC',
        }));
        exportInventoryAdjustment(mAdjLines, today, '제작창고M차감_단품소모');
      }

      if (previews.step3.production.length > 0) {
        const productionLines: CjReceiptLine[] = previews.step3.production.map((p) => ({
          deliveryWarehouseId: cjWh?.external_id || cjWh?.id || 'CJ창고',
          skuId: p.skuId,
          skuName: p.skuName,
          quantity: p.qty,
          receiptType: 'P' as const,
          requestDate: today,
        }));
        exportProductionReceiptRequest(productionLines, today);
      }
    } catch {
      alert('다운로드 중 오류가 발생했습니다.');
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadStep4 = () => {
    if (!previews.step4) return;
    setDownloading(true);
    try {
      const playwithWh = warehouses['플레이위즈'];
      const cjWh = warehouses['CJ창고'];
      const today = new Date().toISOString().split('T')[0];

      if (previews.step4.mAdj.length > 0) {
        const mAdjLines: InventoryAdjLine[] = previews.step4.mAdj.map((p) => ({
          warehouseId: playwithWh?.external_id || playwithWh?.id || '플레이위즈',
          skuId: p.skuId,
          skuName: p.skuName,
          quantity: p.qty,
          code: 'M' as const,
          reason: 'ETC',
        }));
        exportInventoryAdjustment(mAdjLines, today, '플레이위즈M차감_출고');
      }

      if (previews.step4.cj.length > 0) {
        const cjLines: CjReceiptLine[] = previews.step4.cj.map((p) => ({
          deliveryWarehouseId: cjWh?.external_id || cjWh?.id || 'CJ창고',
          skuId: p.skuId,
          skuName: p.skuName,
          quantity: p.qty,
          receiptType: 'G' as const,
          requestDate: today,
        }));
        exportCjReceiptRequest(cjLines, today);
      }
    } catch {
      alert('다운로드 중 오류가 발생했습니다.');
    } finally {
      setDownloading(false);
    }
  };

  // ── 단계별 설정 ──

  const step1Available = selectedWo
    ? ['이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료', '출고완료'].includes(selectedWo.status)
    : false;
  const step2Available = selectedWo
    ? ['입고확인완료', '마킹중', '마킹완료', '출고완료'].includes(selectedWo.status)
    : false;
  const step3Available = selectedWo
    ? ['마킹중', '마킹완료', '출고완료'].includes(selectedWo.status)
    : false;
  const step4Available = selectedWo
    ? ['마킹완료', '출고완료'].includes(selectedWo.status)
    : false;

  const steps = [
    {
      num: 1,
      label: 'STEP 1',
      title: '오프라인 발송 확인 후',
      available: step1Available,
      pendingMsg: '작업지시서 업로드 후 활성화됩니다',
      items: [
        { num: '①', name: '이관지시서 (오프라인→플레이위즈)' },
        { num: '②', name: '재고조정양식 (오프라인샵 M차감)' },
      ],
      onDownload: handleDownloadStep1,
      previewData: previews.step1
        ? [
            { label: '이관 / M차감', items: previews.step1.transfer },
          ]
        : null,
      hasData: (previews.step1?.transfer.length || 0) > 0,
    },
    {
      num: 2,
      label: 'STEP 2',
      title: '플레이위즈 입고 확인 후',
      available: step2Available,
      pendingMsg: '플레이위즈 입고 확인 후 활성화됩니다',
      items: [{ num: '③', name: '재고조정양식 (제작창고 P증가)' }],
      onDownload: handleDownloadStep2,
      previewData: previews.step2
        ? [{ label: 'P증가 (마킹 BOM + 단품)', items: previews.step2.adj }]
        : null,
      hasData: (previews.step2?.adj.length || 0) > 0,
    },
    {
      num: 3,
      label: 'STEP 3',
      title: '마킹 완료 — 완성품 제작 반영',
      available: step3Available,
      pendingMsg: '마킹 작업 시작 후 활성화됩니다',
      items: [
        { num: '④', name: '재고조정양식 (제작창고 M차감 — 단품 소모)' },
        { num: '⑤', name: '생산입고요청양식 (P타입 — 완성품 생성)' },
      ],
      onDownload: handleDownloadStep3,
      previewData: previews.step3
        ? [
            { label: '④ 단품 소모 (M차감)', items: previews.step3.mAdj },
            { label: '⑤ 완성품 생산입고 (P타입)', items: previews.step3.production },
          ]
        : null,
      hasData: (previews.step3?.mAdj.length || 0) > 0 || (previews.step3?.production.length || 0) > 0,
    },
    {
      num: 4,
      label: 'STEP 4',
      title: '물류센터 출고 — CJ 입고 요청',
      available: step4Available,
      pendingMsg: '마킹 완료 후 활성화됩니다',
      items: [
        { num: '⑥', name: '재고조정양식 (플레이위즈 M차감 — 출고)' },
        { num: '⑦', name: 'CJ창고 입고요청양식 (G타입)' },
      ],
      onDownload: handleDownloadStep4,
      previewData: previews.step4
        ? [
            { label: '⑥ 플레이위즈 M차감 (출고)', items: previews.step4.mAdj },
            { label: '⑦ CJ창고 G타입 입고', items: previews.step4.cj },
          ]
        : null,
      hasData: (previews.step4?.mAdj.length || 0) > 0 || (previews.step4?.cj.length || 0) > 0,
    },
  ];

  // ── 미리보기 렌더링 ──

  const renderPreviewSection = (
    sections: { label: string; items: PreviewItem[] }[]
  ) => (
    <div className="space-y-3 mt-3">
      {sections.map((section) => (
        <div key={section.label} className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs font-medium text-gray-500 mb-2">{section.label}</p>
          {section.items.length === 0 ? (
            <p className="text-xs text-gray-400">데이터 없음</p>
          ) : (
            <>
              <div className="space-y-1">
                {section.items.map((item) => (
                  <div key={item.skuId} className="flex justify-between text-sm">
                    <span className="text-gray-700 truncate mr-2">{item.skuName}</span>
                    <span className="text-gray-900 font-medium flex-shrink-0">
                      {item.qty.toLocaleString()}개
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between text-sm">
                <span className="text-gray-500">총 {section.items.length}종</span>
                <span className="font-bold text-gray-900">
                  {section.items.reduce((s, i) => s + i.qty, 0).toLocaleString()}개
                </span>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );

  // ── 렌더링 ──

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-xl font-bold text-gray-900">BERRIZ 업로드용 양식 다운로드</h2>

      {/* 에러 */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* 작업지시서 선택 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">작업지시서 선택</label>
        <div className="relative">
          <select
            value={selectedWoId}
            onChange={(e) => setSelectedWoId(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {workOrders.map((wo) => (
              <option key={wo.id} value={wo.id}>
                {wo.download_date} — {wo.status}
              </option>
            ))}
          </select>
          <ChevronDown size={16} className="absolute right-3 top-3 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* 로딩 */}
      {previewLoading && (
        <div className="flex items-center justify-center py-8 text-gray-400 gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">데이터 조회 중...</span>
        </div>
      )}

      {/* 단계별 다운로드 */}
      {!previewLoading &&
        steps.map((step) => {
          const isExpanded = expandedStep === step.num;
          const totalItems = step.previewData
            ? step.previewData.reduce((s, sec) => s + sec.items.length, 0)
            : 0;
          const totalQty = step.previewData
            ? step.previewData.reduce(
                (s, sec) => s + sec.items.reduce((ss, i) => ss + i.qty, 0),
                0
              )
            : 0;

          return (
            <div
              key={step.label}
              className={`bg-white rounded-xl shadow-sm border overflow-hidden ${
                step.available ? 'border-gray-100' : 'border-gray-100 opacity-70'
              }`}
            >
              {/* 헤더 */}
              <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">
                    {step.label}
                  </span>
                  <h3 className="font-medium text-gray-900 mt-0.5">{step.title}</h3>
                </div>
                <div className="flex items-center gap-2">
                  {step.available && step.hasData && (
                    <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                      {totalItems}종 {totalQty.toLocaleString()}개
                    </span>
                  )}
                  {step.available ? (
                    <CheckCircle size={18} className="text-green-500" />
                  ) : (
                    <Lock size={18} className="text-gray-300" />
                  )}
                </div>
              </div>

              {/* 본문 */}
              <div className="px-5 py-4">
                <ul className="space-y-1.5 mb-4">
                  {step.items.map((item) => (
                    <li key={item.num} className="flex items-center gap-2 text-sm text-gray-700">
                      <span className="text-blue-600 font-medium">{item.num}</span>
                      {item.name}
                    </li>
                  ))}
                </ul>

                {step.available ? (
                  <>
                    {/* 미리보기 토글 */}
                    {step.previewData && (
                      <button
                        onClick={() => setExpandedStep(isExpanded ? null : step.num)}
                        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3 transition-colors"
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {isExpanded ? '미리보기 닫기' : '미리보기'}
                      </button>
                    )}

                    {/* 미리보기 내용 */}
                    {isExpanded && step.previewData && renderPreviewSection(step.previewData)}

                    {/* 데이터 없음 경고 */}
                    {step.available && !step.hasData && (
                      <p className="text-sm text-amber-600 flex items-center gap-1.5 mb-3">
                        <AlertTriangle size={14} />
                        실적 데이터가 없습니다
                      </p>
                    )}

                    {/* 다운로드 버튼 */}
                    <button
                      onClick={step.onDownload}
                      disabled={downloading || !step.hasData}
                      className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
                    >
                      <Download size={16} />
                      {step.num === 1 ? '묶음 다운로드 (.xlsx)' : '다운로드'}
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 flex items-center gap-1.5">
                    <Lock size={14} />
                    {step.pendingMsg}
                  </p>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}
