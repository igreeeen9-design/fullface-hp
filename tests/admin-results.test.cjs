const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
// 公開中のdata/は管理画面から随時更新されるため、テストは固定データ(tests/fixtures)を使う。
// アプリが読み書きするパス(data/...)はそのままに、読み込み元だけfixturesへ差し替える
const fixtures = path.join(__dirname, 'fixtures');
const fixturePath = (name) => path.join(fixtures, name.replace(/^data\//, ''));
const readJson = (name) => JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));
const readCsv = (date) => fs.readFileSync(fixturePath(`data/raw-games/${date}.csv`), 'utf8');
const clone = (x) => JSON.parse(JSON.stringify(x));
const script = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

function setup() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '0', style: {}, dataset: {}, innerHTML: '', textContent: '',
      addEventListener() {}, querySelectorAll() { return []; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    localStorage: { getItem: () => '' },
    TextEncoder, TextDecoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch: () => { throw new Error('Unexpected network access'); },
  });
  // ブラウザ起動時の空スタメン描画だけを除き、管理画面の実際の関数を実行する。
  vm.runInContext(script.slice(0, script.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')), context);
  const run = (code) => vm.runInContext(code, context);
  const functions = run('({ prepareResultBoxscores, totalResultBatting, applyResultBattingDelta, buildGameImportFromCsv, applyBattingStatsToPlayers, recomputeSeasonCategories, reconstructAtBatsFromRow, collectBoxscoreFromRow, collectCurrentGroupGames, mergeGameIntoResults, saveResults, loadResults })');
  const files = new Map(['results.json', 'stats.json'].map((name) => [`data/${name}`, readJson(name)]));
  const writes = [];
  context.ghGet = async (name) => {
    if (files.has(name)) return { sha: name + ':sha', content: Buffer.from(JSON.stringify(files.get(name))).toString('base64') };
    const local = fixturePath(name);
    if (fs.existsSync(local)) return { sha: name + ':sha', content: fs.readFileSync(local).toString('base64') };
    const error = new Error('Missing CSV'); error.status = 404; throw error;
  };
  context.ghPut = async (name, data) => {
    writes.push({ name, data: clone(data) });
    files.set(name, clone(data));
    return { content: { sha: name + ':saved' } };
  };
  require('./helpers/csv-github.cjs')(context, files, writes);
  return { context, run, functions, files, writes, element };
}

async function existing() {
  const env = setup();
  const results = readJson('results.json');
  await env.functions.prepareResultBoxscores(results);
  return { ...env, results, baseline: env.functions.totalResultBatting(results), stats: readJson('stats.json') };
}

function editBoxscore(env, game, edit) {
  env.context.gameForTest = game;
  const boxscore = clone(env.run('resultBoxscores.get(gameForTest) || gameForTest.boxscore'));
  edit(boxscore);
  game.boxscore = boxscore;
  env.run('resultBoxscores.set(gameForTest, gameForTest.boxscore)');
}

function panelForBoxscore(env, boxscore) {
  const headers = boxscore.headers;
  const cards = boxscore.rows.map((row) => ({
    _sb: Number(row[headers.indexOf('盗塁')] || 0),
    querySelector(selector) {
      const label = { '.bx-name': '選手名', '.bx-position': '守備', '.bx-rbi': '打点', '.bx-runs': '得点' }[selector];
      return { value: String(row[headers.indexOf(label)] || '') };
    },
    querySelectorAll() {
      return env.functions.reconstructAtBatsFromRow(headers, row).map((value) => ({ value }));
    },
  }));
  return { querySelectorAll: () => cards };
}

function editedPanelBoxscore(env, boxscore) {
  return env.functions.collectBoxscoreFromRow({
    dataset: { bxInit: '1' },
    querySelector: () => panelForBoxscore(env, boxscore),
  });
}

test('固定データ(2026年10試合): CSV補完と無変更保存で通算・ランキング・過去年度を完全維持', async () => {
  const env = await existing();
  const before = clone(env.stats);
  const resultsBefore = clone(env.results);
  assert.equal(env.results.groups.filter((g) => g.era === 'current').flatMap((g) => g.games).length, 10);
  assert.equal(env.baseline.size, 19);
  assert.equal(env.functions.applyResultBattingDelta(env.stats, env.baseline, env.functions.totalResultBatting(env.results)), false);
  assert.deepEqual(env.stats, before);
  assert.deepEqual(env.results, resultsBefore);
  // 全試合の編集パネルを開いて保存した場合も、再構成で値が変わらない。
  for (const group of env.results.groups.filter((g) => g.era === 'current')) {
    for (const game of group.games) editBoxscore(env, game, (b) => Object.assign(b, editedPanelBoxscore(env, b)));
  }
  assert.equal(env.functions.applyResultBattingDelta(env.stats, env.baseline, env.functions.totalResultBatting(env.results)), false);
  assert.deepEqual(env.stats, before);
});

test('凡打を本塁打へ訂正: 通算とランキングを更新し、他選手・盗塁・投手勝利数・過去年度を維持', async () => {
  const env = await existing();
  const before = clone(env.stats);
  const game = env.results.groups[0].games[0];
  editBoxscore(env, game, (b) => {
    const r = b.rows.find((r) => r[b.headers.indexOf('選手名')] === '中西');
    for (const label of ['安打', '本塁打', '打点']) r[b.headers.indexOf(label)] = String(Number(r[b.headers.indexOf(label)]) + 1);
  });
  assert.equal(env.functions.applyResultBattingDelta(env.stats, env.baseline, env.functions.totalResultBatting(env.results)), true);
  const rec = env.stats.seasonRanking.players.find((p) => p.name === '中西');
  const old = before.seasonRanking.players.find((p) => p.name === '中西');
  assert.equal(rec.h, old.h + 1); assert.equal(rec.hr, old.hr + 1); assert.equal(rec.rbi, old.rbi + 1);
  assert.equal(rec.ab, old.ab); assert.equal(rec.gp, old.gp); assert.equal(rec.sb, old.sb);
  assert.equal(rec.avg, '.188'); assert.equal(rec.slg, '.375');
  assert.deepEqual(env.stats.seasonRanking.players.filter((p) => p.name !== '中西'), before.seasonRanking.players.filter((p) => p.name !== '中西'));
  assert.deepEqual(env.stats.historyRankings, before.historyRankings);
  assert.deepEqual(env.stats.seasonRanking.categories.find((c) => c.label === '勝利数'), before.seasonRanking.categories.find((c) => c.label === '勝利数'));
  assert.ok(env.stats.seasonRanking.categories.find((c) => c.label === '本塁打').entries.some((e) => e.name.includes('中西')));
  const saved = clone(env.stats);
  const baseline = env.functions.totalResultBatting(env.results);
  env.functions.applyResultBattingDelta(env.stats, baseline, baseline);
  assert.deepEqual(clone(env.stats), saved);
});

test('打点だけの訂正では既存の率を再計算しない', async () => {
  const env = await existing();
  const before = clone(env.stats);
  editBoxscore(env, env.results.groups[0].games[0], (b) => b.rows[0][b.headers.indexOf('打点')] = '2');
  env.functions.applyResultBattingDelta(env.stats, env.baseline, env.functions.totalResultBatting(env.results));
  for (const rec of env.stats.seasonRanking.players) {
    const old = before.seasonRanking.players.find((p) => p.name === rec.name);
    for (const key of ['avg', 'obp', 'slg', 'ops']) assert.equal(rec[key], old[key]);
  }
});

test('手入力の新規登録・選手削除・試合削除を差分反映できる', async () => {
  const env = await existing();
  const before = clone(env.stats);
  const csv = readCsv('2026-09-13');
  const imported = env.functions.buildGameImportFromCsv(csv);
  imported.game.date = '2026-09-27';
  imported.game.boxscore.rows = [imported.game.boxscore.rows[0]];
  imported.game.boxscore.rows[0][1] = '新選手';
  env.results.groups[0].games.push(imported.game);
  const added = env.functions.totalResultBatting(env.results);
  env.functions.applyResultBattingDelta(env.stats, env.baseline, added);
  assert.equal(env.stats.seasonRanking.players.find((p) => p.name === '新選手').gp, 1);
  imported.game.boxscore.rows = [];
  const removed = env.functions.totalResultBatting(env.results);
  env.functions.applyResultBattingDelta(env.stats, added, removed);
  assert.equal(env.stats.seasonRanking.players.find((p) => p.name === '新選手').gp, 0);
  assert.deepEqual(env.stats.seasonRanking.players.filter((p) => p.name !== '新選手'), before.seasonRanking.players);
  const game = env.results.groups[0].games.shift();
  env.functions.applyResultBattingDelta(env.stats, removed, env.functions.totalResultBatting(env.results));
  assert.equal(env.stats.seasonRanking.players.find((p) => p.name === '中西').gp, before.seasonRanking.players.find((p) => p.name === '中西').gp - 1);
  env.results.groups[0].games.unshift(game);
});

test('CSV取り込みの既存計算と、新規試合を通常保存する計算が一致する', async () => {
  const env = await existing();
  const imp = env.functions.buildGameImportFromCsv(readCsv('2026-09-13'));
  imp.game.date = '2026-09-27';
  env.functions.mergeGameIntoResults(env.results, imp.game, 'league');
  assert.throws(() => env.functions.mergeGameIntoResults(env.results, imp.game, 'league'), /同じ日付/);
  const expected = clone(env.stats);
  env.functions.applyBattingStatsToPlayers(expected.seasonRanking.players, imp.playerStats);
  env.functions.recomputeSeasonCategories(expected.seasonRanking);
  env.functions.applyResultBattingDelta(env.stats, env.baseline, env.functions.totalResultBatting(env.results));
  assert.deepEqual(clone(env.stats), clone(expected));
});

test('スコアだけの保存でstats.jsonを書き換えない / 成績訂正は両方保存し再保存で二重加算しない', async () => {
  const env = await existing();
  env.context.testData = env.results;
  env.context.testBaseline = env.baseline;
  env.run("states.results = { sha: 'original', data: testData, battingBaseline: testBaseline }; applyCurrentGroupEditsToStatePrevious = () => {};");
  env.results.groups[0].games[0].score = '6 - 6';
  env.results.groups[0].games[0].resultClass = 'draw';
  await env.functions.saveResults();
  assert.deepEqual(env.writes.map((w) => w.name), ['data/results.json']);
  editBoxscore(env, env.results.groups[0].games[0], (b) => b.rows[0][b.headers.indexOf('打点')] = '1');
  await env.functions.saveResults();
  assert.deepEqual(env.writes.slice(1).map((w) => w.name), ['data/results.json', 'data/stats.json']);
  const savedStats = clone(env.files.get('data/stats.json'));
  await env.functions.saveResults();
  assert.deepEqual(env.files.get('data/stats.json'), savedStats);
  assert.equal(env.writes.filter((w) => w.name === 'data/stats.json').length, 1);
});

test('元CSVの通信失敗と不正な通算差分は保存前に検出', async () => {
  const env = await existing();
  env.context.ghGet = async () => { const e = new Error('通信失敗'); e.status = 500; throw e; };
  await assert.rejects(env.functions.prepareResultBoxscores(readJson('results.json')), /通信失敗/);
  const stats = clone(env.stats);
  const before = new Map([['中西', { h: 999 }]]);
  assert.throws(() => env.functions.applyResultBattingDelta(stats, before, new Map()), /保存を中止/);
  assert.equal(env.writes.length, 0);
});

test('日付変更でも元CSVの成績を保持し、全選手を消した編集は空のboxscoreとして保存', async () => {
  const env = await existing();
  const game = env.results.groups[0].games[0];
  const values = { '.res-us': '5', '.res-them': '6', '.res-date': '2026-09-14', '.res-opponent': game.opponent, '.res-venue': game.venue };
  const row = {
    dataset: {}, _originalGame: game,
    querySelector: (selector) => selector === '.boxscore-panel' ? null : { value: values[selector] },
  };
  env.context.document.querySelectorAll = () => [row];
  const collected = env.functions.collectCurrentGroupGames()[0];
  assert.ok(collected.boxscore);
  env.results.groups[0].games[0] = collected;
  assert.equal(env.functions.applyResultBattingDelta(env.stats, env.baseline, env.functions.totalResultBatting(env.results)), false);
  const reloaded = clone(env.results);
  await env.functions.prepareResultBoxscores(reloaded);
  assert.deepEqual(clone([...env.functions.totalResultBatting(reloaded)]), clone([...env.baseline]));
  row.dataset.bxInit = '1';
  row.querySelector = (selector) => selector === '.boxscore-panel' ? { querySelectorAll: () => [] } : { value: values[selector] };
  const emptied = env.functions.collectCurrentGroupGames()[0];
  assert.equal(emptied.boxscore.rows.length, 0);
  env.results.groups[0].games[0] = emptied;
  const removed = env.functions.totalResultBatting(env.results);
  assert.equal(removed.get('中西').gp, env.baseline.get('中西').gp - 1);
});

test('成績保存だけ失敗した後、同じ画面で再試行すると差分を一度だけ反映', async () => {
  const env = await existing();
  env.context.testData = env.results;
  env.context.testBaseline = env.baseline;
  env.run("states.results = { sha: 'original', data: testData, battingBaseline: testBaseline }; applyCurrentGroupEditsToStatePrevious = () => {};");
  editBoxscore(env, env.results.groups[0].games[0], (b) => b.rows[0][b.headers.indexOf('打点')] = '1');
  const originalPut = env.context.ghPut;
  let fail = true;
  env.context.ghPut = async (...args) => {
    if (args[0] === 'data/stats.json' && fail) { fail = false; throw new Error('成績保存の通信失敗'); }
    return originalPut(...args);
  };
  await env.functions.saveResults();
  assert.match(env.element('statusMsg').textContent, /通信失敗/);
  assert.deepEqual(env.files.get('data/stats.json'), readJson('stats.json'));
  await env.functions.saveResults();
  const previous = readJson('stats.json').seasonRanking.players.find((p) => p.name === '中西');
  const saved = env.files.get('data/stats.json').seasonRanking.players.find((p) => p.name === '中西');
  assert.equal(saved.rbi, previous.rbi + 1);
  await env.functions.saveResults();
  assert.equal(env.writes.filter((w) => w.name === 'data/stats.json').length, 1);
});

test('元CSVのない手入力試合も読み込め、CSV由来の氏名表記ゆれを既存19選手に統合', async () => {
  const env = await existing();
  assert.deepEqual([...env.baseline.keys()].sort(), env.stats.seasonRanking.players.map((p) => p.name).sort());
  const data = { groups: [{ era: 'current', games: [{ date: '2026-10-01', opponent: '手入力' }] }] };
  await env.functions.prepareResultBoxscores(data);
  assert.equal(env.functions.totalResultBatting(data).size, 0);
});

test('盗塁列のない旧boxscoreも未編集保存・日付変更で盗塁を失わない', async () => {
  const env = setup();
  const results = readJson('results.json');
  const game = results.groups[0].games[0];
  const imp = env.functions.buildGameImportFromCsv(readCsv('2026-09-13'));
  game.boxscore = clone(imp.game.boxscore);
  game.boxscore.headers.pop(); game.boxscore.rows.forEach((r) => r.pop());
  await env.functions.prepareResultBoxscores(results);
  const baseline = env.functions.totalResultBatting(results);
  const values = { '.res-us': '5', '.res-them': '6', '.res-date': '2026-09-14', '.res-opponent': game.opponent, '.res-venue': game.venue };
  const row = { dataset: {}, _originalGame: game, querySelector: (s) => s === '.boxscore-panel' ? {} : { value: values[s] } };
  env.context.document.querySelectorAll = () => [row];
  results.groups[0].games[0] = env.functions.collectCurrentGroupGames()[0];
  const reloaded = clone(results);
  await env.functions.prepareResultBoxscores(reloaded);
  assert.deepEqual(clone([...env.functions.totalResultBatting(reloaded)]), clone([...baseline]));
});

test('CSVの実際の保存処理から通常保存・再編集へ移っても二重加算しない', async () => {
  const env = setup();
  env.run('renderResultsGroupSelect = () => {}; renderResultsGameList = () => {}; applyCurrentGroupEditsToStatePrevious = () => {};');
  const csvText = readCsv('2026-09-13').replace('9/13,', '9/27,');
  const imp = env.functions.buildGameImportFromCsv(csvText);
  Object.assign(imp, { csvText, resultsData: readJson('results.json'), resultsSha: 'data/results.json:sha', statsData: readJson('stats.json'), statsSha: 'data/stats.json:sha' });
  env.context.importForTest = imp;
  env.run('pendingCsvImport = importForTest;');
  await env.run('commitCsvImport()');
  assert.equal(env.files.get('data/results.json').groups[0].games.length, 9);
  const importedStats = clone(env.files.get('data/stats.json'));
  assert.ok(env.run('states.results.battingBaseline'));
  await env.functions.saveResults();
  assert.deepEqual(env.files.get('data/stats.json'), importedStats);
  const game = env.run('states.results.data.groups[0].games[0]');
  editBoxscore(env, game, (b) => b.rows[0][b.headers.indexOf('打点')] = '1');
  await env.functions.saveResults();
  const old = importedStats.seasonRanking.players.find((p) => p.name === '中西');
  const updated = env.files.get('data/stats.json').seasonRanking.players.find((p) => p.name === '中西');
  assert.equal(updated.rbi, old.rbi + 1);
  assert.equal(updated.gp, old.gp);
});

// フォーム収集→グループへの反映→GitHub保存まで実際の関数を通す。
function bindResultsForm(env, date, edit) {
  const games = env.run('states.results.data.groups[0].games');
  let editedSource;
  const rows = games.map((game) => {
    const [us, them] = game.score.split('-').map((s) => s.trim());
    const values = { '.res-us': us, '.res-them': them, '.res-date': game.date, '.res-opponent': game.opponent, '.res-venue': game.venue };
    let panel = null;
    if (game.date === date) {
      env.context.gameForTest = game;
      const source = clone(env.run('resultBoxscores.get(gameForTest) || gameForTest.boxscore'));
      editedSource = clone(source);
      if (edit) edit(source);
      panel = panelForBoxscore(env, source);
    }
    return {
      dataset: panel ? { bxInit: '1' } : {}, _originalGame: game,
      querySelector: (s) => s === '.boxscore-panel' ? panel : { value: values[s] },
    };
  });
  env.context.document.querySelectorAll = () => rows;
  return editedSource;
}

for (const importFirst of [false, true]) {
  test(`${importFirst ? 'CSV取り込み後の' : ''}既存試合をフォームから修正・連続保存・再読込保存: 全通算値とランキングの一致、盗塁保持`, async () => {
    const env = setup();
    env.run('renderResultsGroupSelect = () => {}; renderResultsGameList = () => {};');
    if (importFirst) {
      const csvText = readCsv('2026-09-13').replace('9/13,', '9/27,');
      const imp = env.functions.buildGameImportFromCsv(csvText);
      Object.assign(imp, { csvText, resultsData: readJson('results.json'), resultsSha: 'data/results.json:sha', statsData: readJson('stats.json'), statsSha: 'data/stats.json:sha' });
      env.context.importForTest = imp;
      env.run('pendingCsvImport = importForTest;');
      await env.run('commitCsvImport()');
    } else {
      await env.functions.loadResults();
    }
    const expected = clone(env.files.get('data/stats.json'));
    const initialStealRanking = clone(expected.seasonRanking.categories.find((c) => c.label === '盗塁'));
    expected.seasonRanking.players.find((p) => p.name === '大淵').rbi += 1;
    env.functions.recomputeSeasonCategories(expected.seasonRanking);
    const source = bindResultsForm(env, '2026-03-01', (box) => {
      const row = box.rows.find((r) => r[box.headers.indexOf('選手名')] === '大淵');
      const index = box.headers.indexOf('打点');
      row[index] = String(Number(row[index]) + 1);
    });
    const sourceSteals = source.rows.map((r) => r[source.headers.indexOf('盗塁')]);
    assert.ok(sourceSteals.some((n) => Number(n) > 0));
    for (let i = 0; i < 2; i++) {
      await env.functions.saveResults();
      assert.notEqual(env.element('statusMsg').className, 'err', env.element('statusMsg').textContent);
      assert.deepEqual(env.files.get('data/stats.json'), clone(expected));
    }
    const savedGame = env.files.get('data/results.json').groups[0].games.find((g) => g.date === '2026-03-01');
    assert.deepEqual(savedGame.boxscore.rows.map((r) => r[savedGame.boxscore.headers.indexOf('盗塁')]), sourceSteals);
    // 同順位内の名前の順番は既存の再計算で変わりうるため、順位・人数・値を比較する。
    const rankedEntries = (category) => category.entries.map((entry) => ({
      value: entry.value, names: entry.name.split('・').sort(),
    }));
    assert.deepEqual(rankedEntries(env.files.get('data/stats.json').seasonRanking.categories.find((c) => c.label === '盗塁')), rankedEntries(initialStealRanking));
    await env.functions.loadResults();
    bindResultsForm(env, '2026-03-01');
    await env.functions.saveResults();
    assert.deepEqual(env.files.get('data/stats.json'), clone(expected));
    assert.equal(env.writes.filter((w) => w.name === 'data/stats.json').length, importFirst ? 2 : 1);
  });
}
