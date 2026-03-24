import * as XLSX from 'xlsx';

export interface ParsedOrder {
  orderNumber: string;
  deliveryNumber: string;
  orderDate: string;
  skuId: string;
  skuName: string;
  optionText: string;
  quantity: number;
  needsMarking: boolean;
  markingType: 'completed' | 'kit' | 'none'; // 완제품마킹 / 마킹키트 / 마킹없음
}

export interface OrderParseResult {
  orders: ParsedOrder[];
  summary: {
    total: number;
    markingCompleted: number;  // 마킹 완제품 (26UN-*_선수)
    markingKit: number;        // 마킹키트 (26MK-*)
    noMarking: number;         // 마킹 불필요
    uniqueOrders: number;      // 고유 주문번호 수
  };
}

/**
 * SKU코드로 마킹 필요 여부 판별
 * - 26UN-*_선수이니셜 → 마킹 완제품 (BOM 전개 필요)
 * - 26MK-* → 마킹키트 단품
 * - 그 외 → 마킹 불필요
 */
function classifyMarking(skuId: string, _option: string): { needsMarking: boolean; markingType: 'completed' | 'kit' | 'none' } {
  // 마킹 완제품: 26UN- 접두사 + _선수이니셜 접미사
  if (skuId.startsWith('26UN-') && skuId.includes('_')) {
    return { needsMarking: true, markingType: 'completed' };
  }
  // 마킹키트 단품
  if (skuId.startsWith('26MK-')) {
    return { needsMarking: true, markingType: 'kit' };
  }
  // 마킹없음
  return { needsMarking: false, markingType: 'none' };
}

/**
 * FulfillmentShipping 엑셀 파싱
 *
 * 컬럼 매핑:
 * A(0): 배송상태, D(3): 배송번호, I(8): 상품명, J(9): 옵션
 * K(10): SKU코드, M(12): 수량, T(19): 주문번호, V(21): 주문일시
 */
export function parseOrderExcel(wb: XLSX.WorkBook): OrderParseResult {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (raw.length < 2) throw new Error('데이터가 부족합니다.');

  // 헤더 검증
  const headers = raw[0].map((h: any) => String(h).trim());
  if (!headers.includes('주문번호') && !headers.includes('배송상태')) {
    throw new Error('FulfillmentShipping 양식이 아닙니다. 배송상태/주문번호 컬럼이 필요합니다.');
  }

  // 컬럼 인덱스 (고정 or 헤더에서 찾기)
  const colIdx = {
    status: headers.indexOf('배송상태') >= 0 ? headers.indexOf('배송상태') : 0,
    deliveryNo: headers.indexOf('배송번호') >= 0 ? headers.indexOf('배송번호') : 3,
    productName: headers.indexOf('상품명') >= 0 ? headers.indexOf('상품명') : 8,
    option: headers.indexOf('옵션') >= 0 ? headers.indexOf('옵션') : 9,
    skuCode: headers.indexOf('SKU코드') >= 0 ? headers.indexOf('SKU코드') : 10,
    quantity: headers.indexOf('수량') >= 0 ? headers.indexOf('수량') : 12,
    orderNo: headers.indexOf('주문번호') >= 0 ? headers.indexOf('주문번호') : 19,
    orderDate: headers.indexOf('주문일시') >= 0 ? headers.indexOf('주문일시') : 21,
  };

  const orders: ParsedOrder[] = [];
  let markingCompleted = 0;
  let markingKit = 0;
  let noMarking = 0;
  const orderNumbers = new Set<string>();

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    const skuId = String(row[colIdx.skuCode] || '').trim();
    const orderNumber = String(row[colIdx.orderNo] || '').trim();
    const quantity = Number(row[colIdx.quantity]) || 1;

    if (!skuId || !orderNumber) continue;

    const option = String(row[colIdx.option] || '').trim();
    const { needsMarking, markingType } = classifyMarking(skuId, option);

    orders.push({
      orderNumber,
      deliveryNumber: String(row[colIdx.deliveryNo] || '').trim(),
      orderDate: String(row[colIdx.orderDate] || '').trim(),
      skuId,
      skuName: String(row[colIdx.productName] || '').trim(),
      optionText: option,
      quantity,
      needsMarking,
      markingType,
    });

    orderNumbers.add(orderNumber);
    if (markingType === 'completed') markingCompleted++;
    else if (markingType === 'kit') markingKit++;
    else noMarking++;
  }

  return {
    orders,
    summary: {
      total: orders.length,
      markingCompleted,
      markingKit,
      noMarking,
      uniqueOrders: orderNumbers.size,
    },
  };
}
