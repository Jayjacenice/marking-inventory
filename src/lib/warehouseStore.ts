/**
 * 창고 ID 전역 캐시 — 앱 시작 시 1회만 로드, 이후 즉시 반환
 * warehouse 테이블은 절대 변경되지 않으므로 TTL 없이 영구 캐시
 */
import { supabase } from './supabase';

interface Warehouse {
  id: string;
  name: string;
}

let warehouses: Warehouse[] | null = null;
let loadPromise: Promise<Warehouse[]> | null = null;

/** 창고 목록 조회 (캐시 우선) */
export async function getWarehouses(): Promise<Warehouse[]> {
  if (warehouses) return warehouses;
  if (loadPromise) return loadPromise;

  loadPromise = Promise.resolve(
    supabase.from('warehouse').select('id, name')
  ).then(({ data }) => {
    warehouses = (data ?? []) as Warehouse[];
    loadPromise = null;
    return warehouses;
  });

  return loadPromise;
}

/** 이름으로 창고 ID 조회 (캐시 우선) */
export async function getWarehouseId(name: string): Promise<string | null> {
  const list = await getWarehouses();
  return list.find((w) => w.name === name)?.id ?? null;
}

/** 자주 쓰는 창고 ID 일괄 반환 */
export async function getCommonWarehouseIds(): Promise<{
  offline: string | null;
  playwith: string | null;
  marking: string | null;
}> {
  const list = await getWarehouses();
  const find = (name: string) => list.find((w) => w.name.includes(name))?.id ?? null;
  return {
    offline: find('오프라인'),
    playwith: find('플레이위즈'),
    marking: find('마킹'),
  };
}

/** 캐시 초기화 (테스트용) */
export function clearWarehouseCache(): void {
  warehouses = null;
  loadPromise = null;
}
