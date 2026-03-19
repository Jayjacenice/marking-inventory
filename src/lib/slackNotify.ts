interface SlackNotifyParams {
  action: '발송확인' | '입고확인' | '마킹작업' | '출고확인';
  user: string;
  date: string;
  items: { name: string; qty: number }[];
  extra?: string;
}

export async function notifySlack(params: SlackNotifyParams): Promise<void> {
  try {
    await fetch('/api/slack-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch {
    // 슬랙 알림 실패는 무시 (핵심 기능 아님)
    console.warn('Slack 알림 전송 실패');
  }
}
