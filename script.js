const navToggle = document.getElementById('navToggle');
const mainNav = document.getElementById('mainNav');

function closeAllNavGroups() {
  mainNav.querySelectorAll('.nav-group.open').forEach((group) => {
    group.classList.remove('open');
    const toggle = group.querySelector('.nav-group-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
}

navToggle.addEventListener('click', () => {
  const isOpen = mainNav.classList.toggle('open');
  if (!isOpen) closeAllNavGroups();
});

mainNav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    mainNav.classList.remove('open');
    closeAllNavGroups();
  });
});

mainNav.querySelectorAll('.nav-group-toggle').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const group = toggle.closest('.nav-group');
    const isOpen = group.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
});

document.querySelectorAll('.detail-toggle').forEach((button) => {
  button.addEventListener('click', () => {
    const detailRow = button.closest('tr').nextElementSibling;
    const isOpen = !detailRow.hidden;
    detailRow.hidden = isOpen;
    button.textContent = isOpen ? '詳細を見る' : '詳細を閉じる';
  });
});

/* ---- Next Game (data/next-game.json を読み込んで表示) ---- */

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatGameDate(dateStr, timeStr) {
  if (!dateStr) return '未定';
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  if (isNaN(d.getTime())) return dateStr;
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const label = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}(${days[d.getDay()]})`;
  return timeStr ? `${label} ${timeStr}` : label;
}

function formatUpdatedAt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderNextGame(container, data) {
  const g = data && data.current;
  if (!g || !g.opponent) {
    container.innerHTML = '<p class="placeholder-note">次戦情報は準備中です。決まり次第このページに表示されます。</p>';
    return;
  }

  const lineup = Array.isArray(g.lineup) ? g.lineup : [];
  const bench = Array.isArray(g.bench) ? g.bench : [];

  const lineupRows = lineup.length
    ? lineup.map((p) => `
        <tr>
          <td>${escapeHtml(p.order)}</td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.position)}</td>
        </tr>`).join('')
    : '<tr class="empty-row"><td colspan="3">スタメン未発表</td></tr>';

  const benchItems = bench.length
    ? bench.map((name) => `<li>${escapeHtml(name)}</li>`).join('')
    : '<li>未定</li>';

  container.innerHTML = `
    <dl class="about-facts next-game-meta">
      <div class="fact"><dt>対戦相手</dt><dd>${escapeHtml(g.opponent)}</dd></div>
      <div class="fact"><dt>試合日時</dt><dd>${escapeHtml(formatGameDate(g.date, g.startTime))}</dd></div>
      <div class="fact"><dt>試合会場</dt><dd>${escapeHtml(g.location) || '未定'}</dd></div>
      <div class="fact"><dt>集合時間</dt><dd>${escapeHtml(g.meetTime) || '未定'}</dd></div>
    </dl>
    <div class="next-game-lineup">
      <h3>スタメン</h3>
      <div class="table-wrap">
        <table class="data-table lineup-table">
          <thead><tr><th>打順</th><th>選手</th><th>守備</th></tr></thead>
          <tbody>${lineupRows}</tbody>
        </table>
      </div>
    </div>
    <div class="next-game-bench">
      <h3>ベンチメンバー</h3>
      <ul class="bench-list">${benchItems}</ul>
    </div>
    ${g.updatedAt ? `<p class="next-game-updated">最終更新: ${escapeHtml(formatUpdatedAt(g.updatedAt))}</p>` : ''}
  `;
}

async function loadNextGame() {
  const container = document.getElementById('nextGameContent');
  if (!container) return;
  try {
    const res = await fetch('data/next-game.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('failed to load next-game.json');
    const data = await res.json();
    renderNextGame(container, data);
  } catch (e) {
    container.innerHTML = '<p class="placeholder-note">次戦情報の読み込みに失敗しました。しばらくしてから再度お試しください。</p>';
  }
}

loadNextGame();
