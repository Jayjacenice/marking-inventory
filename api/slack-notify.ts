import type { VercelRequest, VercelResponse } from '@vercel/node';

const ACTION_EMOJI: Record<string, string> = {
  '발송확인': '📦',
  '입고확인': '📥',
  '마킹작업': '🏷️',
  '출고확인': '🚚',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    return res.status(500).json({ error: 'Slack configuration missing' });
  }

  try {
    const { action, user, date, items, extra } = req.body;

    if (!action || !user || !items) {
      return res.status(400).json({ error: 'Missing required fields' });
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
        'Content-Type': 'application/json',
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
      return res.status(502).json({ error: slackData.error });
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('Slack notify error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
