import { config } from './config.js';

const slots = [
  { hour: 7, label: '朝' },
  { hour: 12, label: '昼' },
  { hour: 19, label: '夜' }
];

const pillars = [
  '空飛ぶクルマ事業の進捗から見える、未来の移動インフラの作り方',
  '中井佑が大切にしている意思決定、巻き込み方、事業づくりの考え方',
  '一人ではなくチームと仕組みで挑む、ハードウェアスタートアップの日常',
  '一般の人にも伝わる、空飛ぶクルマの社会実装に向けた小さな前進',
  'バズりやすい問いかけ、学び、失敗談、ビジネスの原理原則'
];

const fallbackAngles = [
  '大きな夢ほど、毎日の進捗は地味です。でも地味な確認を積み上げられるチームだけが、最後に社会実装へ近づく。空飛ぶクルマも同じで、派手な発表より「今日も安全側に一歩進んだか」を大事にしています。',
  '事業づくりで一番怖いのは、難しい課題ではなく「誰の何を変えるのか」が曖昧なまま走ること。空飛ぶクルマも技術の話に見えて、最後は人の移動体験をどう変えるかの話です。',
  '未来の乗り物を作る仕事は、未来だけを見ていると進みません。規制、地域、運航、整備、利用者の不安。現実の制約を一つずつ味方に変えることが、いちばんの近道だと思っています。',
  '「できたらすごい」から「使えるから選ばれる」へ。この距離を埋めるのがビジネスの仕事。空飛ぶクルマも、夢を語る段階から運用を設計する段階へ進めていきたい。',
  '新規事業は、正解を当てるゲームではなく、間違いを早く小さく見つけるゲーム。今日の違和感を放置しないことが、明日の大きな手戻りを防ぐ。'
];

function tokyoParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: value('weekday')
  };
}

function tokyoLocalDateToUtc({ year, month, day, hour = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, 0, 0, 0));
}

function addTokyoDays(parts, days) {
  const utcNoon = Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0);
  return tokyoParts(new Date(utcNoon));
}

function toUtcIsoFromTokyoSlot(parts, hour) {
  return tokyoLocalDateToUtc({ ...parts, hour }).toISOString();
}

export function nextWeekStart(baseDate = new Date()) {
  const parts = tokyoParts(baseDate);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const diffToMonday = ((8 - weekdayIndex) % 7) || 7;
  const nextMonday = addTokyoDays(parts, diffToMonday);
  return tokyoLocalDateToUtc(nextMonday);
}

export function buildFallbackPosts({ startDate = nextWeekStart(), days = 7 } = {}) {
  const posts = [];
  for (let day = 0; day < days; day += 1) {
    for (const slot of slots) {
      const scheduledDay = addTokyoDays(tokyoParts(startDate), day);
      const scheduledAt = toUtcIsoFromTokyoSlot(scheduledDay, slot.hour);
      const index = posts.length;
      const content = `${fallbackAngles[index % fallbackAngles.length]}\n\n#空飛ぶクルマ #事業開発`;
      posts.push({
        id: `draft-${scheduledDay.year}-${String(scheduledDay.month).padStart(2, '0')}-${String(scheduledDay.day).padStart(2, '0')}-${slot.label}`,
        content: content.slice(0, 260),
        scheduledAt,
        status: 'draft',
        pillar: pillars[index % pillars.length],
        source: 'fallback',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }
  return posts;
}

export async function generateWithOpenAI({ startDate = nextWeekStart(), days = 7 } = {}) {
  if (!config.openaiApiKey) return buildFallbackPosts({ startDate, days });

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: [
        {
          role: 'system',
          content: 'あなたはX運用に強い日本語編集者です。誇大広告を避け、事業家の人格と思想が伝わる投稿を作ります。各投稿は260字以内、JSONのみで返します。'
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: '中井佑の人となり、ビジネスの考え方、空飛ぶクルマ事業進捗が伝わるX投稿案を作る',
            schedule: `${startDate.toISOString()}から${days}日分、Asia/Tokyoの毎日7時/12時/19時`,
            pillars,
            output_schema: [{ content: 'string', pillar: 'string' }]
          })
        }
      ],
      text: { format: { type: 'json_object' } }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI generation failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((c) => c.text).join('');
  const parsed = JSON.parse(text);
  const ideas = Array.isArray(parsed) ? parsed : parsed.posts || parsed.items || [];
  const fallback = buildFallbackPosts({ startDate, days });
  return fallback.map((post, index) => ({
    ...post,
    content: (ideas[index]?.content || post.content).slice(0, 260),
    pillar: ideas[index]?.pillar || post.pillar,
    source: 'openai'
  }));
}
