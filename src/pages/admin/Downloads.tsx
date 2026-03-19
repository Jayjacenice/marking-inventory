import { useEffect, useState, useRef } from 'react';
import { useStaleGuard } from '../../hooks/useStaleGuard';
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
  skuId: string;     // SKU코드 (alphanumeric)
  skuName: string;
  berrizId: string;  // BERRIZ 숫자형 SKU ID
  qty: number;
}

interface StepPreviews {
  step1: { transfer: PreviewItem[]; adj: PreviewItem[] } | null;
  step2: { adj: PreviewItem[] } | null;
  step3: { mAdj: PreviewItem[]; production: PreviewItem[] } | null;
  step4: { mAdj: PreviewItem[]; cj: PreviewItem[] } | null;
}

interface WaveOption {
  value: number | 'all';
  label: string;
  date: string;
  totalQty: number;
}

type StepKey = 'step1' | 'step2' | 'step3' | 'step4';

// ── 헬퍼: 차수별 로그 필터링 ──

function filterLogsByWave(logs: any[], wave: number | 'all'): any[] {
  if (wave === 'all') return logs;
  // wave 필드가 있는 경우 (shipment_confirm, receipt_check)
  const byWaveField = logs.filter((l) => l.summary?.wave === wave);
  if (byWaveField.length > 0) return byWaveField;
  // wave 필드 없는 경우 (marking_work, shipment_out) → 인덱스 기반
  const idx = (wave as number) - 1;
  return idx >= 0 && idx < logs.length ? [logs[idx]] : [];
}

// ── 헬퍼: 로그에서 고유 skuId 수집 ──

function collectUniqueSkuIds(logs: any[], qtyField: string): string[] {
  const ids = new Set<string>();
  for (const log of logs) {
    for (const item of log.summary?.items || []) {
      if ((item[qtyField] || 0) > 0) ids.add(item.skuId);
    }
  }
  return Array.from(ids);
}

// ── 헬퍼: sku 테이블에서 berriz_id 일괄 조회 ──

async function fetchBerrizIds(
  skuIds: string[]
): Promise<Record<string, { berrizId: string; skuName: string }>> {
  if (skuIds.length === 0) return {};
  const { data } = await supabase.from('sku').select('sku_id, sku_name, berriz_id').in('sku_id', skuIds);
  const map: Record<string, { berrizId: string; skuName: string }> = {};
  for (const row of data || []) {
    map[row.sku_id] = { berrizId: row.berriz_id || '', skuName: row.sku_name };
  }
  return map;
}

// ── 헬퍼: BOM 조회 ──

async function fetchBomForSkus(finishedSkuIds: string[]): Promise<any[]> {
  if (finishedSkuIds.length === 0) return [];
  const { data } = await supabase
    .from('bom')
    .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name, berriz_id)')
    .in('finished_sku_id', finishedSkuIds);
  return data || [];
}

// ── 헬퍼: 로그 items → PreviewItem[] 합산 ──

function mergeLogItems(
  logs: any[],
  qtyField: string,
  skuMap: Record<string, { berrizId: string; skuName: string }>
): PreviewItem[] {
  const map: Record<string, PreviewItem> = {};
  for (const log of logs) {
    for (const item of log.summary?.items || []) {
      const qty = item[qtyField] || 0;
      if (qty <= 0) continue;
      const key = item.skuId;
      if (!map[key]) {
        const info = skuMap[key] || { berrizId: '', skuName: item.skuName || key };
        map[key] = { skuId: key, skuName: info.skuName, berrizId: info.berrizId, qty: 0 };
      }
      map[key].qty += qty;
    }
  }
  return Object.values(map);
}

// ── 헬퍼: STEP3 M차감 — BOM 전개 후 합산 ──

function expandBomForMAdj(logs: any[], bomList: any[], qtyField: string): PreviewItem[] {
  const map: Record<string, PreviewItem> = {};
  for (const log of logs) {
    for (const item of log.summary?.items || []) {
      const qty = item[qtyField] || 0;
      if (qty <= 0) continue;
      const boms = bomList.filter((b: any) => b.finished_sku_id === item.skuId);
      for (const bom of boms) {
        const key = bom.component_sku_id;
        if (!map[key]) {
          map[key] = {
            skuId: key,
            skuName: bom.component?.sku_name || key,
            berrizId: bom.component?.berriz_id || '',
            qty: 0,
          };
        }
        map[key].qty += bom.quantity * qty;
      }
    }
  }
  return Object.values(map);
}

// ── 헬퍼: 차수 목록 생성 ──

function buildWaveOptions(logs: any[], qtyField: string): WaveOption[] {
  if (logs.length === 0) return [];
  const options: WaveOption[] = logs.map((log: any, idx: number) => ({
    value: log.summary?.wave || idx + 1,
    label: `${log.summary?.wave || idx + 1}차 (${log.action_date})`,
    date: log.action_date,
    totalQty: (log.summary?.items || []).reduce((s: number, i: any) => s + (i[qtyField] || 0), 0),
  }));
  if (logs.length > 1) {
    options.unshift({
      value: 'all',
      label: `전체 (${logs.length}회 합산)`,
      date: '',
      totalQty: options.reduce((s, o) => s + o.totalQty, 0),
    });
  }
  return options;
}

// ── 컴포넌트 ────────────────────────────────────

export default function Downloads() {
  const isStale = useStaleGuard();
  const [workOrders, setWorkOrders] = useState<WorkOrderOption[]>([]);
  const [selectedWoId, setSelectedWoId] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [warehouses, setWarehouses] = useState<Record<string, any>>({});
  const [previews, setPreviews] = useState<StepPreviews>({
    step1: null, step2: null, step3: null, step4: null,
  });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── 차수별 상태 ──
  const [stepWaves, setStepWaves] = useState<Record<StepKey, WaveOption[]>>({
    step1: [], step2: [], step3: [], step4: [],
  });
  const [selectedWaves, setSelectedWaves] = useState<Record<StepKey, number | 'all'>>({
    step1: 'all', step2: 'all', step3: 'all', step4: 'all',
  });
  const [activityData, setActivityData] = useState<Record<StepKey, any[]>>({
    step1: [], step2: [], step3: [], step4: [],
  });
  const activityLoadedRef = useRef(false);

  useEffect(() => {
    loadWorkOrders();
    loadWarehouses();
  }, []);

  useEffect(() => {
    if (selectedWoId) {
      activityLoadedRef.current = false;
      loadActivityLogs();
    }
  }, [selectedWoId]);

  // activityData 또는 selectedWaves 변경 시 미리보기 재계산
  useEffect(() => {
    if (activityLoadedRef.current) {
      buildPreviewsForWave();
    }
  }, [selectedWaves]);

  // ── 작업지시서 목록 + 창고 로드 ──

  const loadWorkOrders = async () => {
    try {
      const { data, error: err } = await supabase
        .from('work_order')
        .select('id, download_date, status')
        .order('uploaded_at', { ascending: false });
      if (isStale() || err) { if (err) throw err; return; }
      setWorkOrders((data || []) as WorkOrderOption[]);
      if (data && data.length > 0) setSelectedWoId(data[0].id);
    } catch (err) {
      console.error('loadWorkOrders error:', err);
    }
  };

  const loadWarehouses = async () => {
    try {
      const { data, error: err } = await supabase.from('warehouse').select('*');
      if (isStale() || err) { if (err) throw err; return; }
      const map: Record<string, any> = {};
      (data || []).forEach((w: any) => (map[w.name] = w));
      setWarehouses(map);
    } catch (err) {
      console.error('loadWarehouses error:', err);
    }
  };

  // ── activity_log 로드 (작업지시서 선택 시 1회) ──

  const loadActivityLogs = async () => {
    setPreviewLoading(true);
    setError(null);
    setExpandedStep(null);
    try {
      const [shipRes, recRes, markRes, outRes] = await Promise.all([
        supabase.from('activity_log')
          .select('id, action_date, summary, created_at')
          .eq('work_order_id', selectedWoId).eq('action_type', 'shipment_confirm')
          .order('created_at', { ascending: true }),
        supabase.from('activity_log')
          .select('id, action_date, summary, created_at')
          .eq('work_order_id', selectedWoId).eq('action_type', 'receipt_check')
          .order('created_at', { ascending: true }),
        supabase.from('activity_log')
          .select('id, action_date, summary, created_at')
          .eq('work_order_id', selectedWoId).eq('action_type', 'marking_work')
          .order('created_at', { ascending: true }),
        supabase.from('activity_log')
          .select('id, action_date, summary, created_at')
          .eq('work_order_id', selectedWoId).eq('action_type', 'shipment_out')
          .order('created_at', { ascending: true }),
      ]);

      if (isStale()) return;

      const shipLogs = shipRes.data || [];
      const recLogs = recRes.data || [];
      const markLogs = markRes.data || [];
      const outLogs = outRes.data || [];

      const newActivityData = {
        step1: shipLogs,
        step2: recLogs,
        step3: markLogs,
        step4: outLogs,
      };
      setActivityData(newActivityData);

      const newStepWaves = {
        step1: buildWaveOptions(shipLogs, 'sentQty'),
        step2: buildWaveOptions(recLogs, 'actualQty'),
        step3: buildWaveOptions(markLogs, 'completedQty'),
        step4: buildWaveOptions(outLogs, 'shipQty'),
      };
      setStepWaves(newStepWaves);

      // 기본 선택: 차수가 1개면 그 차수, 여러 개면 가장 최근 차수
      const pickDefault = (logs: any[], waves: WaveOption[]): number | 'all' => {
        if (waves.length === 0) return 'all';
        if (logs.length === 1) return waves[0].value === 'all' ? (waves[1]?.value ?? 'all') : waves[0].value;
        // 여러 개면 가장 마지막 차수
        const last = logs[logs.length - 1];
        return last.summary?.wave || logs.length;
      };

      const newSelectedWaves = {
        step1: pickDefault(shipLogs, newStepWaves.step1),
        step2: pickDefault(recLogs, newStepWaves.step2),
        step3: pickDefault(markLogs, newStepWaves.step3),
        step4: pickDefault(outLogs, newStepWaves.step4),
      };
      setSelectedWaves(newSelectedWaves);

      // 직접 buildPreviewsForWave 호출 (state 업데이트 전이라 인자로 전달)
      activityLoadedRef.current = true;
      await buildPreviewsForWaveWith(newActivityData, newSelectedWaves);
    } catch (err: any) {
      setError(`데이터 조회 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── 차수별 미리보기 데이터 구성 ──

  const buildPreviewsForWave = async () => {
    await buildPreviewsForWaveWith(activityData, selectedWaves);
  };

  const buildPreviewsForWaveWith = async (
    data: Record<StepKey, any[]>,
    waves: Record<StepKey, number | 'all'>
  ) => {
    setPreviewLoading(true);
    setError(null);
    try {
      // ── STEP 1: shipment_confirm (BOM 전개 완료 상태) ──
      const s1Logs = filterLogsByWave(data.step1, waves.step1);
      const s1SkuIds = collectUniqueSkuIds(s1Logs, 'sentQty');
      const s1SkuMap = await fetchBerrizIds(s1SkuIds);
      const s1Items = mergeLogItems(s1Logs, 'sentQty', s1SkuMap);

      // ── STEP 2: receipt_check (BOM 전개 완료 상태) ──
      const s2Logs = filterLogsByWave(data.step2, waves.step2);
      const s2SkuIds = collectUniqueSkuIds(s2Logs, 'actualQty');
      const s2SkuMap = await fetchBerrizIds(s2SkuIds);
      const s2Items = mergeLogItems(s2Logs, 'actualQty', s2SkuMap);

      // ── STEP 3: marking_work (finished_sku_id 수준) ──
      const s3Logs = filterLogsByWave(data.step3, waves.step3);
      const s3FinishedIds = collectUniqueSkuIds(s3Logs, 'completedQty');
      // ④ M차감: BOM 전개 필요
      const bomData = await fetchBomForSkus(s3FinishedIds);
      const s3MItems = expandBomForMAdj(s3Logs, bomData, 'completedQty');
      // ⑤ P입고: finished_sku_id 직접 사용
      const s3PSkuMap = await fetchBerrizIds(s3FinishedIds);
      const s3PItems = mergeLogItems(s3Logs, 'completedQty', s3PSkuMap);

      // ── STEP 4: shipment_out (finished_sku_id 수준) ──
      const s4Logs = filterLogsByWave(data.step4, waves.step4);
      const s4SkuIds = collectUniqueSkuIds(s4Logs, 'shipQty');
      const s4SkuMap = await fetchBerrizIds(s4SkuIds);
      const s4Items = mergeLogItems(s4Logs, 'shipQty', s4SkuMap);

      if (isStale()) return;
      setPreviews({
        step1: { transfer: s1Items, adj: s1Items },
        step2: { adj: s2Items },
        step3: { mAdj: s3MItems, production: s3PItems },
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

  const getWaveLabel = (stepKey: StepKey): string => {
    const wave = selectedWaves[stepKey];
    return wave === 'all' ? '전체' : `${wave}차`;
  };

  const getWaveDateOrToday = (stepKey: StepKey): string => {
    const wave = selectedWaves[stepKey];
    if (wave === 'all') return new Date().toISOString().split('T')[0];
    const found = stepWaves[stepKey].find((w) => w.value === wave);
    return found?.date || new Date().toISOString().split('T')[0];
  };

  const handleDownloadStep1 = () => {
    if (!previews.step1 || previews.step1.transfer.length === 0) return;
    setDownloading(true);
    try {
      const offlineWh = warehouses['오프라인샵'];
      const playwithWh = warehouses['플레이위즈'];
      const waveLabel = getWaveLabel('step1');
      const yymmdd = date.slice(2);
      const transferLines: TransferLine[] = previews.step1.transfer.map((p) => ({
        skuId: p.skuId,
        skuName: p.skuName,
        quantity: p.qty,
      }));
      const adjLines: InventoryAdjLine[] = previews.step1.adj.map((p) => ({
        skuId: p.berrizId || p.skuId,
        warehouseId: '305852852048384',
        quantity: p.qty,
        code: 'M' as const,
        reason: 'ETC',
        memo: `${yymmdd} 오프라인 ${waveLabel} 출고분`,
        skuCode: p.skuId,
        skuName: p.skuName,
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
      const waveLabel = getWaveLabel('step2');
      const yymmdd = date.slice(2);
      const adjLines: InventoryAdjLine[] = previews.step2.adj.map((p) => ({
        skuId: p.berrizId || p.skuId,
        warehouseId: '303310368831744',
        quantity: p.qty,
        code: 'P' as const,
        reason: 'ETC',
        memo: `${yymmdd} 플레이위즈 ${waveLabel} 입고분`,
        skuCode: p.skuId,
        skuName: p.skuName,
      }));
      exportInventoryAdjustment(adjLines, date, `제작창고P증가_${waveLabel}`);
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
      const waveLabel = getWaveLabel('step3');
      const waveDate = getWaveDateOrToday('step3');

      if (previews.step3.mAdj.length > 0) {
        const mAdjLines: InventoryAdjLine[] = previews.step3.mAdj.map((p) => ({
          skuId: p.berrizId || p.skuId,
          warehouseId: '303310368831744',
          quantity: p.qty,
          code: 'M' as const,
          reason: 'ETC',
          memo: `마킹 ${waveLabel} 단품 소모`,
          skuCode: p.skuId,
          skuName: p.skuName,
        }));
        exportInventoryAdjustment(mAdjLines, waveDate, `제작창고M차감_단품소모_${waveLabel}`);
      }

      if (previews.step3.production.length > 0) {
        const productionLines: CjReceiptLine[] = previews.step3.production.map((p) => ({
          deliveryWarehouseId: '303310368831744',
          skuId: p.skuId,
          skuName: p.skuName,
          quantity: p.qty,
          receiptType: 'P' as const,
          requestDate: waveDate,
        }));
        exportProductionReceiptRequest(productionLines, waveDate);
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
      const cjWh = warehouses['CJ창고'];
      const waveLabel = getWaveLabel('step4');
      const waveDate = getWaveDateOrToday('step4');

      if (previews.step4.mAdj.length > 0) {
        const mAdjLines: InventoryAdjLine[] = previews.step4.mAdj.map((p) => ({
          skuId: p.berrizId || p.skuId,
          warehouseId: '303310368831744',
          quantity: p.qty,
          code: 'M' as const,
          reason: 'ETC',
          memo: `플레이위즈 ${waveLabel} 출고`,
          skuCode: p.skuId,
          skuName: p.skuName,
        }));
        exportInventoryAdjustment(mAdjLines, waveDate, `플레이위즈M차감_출고_${waveLabel}`);
      }

      if (previews.step4.cj.length > 0) {
        const cjLines: CjReceiptLine[] = previews.step4.cj.map((p) => ({
          deliveryWarehouseId: cjWh?.external_id || cjWh?.id || 'CJ창고',
          skuId: p.skuId,
          skuName: p.skuName,
          quantity: p.qty,
          receiptType: 'G' as const,
          requestDate: waveDate,
        }));
        exportCjReceiptRequest(cjLines, waveDate);
      }
    } catch {
      alert('다운로드 중 오류가 발생했습니다.');
    } finally {
      setDownloading(false);
    }
  };

  // ── 단계별 설정 ──

  const step1Available = selectedWo
    ? ['이관중', '입고확인완료', '마킹중', '마킹완료', '출고완료'].includes(selectedWo.status)
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
      waveKey: 'step1' as StepKey,
      available: step1Available,
      pendingMsg: '오프라인 발송 확인 후 활성화됩니다',
      items: [
        { num: '①', name: '이관지시서 (오프라인→플레이위즈)' },
        { num: '②', name: '재고조정양식 (오프라인샵 M차감)' },
      ],
      onDownload: handleDownloadStep1,
      previewData: previews.step1
        ? [{ label: '이관 / M차감', items: previews.step1.transfer }]
        : null,
      hasData: (previews.step1?.transfer.length || 0) > 0,
    },
    {
      num: 2,
      label: 'STEP 2',
      title: '플레이위즈 입고 확인 후',
      waveKey: 'step2' as StepKey,
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
      waveKey: 'step3' as StepKey,
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
      waveKey: 'step4' as StepKey,
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
          const waves = stepWaves[step.waveKey];
          const currentWave = selectedWaves[step.waveKey];

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
                    {/* 차수 선택 드롭다운 */}
                    {waves.length > 0 && (
                      <div className="mb-3">
                        <label className="block text-xs font-medium text-gray-500 mb-1">차수 선택</label>
                        <div className="relative">
                          <select
                            value={String(currentWave)}
                            onChange={(e) => {
                              const v = e.target.value;
                              setSelectedWaves((prev) => ({
                                ...prev,
                                [step.waveKey]: v === 'all' ? 'all' : Number(v),
                              }));
                            }}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {waves.map((w) => (
                              <option key={String(w.value)} value={String(w.value)}>
                                {w.label} — {w.totalQty.toLocaleString()}개
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={14} className="absolute right-3 top-2.5 text-gray-400 pointer-events-none" />
                        </div>
                      </div>
                    )}

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
