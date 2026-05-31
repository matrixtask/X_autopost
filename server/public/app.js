const tokenInput = document.querySelector('#token');
const toast = document.querySelector('#toast');
const statusFilter = document.querySelector('#status-filter');
const statusLabels = {
  total: '総投稿案',
  draft: '承認待ち',
  approved: '承認済み',
  posted: '投稿済み',
  failed: '失敗',
  rejected: '却下'
};

tokenInput.value = localStorage.getItem('adminToken') || '';

document.querySelector('#save-token').addEventListener('click', () => {
  localStorage.setItem('adminToken', tokenInput.value.trim());
  showToast('Admin Tokenを保存しました。');
});
document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#generate').addEventListener('click', generateWeek);
document.querySelector('#tick').addEventListener('click', runTick);
statusFilter.addEventListener('change', loadPosts);

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const token = tokenInput.value.trim() || localStorage.getItem('adminToken');
  if (!token) throw new Error('Admin Tokenを入力してください。');
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo'
  }).format(new Date(value));
}

function renderStats(summary) {
  const keys = ['total', 'draft', 'approved', 'posted', 'failed'];
  document.querySelector('#stats').innerHTML = keys.map((key) => `
    <article class="panel stat">
      <span>${statusLabels[key]}</span>
      <strong>${summary[key] ?? 0}</strong>
      ${key === 'approved' ? `<small>承認率 ${summary.approvalRate}%</small>` : ''}
      ${key === 'posted' ? `<small>投稿成功率 ${summary.publishSuccessRate}%</small>` : ''}
    </article>
  `).join('');
}

function renderBars(selector, rows, maxValue = null) {
  const max = maxValue ?? Math.max(1, ...rows.map((row) => row.value));
  document.querySelector(selector).innerHTML = rows.length ? rows.map((row) => `
    <div class="bar-row" title="${escapeHtml(row.label)}: ${row.value}">
      <span class="bar-label">${escapeHtml(row.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (row.value / max) * 100)}%"></span></span>
      <span class="bar-value">${row.value}</span>
    </div>
  `).join('') : '<p class="muted">データがありません。</p>';
}

function renderEvents(events) {
  document.querySelector('#events').innerHTML = events.length ? events.map((event) => `
    <li>
      <strong>${escapeHtml(event.type)}</strong> ${escapeHtml(event.postId || '')}
      <small>${formatDate(event.at)} / ${escapeHtml(event.from || '-')} → ${escapeHtml(event.to || '-')}</small>
    </li>
  `).join('') : '<li class="muted">まだイベントがありません。</li>';
}

function renderAnalytics(data) {
  renderStats(data.summary);
  document.querySelector('#generated-at').textContent = `更新: ${formatDate(data.generatedAt)}`;
  renderBars('#status-bars', ['draft', 'approved', 'posted', 'failed', 'rejected'].map((key) => ({ label: statusLabels[key], value: data.summary[key] || 0 })));
  renderBars('#pillar-bars', data.charts.byPillar.slice(0, 8));
  renderBars('#daily-bars', data.charts.dailyScheduled.slice(-10));
  renderEvents(data.recentEvents);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function postCard(post) {
  return `
    <article class="post-card" data-id="${escapeHtml(post.id)}">
      <header>
        <div>
          <span class="badge ${escapeHtml(post.status)}">${escapeHtml(post.status)}</span>
          <strong>${formatDate(post.scheduledAt)}</strong>
        </div>
        <small class="muted">${escapeHtml(post.source || '-') }</small>
      </header>
      <textarea aria-label="post content">${escapeHtml(post.content)}</textarea>
      <p class="muted">${escapeHtml(post.pillar || '未分類')}</p>
      ${post.lastError ? `<p class="muted">エラー: ${escapeHtml(post.lastError)}</p>` : ''}
      <div class="post-actions">
        <button class="save secondary">保存</button>
        <button class="approve ok">承認</button>
        <button class="reject danger">却下</button>
      </div>
    </article>
  `;
}

async function loadPosts() {
  const status = statusFilter.value;
  const data = await api(`/api/posts${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  const list = document.querySelector('#posts');
  list.innerHTML = data.posts.length ? data.posts.map(postCard).join('') : '<p class="muted">投稿がありません。</p>';
  list.querySelectorAll('.post-card').forEach((card) => {
    const id = card.dataset.id;
    const content = card.querySelector('textarea');
    card.querySelector('.save').addEventListener('click', () => updatePost(id, { content: content.value }));
    card.querySelector('.approve').addEventListener('click', () => actionPost(id, content.value, 'approve'));
    card.querySelector('.reject').addEventListener('click', () => actionPost(id, content.value, 'reject'));
  });
}

async function updatePost(id, patch) {
  await api(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  showToast('投稿を保存しました。');
  await refresh();
}

async function actionPost(id, content, action) {
  await api(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ content }) });
  await api(`/api/posts/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  showToast(action === 'approve' ? '承認しました。' : '却下しました。');
  await refresh();
}

async function generateWeek() {
  await api('/api/posts/generate-week', { method: 'POST', body: JSON.stringify({ days: 7 }) });
  showToast('1週間分の投稿案を生成しました。');
  await refresh();
}

async function runTick() {
  const result = await api('/api/tick', { method: 'POST' });
  showToast(`投稿チェック完了: ${result.results.length}件`);
  await refresh();
}

async function refresh() {
  try {
    const analytics = await api('/api/analytics');
    renderAnalytics(analytics);
    await loadPosts();
  } catch (error) {
    showToast(error.message);
  }
}

refresh();
