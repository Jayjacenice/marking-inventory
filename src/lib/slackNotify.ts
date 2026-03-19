interface SlackNotifyParams {
  action: '발송확인' | '입고확인' | '마킹작업' | '출고확인' | '작업불가알림';
  user: string;
  date: string;
  items: { name: string; qty: number }[];
  message?: string;
  extra?: string;
}

/** action별 Slack attachment 색상 및 제목 */
function getSlackMeta(action: SlackNotifyParams['action']) {
  switch (action) {
    case '작업불가알림':
      return { color: '#FF0000', title: '⚠️ 작업불가 알림' };
    case '발송확인':
      return { color: '#2196F3', title: '📦 발송 확인' };
    case '입고확인':
      return { color: '#4CAF50', title: '📥 입고 확인' };
    case '마킹작업':
      return { color: '#9C27B0', title: '🏷️ 마킹 작업' };
    case '출고확인':
      return { color: '#FF9800', title: '📤 출고 확인' };
  }
}

export async function notifySlack(params: SlackNotifyParams): Promise<void> {
  try {
    const meta = getSlackMeta(params.action);
    const itemLines = params.items
      .map((it) => `• ${it.name}: ${it.qty}개`)
      .join('\n');

    const sections: string[] = [];
    if (params.message) sections.push(params.message);
    if (itemLines) sections.push(itemLines);

    await fetch('/api/slack-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        _meta: meta,
        _body: sections.join('\n\n'),
      }),
    });
  } catch {
    // 슬랙 알림 실패는 무시 (핵심 기능 아님)
    console.warn('Slack 알림 전송 실패');
  }
}
