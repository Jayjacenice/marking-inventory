import * as XLSX from 'xlsx';

// ──────────────────────────────────────────────
// 타입 정의
// ──────────────────────────────────────────────

export interface ExcelMatchedItem {
  skuId: string;
  uploadedQty: number;
  matchKey: string; // SKU ID 또는 "SKU_ID::마킹 예정" / "SKU_ID::단순 출고"
}

export interface ExcelParseResult {
  matched: ExcelMatchedItem[];
  unmatched: string[]; // 매칭 실패 식별자 목록
}

export interface ExcelItem {
  skuId: string;
  skuName: string;
  barcode: string | null;
  needsMarking?: boolean; // 마킹 예정 / 단순 출고 구분 (옵셔널: 하위 호환)
}

// ──────────────────────────────────────────────
// matchKey 헬퍼
// ──────────────────────────────────────────────

const MARKING_LABEL = '마킹 예정';
const DIRECT_LABEL = '단순 출고';

export function buildMatchKey(skuId: string, needsMarking?: boolean): string {
  if (needsMarking === undefined) return skuId;
  return `${skuId}::${needsMarking ? MARKING_LABEL : DIRECT_LABEL}`;
}

// ──────────────────────────────────────────────
// 컬럼 자동 탐지 패턴
// ──────────────────────────────────────────────

const SKU_ID_PATTERNS = ['sku_id', 'skuid', 'sku id', 'sku', '품목코드', 'item_id', 'itemid', 'item id'];
const BARCODE_PATTERNS = ['barcode', '바코드', 'bar_code', 'bar code'];
const SKU_NAME_PATTERNS = ['sku_name', 'skuname', 'sku name', 'sku명', '품목명', '상품명', 'name', '이름'];
const QTY_PATTERNS = ['qty', '수량', 'quantity', '개수', '발송수량', '입고수량', 'amount'];
const CATEGORY_PATTERNS = ['구분', 'category', 'type', '마킹구분'];

function normalizeHeader(header: unknown): string {
  return String(header ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function findColumnIndex(headers: unknown[], patterns: string[]): number {
  return headers.findIndex((h) => patterns.includes(normalizeHeader(h)));
}

// ──────────────────────────────────────────────
// 엑셀 파싱 — SKU ID / 바코드 / SKU명 + 구분 컬럼으로 매칭
// ──────────────────────────────────────────────

export function parseQtyExcel(file: File, items: ExcelItem[]): Promise<ExcelParseResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

        if (rows.length < 2) {
          resolve({ matched: [], unmatched: [] });
          return;
        }

        const headers = rows[0] as unknown[];

        const skuIdCol = findColumnIndex(headers, SKU_ID_PATTERNS);
        const barcodeCol = findColumnIndex(headers, BARCODE_PATTERNS);
        const skuNameCol = findColumnIndex(headers, SKU_NAME_PATTERNS);
        const qtyCol = findColumnIndex(headers, QTY_PATTERNS);
        const categoryCol = findColumnIndex(headers, CATEGORY_PATTERNS);

        if (qtyCol === -1) {
          reject(new Error('수량 컬럼을 찾을 수 없습니다. 헤더에 "수량" 또는 "qty"를 포함해주세요.'));
          return;
        }
        if (skuIdCol === -1 && barcodeCol === -1 && skuNameCol === -1) {
          reject(new Error('식별자 컬럼(SKU ID / 바코드 / SKU명)을 찾을 수 없습니다.'));
          return;
        }

        // items에 needsMarking 정보가 있는지 확인 (복합 매칭 모드)
        const hasCategory = items.some((i) => i.needsMarking !== undefined);

        // 룩업 맵 구성
        // 복합 키 모드: "sku_lower::마킹 예정" / "sku_lower::단순 출고"
        // 단순 모드: "sku_lower"
        const skuIdMap = new Map<string, { skuId: string; matchKey: string }>();
        const barcodeMap = new Map<string, { skuId: string; matchKey: string }>();
        const skuNameMap = new Map<string, { skuId: string; matchKey: string }>();

        for (const item of items) {
          const matchKey = buildMatchKey(item.skuId, hasCategory ? item.needsMarking : undefined);

          if (hasCategory && item.needsMarking !== undefined) {
            // 복합 키: "sku_lower::마킹 예정"
            const catLabel = item.needsMarking ? MARKING_LABEL : DIRECT_LABEL;
            const compositeKey = `${item.skuId.toLowerCase()}::${catLabel}`;
            skuIdMap.set(compositeKey, { skuId: item.skuId, matchKey });
            if (item.barcode) barcodeMap.set(`${item.barcode.toLowerCase()}::${catLabel}`, { skuId: item.skuId, matchKey });
            skuNameMap.set(`${item.skuName.toLowerCase()}::${catLabel}`, { skuId: item.skuId, matchKey });
          }
          // 단순 키도 항상 등록 (폴백 + 하위 호환)
          if (!skuIdMap.has(item.skuId.toLowerCase())) {
            skuIdMap.set(item.skuId.toLowerCase(), { skuId: item.skuId, matchKey });
          }
          if (item.barcode && !barcodeMap.has(item.barcode.toLowerCase())) {
            barcodeMap.set(item.barcode.toLowerCase(), { skuId: item.skuId, matchKey });
          }
          if (!skuNameMap.has(item.skuName.toLowerCase())) {
            skuNameMap.set(item.skuName.toLowerCase(), { skuId: item.skuId, matchKey });
          }
        }

        const matched: ExcelMatchedItem[] = [];
        const unmatched: string[] = [];

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i] as unknown[];

          // 수량 파싱
          const rawQty = row[qtyCol];
          if (rawQty == null || rawQty === '') continue;
          const qty = Number(rawQty);
          if (isNaN(qty)) continue;

          // 구분 값 추출
          const catValue = categoryCol !== -1 && row[categoryCol] != null
            ? String(row[categoryCol]).trim()
            : '';

          let matchResult: { skuId: string; matchKey: string } | undefined;
          let identifier = '';

          // 1순위: SKU ID (+ 구분)
          if (skuIdCol !== -1 && row[skuIdCol] != null) {
            const val = String(row[skuIdCol]).trim().toLowerCase();
            identifier = val;
            // 복합 키 시도
            if (catValue) matchResult = skuIdMap.get(`${val}::${catValue}`);
            // 폴백: 단순 키
            if (!matchResult) matchResult = skuIdMap.get(val);
          }

          // 2순위: 바코드 (+ 구분)
          if (!matchResult && barcodeCol !== -1 && row[barcodeCol] != null) {
            const val = String(row[barcodeCol]).trim().toLowerCase();
            if (!identifier) identifier = val;
            if (catValue) matchResult = barcodeMap.get(`${val}::${catValue}`);
            if (!matchResult) matchResult = barcodeMap.get(val);
          }

          // 3순위: SKU명 (+ 구분)
          if (!matchResult && skuNameCol !== -1 && row[skuNameCol] != null) {
            const val = String(row[skuNameCol]).trim().toLowerCase();
            if (!identifier) identifier = val;
            if (catValue) matchResult = skuNameMap.get(`${val}::${catValue}`);
            if (!matchResult) matchResult = skuNameMap.get(val);
          }

          if (matchResult) {
            matched.push({ skuId: matchResult.skuId, uploadedQty: Math.max(0, qty), matchKey: matchResult.matchKey });
          } else if (identifier) {
            unmatched.push(identifier);
          }
        }

        resolve({ matched, unmatched });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '알 수 없는 오류';
        reject(new Error(`엑셀 파싱 실패: ${msg}`));
      }
    };

    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsArrayBuffer(file);
  });
}

// ──────────────────────────────────────────────
// 양식 다운로드 — 현재 품목 목록 기반 (구분 컬럼 옵션)
// ──────────────────────────────────────────────

export function generateTemplate(
  items: { skuId: string; skuName: string; barcode?: string | null; qty: number; needsMarking?: boolean }[],
  filename: string
): void {
  const hasCategory = items.some((i) => i.needsMarking !== undefined);

  // 정렬: 1) 구분 (마킹 예정 → 단순 출고) 2) 상품 구분 (유니폼 UN → 마킹 MK) 3) 상품명 오름차순
  const sorted = [...items].sort((a, b) => {
    // 1순위: 마킹 예정 먼저 (needsMarking=true → 0, false → 1, undefined → 2)
    const catA = a.needsMarking === true ? 0 : a.needsMarking === false ? 1 : 2;
    const catB = b.needsMarking === true ? 0 : b.needsMarking === false ? 1 : 2;
    if (catA !== catB) return catA - catB;
    // 2순위: 유니폼(UN) 먼저, 마킹(MK) 나중
    const isUniformA = a.skuId.includes('UN-') ? 0 : 1;
    const isUniformB = b.skuId.includes('UN-') ? 0 : 1;
    if (isUniformA !== isUniformB) return isUniformA - isUniformB;
    // 3순위: 상품명 오름차순
    return a.skuName.localeCompare(b.skuName, 'ko');
  });

  const wsData = hasCategory
    ? [
        ['구분', 'SKU ID', 'SKU명', '바코드', '수량'],
        ...sorted.map((item) => [
          item.needsMarking !== undefined ? (item.needsMarking ? MARKING_LABEL : DIRECT_LABEL) : '',
          item.skuId,
          item.skuName,
          item.barcode ?? '',
          item.qty,
        ]),
      ]
    : [
        ['SKU ID', 'SKU명', '바코드', '수량'],
        ...sorted.map((item) => [item.skuId, item.skuName, item.barcode ?? '', item.qty]),
      ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = hasCategory
    ? [{ wch: 12 }, { wch: 20 }, { wch: 30 }, { wch: 16 }, { wch: 10 }]
    : [{ wch: 20 }, { wch: 30 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '수량입력');
  XLSX.writeFile(wb, filename);
}
