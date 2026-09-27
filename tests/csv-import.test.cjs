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
  files.set('data/schedule.json', { games: [] });
  files.set('data/players.json', read('players.json'));
  const mock = installGitHub(context, files);
  const csvText = fs.readFileSync(path.join(fixtures, 'raw-games/2026-09-13.csv'), 'utf8').replace('9/13,', '9/27,');
  const imp = context.buildGameImportFromCsv(csvText);
  Object.assign(imp, { csvText, resultsData: read('results.json'), statsData: read('stats.json'),
    resultsSha: 'data/results.json:sha', statsSha: 'data/stats.json:sha',
    identitySelected: true, scheduleId: null, scheduleSha: 'data/schedule.json:sha' });
  Object.assign(imp.game, context.newCsvIdentity(imp.resultsData, { games: [] }, imp.game.date, null));
  element('csvParticipantsConfirmed').checked = true;
  context.document.querySelectorAll = selector => selector.includes('[data-gp-member]') ? (vm.runInContext('pendingCsvImport?.playerStats || []', context)).map(p => ({value:p.name,checked:true})) : [];
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
  assert.equal(files.get('data/raw-games/2026-09-27-01.csv'), imp.csvText);
  assert.equal(mock.publications, 1);
  assert.deepEqual(clone({ ...imp, attempt: undefined }), before);
  assert.equal(mock.calls.filter((x) => x.route === 'git/commits').length, 1);
  await c.saveCsvImport(imp);
  assert.equal(mock.publications, 1);
  // 同一gameIdで再保存しても重複で停止し、再加算しない。
  await assert.rejects(c.saveCsvImport({ ...before }), /同じgameId/);
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
  files.set('data/raw-games/2026-09-27-01.csv', 'existing csv');
  const mock = installGitHub(c, files);
  await assert.rejects(c.saveCsvImport(imp), /元CSVが既に存在/);
  assert.equal(mock.publications, 0);
  assert.equal(files.get('data/raw-games/2026-09-27-01.csv'), 'existing csv');
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

function newImportFor(env, csvText, scheduleId = null) {
  const { context: c, files } = env;
  const imp = { ...c.buildGameImportFromCsv(csvText), csvText, mode: 'new',
    resultsData: clone(files.get('data/results.json')), statsData: clone(files.get('data/stats.json')),
    resultsSha: 'data/results.json:sha', statsSha: 'data/stats.json:sha', scheduleSha: 'data/schedule.json:sha',
    identitySelected: true, scheduleId, confirmSeparate: true };
  Object.assign(imp.game, c.newCsvIdentity(imp.resultsData, files.get('data/schedule.json'), imp.game.date, scheduleId));
  return imp;
}

for (const sameOpponent of [false, true]) {
  test(`同日${sameOpponent ? '同一' : '別'}相手の第2・第3試合を登録、元の試合・CSVを保持し追加分だけ加算、個別差し替え可能`, async () => {
    const env = setup();
    const { context: c, files, imp: first } = env;
    await c.saveCsvImport(first);
    const firstGame = clone(c.findCsvReplacement(files.get('data/results.json'), first.game.gameId).game);
    const firstRaw = files.get(first.game.rawCsvPath);
    const before = clone(files.get('data/stats.json'));
    const second = newImportFor(env, sameOpponent ? first.csvText : first.csvText.replace('Pana Spirits', '別チーム'));
    const expected = clone(before);
    c.applyBattingStatsToPlayers(expected.seasonRanking.players, second.playerStats);
    c.recomputeSeasonCategories(expected.seasonRanking);
    await c.saveCsvImport(second);
    assert.notEqual(first.game.gameId, second.game.gameId);
    assert.notEqual(first.game.rawCsvPath, second.game.rawCsvPath);
    assert.deepEqual(files.get('data/stats.json'), clone(expected));
    assert.deepEqual(clone(c.findCsvReplacement(files.get('data/results.json'), first.game.gameId).game), firstGame);
    assert.equal(files.get(first.game.rawCsvPath), firstRaw);
    const third = newImportFor(env, first.csvText);
    await c.saveCsvImport(third);
    assert.equal(new Set([first, second, third].map(i => i.game.rawCsvPath)).size, 3);
    for (const imp of [first, second, third]) {
      const oldResults = clone(files.get('data/results.json'));
      const csvText = imp.csvText.replace('一ゴロ', '"左２安\n打点１"');
      const replacement = { ...c.buildGameImportFromCsv(csvText), csvText, mode: 'replace', targetGameId: imp.game.gameId,
        resultsSha: 'data/results.json:sha', statsSha: 'data/stats.json:sha', rawSha: imp.game.rawCsvPath + ':sha' };
      await c.saveCsvImport(replacement);
      assert.equal(files.get(imp.game.rawCsvPath), csvText);
      const others = data => data.groups.flatMap(g => g.games).filter(g => g.gameId !== imp.game.gameId);
      assert.deepEqual(others(files.get('data/results.json')), others(oldResults));
    }
  });
}

test('明示選択した日程IDを継承、日付や相手名からは自動同定しない', async () => {
  const env = setup();
  const { context: c, files } = env;
  files.set('data/schedule.json', { games: [
    { id: 'schedule-first', date: env.imp.game.date, opponent: env.imp.game.opponent },
    { id: 'schedule-second', date: env.imp.game.date, opponent: env.imp.game.opponent },
  ] });
  installGitHub(c, files);
  for (const id of ['schedule-first', 'schedule-second']) {
    const imp = newImportFor(env, env.imp.csvText, id);
    await c.saveCsvImport(imp);
    assert.equal(imp.game.gameId, id);
    assert.equal(files.get(`data/raw-games/${id}.csv`), imp.csvText);
  }
  assert.throws(() => newImportFor(env, env.imp.csvText, 'schedule-first'), /登録済み/);
  const separate = newImportFor(env, env.imp.csvText);
  assert.match(separate.game.gameId, /^2026-09-27-\d+$/);
});

test('自動IDは結果のID・日程のID・既存CSV参照先を避ける', () => {
  const { context: c, imp } = setup();
  const results = { groups: [{ games: [
    { gameId: '2026-09-27-01' },
    { gameId: 'other', rawCsvPath: 'data/raw-games/2026-09-27-03.csv' },
  ] }] };
  const identity = c.newCsvIdentity(results, { games: [{ id: '2026-09-27-02' }] }, imp.game.date, null);
  assert.equal(identity.gameId, '2026-09-27-04');
});

test('同日既存試合は別試合の確認が必要、日程未選択も保存しない', async () => {
  const env = setup();
  await env.context.saveCsvImport(env.imp);
  const second = newImportFor(env, env.imp.csvText);
  second.confirmSeparate = false;
  await assert.rejects(env.context.saveCsvImport(second), /別試合/);
  second.confirmSeparate = true;
  second.identitySelected = false;
  await assert.rejects(env.context.saveCsvImport(second), /対応する日程/);
  assert.equal(env.mock.publications, 1);
});

test('日程SHA競合で停止し3ファイルを書き換えない', async () => {
  const { context: c, imp, mock } = setup();
  imp.scheduleSha = 'outdated';
  await assert.rejects(c.saveCsvImport(imp), /他の更新/);
  assert.ok(!mock.calls.some(call => call.method === 'POST'));
});

test('新規登録プレビュー: 同日一覧・CSV一致警告・明示選択・別試合確認後に保存', async () => {
  const env = setup();
  const { context: c, imp, element, files } = env;
  await c.saveCsvImport(imp);
  element('csvImportMode').value = 'new';
  element('csvFileInput').files = [{ text: async () => imp.csvText }];
  await element('csvParseBtn').listeners.click();
  const html = element('csvPreviewArea').innerHTML;
  assert.match(html, /同じ日付の登録済み試合/);
  assert.match(html, /2026-09-27-01/);
  assert.match(html, /登録済み元CSVと内容が一致/);
  assert.match(html, /別試合として新規登録する/);
  assert.match(html, /対応する日程なし/);
  element('csvScheduleChoice').listeners.change({ target: { value: '__new__' } });
  assert.match(element('csvNewIdentity').textContent, /2026-09-27-02/);
  element('csvConfirmSeparate').checked = true;
  vm.runInContext('loadResults = async () => {};', c);
  await element('csvCommitBtn').listeners.click();
  assert.ok(files.has('data/raw-games/2026-09-27-02.csv'));
});

test('既存試合の識別情報と日付だけのCSV参照先は新規IDの発行で変わらない', () => {
  const { context: c } = setup();
  const results = read('results.json');
  const games = results.groups.filter(g => g.era === 'current').flatMap(g => g.games);
  for (const game of games) Object.assign(game, { gameId: `${game.date}-01`, rawCsvPath: `data/raw-games/${game.date}.csv` });
  const before = clone(results);
  const identity = c.newCsvIdentity(results, { games: [] }, '2026-09-13', null);
  assert.equal(identity.gameId, '2026-09-13-02');
  assert.deepEqual(results, before);
});

function workflowSetup() {
  const env = setup();
  const { context: c, files } = env;
  const storage = new Map();
  c.localStorage = { getItem: key => storage.get(key) || '', setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  vm.runInContext(fs.readFileSync(path.join(root, 'game-attendance.js'), 'utf8'), c);
  c.confirm = () => true;
  env.element('postgameParticipantsConfirmed').checked = true;
  c.document.querySelectorAll = selector => selector.includes('[data-gp-member]') ? (vm.runInContext('postgame.imp?.playerStats || []', c)).map(p => ({value:p.name,checked:true})) : [];
  c.todayJstDateString = () => '2026-09-27';
  files.set('data/schedule.json', { games: [
    { id: 'today-1', date: '2026-09-27', opponent: 'Pana Spirits', time: '9:00' },
    { id: 'today-2', date: '2026-09-27', opponent: 'Pana Spirits', time: '13:00' },
  ] });
  files.set('data/next-game.json', { current: { scheduleGameId: 'today-1', date: '2026-09-27', opponent: 'Pana Spirits' }, history: [] });
  const writes = [];
  c.ghGet = async path => ({ sha: path + ':sha', content: Buffer.from(JSON.stringify(files.get(path))).toString('base64') });
  c.ghPut = async (path, data) => { files.set(path, clone(data)); writes.push(path); return { content: { sha: path + ':new' } }; };
  vm.runInContext('fillNextGameForm = () => {}; renderNextGameStatus = () => {};', c);
  return { ...env, storage, writes, mock: installGitHub(c, files), state: () => vm.runInContext('postgame', c),
    run: code => vm.runInContext(code, c) };
}
async function selectWorkflow(env, id = 'today-1') {
  await env.context.loadPostgame();
  env.element('postgameSelect').value = id;
  await env.context.postgameAction();
}

test('試合後5段階: 日程IDを固定してCSV保存後に同日次戦へ切替、主ボタンは1つ', async () => {
  const env = workflowSetup();
  const { context: c, element, files } = env;
  await selectWorkflow(env);
  assert.equal(env.state().step, 2);
  assert.match(element('postgameTarget').textContent, /today-1/);
  element('postgameFile').files = [{ text: async () => env.imp.csvText }];
  await c.postgameAction();
  assert.equal(env.state().step, 3);
  assert.equal(env.state().imp.game.gameId, 'today-1');
  assert.doesNotMatch(element('postgameFlow').innerHTML, /id="csvCommitBtn"/);
  assert.equal((element('postgameFlow').innerHTML.match(/id="postgamePrimary"/g) || []).length, 1);
  await c.postgameAction();
  assert.equal(env.state().step, 4);
  await c.postgameAction();
  assert.equal(env.state().step, 5);
  assert.equal(env.state().saved, true);
  assert.equal(files.get('data/next-game.json').current.scheduleGameId, 'today-1');
  await c.postgameAction();
  assert.equal(files.get('data/next-game.json').current.scheduleGameId, 'today-2');
  assert.equal(env.state().switchMessage, '切替済み');
});

test('試合後: 過去訂正・現在ID不一致では次戦操作せず、履歴済みは切替済み', () => {
  const { context: c } = workflowSetup();
  const next = { current: { scheduleGameId: 'current' }, history: [{ scheduleGameId: 'done' }] };
  assert.match(c.postgameSwitchState(next, { id: 'current', past: true }), /切替は不要/);
  assert.match(c.postgameSwitchState(next, { id: 'different' }), /切替は不要/);
  assert.equal(c.postgameSwitchState(next, { id: 'done' }), '切替済み');
});

test('試合後: 切替直前に他端末が次戦を変更しても別試合を終了させない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  env.run("postgame.step = 5; postgame.saved = true;");
  env.files.get('data/next-game.json').current.scheduleGameId = 'today-2';
  await env.context.postgameAction();
  assert.equal(env.writes.length, 0);
  assert.match(env.state().switchMessage, /切替は不要/);
});

test('試合後: 雨天中止ではCSVを不要表示し中止と次戦を一緒に保存', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.element('postgameCancel').onclick();
  assert.equal(env.state().step, 5);
  assert.match(env.element('postgameFlow').innerHTML, /雨天中止のため不要/);
  await env.context.postgameAction();
  assert.deepEqual(env.writes, ['data/next-game.json']);
  assert.equal(env.files.get('data/next-game.json').history[0].status, 'cancelled');
  assert.equal(env.mock.publications, 0);
});

test('試合後: 応答消失は保存状態を確認し、ページ再開でも同じコミットを確認して二重保存しない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.context.parsePostgameCsv(env.imp.csvText);
  await env.context.postgameAction();
  env.mock.loseResponse = true; env.mock.failChecks = true;
  await env.context.postgameAction();
  assert.equal(env.state().uncertain, true);
  assert.match(env.context.postgamePrimaryLabel(), /再確認/);
  env.run('postgame = { step: 1 };');
  env.mock.failChecks = false;
  await env.context.loadPostgame();
  assert.equal(env.state().saved, true);
  assert.equal(env.mock.publications, 1);
  assert.equal(env.state().step, 5);
});

test('試合後: ref更新前の失敗は未反映を確認し、保存済みコミットだけを再試行', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.context.parsePostgameCsv(env.imp.csvText);
  await env.context.postgameAction();
  env.mock.failPath = 'git/refs/heads/main';
  await env.context.postgameAction();
  assert.equal(env.state().uncertain, true);
  env.mock.failPath = '';
  await env.context.postgameAction();
  assert.equal(env.state().retryReady, true);
  await env.context.postgameAction();
  assert.equal(env.mock.publications, 1);
  assert.equal(env.mock.calls.filter(call => call.route === 'git/commits').length, 1);
});

test('試合後: SHA競合時は最新データで確認画面に戻り保存しない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.context.parsePostgameCsv(env.imp.csvText);
  await env.context.postgameAction();
  env.state().imp.resultsSha = 'stale';
  await env.context.postgameAction();
  assert.equal(env.state().step, 3);
  assert.equal(env.mock.publications, 0);
  assert.match(env.element('postgameFlow').innerHTML, /確認し直して/);
});

test('試合後: 保存前に閉じた場合はCSV再選択へ戻り、CSV本文は端末に保存しない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.context.parsePostgameCsv(env.imp.csvText);
  assert.ok(!env.storage.get('ffhp_postgame_v1').includes('csvText'));
  env.run('postgame = { step: 1 };');
  await env.context.loadPostgame();
  assert.equal(env.state().id, 'today-1');
  assert.equal(env.state().step, 2);
});

test('試合後: 日程なしのID生成と競合後の再確認でも日程IDに誤変換しない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env, '__new__');
  await env.context.parsePostgameCsv(env.imp.csvText);
  const id = env.state().id;
  assert.match(id, /^2026-09-27-/);
  await env.context.parsePostgameCsv(env.imp.csvText);
  assert.equal(env.state().id, id);
  assert.equal(env.state().imp.scheduleId, null);
});

test('試合後: 切替保存の応答消失は再取得で切替済みと確認し二度終了しない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  env.run("postgame.step = 5; postgame.mode = 'cancelled';");
  const put = env.context.ghPut;
  env.context.ghPut = async (...args) => { await put(...args); throw new Error('response lost'); };
  await env.context.postgameAction();
  assert.equal(env.state().switchMessage, '切替済み');
  assert.equal(env.writes.length, 1);
  assert.equal(env.files.get('data/next-game.json').history.length, 1);
});

test('試合後: 既存試合の差し替え保存後、過去試合は次戦へ切り替えない', async () => {
  const env = workflowSetup();
  const original = env.context.buildGameImportFromCsv(env.imp.csvText.replace('9/27,', '9/13,'));
  const results = env.files.get('data/results.json');
  const group = results.groups.find(group => group.games.some(game => game.date === '2026-09-13'));
  const index = group.games.findIndex(game => game.date === '2026-09-13');
  group.games[index] = { ...clone(original.game), gameId: 'old-game', rawCsvPath: 'data/raw-games/old-game.csv' };
  env.files.set('data/raw-games/old-game.csv', env.imp.csvText.replace('9/27,', '9/13,'));
  installGitHub(env.context, env.files);
  await selectWorkflow(env, 'old-game');
  assert.equal(env.state().mode, 'replace');
  await env.context.parsePostgameCsv(env.files.get('data/raw-games/old-game.csv').replace('一ゴロ', '二ゴロ'));
  await env.context.postgameAction();
  await env.context.postgameAction();
  assert.match(env.state().switchMessage, /切替は不要/);
  assert.equal(env.files.get('data/next-game.json').current.scheduleGameId, 'today-1');
  assert.equal(env.writes.length, 0);
});

test('試合後: 日付・対戦相手が選択対象と違うCSVは明示確認まで保存へ進めない', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.context.parsePostgameCsv(env.imp.csvText.replace('Pana Spirits', '別の相手'));
  assert.equal(env.state().identityMismatch, true);
  assert.match(env.state().label, /Pana Spirits/);
  await env.context.postgameAction();
  assert.equal(env.state().step, 3);
  assert.equal(env.mock.publications, 0);
  env.element('postgameIdentityConfirm').checked = true;
  await env.context.postgameAction();
  assert.equal(env.state().step, 4);
});

test('試合後: 保存中に別試合へ切替できず、対象と再開情報を保持する', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  env.run('postgameBusy = true;');
  env.element('postgameReset').onclick();
  assert.equal(env.state().id, 'today-1');
  env.run('postgameBusy = false;');
});

function confirmGp(imp, extra = []) {
  imp.game.actualParticipants = { names: [...imp.playerStats.map(p => p.name), ...extra], confirmedAt: '2026-09-27T10:00:00Z' };
}

test('実参加者GP: 打席なしの監督はGPだけ加算し欠席者・打撃・ランキング・過年度を変更しない', async () => {
  const { context: c, imp, files } = setup();
  const expected = clone(imp.statsData);
  c.applyBattingStatsToPlayers(expected.seasonRanking.players, imp.playerStats);
  c.recomputeSeasonCategories(expected.seasonRanking);
  const bench = expected.seasonRanking.players.find(p => !imp.playerStats.some(b => b.name === p.name));
  assert.ok(bench);
  confirmGp(imp, [bench.name, bench.name, '新監督']);
  await c.saveCsvImport(imp);
  const stats = files.get('data/stats.json');
  for (const player of expected.seasonRanking.players) {
    const after = stats.seasonRanking.players.find(p => p.name === player.name);
    assert.deepEqual(after, {...player, gp:player.gp + (player.name === bench.name ? 1 : 0)});
  }
  const manager = stats.seasonRanking.players.find(p => p.name === '新監督');
  assert.equal(manager.gp, 1);
  for (const key of ['pa','ab','h','b2','b3','hr','rbi','sb']) assert.equal(manager[key], 0);
  assert.deepEqual(stats.seasonRanking.categories, clone(expected.seasonRanking.categories));
  assert.deepEqual(files.get('data/results.json').groups.filter(g=>g.era !== 'current'), imp.resultsData.groups.filter(g=>g.era !== 'current'));
  assert.equal(files.get(imp.game.rawCsvPath), imp.csvText);
  await c.saveCsvImport(imp);
  assert.equal(files.get('data/stats.json').seasonRanking.players.find(p=>p.name==='新監督').gp, 1);
});

test('実参加者確認なし・打撃記録がある人を除外した場合は書き込まない', async () => {
  const { context: c, imp, mock } = setup();
  imp.participantRoster = [];
  await assert.rejects(c.saveCsvImport(imp), /未完了/);
  imp.game.actualParticipants = {names:[],confirmedAt:'now'};
  await assert.rejects(c.saveCsvImport(imp), /参加者から外す/);
  assert.equal(mock.publications, 0);
});

for (const failBlob of [1,2,3]) test(`実参加者とGPも一括保存: ファイル${failBlob}失敗では未反映、再試行で1回のみ加算`, async () => {
  const { context: c, imp, files, mock } = setup();
  confirmGp(imp,['ベンチ監督']);
  const before = clone(imp);
  mock.failBlob = failBlob;
  await assert.rejects(c.saveCsvImport(imp), /blob failure/);
  assert.deepEqual(files.get('data/stats.json'), read('stats.json'));
  assert.deepEqual(files.get('data/results.json'), read('results.json'));
  assert.deepEqual(clone(imp),before);
  mock.failBlob = 0;
  await c.saveCsvImport(imp); await c.saveCsvImport(imp);
  assert.equal(files.get('data/stats.json').seasonRanking.players.find(p=>p.name==='ベンチ監督').gp,1);
});

test('実参加者GP: 応答消失後の再試行・CSV差し替えでも確定参加者とGPを保持', async () => {
  const { context: c, imp, files, mock } = setup();
  confirmGp(imp,['ベンチ監督']);
  mock.loseResponse=true;
  await c.saveCsvImport(imp); await c.saveCsvImport(imp);
  const before = clone(files.get('data/stats.json'));
  const correction = imp.csvText.replace('一ゴロ','二ゴロ');
  const replacement = {...c.buildGameImportFromCsv(correction), csvText:correction, mode:'replace', targetGameId:imp.game.gameId,
    resultsSha:'data/results.json:sha', statsSha:'data/stats.json:sha',rawSha:imp.game.rawCsvPath+':sha'};
  await c.saveCsvImport(replacement); await c.saveCsvImport(replacement);
  assert.deepEqual(files.get('data/stats.json'), before);
  const game = files.get('data/results.json').groups.flatMap(g=>g.games).find(g=>g.gameId===imp.game.gameId);
  assert.deepEqual(game.actualParticipants, clone(imp.game.actualParticipants));
});

test('試合後フローは実参加者の確認まで保存へ進まず、名前の重複を除いて確定', async () => {
  const env = workflowSetup();
  await selectWorkflow(env);
  await env.context.parsePostgameCsv(env.imp.csvText);
  env.element('postgameParticipantsConfirmed').checked=false;
  await env.context.postgameAction();
  assert.equal(env.state().step,3);
  assert.match(env.element('postgameFlow').innerHTML,/実際の参加者を確認/);
  env.element('postgameParticipantsConfirmed').checked=true;
  env.element('postgameParticipantExtra').value='監督\n監督';
  await env.context.postgameAction();
  assert.equal(env.state().step,4);
  assert.equal(env.state().imp.game.actualParticipants.names.filter(n=>n==='監督').length,1);
  await env.context.postgameAction();
  assert.equal(env.files.get('data/stats.json').seasonRanking.players.find(p=>p.name==='監督').gp,1);
});

test('旧CSVのゼロ打席行を実参加者から外すとGPだけ0、参加情報なしの旧試合は1', () => {
  const {context:c}=setup();
  const game={boxscore:{headers:['選手名','打席','打数'],rows:[['欠席者','0','0']]}};
  const totals = g => c.totalResultBatting({groups:[{era:'current',games:[g]}]});
  assert.equal(totals(game).get('欠席者').gp,1);
  game.actualParticipants={names:['ベンチ参加'],confirmedAt:'now'};
  assert.equal(totals(game).get('欠席者').gp,0);
  assert.equal(totals(game).get('ベンチ参加').gp,1);
  assert.equal(totals(game).get('ベンチ参加').pa,0);
});

test('差分UI: 道下の盗塁0→1を先頭に表示し丸山との同数化は補足のみにする', () => {
  const {context:c} = setup();
  const oldCsv = fs.readFileSync(path.join(fixtures,'raw-games/2026-09-13.csv'),'utf8');
  const newCsv = oldCsv.replace('一失', '"一失\n盗塁１"');
  const before = c.buildGameImportFromCsv(oldCsv).game, after = c.buildGameImportFromCsv(newCsv).game;
  const oldStats = {seasonRanking:{categories:[{label:'盗塁',entries:[{name:'丸山',value:'1'}]}]}};
  const newStats = {seasonRanking:{categories:[{label:'盗塁',entries:[{name:'道下・丸山',value:'1'}]}]}};
  const original = JSON.stringify([before,after,oldStats,newStats]);
  const html = c.renderCsvReplacementDiff(before,after,oldCsv,newCsv,oldStats,newStats);
  const main = html.split('</section>')[0];
  assert.match(main, /道下　盗塁<\/td><td>0<\/td><td>1/);
  assert.match(main, /道下　第2打席の記録/);
  assert.doesNotMatch(main, /丸山|大淵|ランキング|球場|対戦相手|スコア/);
  assert.match(html, /<details class="admin-note"><summary>ランキングへの影響（補足）/);
  assert.match(html, /道下：盗塁ランキングに追加（1盗塁）/);
  assert.doesNotMatch(html, /丸山/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.equal(JSON.stringify([before,after,oldStats,newStats]),original);
});

test('差分UI: 一ゴロ→二ゴロの数値に出ない訂正も選手と打席を明記', () => {
  const {context:c}=setup();
  const oldCsv=fs.readFileSync(path.join(fixtures,'raw-games/2026-09-13.csv'),'utf8');
  const newCsv=oldCsv.replace('一ゴロ','二ゴロ');
  const stats=read('stats.json');
  const html=c.renderCsvReplacementDiff(c.buildGameImportFromCsv(oldCsv).game,c.buildGameImportFromCsv(newCsv).game,oldCsv,newCsv,stats,stats);
  const main=html.split('</section>')[0];
  assert.match(main,/藤岡　第1打席の記録<\/td><td>一ゴロ<\/td><td>二ゴロ/);
  assert.doesNotMatch(main,/道下|大淵|打数|安打/);
  assert.doesNotMatch(html,/ランキングへの影響/);
});

test('差分UI: ランキング配列の並び替えや同数表記の順番だけでは差分を作らない', () => {
  const {context:c}=setup();
  const csv=fs.readFileSync(path.join(fixtures,'raw-games/2026-09-13.csv'),'utf8');
  const game=c.buildGameImportFromCsv(csv).game;
  const old={seasonRanking:{categories:[{label:'盗塁',entries:[{name:'丸山・道下',value:'1'}]}]}};
  const after={seasonRanking:{categories:[{label:'盗塁',entries:[{name:'道下・丸山',value:'1'}]}]}};
  const html=c.renderCsvReplacementDiff(game,game,csv,csv,old,after);
  assert.doesNotMatch(html,/<tr>|ランキングへの影響|丸山/);
});

test('差分UI: 選手追加・削除は名前で表示し、無関係な選手の配列位置を差分にしない', () => {
  const {context:c}=setup();
  const csv=fs.readFileSync(path.join(fixtures,'raw-games/2026-09-13.csv'),'utf8');
  const afterCsv=csv.replace('藤岡','新選手');
  const stats=read('stats.json');
  const html=c.renderCsvReplacementDiff(c.buildGameImportFromCsv(csv).game,c.buildGameImportFromCsv(afterCsv).game,csv,afterCsv,stats,stats);
  const main=html.split('</section>')[0];
  assert.match(main,/藤岡<\/td><td>登録あり<\/td><td>削除/);
  assert.match(main,/新選手<\/td><td>（なし）<\/td><td>登録あり/);
  assert.doesNotMatch(main,/古賀|道下/);
});

test('差し替え確認の先頭は直接差分で、全選手の未変更成績表を出さずHTMLをエスケープ', () => {
  const {context:c,imp}=setup();
  const stats=read('stats.json');
  const before=clone(imp.game),after=clone(imp.game); after.venue='<img src=x onerror=alert(1)>';
  const diff=c.renderCsvReplacementDiff(before,after,imp.csvText,imp.csvText,stats,stats);
  const html=c.renderCsvPreviewHtml({...imp,mode:'replace',targetGameId:'test',diffHtml:diff});
  assert.ok(html.startsWith('<section class="csv-direct-changes">'));
  assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<img|更新前打率/);
  assert.match(html,/id="csvCommitBtn"/);
});
