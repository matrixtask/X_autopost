const statuses = ['draft', 'approved', 'rejected', 'posted', 'failed'];

function percentage(part, total) {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

function dateKey(isoString) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoString));
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function increment(map, key, amount = 1) {
  const safeKey = key || '未分類';
  map.set(safeKey, (map.get(safeKey) || 0) + amount);
}

function mapToRows(map) {
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ja'));
}

export function buildAnalytics(posts, events = [], now = new Date()) {
  const summary = Object.fromEntries(statuses.map((status) => [status, 0]));
  const byPillar = new Map();
  const bySource = new Map();
  const dailyScheduled = new Map();
  const dailyPosted = new Map();
  const recentEvents = [...events].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);

  for (const post of posts) {
    summary[post.status] = (summary[post.status] || 0) + 1;
    increment(byPillar, post.pillar);
    increment(bySource, post.source);
    if (post.scheduledAt) increment(dailyScheduled, dateKey(post.scheduledAt));
    if (post.postedAt) increment(dailyPosted, dateKey(post.postedAt));
  }

  const approvedOrRejected = summary.approved + summary.rejected + summary.posted + summary.failed;
  const publishAttempts = summary.posted + summary.failed;
  const upcoming = posts
    .filter((post) => ['draft', 'approved'].includes(post.status) && new Date(post.scheduledAt) >= now)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 8);
  const recentPosts = posts
    .filter((post) => ['posted', 'failed', 'rejected'].includes(post.status))
    .sort((a, b) => new Date(b.updatedAt || b.scheduledAt) - new Date(a.updatedAt || a.scheduledAt))
    .slice(0, 8);

  return {
    generatedAt: now.toISOString(),
    summary: {
      total: posts.length,
      ...summary,
      approvalRate: percentage(summary.approved + summary.posted, approvedOrRejected),
      publishSuccessRate: percentage(summary.posted, publishAttempts)
    },
    charts: {
      byPillar: mapToRows(byPillar),
      bySource: mapToRows(bySource),
      dailyScheduled: mapToRows(dailyScheduled).sort((a, b) => a.label.localeCompare(b.label)),
      dailyPosted: mapToRows(dailyPosted).sort((a, b) => a.label.localeCompare(b.label))
    },
    upcoming,
    recentPosts,
    recentEvents
  };
}
