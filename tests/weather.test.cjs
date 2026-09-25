const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const venues = JSON.parse(fs.readFileSync(path.join(root, 'data', 'venues.json'), 'utf8')).venues;
const publicScript = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const NOW = Date.parse('2026-09-25T10:00:00+09:00');

function setup(apiFetch) {
  const storage = new Map();
  const calls = [];
  const ctx = vm.createContext({
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    fetch: async (url) => {
      if (url.startsWith('data/venues.json')) return { ok: true, json: async () => ({ venues }) };
      calls.push(url);
      return apiFetch(url);
    },
  });
  vm.runInContext(publicScript.slice(publicScript.indexOf('function escapeHtml('), publicScript.indexOf('// 球場名をGoogleマップ')), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'weather.js'), 'utf8'), ctx);
  return { ctx, calls, storage };
}

const game = (over = {}) => ({ date: '2026-09-27', startTime: '08:00', location: '駕与丁公園グラウンド', ...over });
const hourlyFor = (date, fill = true) => {
  const time = Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
  return { time, weather_code: time.map((_, h) => (fill ? (h === 7 ? 61 : 3) : null)), temperature_2m: time.map((_, h) => (fill ? 20 + h / 10 : null)), precipitation: time.map((_, h) => (fill ? (h === 7 ? 0.5 : 0) : null)) };
};
const okApi = (fill = true) => async (url) => ({ ok: true, json: async () => ({ hourly: hourlyFor(new URL(url).searchParams.get('start_date'), fill) }) });
async function render(env, g) {
  const el = { innerHTML: '', hidden: true };
  await env.ctx.renderGameWeather(el, g, NOW);
  return el;
}

test('球場マスタ: 正式名とaliasesは一致、部分一致や別球場は一致させない', () => {
  const { ctx } = setup(okApi());
  assert.equal(ctx.findVenue(venues, '駕与丁公園').name, '駕与丁公園');
  assert.equal(ctx.findVenue(venues, '駕与丁公園グラウンド').name, '駕与丁公園');
  assert.equal(ctx.findVenue(venues, ' 駕与丁公園 グラウンド').name, '駕与丁公園');
  assert.equal(ctx.findVenue(venues, '駕与丁公園第2グラウンド'), null);
  assert.equal(ctx.findVenue(venues, '北谷運動公園'), null);
  assert.equal(ctx.findVenue(venues, ''), null);
});

test('表示時間: 開始2時間前〜終了予定、終了時刻・試合時間があれば優先', () => {
  const { ctx } = setup(okApi());
  assert.deepEqual([...ctx.weatherHours({ startTime: '10:00' })], [8, 9, 10, 11, 12]);
  assert.deepEqual([...ctx.weatherHours({ startTime: '8:00' })], [6, 7, 8, 9, 10]);
  assert.deepEqual([...ctx.weatherHours({ startTime: '08:30' })], [6, 7, 8, 9, 10, 11]);
  assert.deepEqual([...ctx.weatherHours({ startTime: '13:00', endTime: '14:30' })], [11, 12, 13, 14, 15]);
  assert.deepEqual([...ctx.weatherHours({ startTime: '13:00', durationMinutes: 180 })], [11, 12, 13, 14, 15, 16]);
  assert.deepEqual([...ctx.weatherHours({ startTime: '22:00' })], [20, 21, 22, 23]);
  assert.deepEqual([...ctx.weatherHours({ startTime: null })], []);
});

test('駕与丁公園: JMAモデル・Asia/Tokyoで取得し、1時間ごとに天気・気温・降水量を表示', async () => {
  const env = setup(okApi());
  const el = await render(env, game());
  const url = new URL(env.calls[0]);
  assert.equal(url.searchParams.get('models'), 'jma_seamless');
  assert.equal(url.searchParams.get('timezone'), 'Asia/Tokyo');
  assert.equal(url.searchParams.get('start_date'), '2026-09-27');
  assert.equal(url.searchParams.get('hourly'), 'weather_code,temperature_2m,precipitation');
  assert.equal(el.hidden, false);
  // 初期表示は開始時刻の1行、一覧は閉じた<details>の中
  const [summary, list] = el.innerHTML.split('<ul class="weather-list">');
  assert.match(summary, /<details class="weather-details">/); assert.doesNotMatch(summary, /<details[^>]*open/);
  assert.match(summary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /試合当日の天気 詳細を見る 閉じる 8:00開始 ☁️ くもり 21℃ 降水0\.0mm/);
  assert.deepEqual(list.match(/\d+:00/g), ['6:00', '7:00', '8:00', '9:00', '10:00']);
  assert.match(list, /弱い雨/); assert.match(list, /is-wet[\s\S]*0\.5mm/);
  assert.match(list, /is-start">\s*<span class="weather-time">8:00/);
  assert.match(el.innerHTML, /天気データ：<a href="https:\/\/open-meteo.com\/"/);
  assert.doesNotMatch(el.innerHTML, /tenki\.jp/); // URL未設定ならボタン自体を出さない
});

test('1時間以内の再表示はキャッシュを使いAPIを呼ばない', async () => {
  const env = setup(okApi());
  await render(env, game());
  await render(env, game());
  assert.equal(env.calls.length, 1);
});

test('tenki.jp URLが設定されていればリンクを表示', async () => {
  const env = setup(okApi());
  env.ctx.venuesRequest = Promise.resolve([{ name: '駕与丁公園', aliases: [], lat: 33.6, lon: 130.4, tenkiUrl: 'https://tenki.jp/leisure/x/' }]);
  vm.runInContext('venuesRequest = this.venuesRequest', env.ctx);
  const el = await render(env, game({ location: '駕与丁公園' }));
  assert.match(el.innerHTML, /href="https:\/\/tenki\.jp\/leisure\/x\/"[^>]*>tenki\.jpで詳しい予報を見る/);
});

test('未登録球場は「予報未設定」、APIは呼ばない', async () => {
  const env = setup(okApi());
  for (const location of ['北谷運動公園', '交流戦', '']) {
    const el = await render(env, game({ location }));
    assert.match(el.innerHTML, /予報未設定/);
  }
  assert.equal(env.calls.length, 0);
});

test('予報期間外: 16日以上先はAPIを呼ばず、範囲外エラーや値なしでも「予報はまだ出ていません」', async () => {
  let env = setup(okApi());
  assert.match((await render(env, game({ date: '2026-10-18' }))).innerHTML, /予報はまだ出ていません/);
  assert.equal(env.calls.length, 0);
  env = setup(async () => ({ ok: false, status: 400, json: async () => ({ error: true, reason: "Parameter 'start_date' is out of allowed range from 2026-06-24 to 2026-10-10" }) }));
  assert.match((await render(env, game({ date: '2026-10-10' }))).innerHTML, /予報はまだ出ていません/);
  env = setup(okApi(false));
  assert.match((await render(env, game({ date: '2026-10-08' }))).innerHTML, /予報はまだ出ていません/);
});

test('通信失敗・サーバーエラーは「天気予報を取得できませんでした」、例外を外に出さない', async () => {
  for (const api of [async () => { throw new TypeError('Failed to fetch'); }, async () => ({ ok: false, status: 500, json: async () => { throw new Error('html'); } })]) {
    const env = setup(api);
    const el = await render(env, game());
    assert.match(el.innerHTML, /天気予報を取得できませんでした/);
    assert.match(el.innerHTML, /Open-Meteo/);
  }
});

test('日付・開始時刻が未定なら天気欄ごと非表示', async () => {
  const env = setup(okApi());
  assert.equal((await render(env, game({ date: '' }))).hidden, true);
  assert.equal((await render(env, game({ startTime: '' }))).hidden, true);
  assert.equal(env.calls.length, 0);
});
