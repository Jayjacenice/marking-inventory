import * as XLSX from 'xlsx';

export interface OfflineStockTransaction {
  barcode: string;
  skuName: string;
  date: string;       // YYYY-MM-DD
  quantity: number;
  txType: '입고' | '판매' | '출고';  // DB tx_type에 맞춤
  memo: string;
}

export interface OfflineStockParseResult {
  transactions: OfflineStockTransaction[];
  dateRange: { min: string; max: string };
  productCount: number;
  summary: Record<string, number>;
}

/**
 * Excel 시리얼 번호 → YYYY-MM-DD
 */
function serialToDate(val: any): string | null {
  const num = typeof val === 'number' ? val : Number(val);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const adj = num > 60 ? num - 1 : num;
    const ms = Date.UTC(1900, 0, 1) + (adj - 1) * 86400000;
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  // YYYY-MM-DD 문자열 그대로 반환
  const s = String(val || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * 판매 탭 파싱
 * 컬럼: A=날짜, B=품목, C=상품코드, D=바코드, E=상품명, F=수량, G~I=금액, J=비고
 */
function parseSalesSheet(ws: XLSX.WorkSheet): OfflineStockTransaction[] {
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const txns: OfflineStockTransaction[] = [];

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    // 합계 행, 품목 헤더 반복 행 skip
    if (row[1] === '합계' || row[1] === '품목' || row[4] === '상품명') continue;

    const date = serialToDate(row[0]);
    const barcode = String(row[3] || '').trim();
    const skuName = String(row[4] || '').trim();
    const qty = Number(row[5]) || 0;

    if (!date || !barcode || barcode.length < 5 || qty <= 0) continue;

    txns.push({
      barcode, skuName, date, quantity: qty,
      txType: '판매', memo: '매장 판매',
    });
  }
  return txns;
}

/**
 * 입고 탭 파싱
 * 컬럼: A=입고일, B=바코드, C=상품명, D=수량, E=입고구분
 */
function parseReceiptSheet(ws: XLSX.WorkSheet): OfflineStockTransaction[] {
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const txns: OfflineStockTransaction[] = [];

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    const date = serialToDate(row[0]);
    const barcode = String(row[1] || '').trim();
    const skuName = String(row[2] || '').trim();
    const qty = Number(row[3]) || 0;
    const reason = String(row[4] || '입고').trim();

    if (!date || !barcode || barcode.length < 5 || qty <= 0) continue;

    txns.push({
      barcode, skuName, date, quantity: qty,
      txType: '입고', memo: `매장 입고 (${reason})`,
    });
  }
  return txns;
}

/**
 * 이동출고 탭 파싱
 * 컬럼: A=날짜, B=품목코드, C=바코드, D=품목명, E=수량
 */
function parseMoveSheet(ws: XLSX.WorkSheet): OfflineStockTransaction[] {
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const txns: OfflineStockTransaction[] = [];

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    const date = serialToDate(row[0]);
    const barcode = String(row[2] || '').trim();
    const skuName = String(row[3] || '').trim();
    const qty = Number(row[4]) || 0;

    if (!date || !barcode || barcode.length < 5 || qty <= 0) continue;

    txns.push({
      barcode, skuName, date, quantity: qty,
      txType: '출고', memo: '이동출고 (플레이위즈)',
    });
  }
  return txns;
}

/**
 * 오프라인 매장 판매/입고/이동출고 엑셀 파싱
 * 워크북에 '판매', '입고', '이동출고' 시트가 있으면 해당 시트 파싱
 * 없으면 첫 번째 시트를 자동 감지 (헤더로 판별)
 */
export function parseOfflineStockExcel(wb: XLSX.WorkBook): OfflineStockParseResult {
  const allTxns: OfflineStockTransaction[] = [];

  // 시트명으로 직접 찾기
  const salesSheet = wb.Sheets['판매'];
  const receiptSheet = wb.Sheets['입고'];
  const moveSheet = wb.Sheets['이동출고'];

  if (salesSheet) {
    allTxns.push(...parseSalesSheet(salesSheet));
  }
  if (receiptSheet) {
    allTxns.push(...parseReceiptSheet(receiptSheet));
  }
  if (moveSheet) {
    allTxns.push(...parseMoveSheet(moveSheet));
  }

  // 명시적 시트가 없으면 첫 번째 시트의 헤더로 판별
  if (!salesSheet && !receiptSheet && !moveSheet) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (raw.length < 2) throw new Error('데이터가 부족합니다.');

    const headers = raw[0].map((h: any) => String(h).trim());

    // 판매 양식 감지: 바코드(D) + 수량(F) + 총매출액 등
    if (headers.includes('바코드') || headers.includes('상품명')) {
      // 바코드 위치로 판별
      const bcIdx = headers.indexOf('바코드');
      if (bcIdx >= 0 && headers.includes('수량')) {
        allTxns.push(...parseSalesSheet(ws));
      }
    }

    // 입고 양식 감지: 입고일 + 바코드 + 수량
    if (headers.includes('입고일') || (headers[0] === '입고일')) {
      allTxns.push(...parseReceiptSheet(ws));
    }
  }

  if (allTxns.length === 0) {
    throw new Error(
      '파싱 가능한 데이터를 찾을 수 없습니다.\n' +
      '"판매" 시트(날짜/바코드/상품명/수량) 또는\n' +
      '"입고" 시트(입고일/바코드/상품명/수량/입고구분)가 필요합니다.'
    );
  }

  // 요약
  const summary: Record<string, number> = {};
  const barcodes = new Set<string>();
  for (const tx of allTxns) {
    summary[tx.txType] = (summary[tx.txType] || 0) + 1;
    barcodes.add(tx.barcode);
  }

  const dates = allTxns.map((t) => t.date).sort();

  return {
    transactions: allTxns,
    dateRange: { min: dates[0], max: dates[dates.length - 1] },
    productCount: barcodes.size,
    summary,
  };
}
