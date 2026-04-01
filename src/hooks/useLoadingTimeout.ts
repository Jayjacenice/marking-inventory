import { useEffect, useRef } from 'react';

/**
 * 페이지 로딩 안전장치 — loading이 지정 시간(기본 15초) 이상 지속되면
 * setLoading(false)를 강제 호출하고 에러 메시지를 표시한다.
 *
 * 사용법:
 *   useLoadingTimeout(loading, setLoading, setError);
 */
export function useLoadingTimeout(
  loading: boolean,
  setLoading: (v: boolean) => void,
  setError?: (msg: string | null) => void,
  timeoutMs = 15_000,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loading) {
      timerRef.current = setTimeout(() => {
        setLoading(false);
        setError?.('데이터 로딩 시간이 초과되었습니다. 새로고침 해주세요.');
      }, timeoutMs);
    } else if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [loading, setLoading, setError, timeoutMs]);
}
