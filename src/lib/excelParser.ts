import * as XLSX from 'xlsx';

export type ProgressCallback = (step: { current: number; total: number; step: string }) => void;

export interface ParsedWorkOrder {
  downloadDate: string;
  lines: RawOrderLine[];
  markingSkuCodes: string[]; // "유니폼 제작 필요" 시트의 완제품 SKU코드 목록
}

export interface RawOrderLine {
  bizPartnerId: string;
  deliveryId: string;
  manufacturerId: string;
  productName: string;
  productId: string;
  option1: string;
  option2: string;
  option3: string;
  skuName: string;
  skuCode: string;
  barcode: string;
  skuId: string;
  quantity: number;
}

/**
 * BERRIZ 작업지시서 엑셀 파싱 (출고수량 시트 기준)
 */
export function parseWorkOrderExcel(file: File, onProgress?: ProgressCallback): Promise<ParsedWorkOrder> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        onProgress?.({ current: 1, total: 3, step: '엑셀 파일 읽는 중...' });
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        // "출고수량" 시트 찾기
        const sheetName =
          workbook.SheetNames.find((n) => n.includes('출고수량')) ||
          workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: '',
        });

        if (rows.length < 2) {
          reject(new Error('출고수량 시트에 데이터가 없습니다.'));
          return;
        }

        // 파일명에서 날짜 추출 (WorkOrder_YYYYMMDD-YYYYMMDD_YYYYMMDDHHII.xlsx)
        const downloadDate = new Date().toISOString().split('T')[0];

        onProgress?.({ current: 2, total: 3, step: `출고수량 파싱 중... (${rows.length - 1}행)` });
        const lines: RawOrderLine[] = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row[11] || !row[12]) continue; // SKU ID나 수량 없으면 스킵
          lines.push({
            bizPartnerId: String(row[0] || ''),
            deliveryId: String(row[1] || ''),
            manufacturerId: String(row[2] || ''),
            productName: String(row[3] || ''),
            productId: String(row[4] || ''),
            option1: String(row[5] || ''),
            option2: String(row[6] || ''),
            option3: String(row[7] || ''),
            skuName: String(row[8] || ''),
            skuCode: String(row[9] || ''),
            barcode: String(row[10] || ''),
            skuId: String(row[9] || ''),   // SKU 코드 (alphanumeric, BOM과 매핑용)
            quantity: Number(row[12]) || 0,
          });
        }

        // "유니폼 제작 필요" 시트에서 마킹 필요 SKU코드 추출
        onProgress?.({ current: 3, total: 3, step: '마킹 필요 항목 분류 중...' });
        const markingSkuCodes: string[] = [];
        const markingSheetName = workbook.SheetNames.find((n) => n.includes('유니폼 제작 필요'));
        if (markingSheetName) {
          const markingSheet = workbook.Sheets[markingSheetName];
          const markingRows: string[][] = XLSX.utils.sheet_to_json(markingSheet, {
            header: 1,
            defval: '',
          });
          for (let i = 1; i < markingRows.length; i++) {
            const code = String(markingRows[i][1] || '').trim();
            if (code) markingSkuCodes.push(code);
          }
        }

        resolve({ downloadDate, lines, markingSkuCodes });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export interface StockRow {
  skuId: string;
  skuName: string;
  warehouseName: string; // 매핑 후 시스템 창고명 ('오프라인샵' | '플레이위즈' | 'CJ창고')
  qty: number;           // 가용재고 (>0만 포함)
}

const WAREHOUSE_MAP: Record<string, string> = {
  '라이온즈_오프라인매장': '오프라인샵',
  '라이온즈_마킹센터(플레이위즈)': '플레이위즈',
  'CJ 대구 창고': 'CJ창고',
};

/**
 * BERRIZ 재고현황 엑셀 파싱 (stock_status_YYYYMMDD.xlsx)
 * C열(index 2): SKU ID, E열(index 4): SKU명, K열(index 10): 창고, O열(index 14): 가용재고
 * Q1→B: 가용재고 0 스킵 / Q2→B: 저장 시 해당 창고 재고 전체 초기화 후 upsert
 */
export function parseStockExcel(file: File, onProgress?: ProgressCallback): Promise<StockRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        onProgress?.({ current: 1, total: 2, step: '엑셀 파일 읽는 중...' });
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetName =
          workbook.SheetNames.find((n) => n.includes('재고')) || workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        if (rows.length < 2) {
          reject(new Error('재고 현황 시트에 데이터가 없습니다.'));
          return;
        }

        onProgress?.({ current: 2, total: 2, step: `재고 데이터 파싱 중... (${rows.length - 1}행)` });

        const result: StockRow[] = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const skuId = String(row[2] || '').trim();         // C열: SKU ID
          const skuName = String(row[4] || '').trim();       // E열: SKU명
          const warehouseRaw = String(row[10] || '').trim(); // K열: 창고
          const qty = Number(row[14]) || 0;                  // O열: 가용재고

          if (!skuId || !warehouseRaw) continue;

          const warehouseName = WAREHOUSE_MAP[warehouseRaw];
          if (!warehouseName) continue; // 매핑 없으면 스킵

          if (qty <= 0) continue; // Q1→B: 가용재고 0 스킵

          result.push({ skuId, skuName, warehouseName, qty });
        }

        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export interface RawBomRow {
  finishedSkuId: string;
  finishedSkuName: string;
  componentSkuId: string;
  componentSkuName: string;
  quantity: number;
}

/**
 * 수동 BOM 엑셀 파싱 (5컬럼 플랫 형식)
 * 컬럼 순서: 완제품 SKU ID | 완제품 SKU명 | 단품 SKU ID | 단품 SKU명 | 수량
 */
export function parseBomExcel(file: File, onProgress?: ProgressCallback): Promise<RawBomRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        onProgress?.({ current: 1, total: 2, step: '엑셀 파일 읽는 중...' });
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: '',
        });

        onProgress?.({ current: 2, total: 2, step: 'BOM 데이터 추출 중...' });
        const result: RawBomRow[] = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row[0] || !row[2]) continue;
          result.push({
            finishedSkuId: String(row[0]),
            finishedSkuName: String(row[1] || ''),
            componentSkuId: String(row[2]),
            componentSkuName: String(row[3] || ''),
            quantity: Number(row[4]) || 1,
          });
        }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * BERRIZ SKU 업로드 양식 BOM 파싱
 * 컬럼[4]  SKU명, 컬럼[5] SKU코드(완제품), 컬럼[17] 구성유형, 컬럼[18] BOM구성("코드:수량,코드:수량")
 * BOM구성 셀 하나를 개별 (완제품→단품) 쌍으로 분해
 */
export function parseBerrizBomExcel(file: File, onProgress?: ProgressCallback): Promise<RawBomRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        onProgress?.({ current: 1, total: 2, step: '엑셀 파일 읽는 중...' });
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: '',
        });

        if (rows.length < 2) {
          reject(new Error('데이터가 없습니다.'));
          return;
        }

        // 단품 코드 → 이름 추론 (코드 패턴 기반)
        // 26UN-... → 유니폼단품, 26MK-... → 마킹단품
        const getComponentName = (code: string): string => {
          if (code.includes('-MK-') || code.startsWith('26MK-')) return `마킹단품_${code}`;
          if (code.includes('-UN-') || code.startsWith('26UN-')) return `유니폼단품_${code}`;
          return code;
        };

        onProgress?.({ current: 2, total: 2, step: `BOM 데이터 추출 중... (${rows.length - 1}행)` });
        const result: RawBomRow[] = [];

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const bomType = String(row[17] || '');
          const finishedSkuCode = String(row[5] || '').trim();
          const finishedSkuName = String(row[4] || '').trim();
          const bomStr = String(row[18] || '').trim();

          // 구성유형이 BOM이고, SKU코드와 BOM구성이 있는 행만 처리
          if (bomType !== 'BOM' || !finishedSkuCode || !bomStr) continue;

          // BOM구성 파싱: "26UN-BS-HM-001:1,26MK-BS-HM-001:1"
          const parts = bomStr.split(',');
          for (const part of parts) {
            const [componentCode, qtyStr] = part.trim().split(':');
            if (!componentCode) continue;
            result.push({
              finishedSkuId: finishedSkuCode,
              finishedSkuName,
              componentSkuId: componentCode.trim(),
              componentSkuName: getComponentName(componentCode.trim()),
              quantity: Number(qtyStr) || 1,
            });
          }
        }

        if (result.length === 0) {
          reject(new Error('구성유형이 BOM인 데이터를 찾을 수 없습니다. BERRIZ SKU 업로드 양식인지 확인하세요.'));
          return;
        }

        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
