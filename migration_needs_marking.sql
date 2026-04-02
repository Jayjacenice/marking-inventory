-- ============================================
-- inventory 테이블에 needs_marking 컬럼 추가
-- PK: (warehouse_id, sku_id) → (warehouse_id, sku_id, needs_marking)
-- ============================================

-- 1. needs_marking 컬럼 추가 (기본값 false)
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS needs_marking boolean NOT NULL DEFAULT false;

-- 2. 기존 PK 삭제
ALTER TABLE inventory DROP CONSTRAINT inventory_pkey;

-- 3. 새 PK 생성 (needs_marking 포함)
ALTER TABLE inventory ADD PRIMARY KEY (warehouse_id, sku_id, needs_marking);

-- 4. inventory_transaction에도 needs_marking 추가 (기록용)
ALTER TABLE inventory_transaction ADD COLUMN IF NOT EXISTS needs_marking boolean DEFAULT NULL;

-- 5. RLS 정책 재적용 (PK 변경으로 영향 없지만 확인용)
-- (기존 RLS는 그대로 유지됨)

-- 완료 확인
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'inventory'
ORDER BY ordinal_position;
