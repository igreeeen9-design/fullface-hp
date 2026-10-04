// One-time, local migration. Dry run by default; --write writes only after all checks pass.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const rootArg = process.argv.indexOf('--root');
const root = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const c = vm.createContext({ document: { getElementById: () => ({ value: '', style: {}, addEventListener() {} }), querySelectorAll: () => [] }, localStorage: { getItem: () => '' } });
vm.runInContext(source.slice(0, source.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')), c);
const normalize = c.normalizePlayerNameBrackets;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const results = JSON.parse(read('data/results.json'));
const stats = JSON.parse(read('data/stats.json'));
const targets = new Set();
const pending = new Map();
const games = results.groups.filter(g => g.era === 'current').flatMap(g => g.games);
const paths = new Set();
for (const game of games) {
  assert.ok(game.rawCsvPath, 'Missing rawCsvPath');
  assert.ok(!paths.has(game.rawCsvPath), 'Duplicate rawCsvPath');
  paths.add(game.rawCsvPath);
  const csv = read(game.rawCsvPath);
  // Change only the player-name column; preserve all other bytes (including CRLF).
  const lines = csv.split(/(?<=\n)/);
  const header = lines.find(line => line.includes('選手名'));
  assert.ok(header, 'Missing player-name header');
  const column = c.parseCsvText(header)[0].indexOf('選手名');
  assert.ok(column >= 0);
  const headerIndex = lines.indexOf(header);
  const updated = lines.map((line, index) => {
    const fields = line.split(',');
    const name = fields[column];
    if (index > headerIndex && name && normalize(name) !== name) {
      targets.add(normalize(name)); fields[column] = normalize(name);
    }
    return fields.join(',');
  }).join('');
  if (updated !== csv) pending.set(game.rawCsvPath, updated);
  const imported = c.buildGameImportFromCsv(updated, game.date);
  // Recompute from the source records, with existing confirmed attendance for GP.
  vm.runInContext('resultBoxscores', c).set(game, imported.game.boxscore);
}
for (const player of stats.seasonRanking.players) if (normalize(player.name) !== player.name) targets.add(normalize(player.name));
const untouchedPlayers = JSON.stringify(stats.seasonRanking.players.filter(p => !targets.has(normalize(p.name))));
const totals = c.totalResultBatting(results);
const fields = ['gp', 'pa', 'ab', 'h', 'b2', 'b3', 'hr', 'rbi', 'sb'];
for (const name of targets) {
  const records = stats.seasonRanking.players.filter(p => normalize(p.name) === name);
  assert.ok(records.length, `No season record: ${name}`);
  const total = totals.get(name);
  assert.ok(total, `No source records: ${name}`);
  // Only proceed when the disjoint stored records agree with the independent source total.
  for (const key of fields) assert.equal(records.reduce((sum, p) => sum + (p[key] || 0), 0), total[key], `${name}: ${key} mismatch; manual review required`);
  const rec = records.find(p => p.name === name) || records[0];
  rec.name = name;
  Object.assign(rec, total);
  c.updateBattingRates(rec);
  stats.seasonRanking.players = stats.seasonRanking.players.filter(p => !records.includes(p) || p === rec);
  console.log(name, JSON.stringify(rec));
}
assert.equal(JSON.stringify(stats.seasonRanking.players.filter(p => !targets.has(normalize(p.name)))), untouchedPlayers);
if (targets.size) c.recomputeSeasonCategories(stats.seasonRanking);
// Replace only exact player-name values / names in the boxscore player-name column.
for (const group of results.groups) for (const game of group.games) {
  const box = game.boxscore;
  if (box) {
    const column = box.headers.indexOf('選手名');
    if (column >= 0) box.rows.forEach(row => { row[column] = normalize(row[column]); });
  }
  if (game.actualParticipants) game.actualParticipants.names = [...new Set(game.actualParticipants.names.map(normalize))];
}
for (const [file, data] of [['data/results.json', results], ['data/stats.json', stats]]) {
  const text = JSON.stringify(data, null, 2) + (read(file).endsWith('\n') ? '\n' : '');
  if (text !== read(file)) pending.set(file, text);
}
console.log('Files:', [...pending.keys()]);
if (process.argv.includes('--write')) for (const [file, text] of pending) fs.writeFileSync(path.join(root, file), text);
