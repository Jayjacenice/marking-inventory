/**
 * 시즌 prefix 중앙 관리.
 *
 * 시즌이 바뀌면 (예: 2026 → 2027) 아래 SEASON 한 줄만 변경하면
 * 전 코드의 prefix 검사·매핑이 일괄 적용된다.
 *
 * 정책: 마킹 완제품 = 유니폼 prefix + 옵션 텍스트(`_홍길동` 등) 포함.
 *      마킹 단품 = `26MK-` 또는 `26MK2-` (둘 중 하나라도 매칭).
 */

export const SEASON = '26';

const P = (cat: string) => `${SEASON}${cat}-`;

/** prefix 상수 — 새 카테고리 추가 시 여기 한 줄. */
export const PREFIX = {
  uniform: P('UN'),     // 26UN-
  marking: P('MK'),     // 26MK-
  marking2: P('MK2'),   // 26MK2-
} as const;

/** Supabase ilike/like 패턴 (`like '26MK-%'` 같은 쿼리용). */
export const LIKE_PATTERN = {
  uniform: `${PREFIX.uniform}%`,
  marking: `${PREFIX.marking}%`,
  marking2: `${PREFIX.marking2}%`,
} as const;

/** 유니폼 단품 또는 마킹 완제품 (= 유니폼 prefix 시작). */
export const isUniform = (sku: string): boolean => sku.startsWith(PREFIX.uniform);

/** 마킹 단품 (`26MK-` 또는 `26MK2-`). 둘 다 커버해야 함. */
export const isMarkingKit = (sku: string): boolean =>
  sku.startsWith(PREFIX.marking) || sku.startsWith(PREFIX.marking2);

/** 마킹 완제품 = 유니폼 SKU + 옵션 텍스트(`_`) 포함. */
export const isFinishedMarked = (sku: string): boolean =>
  isUniform(sku) && sku.includes('_');

/** 유니폼 단품 = 유니폼 SKU 인데 마킹 완제품은 아닌 것. */
export const isUniformPlain = (sku: string): boolean =>
  isUniform(sku) && !sku.includes('_');

/** 유니폼 SKU → 동일 base 의 마킹 SKU 로 변환 (예: 26UN-BS-HM-001 → 26MK-BS-HM-001). */
export const toMarkingSku = (uniformSku: string): string =>
  uniformSku.replace(PREFIX.uniform, PREFIX.marking);

/** 분류 헬퍼 — 한 번에 카테고리 식별. */
export type SkuCategory = 'finished' | 'uniform' | 'marking' | 'other';
export const getSkuCategory = (sku: string): SkuCategory => {
  if (isFinishedMarked(sku)) return 'finished';
  if (isUniform(sku)) return 'uniform';
  if (isMarkingKit(sku)) return 'marking';
  return 'other';
};
