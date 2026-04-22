#!/usr/bin/env node
/**
 * 과거 "잔량 전체 취소(zero_all_remaining)" 이력에 대해
 * online_order.status = '취소' 로 LIFO 소급 적용.
 *
 * 실행:
 *   node _backfill_cancelled_orders.cjs            # dry-run (기본)
 *   node _backfill_cancelled_orders.cjs --apply   # 실제 적용
 *
 * .env.local 의 VITE_SUPABASE_URL, VITE_SUPABASE_SERVICE_ROLE_KEY 사용.
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const envPath = path.join(__dirname, '.env.local');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.trim().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).replace(/^["']|["']$/g, '').trim()];
    }),
);

const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('env 누락'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

async function restGet(qs) {
  const r = await fetch(`${URL}/rest/v1/${qs}`, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function restPatch(qs, body) {
  const r = await fetch(`${URL}/rest/v1/${qs}`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  console.log(APPLY ? '[APPLY 모드]' : '[DRY RUN]', '소급 대상 조회...');

  // 1. 과거 zero_all_remaining 로그 전수 (WO 정보 포함)
  const logs = await restGet(
    `activity_log?select=id,work_order_id,action_date,summary,work_order(id,status)&action_type=eq.zero_all_remaining&order=action_date.asc`,
  );
  console.log(`  zero_all_remaining 로그: ${logs.length}건`);

  // 2. 이미 '출고완료'인 WO는 finish_work_order RPC가 online_order를 '신규' 복귀시켰을 것 → 스킵
  const activeLogs = logs.filter((l) => l.work_order && l.work_order.status !== '출고완료');
  console.log(`  활성 WO 기반 로그: ${activeLogs.length}건 (${logs.length - activeLogs.length}건은 '출고완료'라 스킵)`);

  let totalMarked = 0;
  let totalShortfall = 0;

  for (const log of activeLogs) {
    const items = (log.summary && log.summary.items) || [];
    if (items.length === 0) continue;
    const woId = log.work_order_id;
    console.log(`\n  WO ${woId} @ ${log.action_date} (${items.length}개 SKU)`);

    for (const it of items) {
      const cancelQty = (it.before || 0) - (it.after || 0);
      if (cancelQty <= 0) continue;

      // LIFO 후보 (status NOT IN '취소','출고완료')
      const candQs =
        `online_order?select=id,quantity,status,order_date,created_at` +
        `&work_order_id=eq.${woId}` +
        `&sku_id=eq.${encodeURIComponent(it.skuId)}` +
        `&status=not.in.("취소","출고완료")` +
        `&order=order_date.desc&order=created_at.desc`;
      const candidates = await restGet(candQs);

      const toCancel = [];
      let acc = 0;
      for (const o of candidates) {
        if (acc >= cancelQty) break;
        toCancel.push(o.id);
        acc += o.quantity || 0;
      }
      const shortfall = Math.max(0, cancelQty - acc);
      totalShortfall += shortfall;

      console.log(
        `    [${it.skuId}] 취소대상 ${cancelQty}개 → 주문 ${toCancel.length}건 선택 (합 ${acc})${shortfall > 0 ? `, 부족 ${shortfall}` : ''}`,
      );

      if (APPLY && toCancel.length > 0) {
        // 500개씩 배치 PATCH
        for (let i = 0; i < toCancel.length; i += 500) {
          const batch = toCancel.slice(i, i + 500);
          const qs = `online_order?id=in.(${batch.join(',')})`;
          await restPatch(qs, { status: '취소' });
        }
        totalMarked += toCancel.length;
      } else {
        totalMarked += toCancel.length;
      }
    }
  }

  console.log('\n요약');
  console.log(`  ${APPLY ? '적용' : '적용 예정'}: ${totalMarked}건 online_order → status='취소'`);
  if (totalShortfall > 0) console.log(`  수량 부족(과거 데이터 변화로 후보 없음): ${totalShortfall}`);
  if (!APPLY) console.log('\n실제 적용: node _backfill_cancelled_orders.cjs --apply');
}

main().catch((e) => { console.error(e); process.exit(1); });
