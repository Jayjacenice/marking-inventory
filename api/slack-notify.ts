import type { IncomingMessage, ServerResponse } from 'http';

const ACTION_EMOJI: Record<string, string> = {
  '발송확인': '📦',
  '입고확인': '📥',
  '마킹작업': '🏷️',
  '출고확인': '🚚',
};

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    return send(res, 500, { error: 'Slack configuration missing' });
  }

  try {
    const { action, user, date, items, extra } = await parseBody(req);

    if (!action || !user || !items) {
      return send(res, 400, { error: 'Missing required fields' });
    }

    const emoji = ACTION_EMOJI[action] || '📋';
    const totalQty = items.reduce((s: number, i: any) => s + (i.qty || 0), 0);

    const itemLines = items.slice(0, 10).map((i: any) => `• ${i.name}: ${i.qty}개`);
    if (items.length > 10) {
      itemLines.push(`_...외 ${items.length - 10}종_`);
    }

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${action} 완료*\n담당자: ${user} | 날짜: ${date}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${items.length}종 / ${totalQty.toLocaleString()}개*\n${itemLines.join('\n')}`,
        },
      },
    ];

    if (extra) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: extra },
      });
    }

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel,
        text: `${emoji} ${action} 완료 — ${user} (${items.length}종 ${totalQty}개)`,
        blocks,
      }),
    });

    const slackData = await slackRes.json();

    if (!slackData.ok) {
      console.error('Slack API error:', slackData.error);
      return send(res, 502, { error: slackData.error });
    }

    return send(res, 200, { ok: true });
  } catch (err: any) {
    console.error('Slack notify error:', err);
    return send(res, 500, { error: err.message || 'Internal error' });
  }
}
