import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('.env.local 파일에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 설정해주세요.');
}

/**
 * 10초 타임아웃을 적용한 fetch 래퍼.
 * Supabase의 모든 HTTP 요청(DB 쿼리, 토큰 갱신 등)에 적용되어
 * 네트워크 hang 시 Promise가 영원히 대기하지 않도록 보장한다.
 */
const FETCH_TIMEOUT_MS = 10_000;

const fetchWithTimeout = (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out after 10s', 'TimeoutError')),
    FETCH_TIMEOUT_MS
  );
  // 호출측에서 이미 signal을 넘긴 경우 해당 signal도 abort 시 함께 처리
  init?.signal?.addEventListener('abort', () => controller.abort(init.signal!.reason));

  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
};

// lock: no-op — Web Locks API가 일부 브라우저 환경에서 hang을 유발하여
// onAuthStateChange·signInWithPassword 등이 영원히 대기하는 문제 방지.
// 동시 토큰 갱신 리스크보다 앱 hang 방지가 우선.
// global.fetch에 타임아웃 래퍼를 주입해 모든 요청이 최대 10초 내 완료되도록 보장.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: fetchWithTimeout },
  auth: {
    lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<any>) => fn(),
  },
});
