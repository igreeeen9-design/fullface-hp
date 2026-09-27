const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const installGitHub = require('./helpers/csv-github.cjs');
const root = path.resolve(__dirname, '..');
// 公開中のdata/は管理画面から随時更新されるため、テストは固定データ(tests/fixtures)を使う
const fixtures = path.join(__dirname, 'fixtures');
const read = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const script = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function setup() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] },
    localStorage: { getItem: () => '' }, TextEncoder, TextDecoder,
    btoa: (v) => Buffer.from(v, 'binary').toString('base64'), atob: (v) => Buffer.from(v, 'base64').toString('binary') });
  vm.runInContext(script.slice(0, script.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')), context);
  const files = new Map(['results.json', 'stats.json'].map((name) => ['data/' + name, read(name)]));
  const mock = installGitHub(context, files);
  const csvText = fs.readFileSync(path.join(fixtures, 'raw-games/2026-09-13.csv'), 'utf8').replace('9/13,', '9/27,');
  const imp = context.buildGameImportFromCsv(csvText);
  Object.assign(imp, { csvText, resultsData: read('results.json'), statsData: read('stats.json'),
    resultsSha: 'data/results.json:sha', statsSha: 'data/stats.json:sha' });
  return { context, files, mock, imp, element };
}

test('通常取り込み: 3ファイルを一括公開し、従来の成績・ランキング計算、元データを維持', async () => {
  const { context: c, imp, files, mock } = setup();
  const before = clone(imp);
  const expectedResults = clone(imp.resultsData);
  const expectedStats = clone(imp.statsData);
  c.mergeGameIntoResults(expectedResults, clone(imp.game), imp.group);
  c.applyBattingStatsToPlayers(expectedStats.seasonRanking.players, imp.playerStats);
  c.recomputeSeasonCategories(expectedStats.seasonRanking);
  await c.saveCsvImport(imp);
  assert.deepEqual(files.get('data/results.json'), clone(expectedResults));
  assert.deepEqual(files.get('data/stats.json'), clone(expectedStats));
  assert.equal(files.get('data/raw-games/2026-09-27.csv'), imp.csvText);
  assert.equal(mock.publications, 1);
  assert.deepEqual(clone({ ...imp, attempt: undefined }), before);
  assert.equal(mock.calls.filter((x) => x.route === 'git/commits').length, 1);
  await c.saveCsvImport(imp);
  assert.equal(mock.publications, 1);
  // 再解析した同一CSVも日付重複で停止し、再加算しない。
  await assert.rejects(c.saveCsvImport({ ...before }), /同じ日付/);
  assert.deepEqual(files.get('data/stats.json'), clone(expectedStats));
});

for (const [label, failBlob] of [['results', 1], ['stats', 2], ['元CSV', 3]]) {
  test(`${label}準備中の失敗: 公開データ・一時データは不変、コミット未作成、再試行できる`, async () => {
    const { context: c, imp, files, mock } = setup();
    const before = clone(imp);
    mock.failBlob = failBlob;
    await assert.rejects(c.saveCsvImport(imp), /blob failure/);
    assert.equal(mock.head, 'base');
    assert.equal(mock.publications, 0);
    assert.deepEqual(files.get('data/results.json'), read('results.json'));
    assert.deepEqual(files.get('data/stats.json'), read('stats.json'));
    assert.deepEqual(clone(imp), before);
    assert.ok(!mock.calls.some((x) => x.route === 'git/commits'));
    mock.failBlob = 0;
    await c.saveCsvImport(imp);
    assert.equal(mock.publications, 1);
  });
}

for (const route of ['git/trees', 'git/commits']) {
  test(`${route}失敗でもmainは不変`, async () => {
    const { context: c, imp, files, mock } = setup();
    mock.failPath = route;
    await assert.rejects(c.saveCsvImport(imp));
    assert.equal(mock.publications, 0);
    assert.deepEqual(files.get('data/stats.json'), read('stats.json'));
    mock.failPath = '';
    await c.saveCsvImport(imp);
    assert.equal(mock.publications, 1);
  });
}

test('プレビュー後のSHA変更で停止し、オブジェクトも作成しない', async () => {
  const { context: c, imp, mock } = setup();
  imp.statsSha = 'outdated';
  await assert.rejects(c.saveCsvImport(imp), /他の更新/);
  assert.ok(!mock.calls.some((x) => x.method === 'POST'));
});

test('他端末が保存直前に更新: force:falseで停止し、再試行も上書きしない', async () => {
  const { context: c, imp, mock, files } = setup();
  mock.race = true;
  await assert.rejects(c.saveCsvImport(imp), /他の更新/);
  assert.equal(mock.head, 'other');
  await assert.rejects(c.saveCsvImport(imp), /他の更新/);
  assert.equal(mock.publications, 0);
  assert.deepEqual(files.get('data/results.json'), read('results.json'));
  assert.deepEqual(files.get('data/stats.json'), read('stats.json'));
});

for (const descendant of [false, true]) {
  test(`保存成功後の応答消失: ${descendant ? '後続更新があっても' : 'HEADで'}反映を確認し二重加算しない`, async () => {
    const { context: c, imp, mock, files } = setup();
    mock.loseResponse = true;
    mock.descendant = descendant;
    await c.saveCsvImport(imp);
    const saved = clone(files.get('data/stats.json'));
    await c.saveCsvImport(imp);
    assert.equal(mock.publications, 1);
    assert.deepEqual(files.get('data/stats.json'), saved);
  });
}

test('応答消失後の確認も失敗: 成功扱いせず、復旧後に同じコミットを確認', async () => {
  const { context: c, imp, mock } = setup();
  mock.loseResponse = true;
  mock.failChecks = true;
  await assert.rejects(c.saveCsvImport(imp), /保存結果を確認できません/);
  const commit = imp.attempt.commitSha;
  await assert.rejects(c.saveCsvImport(imp), /verification unavailable/);
  mock.failChecks = false;
  await c.saveCsvImport(imp);
  assert.equal(imp.attempt.commitSha, commit);
  assert.equal(mock.publications, 1);
});

test('ref更新前の通信失敗: 準備済みコミットを再利用して一度だけ公開', async () => {
  const { context: c, imp, mock } = setup();
  mock.failPath = 'git/refs/heads/main';
  await assert.rejects(c.saveCsvImport(imp));
  assert.equal(mock.publications, 0);
  mock.failPath = '';
  await c.saveCsvImport(imp);
  assert.equal(mock.publications, 1);
  assert.equal(mock.calls.filter((x) => x.route === 'git/commits').length, 1);
});

test('画面: 元CSV失敗は成功表示せず再試行可能、成功時だけ入力をクリア', async () => {
  const { context: c, imp, mock, element } = setup();
  c.testImport = imp;
  vm.runInContext('pendingCsvImport = testImport; loadResults = async () => {};', c);
  mock.failBlob = 3;
  await c.commitCsvImport();
  assert.match(element('csvCommitNote').innerHTML, /blob failure/);
  assert.equal(element('csvCommitBtn').disabled, false);
  assert.equal(vm.runInContext('pendingCsvImport', c), imp);
  mock.failBlob = 0;
  await c.commitCsvImport();
  assert.match(element('csvPreviewArea').innerHTML, /まとめて保存/);
  assert.equal(vm.runInContext('pendingCsvImport', c), null);
});

test('元CSVが既に存在する場合は上書きせず、コミット作成前に停止', async () => {
  const { context: c, imp, files } = setup();
  files.set('data/raw-games/2026-09-27.csv', 'existing csv');
  const mock = installGitHub(c, files);
  await assert.rejects(c.saveCsvImport(imp), /元CSVが既に存在/);
  assert.equal(mock.publications, 0);
  assert.equal(files.get('data/raw-games/2026-09-27.csv'), 'existing csv');
  assert.ok(!mock.calls.some((x) => x.method === 'POST'));
});

test('保存開始時のデータ取得失敗では一時データを保持し、再試行できる', async () => {
  const { context: c, imp, mock } = setup();
  const before = clone(imp);
  mock.failPath = 'contents/data/stats.json?ref=base';
  await assert.rejects(c.saveCsvImport(imp));
  assert.deepEqual(clone(imp), before);
  assert.equal(mock.publications, 0);
  mock.failPath = '';
  await c.saveCsvImport(imp);
  assert.equal(mock.publications, 1);
});

function replacementSetup(correction = '二ゴロ') {
  const env = setup();
  const { context: c, files } = env;
  const oldCsv = fs.readFileSync(path.join(fixtures, 'raw-games/2026-09-13.csv'), 'utf8');
  const original = c.buildGameImportFromCsv(oldCsv);
  const results = read('results.json');
  const group = results.groups.find(g => g.games.some(x => x.date === '2026-09-13'));
  const index = group.games.findIndex(x => x.date === '2026-09-13');
  group.games[index] = { ...clone(original.game), gameId: 'explicit-target', rawCsvPath: 'data/raw-games/original.csv' };
  files.set('data/results.json', results);
  files.set('data/raw-games/original.csv', oldCsv);
  const csvText = oldCsv.replace('一ゴロ', correction);
  const imp = { ...c.buildGameImportFromCsv(csvText), csvText, mode: 'replace', targetGameId: 'explicit-target',
    resultsSha: 'data/results.json:sha', statsSha: 'data/stats.json:sha', rawSha: 'data/raw-games/original.csv:sha' };
  return { ...env, imp, mock: installGitHub(c, files), beforeResults: clone(results), beforeStats: clone(files.get('data/stats.json')) };
}

test('差し替え: 一ゴロ→二ゴロは元CSVのみ訂正し、通算成績・ランキング・他試合を保持', async () => {
  const { context: c, imp, files, beforeResults, beforeStats } = replacementSetup();
  await c.saveCsvImport(imp);
  assert.deepEqual(files.get('data/results.json'), beforeResults);
  assert.deepEqual(files.get('data/stats.json'), beforeStats);
  assert.equal(files.get('data/raw-games/original.csv'), imp.csvText);
});

test('差し替え: 凡打→二塁打＋打点1は対象選手の差分と率・ランキングだけ反映、再適用は変更なし', async () => {
  const { context: c, imp, files, beforeResults, beforeStats, mock } = replacementSetup('"左２安\n打点１"');
  await c.saveCsvImport(imp);
  const stats = files.get('data/stats.json');
  const before = beforeStats.seasonRanking.players.find(p => p.name === '藤岡');
  const after = stats.seasonRanking.players.find(p => p.name === '藤岡');
  const expected = { ...before, h: before.h + 1, b2: before.b2 + 1, rbi: before.rbi + 1 };
  c.updateBattingRates(expected);
  assert.deepEqual(after, expected);
  assert.notEqual(after.avg, before.avg);
  assert.notDeepEqual(stats.seasonRanking.categories, beforeStats.seasonRanking.categories);
  assert.deepEqual(stats.seasonRanking.players.filter(p => p.name !== '藤岡'), beforeStats.seasonRanking.players.filter(p => p.name !== '藤岡'));
  const otherGames = data => data.groups.flatMap(g => g.games).filter(g => g.gameId !== 'explicit-target');
  assert.deepEqual(otherGames(files.get('data/results.json')), otherGames(beforeResults));
  const target = c.findCsvReplacement(files.get('data/results.json'), 'explicit-target').game;
  assert.equal(target.rawCsvPath, 'data/raw-games/original.csv');
  assert.equal(files.get(target.rawCsvPath), imp.csvText);
  const saved = clone(stats);
  const outcome = await c.saveCsvImport({ ...imp, attempt: undefined });
  assert.equal(outcome.unchanged, true);
  assert.equal(mock.publications, 1);
  assert.deepEqual(files.get('data/stats.json'), saved);
});

for (const failBlob of [1, 2, 3]) test(`差し替え: blob ${failBlob}失敗時は3ファイル・入力不変で再試行可能`, async () => {
  const { context: c, imp, files, mock } = replacementSetup();
  const before = clone([...files]);
  const input = clone(imp);
  mock.failBlob = failBlob;
  await assert.rejects(c.saveCsvImport(imp), /blob failure/);
  assert.deepEqual(clone([...files]), before);
  assert.deepEqual(clone(imp), input);
  mock.failBlob = 0;
  await c.saveCsvImport(imp);
  assert.equal(mock.publications, 1);
});

test('差し替え: raw CSVのSHA競合で書き込み前に停止', async () => {
  const { context: c, imp, mock } = replacementSetup();
  imp.rawSha = 'stale';
  await assert.rejects(c.saveCsvImport(imp), /他の更新/);
  assert.ok(!mock.calls.some(x => x.method === 'POST'));
});

test('差し替え: 他端末更新は上書きしない', async () => {
  const { context: c, imp, mock, files } = replacementSetup();
  const before = clone([...files]);
  mock.race = true;
  await assert.rejects(c.saveCsvImport(imp), /他の更新/);
  assert.deepEqual(clone([...files]), before);
});

test('差し替え: 応答消失・確認失敗から同じコミットを確認し再加算しない', async () => {
  const { context: c, imp, mock, files } = replacementSetup('"左２安\n打点１"');
  mock.loseResponse = true;
  mock.failChecks = true;
  await assert.rejects(c.saveCsvImport(imp), /保存結果を確認できません/);
  const saved = clone([...files]);
  mock.failChecks = false;
  await c.saveCsvImport(imp);
  assert.deepEqual(clone([...files]), saved);
  assert.equal(mock.publications, 1);
});

test('差し替え: ID不明・重複・共有パスは停止し日付から推測しない', () => {
  const { context: c, beforeResults } = replacementSetup();
  assert.throws(() => c.findCsvReplacement(beforeResults, 'missing'), /gameId/);
  const target = c.findCsvReplacement(beforeResults, 'explicit-target');
  target.group.games.push(clone(target.game));
  assert.throws(() => c.findCsvReplacement(beforeResults, 'explicit-target'), /gameId/);
  target.group.games.at(-1).gameId = 'other';
  assert.throws(() => c.findCsvReplacement(beforeResults, 'explicit-target'), /共有/);
});

test('差分表示: 数値が同じ打席訂正も修正前後を表示しHTMLをエスケープ', () => {
  const { context: c } = setup();
  const html = c.renderCsvChanges(['一ゴロ', '<script>'], ['二ゴロ', '訂正'], '元CSV');
  assert.match(html, /一ゴロ/);
  assert.match(html, /二ゴロ/);
  assert.match(html, /&lt;script&gt;/);
});

test('差し替え: 旧形式のboxscoreなし・盗塁列なしも元CSVで補完し再加算しない', () => {
  for (const missingBox of [true, false]) {
    const { context: c, imp, beforeResults, beforeStats, files } = replacementSetup();
    const target = c.findCsvReplacement(beforeResults, imp.targetGameId).game;
    if (missingBox) delete target.boxscore;
    else {
      const index = target.boxscore.headers.indexOf('盗塁');
      target.boxscore.headers.splice(index, 1);
      target.boxscore.rows.forEach(row => row.splice(index, 1));
    }
    const original = clone(beforeStats);
    c.prepareCsvReplacement(beforeResults, beforeStats, imp, files.get('data/raw-games/original.csv'));
    assert.deepEqual(beforeStats, original);
  }
});

test('差し替え: 修正前は古いCSVではなく手動編集済みboxscoreの数値を使う', () => {
  const { context: c, imp, beforeResults, beforeStats, files } = replacementSetup();
  const box = c.findCsvReplacement(beforeResults, imp.targetGameId).game.boxscore;
  const row = box.rows.find(row => row[box.headers.indexOf('選手名')] === '藤岡');
  row[box.headers.indexOf('打点')] = String(Number(row[box.headers.indexOf('打点')]) + 1);
  beforeStats.seasonRanking.players.find(p => p.name === '藤岡').rbi += 1;
  const expected = beforeStats.seasonRanking.players.find(p => p.name === '藤岡').rbi - 1;
  c.prepareCsvReplacement(beforeResults, beforeStats, imp, files.get('data/raw-games/original.csv'));
  assert.equal(beforeStats.seasonRanking.players.find(p => p.name === '藤岡').rbi, expected);
});

test('管理画面: ID選択→プレビューにセル訂正の差分→差し替え保存→再読込は変更なし', async () => {
  const { context: c, imp, element, files } = replacementSetup();
  element('csvImportMode').value = 'replace';
  element('csvReplacementGame').value = imp.targetGameId;
  element('csvFileInput').files = [{ text: async () => imp.csvText }];
  await element('csvParseBtn').listeners.click();
  const html = element('csvPreviewArea').innerHTML;
  assert.match(html, /explicit-target/);
  assert.match(html, /一ゴロ/);
  assert.match(html, /二ゴロ/);
  assert.match(html, /選択した試合を修正版CSVで差し替える/);
  vm.runInContext('loadResults = async () => {};', c);
  await element('csvCommitBtn').listeners.click();
  assert.equal(files.get('data/raw-games/original.csv'), imp.csvText);
  await element('csvParseBtn').listeners.click();
  assert.match(element('csvPreviewArea').innerHTML, /変更なし/);
});
