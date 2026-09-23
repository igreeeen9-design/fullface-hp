const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const installGitHub = require('./helpers/csv-github.cjs');
const root = path.resolve(__dirname, '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const script = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function setup() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, addEventListener() {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] },
    localStorage: { getItem: () => '' }, TextEncoder, TextDecoder,
    btoa: (v) => Buffer.from(v, 'binary').toString('base64'), atob: (v) => Buffer.from(v, 'base64').toString('binary') });
  vm.runInContext(script.slice(0, script.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')), context);
  const files = new Map(['results.json', 'stats.json'].map((name) => ['data/' + name, read(name)]));
  const mock = installGitHub(context, files);
  const csvText = fs.readFileSync(path.join(root, 'data/raw-games/2026-09-13.csv'), 'utf8').replace('9/13,', '9/27,');
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
