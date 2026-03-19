import * as XLSX from 'xlsx';
import type { TxType } from '../types';

export interface CjTransaction {
  skuId: string;
  barcode?: string;
  skuName: string;
  date: string; // YYYY-MM-DD
  quantity: number;
  type: TxType;
  refNo?: string; // 전표번호 (출고: KX전표, 입고: 슬립번호, 반품: 주문번호)
}

/** "0 / 1" 또는 "0/1" 형식에서 슬래시 뒤 숫자 추출 */
function parseSlashQty(val: unknown): number {
  if (val == null) return 0;
  const s = String(val);
  const parts = s.split('/');
  if (parts.length >= 2) {
    return Math.abs(parseInt(parts[1].trim(), 10)) || 0;
  }
  return Math.abs(parseInt(s.trim(), 10)) || 0;
}

/** 날짜 값을 YYYY-MM-DD 문자열로 변환 */
function toDateStr(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  // "2026-03-03" 또는 "2026-03-03 00:00:00"
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Excel serial number
  const n = Number(s);
  if (n > 40000 && n < 50000) {
    const d = XLSX.SSF.parse_date_code(n);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  return s;
}

/** 시트를 JSON 배열로 변환 (헤더 기반) */
function sheetToRows(wb: XLSX.WorkBook): Record<string, unknown>[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

/**
 * CJ 출고 파일 파서 (전표별상세내역)
 * - SKU: '상품', 바코드: '상품바코드', 상품명: '명칭.1'
 * - 수량: '최종출고' (슬래시 뒤)
 * - 날짜: '배송일자'
 */
export function parseCjShipment(wb: XLSX.WorkBook): CjTransaction[] {
  const rows = sheetToRows(wb);
  const results: CjTransaction[] = [];

  for (const row of rows) {
    const skuId = String(row['상품'] ?? '').trim();
    if (!skuId) continue;

    const qty = parseSlashQty(row['최종출고']);
    if (qty <= 0) continue;

    // E열 '명칭' 컬럼으로 판매/이동출고 분류
    const clientName = String(row['명칭'] ?? '').trim();
    const isSales = clientName.startsWith('(택배)주식회사 카카오엔터테인먼트');

    const refNo = row['KX전표'] ? String(row['KX전표']).trim() : undefined;
    results.push({
      skuId,
      barcode: row['상품바코드'] ? String(row['상품바코드']).trim() : undefined,
      skuName: String(row['명칭_1'] ?? row['명칭.1'] ?? '').trim(),
      date: toDateStr(row['배송일자']),
      quantity: qty,
      type: isSales ? '판매' : '출고',
      refNo,
    });
  }
  return results;
}

/**
 * CJ 입고 파일 파서 (입고상세내역)
 * - SKU: '상품', 상품명: '명칭.1'
 * - 수량: '최종입고낱개' (숫자 그대로)
 * - 날짜: '입고일'
 */
export function parseCjReceipt(wb: XLSX.WorkBook): CjTransaction[] {
  const rows = sheetToRows(wb);
  const results: CjTransaction[] = [];

  for (const row of rows) {
    const skuId = String(row['상품'] ?? '').trim();
    if (!skuId) continue;

    const qty = Math.abs(Number(row['최종입고낱개']) || 0);
    if (qty <= 0) continue;

    const refNo = (row['슬립번호'] ?? row['전표']) ? String(row['슬립번호'] ?? row['전표']).trim() : undefined;
    results.push({
      skuId,
      skuName: String(row['명칭_1'] ?? row['명칭.1'] ?? '').trim(),
      date: toDateStr(row['입고일'] ?? row['입고일자']),
      quantity: qty,
      type: '입고',
      refNo,
    });
  }
  return results;
}

/**
 * CJ 반품 파일 파서 (반품상세내역)
 * - SKU: '상품', 상품명: '명칭.1'
 * - 수량: '최종반품회수량' (슬래시 뒤)
 * - 날짜: '요청일'
 */
export function parseCjReturn(wb: XLSX.WorkBook): CjTransaction[] {
  const rows = sheetToRows(wb);
  const results: CjTransaction[] = [];

  for (const row of rows) {
    const skuId = String(row['상품'] ?? '').trim();
    if (!skuId) continue;

    const qty = parseSlashQty(row['최종반품회수량']);
    if (qty <= 0) continue;

    const refNo = row['주문번호'] ? String(row['주문번호']).trim() : undefined;
    results.push({
      skuId,
      skuName: String(row['명칭_1'] ?? row['명칭.1'] ?? '').trim(),
      date: toDateStr(row['요청일']),
      quantity: qty,
      type: '반품',
      refNo,
    });
  }
  return results;
}

/** 파일명으로 파일 종류 자동 감지 */
export function detectCjFileType(
  filename: string
): '출고' | '입고' | '반품' | null {
  const lower = filename.toLowerCase();
  if (lower.includes('전표별상세') || lower.includes('출고') || lower.includes('shipment'))
    return '출고';
  if (lower.includes('입고상세') || lower.includes('입고') || lower.includes('receipt')) return '입고';
  if (lower.includes('반품상세') || lower.includes('반품') || lower.includes('return')) return '반품';
  return null;
}
