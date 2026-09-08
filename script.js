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

/* 試合日程・試合結果などはJSONから動的に描画されるため、
   個々のボタンに直接ではなくdocument側でイベント委任して詳細開閉を扱う */
document.addEventListener('click', (event) => {
  const button = event.target.closest('.detail-toggle');
  if (!button) return;
  const detailRow = button.closest('tr').nextElementSibling;
  const isOpen = !detailRow.hidden;
  detailRow.hidden = isOpen;
  // ボタンの文言は「詳細」+開閉に応じた語尾(を見る/を閉じる)のspanに分けてあり、
  // スマホでは語尾側をCSSで隠して列幅に収めている。textContentを丸ごと置き換えると
  // そのspan構造が消えてしまうため、語尾のspanだけを更新する
  const suffix = button.querySelector('.detail-toggle-suffix');
  if (suffix) suffix.textContent = isOpen ? 'を見る' : 'を閉じる';
});

/* ---- Next Game (data/next-game.json を読み込んで表示) ---- */

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 「2026/09/13(日)」のような日付表記はスペースが無く折り返せないため、スマホの狭い表内で
// 1文字ずつ縦に折り返される・逆に表全体が広がってしまう、のどちらにもならないよう
// 曜日の「(」の前にだけ改行可能位置(wbr)を入れる
function formatDateCell(str) {
  return escapeHtml(str).replace('(', '<wbr>(').replace(/\//g, '/<wbr>');
}

function formatDateOnly(dateStr) {
  const m = dateStr && /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 閲覧環境のタイムゾーンに関わらず、日付文字列の年月日だけから曜日を求める
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const dayOfWeek = days[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}(${dayOfWeek})`;
}

function formatGameDate(dateStr, timeStr) {
  const label = formatDateOnly(dateStr);
  if (!label) return '未定';
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
      <h3>スターティングメンバー発表！</h3>
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
    ${g.note ? `
    <div class="next-game-note">
      <h3>監督から一言・連絡事項</h3>
      <p>${escapeHtml(g.note).replace(/\n/g, '<br>')}</p>
    </div>` : ''}
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

/* ---- 試合日程・試合結果・過去の成績・個人成績(data/*.json を読み込んで表示) ---- */

const ERROR_NOTE = '<p class="placeholder-note">データの読み込みに失敗しました。しばらくしてから再度お試しください。</p>';

async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load ${url}`);
  return res.json();
}

function renderSchedule(container, data) {
  const games = (data && Array.isArray(data.games)) ? data.games : [];
  if (!games.length) {
    container.innerHTML = '<p class="placeholder-note">試合日程は準備中です。</p>';
    return;
  }
  const rows = games.map((g) => `
        <tr>
          <td>${formatDateOnly(g.date) ? formatDateCell(formatDateOnly(g.date)) : '未定'}</td>
          <td>${escapeHtml(g.opponent)}</td>
          <td>${escapeHtml(g.location || '未定')}</td>
          <td>${escapeHtml(g.time || '未定')}</td>
        </tr>`).join('');
  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>日付</th><th>対戦相手</th><th>場所</th><th>時間</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderGameDetail(detail) {
  if (!detail) return '';
  if (detail.type === 'linescore') {
    const inningHeaders = (detail.innings || []).map((i) => `<th>${escapeHtml(i)}</th>`).join('');
    const rows = (detail.rows || []).map((r) => `
                    <tr>
                      <td class="linescore-team">${escapeHtml(r.team)}</td>
                      ${(r.values || []).map((v) => `<td>${escapeHtml(v)}</td>`).join('')}
                      <td class="linescore-total">${escapeHtml(r.total)}</td>
                    </tr>`).join('');
    return `
                <table class="linescore">
                  <thead>
                    <tr><th></th>${inningHeaders}<th>計</th></tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>`;
  }
  if (detail.type === 'boxscore') {
    const headers = (detail.headers || []).map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    const rows = (detail.rows || []).map((row) => `
                      <tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
    return `
                <div class="table-wrap">
                  <table class="data-table boxscore">
                    <thead><tr>${headers}</tr></thead>
                    <tbody>${rows}</tbody>
                  </table>
                </div>`;
  }
  return '';
}

function renderResultsGroup(group) {
  const rows = (group.games || []).map((g) => {
    const hasBoxscore = !!(g.boxscore && Array.isArray(g.boxscore.headers) && Array.isArray(g.boxscore.rows) && g.boxscore.rows.length);
    const hasDetail = !!g.detail || hasBoxscore;
    const detailCell = hasDetail
      ? '<button class="detail-toggle" type="button">詳細<span class="detail-toggle-suffix">を見る</span></button>' : '';
    // 試合結果(イニング別得点)と個人成績(ボックススコア)は別々のデータとして
    // 保存されているため(既存データを壊さないための互換設計)、両方あれば
    // 同じ詳細欄の中に並べて表示する
    const detailBlocks = [
      g.detail ? renderGameDetail(g.detail) : '',
      hasBoxscore ? renderGameDetail({ type: 'boxscore', headers: g.boxscore.headers, rows: g.boxscore.rows }) : '',
    ].filter(Boolean).join('');
    // detail-cell-inner: 中の個人成績表(ボックススコア)は横に長いが、それに引っ張られて
    // 試合結果テーブル本体まで横スクロールが必要にならないよう、専用のCSSで幅の伝播を止める
    const detailRow = hasDetail ? `
            <tr class="detail-row" hidden>
              <td colspan="6"><div class="detail-cell-inner">${detailBlocks}
              </div></td>
            </tr>` : '';
    return `
            <tr class="result-row">
              <td>${formatDateCell(g.dateLabel)}</td>
              <td>${escapeHtml(g.opponent)}</td>
              <td>${escapeHtml(g.score)}</td>
              <td class="result-${escapeHtml(g.resultClass)}">${escapeHtml(g.resultLabel)}</td>
              <td>${escapeHtml(g.venue)}</td>
              <td>${detailCell}</td>
            </tr>${detailRow}`;
  }).join('');
  return `
      <h3 class="table-title">${escapeHtml(group.title)}</h3>
      <div class="table-wrap">
        <table class="data-table results-table">
          <thead>
            <tr><th>日付</th><th>対戦相手</th><th>スコア</th><th>結果</th><th>球場</th><th>詳細</th></tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr><td colspan="6">${escapeHtml(group.record)}</td></tr>
          </tfoot>
        </table>
      </div>`;
}

function renderRankingGrid(categories) {
  const cards = (categories || []).map((cat) => {
    const items = (cat.entries || []).map((e) => `<li><span>${escapeHtml(e.name)}</span><b>${escapeHtml(e.value)}</b></li>`).join('');
    return `
        <div class="ranking-card">
          <h4>${escapeHtml(cat.label)}</h4>
          <ol>${items}</ol>
        </div>`;
  }).join('');
  return `<div class="ranking-grid">${cards}</div>`;
}

function renderResults(container, resultsData) {
  const groups = (resultsData && Array.isArray(resultsData.groups))
    ? resultsData.groups.filter((g) => g.era === 'current') : [];
  if (!groups.length) {
    container.innerHTML = '<p class="placeholder-note">試合結果は準備中です。</p>';
    return;
  }
  const parts = groups.map((g) => {
    let html = renderResultsGroup(g);
    // 2026年度は試合ごとの個人成績(admin.htmlから入力)が蓄積され次第、
    // 自動でシーズン合計成績を表示する(現時点でデータが無ければ何も表示しない)
    const { rows: seasonRows, hasReliablePA } = aggregateBoxscoreSeason(g);
    if (seasonRows.length) {
      html += `
      <h3 class="table-title">${escapeHtml(g.title)} シーズン合計成績</h3>
      <p class="placeholder-note">※ admin.htmlから入力された試合ごとの個人成績の合計です。打数(AB)が0の選手は打率などを「-」と表示しています。</p>
      ${renderSeasonTotalsTable(seasonRows, hasReliablePA)}`;
    }
    return html;
  });
  const totalHtml = resultsData.leagueTotal
    ? `<p class="league-total">${escapeHtml(resultsData.leagueTotal)}</p>` : '';
  container.innerHTML = parts.join('') + totalHtml;
}

/* シーズン合計成績: 各試合のボックススコア(既存データ)を選手ごとに合算する。
   打席数(PA)は犠打・犠飛が記録されていないため正確に算出できず表示しない。
   打率・出塁率・長打率は既存の1試合ごとの数値と同じ式(打率=安打/打数、
   出塁率=(安打+四球+死球)/(打数+四球+死球)、長打率=塁打/打数)で算出しており、
   このサイトの既存データと矛盾しないことを確認済み。 */
function formatRate(numerator, denominator) {
  if (!denominator) return '-';
  const value = numerator / denominator;
  const s = Math.abs(value).toFixed(3);
  const body = s.startsWith('0.') ? s.slice(1) : s;
  return (value < 0 ? '-' : '') + body;
}

function boxscoreSourceOf(game) {
  // 2026年度以降はadmin.htmlから入力された個人成績を game.boxscore に保存する
  // (試合結果本体やイニング別得点 game.detail を書き換えずに済むようにするため)。
  // 2023〜2025年度は移行時のデータ構造のまま game.detail(type: boxscore)に入っている。
  if (game.boxscore && Array.isArray(game.boxscore.headers) && Array.isArray(game.boxscore.rows)) {
    return game.boxscore;
  }
  if (game.detail && game.detail.type === 'boxscore') {
    return game.detail;
  }
  return null;
}

function aggregateBoxscoreSeason(group) {
  const totals = {};
  const order = [];
  let paColumnCount = 0;
  let gamesWithBoxscore = 0;
  (group.games || []).forEach((game) => {
    const d = boxscoreSourceOf(game);
    if (!d) return;
    const idx = {};
    (d.headers || []).forEach((h, i) => { idx[h] = i; });
    const required = ['選手名', '打数', '安打', '単打', '二塁打', '三塁打', '本塁打', '打点', '得点', '三振', '四球', '死球'];
    if (required.some((key) => !(key in idx))) return;
    gamesWithBoxscore++;
    if ('打席' in idx) paColumnCount++;
    (d.rows || []).forEach((row) => {
      const name = row[idx['選手名']];
      if (!name) return;
      if (!totals[name]) {
        totals[name] = { name, PA: 0, AB: 0, H: 0, B1: 0, B2: 0, B3: 0, HR: 0, RBI: 0, Runs: 0, SO: 0, BB: 0, HBP: 0, SH: 0, SF: 0 };
        order.push(name);
      }
      const t = totals[name];
      const num = (key) => { const v = row[idx[key]]; return (v === '-' || v == null) ? 0 : (Number(v) || 0); };
      t.AB += num('打数'); t.H += num('安打'); t.B1 += num('単打'); t.B2 += num('二塁打');
      t.B3 += num('三塁打'); t.HR += num('本塁打'); t.RBI += num('打点'); t.Runs += num('得点');
      t.SO += num('三振'); t.BB += num('四球'); t.HBP += num('死球');
      if ('打席' in idx) t.PA += num('打席');
      if ('犠打' in idx) t.SH += num('犠打');
      if ('犠飛' in idx) t.SF += num('犠飛');
    });
  });
  // すべてのボックススコアに打席(PA)が記録されている場合のみPA列を信頼できるとみなす
  // (2023〜2025年度のように一部の試合にPAが無いと合計が過小になり誤解を招くため)
  const hasReliablePA = gamesWithBoxscore > 0 && paColumnCount === gamesWithBoxscore;
  const rows = order.map((name) => totals[name]).sort((a, b) => (b.AB - a.AB) || (b.H - a.H));
  return { rows, hasReliablePA };
}

function renderSeasonTotalsTable(rows, hasReliablePA) {
  if (!rows.length) return '';
  const body = rows.map((p) => {
    const totalBases = p.B1 + p.B2 * 2 + p.B3 * 3 + p.HR * 4;
    const avg = formatRate(p.H, p.AB);
    const obp = formatRate(p.H + p.BB + p.HBP, p.AB + p.BB + p.HBP);
    const slg = formatRate(totalBases, p.AB);
    return `
            <tr>
              <td>${escapeHtml(p.name)}</td>
              ${hasReliablePA ? `<td>${p.PA}</td>` : ''}
              <td>${p.AB}</td>
              <td>${p.H}</td>
              <td>${p.B2}</td>
              <td>${p.B3}</td>
              <td>${p.HR}</td>
              <td>${p.RBI}</td>
              <td>${p.Runs}</td>
              <td>${p.BB}</td>
              <td>${p.HBP}</td>
              <td>${p.SO}</td>
              ${hasReliablePA ? `<td>${p.SH}</td><td>${p.SF}</td>` : ''}
              <td>${avg}</td>
              <td>${obp}</td>
              <td>${slg}</td>
            </tr>`;
  }).join('');
  return `
      <div class="table-wrap">
        <table class="data-table season-totals">
          <thead>
            <tr>
              <th>選手名</th>
              ${hasReliablePA ? '<th>打席</th>' : ''}
              <th>打数</th><th>安打</th><th>二塁打</th><th>三塁打</th><th>本塁打</th>
              <th>打点</th><th>得点</th><th>四球</th><th>死球</th><th>三振</th>
              ${hasReliablePA ? '<th>犠打</th><th>犠飛</th>' : ''}
              <th>打率</th><th>出塁率</th><th>長打率</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
}

function renderHistory(container, resultsData, statsData, statsFailed) {
  const groups = (resultsData && Array.isArray(resultsData.groups))
    ? resultsData.groups.filter((g) => g.era === 'history') : [];
  if (!groups.length) {
    container.innerHTML = '<p class="placeholder-note">過去の成績は準備中です。</p>';
    return;
  }
  const rankingsById = {};
  ((statsData && statsData.historyRankings) || []).forEach((r) => { rankingsById[r.id] = r; });

  const parts = groups.map((g) => {
    let html = renderResultsGroup(g);
    const ranking = rankingsById[g.id];
    if (ranking) {
      html += `
      <h3 class="table-title">${escapeHtml(ranking.title)}</h3>
      <p class="placeholder-note">${escapeHtml(ranking.note)}</p>
      ${renderRankingGrid(ranking.categories)}`;
    } else if (statsFailed) {
      html += '<p class="placeholder-note">個人成績ランキングの読み込みに失敗しました。</p>';
    }
    const { rows: seasonRows, hasReliablePA } = aggregateBoxscoreSeason(g);
    if (seasonRows.length) {
      html += `
      <h3 class="table-title">${escapeHtml(g.title)} シーズン合計成績</h3>
      <p class="placeholder-note">※ 各試合のボックススコアの合計です。打席数(PA)は犠打・犠飛が記録に含まれないため表示していません。打数(AB)が0の選手は打率などを「-」と表示しています。</p>
      ${renderSeasonTotalsTable(seasonRows, hasReliablePA)}`;
    }
    return html;
  });
  const totalHtml = resultsData.historyTotal
    ? `<p class="league-total">${escapeHtml(resultsData.historyTotal)}</p>` : '';
  container.innerHTML = parts.join('') + totalHtml;
}

function renderPlayers(container, playersData, statsData, statsFailed) {
  const roster = (playersData && Array.isArray(playersData.roster)) ? playersData.roster : [];
  const rosterRows = roster.map((p) => `
            <tr><td>${escapeHtml(p.number)}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.position)}</td></tr>`).join('');
  const rosterHtml = roster.length ? `
      <h3 class="table-title">選手名簿</h3>
      <div class="table-wrap">
        <table class="data-table roster-table">
          <thead>
            <tr><th>背番号</th><th>選手名</th><th>主な守備</th></tr>
          </thead>
          <tbody>${rosterRows}</tbody>
        </table>
      </div>` : '<p class="placeholder-note">選手名簿は準備中です。</p>';

  const ranking = statsData && statsData.seasonRanking;
  let rankingHtml = '';
  if (ranking && Array.isArray(ranking.categories) && ranking.categories.length) {
    rankingHtml = `
      <h3 class="table-title">${escapeHtml(ranking.title || 'シーズンランキング TOP5')}</h3>
      <p class="placeholder-note">${escapeHtml(ranking.note || '')}</p>
      ${renderRankingGrid(ranking.categories)}`;
  } else if (statsFailed) {
    rankingHtml = '<p class="placeholder-note">個人成績ランキングの読み込みに失敗しました。</p>';
  }

  container.innerHTML = rosterHtml + rankingHtml;
}

async function loadSiteData() {
  const scheduleEl = document.getElementById('scheduleContent');
  const resultsEl = document.getElementById('resultsContent');
  const historyEl = document.getElementById('historyContent');
  const playersEl = document.getElementById('playersContent');

  if (scheduleEl) {
    try {
      renderSchedule(scheduleEl, await loadJson('data/schedule.json'));
    } catch (e) {
      scheduleEl.innerHTML = ERROR_NOTE;
    }
  }

  let resultsData = null;
  let resultsFailed = false;
  try {
    resultsData = await loadJson('data/results.json');
  } catch (e) {
    resultsFailed = true;
  }

  if (resultsEl) {
    if (resultsFailed) {
      resultsEl.innerHTML = ERROR_NOTE;
    } else {
      renderResults(resultsEl, resultsData);
    }
  }

  let statsData = null;
  let statsFailed = false;
  try {
    statsData = await loadJson('data/stats.json');
  } catch (e) {
    statsFailed = true;
  }

  if (historyEl) {
    if (resultsFailed) {
      historyEl.innerHTML = ERROR_NOTE;
    } else {
      renderHistory(historyEl, resultsData, statsData, statsFailed);
    }
  }

  if (playersEl) {
    try {
      const playersData = await loadJson('data/players.json');
      renderPlayers(playersEl, playersData, statsData, statsFailed);
    } catch (e) {
      playersEl.innerHTML = ERROR_NOTE;
    }
  }
}

loadSiteData();
