/* ---- 次戦情報の天気予報(Open-Meteo / 気象庁モデル) ----
   試合の日付・開始時刻・球場名は次戦情報(next-game.json)の値をそのまま使い、
   球場の緯度経度・tenki.jpのURLは球場マスタ(data/venues.json)から引く。
   APIキー不要の無料APIをブラウザから直接呼ぶだけなので、サーバー側の設定は不要。
   ここで何が起きても次戦情報など他の表示は壊さないよう、呼び出し側は例外を握りつぶす */

const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast';
// jma_seamlessは直近(約4日先まで)を5km格子のMSM、その先を粗いGSMで自動的につなぐ。
// 気象庁モデルは降水確率を提供していないため、降水は1時間降水量(mm)で表示する
const WEATHER_MODEL = 'jma_seamless';
const WEATHER_TIMEZONE = 'Asia/Tokyo';
// Open-Meteoが受け付けるのは今日から16日先まで。それより先は問い合わせずに「まだ」とする
const WEATHER_MAX_DAYS_AHEAD = 15;
const WEATHER_PRE_GAME_HOURS = 2;
const WEATHER_DEFAULT_GAME_MINUTES = 120;
const WEATHER_CACHE_PREFIX = 'ffWeather:v1:';
const WEATHER_CACHE_TTL_MS = 60 * 60 * 1000;
const WEATHER_FETCH_TIMEOUT_MS = 10000;

// WMO天気コード → 日本語・アイコン
const WEATHER_CODES = {
  0: ['☀️', '快晴'],
  1: ['🌤️', '晴れ'],
  2: ['⛅', '晴れ時々くもり'],
  3: ['☁️', 'くもり'],
  45: ['🌫️', '霧'],
  48: ['🌫️', '霧'],
  51: ['🌦️', '弱い霧雨'],
  53: ['🌦️', '霧雨'],
  55: ['🌧️', '強い霧雨'],
  56: ['🌧️', '着氷性の霧雨'],
  57: ['🌧️', '着氷性の霧雨'],
  61: ['🌧️', '弱い雨'],
  63: ['🌧️', '雨'],
  65: ['🌧️', '強い雨'],
  66: ['🌧️', '着氷性の雨'],
  67: ['🌧️', '着氷性の雨'],
  71: ['🌨️', '弱い雪'],
  73: ['🌨️', '雪'],
  75: ['🌨️', '強い雪'],
  77: ['🌨️', '霧雪'],
  80: ['🌦️', '弱いにわか雨'],
  81: ['🌧️', 'にわか雨'],
  82: ['🌧️', '激しいにわか雨'],
  85: ['🌨️', 'にわか雪'],
  86: ['🌨️', '強いにわか雪'],
  95: ['⛈️', '雷雨'],
  96: ['⛈️', 'ひょうを伴う雷雨'],
  99: ['⛈️', 'ひょうを伴う雷雨'],
};

function weatherLabel(code) {
  const entry = WEATHER_CODES[code];
  return entry ? { icon: entry[0], label: entry[1] } : { icon: '―', label: '不明' };
}

// 全角・半角や空白の違いだけの表記ゆれは吸収し、それ以外は球場マスタのname/aliasesと
// 完全一致したものだけを採用する(部分一致だと「第1」「第2」のような別球場を取り違えるため)
function normalizeVenueName(name) {
  return String(name || '').normalize('NFKC').replace(/\s/g, '');
}

function findVenue(venues, locationName) {
  const target = normalizeVenueName(locationName);
  if (!target || !Array.isArray(venues)) return null;
  return venues.find((venue) => [venue.name, ...(Array.isArray(venue.aliases) ? venue.aliases : [])]
    .some((name) => normalizeVenueName(name) === target)) || null;
}

function parseClockMinutes(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || '').normalize('NFKC').trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 24 * 60 ? minutes : null;
}

// 表示する時(0〜23)の一覧。開始2時間前〜終了予定を1時間単位で。
// 終了予定は endTime / durationMinutes があれば優先し、無ければ開始+2時間。
// 日付をまたぐ分は同じ日の範囲に収める
function weatherHours(game) {
  const start = parseClockMinutes(game && game.startTime);
  if (start == null) return [];
  let end = parseClockMinutes(game.endTime);
  if (end == null || end <= start) {
    const duration = Number(game.durationMinutes);
    end = start + (duration > 0 ? duration : WEATHER_DEFAULT_GAME_MINUTES);
  }
  const first = Math.max(0, Math.floor((start - WEATHER_PRE_GAME_HOURS * 60) / 60));
  const last = Math.min(23, Math.ceil(end / 60));
  const hours = [];
  for (let h = first; h <= last; h++) hours.push(h);
  return hours;
}

// 閲覧端末のタイムゾーンに関係なく、日本時間の「今日」をYYYY-MM-DDで返す
function todayInTokyo(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);
}

function weatherApiUrl(venue, date) {
  const params = new URLSearchParams({
    latitude: String(venue.lat),
    longitude: String(venue.lon),
    hourly: 'weather_code,temperature_2m,precipitation',
    models: WEATHER_MODEL,
    timezone: WEATHER_TIMEZONE,
    start_date: date,
    end_date: date,
  });
  return `${WEATHER_API_URL}?${params}`;
}

function readWeatherCache(key, now) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached && cached.hourly && now - cached.savedAt < WEATHER_CACHE_TTL_MS) return cached.hourly;
  } catch (e) { /* 保存領域が使えない環境ではキャッシュなしで動く */ }
  return null;
}

function writeWeatherCache(key, hourly, now) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: now, hourly }));
  } catch (e) { /* 同上 */ }
}

// 戻り値: { status: 'ok', hourly } / { status: 'not-yet' }。通信失敗は例外
async function fetchHourlyWeather(venue, date, now = Date.now()) {
  const cacheKey = `${WEATHER_CACHE_PREFIX}${venue.lat},${venue.lon},${date}`;
  const cached = readWeatherCache(cacheKey, now);
  if (cached) return { status: 'ok', hourly: cached };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), WEATHER_FETCH_TIMEOUT_MS) : null;
  try {
    const res = await fetch(weatherApiUrl(venue, date), controller ? { signal: controller.signal } : {});
    const body = await res.json().catch(() => null);
    // 予報期間外の日付は400と「out of allowed range」の理由が返る
    if (!res.ok) {
      if (body && /out of allowed range/i.test(body.reason || '')) return { status: 'not-yet' };
      throw new Error(`weather api ${res.status}`);
    }
    if (!body || !body.hourly || !Array.isArray(body.hourly.time)) throw new Error('weather api: invalid body');
    writeWeatherCache(cacheKey, body.hourly, now);
    return { status: 'ok', hourly: body.hourly };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// APIの時系列から表示対象の時刻だけ抜き出す。予報値が1つも無ければnull(=まだ出ていない)
function pickWeatherRows(hourly, date, hours) {
  const index = new Map(hourly.time.map((t, i) => [t, i]));
  const rows = hours.map((h) => {
    const i = index.get(`${date}T${String(h).padStart(2, '0')}:00`);
    const at = (key) => (i == null || !Array.isArray(hourly[key]) ? null : hourly[key][i]);
    return { hour: h, code: at('weather_code'), temp: at('temperature_2m'), precip: at('precipitation') };
  });
  return rows.some((r) => r.code != null || r.temp != null) ? rows : null;
}

function weatherCells(r) {
  const w = r.code == null ? { icon: '―', label: '―' } : weatherLabel(r.code);
  return {
    icon: w.icon,
    label: escapeHtml(w.label),
    temp: r.temp == null ? '―' : `${Math.round(r.temp)}℃`,
    precip: r.precip == null ? '―' : `${Number(r.precip).toFixed(1)}mm`,
    wet: r.precip > 0,
  };
}

// 初期表示は見出しと試合開始時刻の1行だけ。1時間ごとの一覧と出典は<details>で
// 閉じておき、開いたときだけ表示する(次戦情報の中で天気欄が場所を取りすぎないように)
function renderWeatherForecast(rows, game, venue) {
  const startMinutes = parseClockMinutes(game.startTime);
  const startHour = Math.floor(startMinutes / 60);
  const startLabel = `${startHour}:${String(startMinutes % 60).padStart(2, '0')}`;
  const startRow = rows.find((r) => r.hour === startHour);
  const now = weatherCells(startRow);
  const list = rows.map((r) => {
    const c = weatherCells(r);
    return `<li class="weather-row${r.hour === startHour ? ' is-start' : ''}${c.wet ? ' is-wet' : ''}">
        <span class="weather-time">${r.hour}:00</span>
        <span class="weather-icon" aria-hidden="true">${c.icon}</span>
        <span class="weather-desc">${c.label}</span>
        <span class="weather-temp">${c.temp}</span>
        <span class="weather-precip">${c.precip}</span>
      </li>`;
  }).join('');
  return `<details class="weather-details">
    <summary>
      <span class="weather-heading">試合当日の天気</span>
      <span class="weather-toggle"><span class="weather-toggle-open">詳細を見る</span><span class="weather-toggle-close">閉じる</span></span>
      <span class="weather-now${now.wet ? ' is-wet' : ''}">
        <span class="weather-now-time">${startLabel}開始</span>
        <span class="weather-now-sky"><span aria-hidden="true">${now.icon}</span>${now.label}</span>
        <span class="weather-now-temp">${now.temp}</span>
        <span class="weather-now-precip">降水${now.precip}</span>
      </span>
    </summary>
    <ul class="weather-list">
      <li class="weather-row weather-row-head" aria-hidden="true"><span>時刻</span><span></span><span>天気</span><span>気温</span><span>降水</span></li>
      ${list}
    </ul>
    ${weatherFoot(venue)}
  </details>`;
}

// 出典(Open-Meteo)とtenki.jpへのリンク。tenki.jpはURL設定済みの球場だけ出す
function weatherFoot(venue) {
  const credit = '<span class="weather-credit">天気データ：<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></span>';
  const tenki = venue && /^https:\/\//.test(venue.tenkiUrl || '')
    ? `<a class="weather-tenki-link" href="${escapeHtml(venue.tenkiUrl)}" target="_blank" rel="noopener">tenki.jpで詳しい予報を見る</a>` : '';
  return `<p class="weather-foot">${[credit, tenki].filter(Boolean).join('<span class="weather-foot-sep">｜</span>')}</p>`;
}

// 予報があるときは見出し・出典ともrenderWeatherForecast側で<details>内に置く。
// メッセージだけ(未設定・まだ・失敗)のときはこちらで見出しと出典を添える
function weatherBox(inner, venue) {
  return `<p class="weather-heading">試合当日の天気</p>
    ${inner}
    ${weatherFoot(venue)}`;
}

const weatherMessage = (text) => `<p class="weather-message">${escapeHtml(text)}</p>`;

let venuesRequest = null;
function loadVenues() {
  if (!venuesRequest) {
    venuesRequest = fetch('data/venues.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data && Array.isArray(data.venues) ? data.venues : []))
      .catch(() => []);
  }
  return venuesRequest;
}

// container: 次戦情報内の天気欄。game: next-game.jsonのcurrent
async function renderGameWeather(container, game, now = Date.now()) {
  if (!container) return;
  const hours = weatherHours(game);
  // 日付・開始時刻が未定の試合は予報の出しようがないので欄ごと出さない
  if (!game || !/^\d{4}-\d{2}-\d{2}$/.test(game.date || '') || !hours.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = weatherBox(weatherMessage('天気予報を読み込み中...'), null);

  const venue = findVenue(await loadVenues(), game.location);
  if (!venue || !Number.isFinite(venue.lat) || !Number.isFinite(venue.lon)) {
    container.innerHTML = weatherBox(weatherMessage('予報未設定'), venue);
    return;
  }
  if (daysBetween(todayInTokyo(now), game.date) > WEATHER_MAX_DAYS_AHEAD) {
    container.innerHTML = weatherBox(weatherMessage('予報はまだ出ていません'), venue);
    return;
  }
  try {
    const result = await fetchHourlyWeather(venue, game.date, now);
    const rows = result.status === 'ok' ? pickWeatherRows(result.hourly, game.date, hours) : null;
    container.innerHTML = (rows
      ? renderWeatherForecast(rows, game, venue)
      : weatherBox(weatherMessage('予報はまだ出ていません'), venue));
  } catch (e) {
    container.innerHTML = weatherBox(weatherMessage('天気予報を取得できませんでした'), venue);
  }
}
