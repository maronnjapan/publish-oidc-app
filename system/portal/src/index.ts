import experimentalCatalog from "../../../experimental-features.json";

interface Env {
  DB: D1Database;
  RATE_LIMIT_PER_IP_PER_DAY: string;
  RATE_LIMIT_GLOBAL_PER_DAY: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_DISPATCH_TOKEN: string;
}

interface RequestRow {
  request_id: string;
  status: "pending" | "generating" | "deployed" | "failed";
  op_id: string;
  url: string | null;
  error: string | null;
  created_at: string;
}

interface PortalUser {
  username: string;
  password: string;
}

interface CreateInput {
  name: string;
  redirectUrl: string;
  clientType: "public" | "confidential";
  scopes: string[];
  features: Record<FeatureName, boolean>;
  experimental: ExperimentalSelection;
  users: PortalUser[];
}

interface ExperimentalOption {
  id: string;
  label: string;
  default?: boolean;
  hint?: string;
}

interface ExperimentalFeature {
  id: string;
  status: string;
  subpath: string;
  label: string;
  spec: string;
  summary: string;
  endpoints: string[];
  options?: ExperimentalOption[];
}

type ExperimentalSelection = Record<string, Record<string, boolean>>;

interface ParseFailure {
  ok: false;
  message: string;
}

type ParseResult = { ok: true; value: CreateInput } | ParseFailure;

const FEATURE_NAMES = ["pkce", "refresh-token", "introspection", "revocation", "request-object"] as const;
type FeatureName = (typeof FEATURE_NAMES)[number];
const OPTIONAL_SCOPES = ["profile", "email", "address", "phone", "offline_access"] as const;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{0,40}$/u;
const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{1,64}$/;
const PASSWORD_HASH_ROUNDS = 1;

// experimental-features.json is the single source of truth shared with the generator.
// Only `supported` entries are wired into generated OPs, so only those are offered here.
const EXPERIMENTAL_FEATURES: ExperimentalFeature[] = (experimentalCatalog.features as ExperimentalFeature[])
  .filter((feature) => feature.status === "supported");

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Renders the experimental section from the catalog so a new feature needs no UI edit. */
function experimentalCard(): string {
  if (EXPERIMENTAL_FEATURES.length === 0) return "";
  const entries = EXPERIMENTAL_FEATURES.map((feature) => {
    const options = (feature.options ?? []).map((option) => `
          <div class="experimental-option-row">
            <label><input class="experimental-option" type="checkbox" data-feature="${escapeHtml(feature.id)}" data-option="${escapeHtml(option.id)}"${option.default ? " checked" : ""} disabled> ${escapeHtml(option.label)}</label>${option.hint ? `
            <p class="hint">${escapeHtml(option.hint)}</p>` : ""}
          </div>`).join("");
    return `
        <div class="experimental-feature">
          <label class="experimental-toggle"><input class="experimental-toggle-input" type="checkbox" value="${escapeHtml(feature.id)}" data-label="${escapeHtml(feature.label)}" data-endpoints="${escapeHtml(feature.endpoints.join(" / "))}"> ${escapeHtml(feature.label)}</label>
          <p class="hint">${escapeHtml(feature.spec)} — ${escapeHtml(feature.summary)}</p>
          <p class="hint">追加されるエンドポイント: <code>${escapeHtml(feature.endpoints.join(" / "))}</code></p>${options}
        </div>`;
  }).join("");
  return `    <section class="card">
      <fieldset><legend>試験的な機能（@maronn-openid-connect/experimental）</legend>
        <p class="warning"><strong>注意:</strong> ここは <code>@maronn-openid-connect/experimental</code> の機能です。APIが安定しておらず、<strong>他の機能より適切に動作しない可能性が高い</strong>ため、動作検証にのみ使ってください。マイナーリリースでも破壊的変更や削除が起こり得ます。</p>${entries}
      </fieldset>
    </section>
`;
}

const HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Maronn OIDC Provider Publisher</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #16233b; background: #f4f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 2rem 1rem 4rem; }
    main { width: min(56rem, 100%); margin: auto; }
    header { margin-bottom: 1.5rem; }
    h1 { margin: 0 0 .4rem; font-size: clamp(1.65rem, 4vw, 2.4rem); }
    h2 { margin: 0 0 .9rem; font-size: 1.1rem; }
    p { line-height: 1.65; }
    .card { margin: 1rem 0; padding: 1.35rem; background: #fff; border: 1px solid #dce3ed; border-radius: .9rem; box-shadow: 0 .6rem 2rem #1e3a5f0d; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem; }
    label, legend { font-weight: 700; }
    label.block { display: block; margin-bottom: .35rem; }
    input, select, button { font: inherit; }
    input[type=text], input[type=url], input[type=password], select { width: 100%; min-height: 2.7rem; padding: .55rem .7rem; border: 1px solid #aeb9c8; border-radius: .5rem; background: #fff; color: inherit; }
    fieldset { margin: 0; padding: 0; border: 0; }
    .choices { display: flex; flex-wrap: wrap; gap: .65rem 1.1rem; margin-top: .7rem; }
    .choices label { font-weight: 500; }
    .hint { margin: .35rem 0 0; color: #52627a; font-size: .9rem; }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
    .section-heading h2 { margin-bottom: 0; }
    .count { color: #52627a; font-size: .9rem; font-weight: 700; }
    .user { display: grid; grid-template-columns: 1fr 1fr auto; gap: .65rem; margin-top: .65rem; align-items: end; }
    button { min-height: 2.7rem; padding: .55rem .9rem; border: 0; border-radius: .5rem; cursor: pointer; font-weight: 750; }
    button.primary { width: 100%; margin-top: .5rem; background: #165dcc; color: #fff; }
    button.secondary { background: #e8eef7; color: #203452; }
    button.danger { background: #fae8e8; color: #8c2525; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    #quota { color: #52627a; }
    #status { min-height: 1.5rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    #csv-feedback.error { color: #a22020; font-weight: 700; }
    .csv-preview { margin-top: .85rem; padding: .85rem; border: 1px solid #cbd5e1; border-radius: .55rem; background: #f8fafc; overflow-x: auto; }
    .csv-preview[hidden] { display: none; }
    .csv-preview p { margin: 0 0 .55rem; }
    .csv-preview table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    .csv-preview th, .csv-preview td { padding: .45rem .55rem; border-top: 1px solid #dce3ed; text-align: left; vertical-align: top; }
    .csv-preview .valid { color: #17613a; font-weight: 700; }
    .csv-preview .invalid { color: #a22020; font-weight: 700; }
    .warning { margin: 0 0 1rem; padding: .8rem .9rem; background: #fff7e8; border: 1px solid #e6c98a; border-radius: .55rem; color: #6b4a05; }
    .experimental-feature { padding: .85rem 0 0; border-top: 1px solid #e6ebf2; }
    .experimental-feature:first-of-type { border-top: 0; padding-top: 0; }
    .experimental-toggle { display: block; margin-bottom: .3rem; }
    .experimental-option-row { margin: .5rem 0 .85rem 1.4rem; }
    .experimental-option-row label { font-weight: 500; }
    .result { padding: 1rem; background: #eef8f2; border: 1px solid #b9dec6; border-radius: .55rem; }
    .result .warning { margin-top: .9rem; }
    .credential { display: grid; grid-template-columns: 9rem 1fr; gap: .5rem; margin: .5rem 0; }
    code { word-break: break-all; user-select: all; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    @media (max-width: 42rem) { .grid, .user { grid-template-columns: 1fr; } .credential { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>OpenID Providerを作成</h1>
    <p>Honoと @maronn-openid-connect/core で構成した専用Cloudflare Workerを発行します。状態は共有D1へOPごとに分離して保存されます。</p>
  </header>
  <form id="form">
    <section class="card">
      <h2>アプリ設定</h2>
      <div class="grid">
        <div><label class="block" for="name">表示名（任意）</label><input id="name" maxlength="40" autocomplete="off"></div>
        <div><label class="block" for="redirect-url">ログイン後のリダイレクトURL</label><input id="redirect-url" type="url" required placeholder="https://example.com/callback"></div>
        <div><label class="block" for="client-type">クライアント種別</label><select id="client-type"><option value="public">public</option><option value="confidential">confidential</option></select></div>
        <div><label class="block">テンプレート</label><input value="Hono（固定）" disabled></div>
      </div>
      <p class="hint">クライアントIDは自動発行されます。confidentialではクライアントシークレットも作成完了後に一度だけ表示します。</p>
      <p class="hint">リダイレクトURLはhttps（localhostと127.0.0.1のみhttp可）で指定し、#以降のフラグメントは含められません。表示名は40文字以内で日本語も使えます。</p>
    </section>

    <section class="card">
      <fieldset><legend>スコープ</legend>
        <div class="choices"><label><input type="checkbox" checked disabled> openid（必須）</label>
          <label><input class="scope" type="checkbox" value="profile"> profile</label>
          <label><input class="scope" type="checkbox" value="email"> email</label>
          <label><input class="scope" type="checkbox" value="address"> address</label>
          <label><input class="scope" type="checkbox" value="phone"> phone</label>
          <label><input class="scope" type="checkbox" value="offline_access"> offline_access</label>
        </div>
      </fieldset>
    </section>

    <section class="card">
      <fieldset><legend>OP機能</legend>
        <div class="choices">
          <label><input class="feature" type="checkbox" value="pkce" checked> PKCE</label>
          <label><input class="feature" type="checkbox" value="refresh-token" checked> Refresh Token</label>
          <label><input class="feature" type="checkbox" value="introspection" checked> Introspection</label>
          <label><input class="feature" type="checkbox" value="revocation" checked> Revocation</label>
          <label><input class="feature" type="checkbox" value="request-object" checked> Request Object</label>
        </div>
        <p class="hint">publicクライアントはライブラリの安全ポリシーにより、PKCE設定をオフにしてもPKCEが必須です。</p>
      </fieldset>
    </section>

${experimentalCard()}
    <section class="card">
      <div class="section-heading"><h2>登録予定のログインユーザー</h2><span class="count" id="user-count">0 / 5件</span></div>
      <div id="users"></div>
      <div class="choices">
        <button class="secondary" id="add-user" type="button">ユーザーを追加</button>
        <label class="secondary" style="padding:.65rem .9rem;border-radius:.5rem;cursor:pointer">CSVから読み込む<input class="sr" id="csv" type="file" accept=".csv,text/csv"></label>
      </div>
      <p class="hint" id="csv-feedback" aria-live="polite"></p>
      <div class="csv-preview" id="csv-preview" hidden></div>
      <p class="hint">ユーザー名は半角英数字と <code>. _ @ -</code> のみ（1〜64文字）、パスワードは8〜128文字です。</p>
      <p class="hint">CSVは先頭行を <code>username,password</code> とし、合計5件まで指定できます。パスワードは共有D1へ個別salt付きSHA-256ハッシュとして保存します。</p>
    </section>

    <section class="card">
      <button class="primary" id="submit" type="submit">OPを作成</button>
      <p id="quota" aria-live="polite">本日の残り作成回数を確認しています…</p>
      <div id="status" aria-live="polite"></div>
    </section>
  </form>
</main>
<script>
const form = document.querySelector('#form');
const users = document.querySelector('#users');
const submit = document.querySelector('#submit');
const quota = document.querySelector('#quota');
const statusBox = document.querySelector('#status');
const addUserButton = document.querySelector('#add-user');
const csvInput = document.querySelector('#csv');
const csvFeedback = document.querySelector('#csv-feedback');
const csvPreview = document.querySelector('#csv-preview');
const userCount = document.querySelector('#user-count');
const redirectInput = document.querySelector('#redirect-url');
const nameInput = document.querySelector('#name');
const USERNAME_RULE = /^[a-zA-Z0-9._@-]{1,64}$/;
const USERNAME_HINT = 'ユーザー名は半角英数字と . _ @ - のみ、1〜64文字で入力してください';
const PASSWORD_HINT = 'パスワードは8〜128文字で入力してください';
let exhausted = false;
let operationBusy = false;
let nextUserId = 1;

function updateUserControls() {
  const count = users.children.length;
  userCount.textContent = count + ' / 5件';
  addUserButton.disabled = count >= 5;
}

function addUser(username = '', password = '') {
  if (users.children.length >= 5) return false;
  const row = document.createElement('div'); row.className = 'user';
  const index = nextUserId++;
  const u = document.createElement('div');
  const ul = document.createElement('label'); ul.className = 'block'; ul.textContent = 'ユーザー名'; ul.htmlFor = 'username-' + index;
  const ui = document.createElement('input'); ui.id = 'username-' + index; ui.type = 'text'; ui.className = 'username'; ui.required = true; ui.maxLength = 64; ui.autocomplete = 'username'; ui.title = USERNAME_HINT; ui.value = username;
  ui.addEventListener('input', () => ui.setCustomValidity(''));
  u.append(ul, ui);
  const p = document.createElement('div');
  const pl = document.createElement('label'); pl.className = 'block'; pl.textContent = 'パスワード'; pl.htmlFor = 'password-' + index;
  const pi = document.createElement('input'); pi.id = 'password-' + index; pi.type = 'password'; pi.className = 'password'; pi.required = true; pi.maxLength = 128; pi.autocomplete = 'new-password'; pi.title = PASSWORD_HINT; pi.value = password;
  pi.addEventListener('input', () => pi.setCustomValidity(''));
  p.append(pl, pi);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = '削除'; remove.addEventListener('click', () => { if (users.children.length > 1) { row.remove(); updateUserControls(); } });
  row.append(u, p, remove); users.append(row); updateUserControls(); return true;
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.length > 1 || cell.length > 0) rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('引用符が閉じられていません');
  row.push(cell); if (row.length > 1 || cell.length > 0) rows.push(row);
  return rows;
}

function validateCsvRows(rows) {
  const seen = new Set();
  return rows.map((row) => {
    const errors = [];
    const username = (row[0] || '').trim();
    const password = row[1] || '';
    if (row.length !== 2) errors.push('列数は2列にしてください');
    if (!USERNAME_RULE.test(username)) errors.push('ユーザー名の形式が不正です');
    if (seen.has(username)) errors.push('ユーザー名が重複しています');
    if (username) seen.add(username);
    if (password.length < 8 || password.length > 128) errors.push('パスワードは8〜128文字にしてください');
    return { username, password, errors };
  });
}

function renderCsvPreview(fileName, entries, countError = '') {
  csvPreview.replaceChildren(); csvPreview.hidden = false;
  const title = document.createElement('p'); const strong = document.createElement('strong');
  strong.textContent = 'CSVプレビュー: ' + fileName; title.append(strong, document.createTextNode('（' + entries.length + '件）')); csvPreview.append(title);
  if (countError) { const error = document.createElement('p'); error.className = 'invalid'; error.textContent = countError; csvPreview.append(error); }
  const table = document.createElement('table');
  const head = document.createElement('thead'); const headRow = document.createElement('tr');
  for (const label of ['行', 'ユーザー名', 'パスワード', '判定']) { const th = document.createElement('th'); th.textContent = label; headRow.append(th); }
  head.append(headRow); table.append(head);
  const body = document.createElement('tbody');
  entries.forEach((entry, index) => {
    const tr = document.createElement('tr');
    const values = [String(index + 1), entry.username || '（未入力）', entry.password ? '入力あり（' + entry.password.length + '文字）' : '（未入力）'];
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    const result = document.createElement('td'); const errors = countError ? [countError, ...entry.errors] : entry.errors;
    result.textContent = errors.length ? errors.join(' / ') : 'OK'; result.className = errors.length ? 'invalid' : 'valid'; tr.append(result); body.append(tr);
  });
  table.append(body); csvPreview.append(table);
}

function redirectUrlError(value) {
  let url;
  try { url = new URL(value); } catch { return 'URLの形式が正しくありません（例: https://example.com/callback）'; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return 'httpsのURL、またはlocalhost・127.0.0.1のhttp URLを指定してください';
  if (url.username || url.password) return 'URLにユーザー名やパスワードを含めないでください';
  if (url.hash) return 'URLに#以降のフラグメントを含めないでください';
  if (value.length > 2048) return 'URLは2048文字以内で入力してください';
  return '';
}

function validateRedirectField() {
  redirectInput.setCustomValidity('');
  if (!redirectInput.value) return true;
  const message = redirectUrlError(redirectInput.value.trim());
  redirectInput.setCustomValidity(message);
  return !message;
}

function validateUserFields() {
  const seen = new Set(); let valid = true;
  for (const row of users.querySelectorAll('.user')) {
    const username = row.querySelector('.username');
    const password = row.querySelector('.password');
    username.setCustomValidity(''); password.setCustomValidity('');
    username.value = username.value.trim();
    if (!USERNAME_RULE.test(username.value)) { username.setCustomValidity(USERNAME_HINT); valid = false; }
    else if (seen.has(username.value)) { username.setCustomValidity('同じユーザー名は複数登録できません'); valid = false; }
    seen.add(username.value);
    if (password.value.length < 8 || password.value.length > 128) { password.setCustomValidity(PASSWORD_HINT); valid = false; }
  }
  return valid;
}

addUserButton.addEventListener('click', () => {
  if (addUser()) { csvFeedback.className = 'hint'; csvFeedback.textContent = '空のユーザー入力欄を追加しました。現在' + users.children.length + '件です。'; }
});
csvInput.addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  csvFeedback.className = 'hint'; csvFeedback.textContent = 'CSVを確認しています…';
  try {
    const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
    if (rows[0] && rows[0][0].trim().toLowerCase() === 'username' && rows[0][1]?.trim().toLowerCase() === 'password') rows.shift();
    const entries = validateCsvRows(rows); const countError = entries.length < 1 || entries.length > 5 ? 'ユーザーは1〜5件にしてください' : '';
    renderCsvPreview(file.name, entries, countError);
    if (countError || entries.some((entry) => entry.errors.length)) {
      csvFeedback.className = 'hint error'; csvFeedback.textContent = 'CSVに修正が必要な項目があります。プレビューの判定欄を確認してください。'; return;
    }
    users.replaceChildren(); entries.forEach((entry) => addUser(entry.username, entry.password)); updateUserControls();
    csvFeedback.textContent = entries.length + '件を登録予定のユーザー欄へ反映しました。内容を確認してからOPを作成してください。'; form.reportValidity();
  } catch (error) {
    csvPreview.hidden = true; csvPreview.replaceChildren(); csvFeedback.className = 'hint error'; csvFeedback.textContent = 'CSVを読み込めませんでした（' + error.message + '）';
  } finally { event.target.value = ''; }
});

function setBusy(value) { operationBusy = value; submit.disabled = operationBusy || exhausted; }
function textStatus(value) { statusBox.replaceChildren(document.createTextNode(value)); }

async function refreshQuota() {
  try {
    const response = await fetch('/api/quota'); if (!response.ok) throw new Error();
    const data = await response.json(); exhausted = data.remaining === 0;
    quota.textContent = '本日の残り作成回数: ' + data.remaining + ' / ' + data.limit + '（UTC日次リセット）'; submit.disabled = operationBusy || exhausted;
  } catch { quota.textContent = '本日の残り作成回数を取得できませんでした'; }
}

function selectedExperimentalFeatures() {
  return [...document.querySelectorAll('.experimental-toggle-input:checked')];
}

function collectExperimental() {
  const selection = {};
  for (const toggle of selectedExperimentalFeatures()) {
    const options = {};
    for (const option of document.querySelectorAll('.experimental-option[data-feature="' + toggle.value + '"]')) options[option.dataset.option] = option.checked;
    selection[toggle.value] = options;
  }
  return selection;
}

function showResult(data, credentials, experimental) {
  statusBox.replaceChildren(); const box = document.createElement('div'); box.className = 'result';
  const title = document.createElement('strong'); title.textContent = 'OPを作成しました'; box.append(title);
  const fields = [['OP URL', data.url], ['クライアントID', credentials.client_id]];
  if (credentials.client_secret) fields.push(['クライアントシークレット', credentials.client_secret]);
  for (const [label, value] of fields) { const row = document.createElement('div'); row.className = 'credential'; const key = document.createElement('span'); key.textContent = label; const code = document.createElement('code'); code.textContent = value; row.append(key, code); box.append(row); }
  const note = document.createElement('p'); note.textContent = credentials.client_secret ? 'シークレットは再表示できません。今すぐ安全な場所へ保存してください。' : 'publicクライアントのためシークレットは発行されません。'; box.append(note);
  if (experimental.length) {
    const warning = document.createElement('p'); warning.className = 'warning';
    warning.textContent = '試験的な機能を有効にしています（' + experimental.map((entry) => entry.label + ': ' + entry.endpoints).join(' / ') + '）。@maronn-openid-connect/experimental はAPIが安定しておらず、他の機能より適切に動作しない可能性が高い点にご注意ください。';
    box.append(warning);
  }
  statusBox.append(box);
}

async function poll(requestId, credentials, startedAt, experimental) {
  if (Date.now() - startedAt > 10 * 60 * 1000) { textStatus('作成状況の確認がタイムアウトしました。'); setBusy(false); return; }
  try {
    const response = await fetch('/api/requests/' + encodeURIComponent(requestId)); const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'status request failed');
    if (data.status === 'deployed') { showResult(data, credentials, experimental); setBusy(false); return; }
    if (data.status === 'failed') { textStatus('作成に失敗しました（' + (data.error || 'ci_failed') + '）'); setBusy(false); return; }
    textStatus('OPを作成しています… 現在: ' + data.status);
  } catch { textStatus('状態を取得できませんでした。再試行しています…'); }
  window.setTimeout(() => poll(requestId, credentials, startedAt, experimental), 3000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  validateRedirectField(); validateUserFields();
  if (users.children.length < 1) { textStatus('ログインユーザーを1件以上登録してください。'); return; }
  if (!form.reportValidity()) { textStatus('入力内容を確認してください。'); return; }
  setBusy(true); textStatus('作成リクエストを送信しています…');
  const body = {
    name: nameInput.value.trim(),
    redirect_url: redirectInput.value.trim(),
    client_type: document.querySelector('#client-type').value,
    scopes: ['openid', ...[...document.querySelectorAll('.scope:checked')].map((e) => e.value)],
    features: Object.fromEntries([...document.querySelectorAll('.feature')].map((e) => [e.value, e.checked])),
    experimental: collectExperimental(),
    users: [...users.querySelectorAll('.user')].map((row) => ({ username: row.querySelector('.username').value, password: row.querySelector('.password').value }))
  };
  const experimentalSummary = selectedExperimentalFeatures().map((toggle) => ({ label: toggle.dataset.label, endpoints: toggle.dataset.endpoints }));
  try {
    const response = await fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json();
    if (response.status === 429) { exhausted = true; throw new Error('本日の作成上限に達しました'); }
    if (!response.ok) throw new Error(data.message || data.error || 'request failed');
    textStatus('OPを作成しています…'); poll(data.request_id, { client_id: data.client_id, client_secret: data.client_secret }, Date.now(), experimentalSummary);
  } catch (error) { textStatus('作成に失敗しました（' + error.message + '）'); setBusy(false); }
  await refreshQuota();
});

redirectInput.addEventListener('input', () => redirectInput.setCustomValidity(''));
redirectInput.addEventListener('blur', () => validateRedirectField());

document.querySelector('.feature[value="refresh-token"]').addEventListener('change', (event) => {
  const offline = document.querySelector('.scope[value="offline_access"]');
  if (!event.target.checked) offline.checked = false;
  offline.disabled = !event.target.checked;
});

for (const toggle of document.querySelectorAll('.experimental-toggle-input')) {
  toggle.addEventListener('change', () => {
    for (const option of document.querySelectorAll('.experimental-option[data-feature="' + toggle.value + '"]')) option.disabled = !toggle.checked;
  });
}

addUser(); refreshQuota();
</script>
</body></html>`;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("content-type", "application/json; charset=utf-8");
  resultHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: resultHeaders });
}

function errorResponse(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return json({ error: code, message }, status, headers);
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function expandIpv6(input: string): number[] | null {
  let address = input.toLowerCase().split("%", 1)[0];
  const ipv4 = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4) {
    const parts = ipv4[1].split(".").map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return null;
    address = `${address.slice(0, -ipv4[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(address) || address.includes(":::")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
}

function compressIpv6(parts: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < parts.length;) {
    if (parts[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < parts.length && parts[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  if (bestStart < 0) return parts.map((part) => part.toString(16)).join(":");
  const left = parts.slice(0, bestStart).map((part) => part.toString(16)).join(":");
  const right = parts.slice(bestStart + bestLength).map((part) => part.toString(16)).join(":");
  return `${left}::${right}`;
}

function ipKey(value: string | null): string {
  if (!value) return "unknown";
  const trimmed = value.trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split(".").map(Number);
    return parts.every((part) => part >= 0 && part <= 255) ? trimmed : "invalid";
  }
  const expanded = expandIpv6(trimmed);
  return expanded ? `${compressIpv6([...expanded.slice(0, 4), 0, 0, 0, 0])}/64` : "invalid";
}

function utcDate(now = new Date()): string { return now.toISOString().slice(0, 10); }
function retryAfterUtcMidnight(now = new Date()): string {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return String(Math.max(1, Math.ceil((next - now.getTime()) / 1000)));
}

async function incrementCounter(env: Env, scope: "ip" | "global", key: string, date: string): Promise<number> {
  const row = await env.DB.prepare(`INSERT INTO registry_rate_limits (scope, key, date_utc, count) VALUES (?1, ?2, ?3, 1) ON CONFLICT (scope, key, date_utc) DO UPDATE SET count = count + 1 RETURNING count`).bind(scope, key, date).first<{ count: number }>();
  if (!row) throw new Error("rate-limit counter returned no row");
  return Number(row.count);
}

async function applyRateLimit(env: Env, key: string, date: string): Promise<boolean> {
  const ipLimit = parseLimit(env.RATE_LIMIT_PER_IP_PER_DAY, 10);
  const globalLimit = parseLimit(env.RATE_LIMIT_GLOBAL_PER_DAY, 50);
  const ipCount = await incrementCounter(env, "ip", key, date);
  if (ipCount > ipLimit) return false;
  const globalCount = await incrementCounter(env, "global", "*", date);
  if (globalCount <= globalLimit) return true;
  await env.DB.prepare(`UPDATE registry_rate_limits SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE scope = 'ip' AND key = ?1 AND date_utc = ?2`).bind(key, date).run();
  return false;
}

function validateRedirectUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const localhostHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localhostHttp) || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch { return null; }
}

function invalid(message: string): ParseFailure {
  return { ok: false, message };
}

/**
 * Experimental selections are validated against the catalog rather than passed through:
 * an id or option the generator cannot wire must fail here, not halfway through CI.
 * Declared options that are omitted fall back to their catalog default.
 */
function parseExperimental(value: unknown): { ok: true; value: ExperimentalSelection } | ParseFailure {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value)) return invalid("experimental must be an object");
  const selection: ExperimentalSelection = {};
  for (const [id, rawOptions] of Object.entries(value as Record<string, unknown>)) {
    const feature = EXPERIMENTAL_FEATURES.find((item) => item.id === id);
    if (!feature) return invalid(`experimental feature ${JSON.stringify(id)} is not supported`);
    if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) return invalid(`experimental feature ${JSON.stringify(id)} options must be an object`);
    const declared = feature.options ?? [];
    const options: Record<string, boolean> = {};
    for (const [optionId, optionValue] of Object.entries(rawOptions as Record<string, unknown>)) {
      if (!declared.some((item) => item.id === optionId)) return invalid(`experimental option ${JSON.stringify(`${id}.${optionId}`)} is not supported`);
      if (typeof optionValue !== "boolean") return invalid(`experimental option ${JSON.stringify(`${id}.${optionId}`)} must be true or false`);
      options[optionId] = optionValue;
    }
    for (const option of declared) if (!(option.id in options)) options[option.id] = option.default === true;
    selection[id] = options;
  }
  return { ok: true, value: selection };
}

function parseInput(value: unknown): ParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("request body must be a JSON object");
  const body = value as Record<string, unknown>;
  const rawName = body.name ?? "";
  if (typeof rawName !== "string") return invalid("display name must be a string");
  const name = rawName.trim();
  if (!NAME_PATTERN.test(name)) return invalid("display name must be 40 characters or fewer and must not contain control characters");
  const redirectUrl = validateRedirectUrl(body.redirect_url);
  if (!redirectUrl) return invalid("redirect URL must be an https URL (http is allowed only on localhost) without credentials or a fragment");
  const clientType = body.client_type;
  if (clientType !== "public" && clientType !== "confidential") return invalid("client type must be either public or confidential");
  if (!Array.isArray(body.scopes) || body.scopes[0] !== "openid") return invalid("scopes must be an array whose first entry is openid");
  if (new Set(body.scopes).size !== body.scopes.length) return invalid("scopes must not contain duplicates");
  const unknownScope = body.scopes.find((scope) => scope !== "openid" && !(OPTIONAL_SCOPES as readonly unknown[]).includes(scope));
  if (unknownScope !== undefined) return invalid(`scope ${JSON.stringify(unknownScope)} is not supported`);
  if (!body.features || typeof body.features !== "object" || Array.isArray(body.features)) return invalid("features must be an object");
  const rawFeatures = body.features as Record<string, unknown>;
  const unknownFeature = Object.keys(rawFeatures).find((key) => !(FEATURE_NAMES as readonly string[]).includes(key));
  if (unknownFeature !== undefined) return invalid(`feature ${JSON.stringify(unknownFeature)} is not supported`);
  const missingFeature = FEATURE_NAMES.find((key) => typeof rawFeatures[key] !== "boolean");
  if (missingFeature !== undefined) return invalid(`feature ${JSON.stringify(missingFeature)} must be true or false`);
  if (body.scopes.includes("offline_access") && rawFeatures["refresh-token"] !== true) return invalid("the offline_access scope requires the refresh-token feature");
  const experimental = parseExperimental(body.experimental);
  if (!experimental.ok) return experimental;
  if (!Array.isArray(body.users) || body.users.length < 1 || body.users.length > 5) return invalid("users must contain between 1 and 5 accounts");
  const usernames = new Set<string>();
  const parsedUsers: PortalUser[] = [];
  for (const [index, item] of body.users.entries()) {
    const position = `user ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid(`${position} must be an object`);
    const rawUsername = (item as Record<string, unknown>).username;
    const password = (item as Record<string, unknown>).password;
    if (typeof rawUsername !== "string") return invalid(`${position} must have a username`);
    const username = rawUsername.trim();
    if (!USERNAME_PATTERN.test(username)) return invalid(`${position} username must be 1-64 characters of a-z, A-Z, 0-9, dot, underscore, at sign, or hyphen`);
    if (usernames.has(username)) return invalid(`username ${JSON.stringify(username)} is registered twice`);
    if (typeof password !== "string" || password.length < 8 || password.length > 128) return invalid(`${position} password must be between 8 and 128 characters`);
    usernames.add(username); parsedUsers.push({ username, password });
  }
  return { ok: true, value: { name, redirectUrl, clientType, scopes: body.scopes as string[], features: rawFeatures as Record<FeatureName, boolean>, experimental: experimental.value, users: parsedUsers } };
}

function validateInput(value: unknown): CreateInput | null {
  const result = parseInput(value);
  return result.ok ? result.value : null;
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function allocateOpId(now = Date.now()): string {
  return `maronn-op-${Math.floor(now / 1000).toString(36)}${randomBase64Url(5).replace(/[-_]/g, "a").toLowerCase().slice(0, 6)}`;
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = new TextEncoder().encode(password);
  const saltedPassword = new Uint8Array(saltBytes.length + passwordBytes.length);
  saltedPassword.set(saltBytes);
  saltedPassword.set(passwordBytes, saltBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", saltedPassword);
  return { hash: randomBytesToBase64Url(new Uint8Array(digest)), salt: randomBytesToBase64Url(saltBytes), iterations: PASSWORD_HASH_ROUNDS };
}

function randomBytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function dispatchWorkflow(env: Env, inputs: Record<string, string>): Promise<boolean> {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/generate-op.yml/dispatches`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, "content-type": "application/json", "user-agent": "maronn-oidc-portal", "x-github-api-version": "2022-11-28" },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  return response.status === 204;
}

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const key = ipKey(request.headers.get("CF-Connecting-IP"));
  const date = utcDate();
  const row = await env.DB.prepare(`SELECT count FROM registry_rate_limits WHERE scope = 'ip' AND key = ?1 AND date_utc = ?2`).bind(key, date).first<{ count: number }>();
  const limit = parseLimit(env.RATE_LIMIT_PER_IP_PER_DAY, 10);
  const used = Number(row?.count ?? 0);
  return json({ limit, used, remaining: Math.max(0, limit - used) });
}

async function handleStatus(requestId: string, env: Env): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return errorResponse("not_found", "request was not found", 404);
  const row = await env.DB.prepare(`SELECT request_id, status, op_id, url, error, created_at FROM registry_requests WHERE request_id = ?1`).bind(requestId).first<RequestRow>();
  return row ? json(row) : errorResponse("not_found", "request was not found", 404);
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !origin || origin !== `https://${host}`) return errorResponse("origin_mismatch", "Origin does not match this portal", 403);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 20_000) return errorResponse("payload_too_large", "request body is too large", 413);
  let raw: unknown;
  try { raw = await request.json(); } catch { return errorResponse("invalid_input", "request body must be valid JSON", 400); }
  const parsed = parseInput(raw);
  if (!parsed.ok) return errorResponse("invalid_input", parsed.message, 400);
  const input = parsed.value;

  const key = ipKey(request.headers.get("CF-Connecting-IP"));
  const date = utcDate();
  if (!(await applyRateLimit(env, key, date))) return errorResponse("rate_limited", "daily OP creation limit reached", 429, { "retry-after": retryAfterUtcMidnight() });

  const requestId = crypto.randomUUID();
  const opId = allocateOpId();
  const clientId = `client_${randomBase64Url(12)}`;
  const clientSecret = input.clientType === "confidential" ? randomBase64Url(32) : null;
  const now = new Date().toISOString();
  const requestConfig = {
    name: input.name || opId,
    redirect_url: input.redirectUrl,
    client_type: input.clientType,
    client_id: clientId,
    client_secret: clientSecret,
    scopes: input.scopes,
    features: input.features,
    experimental: input.experimental,
  };
  const hashedUsers = await Promise.all(input.users.map(async (user) => ({ username: user.username, ...(await hashPassword(user.password)) })));
  const statements = [
    env.DB.prepare(`INSERT INTO registry_requests (request_id, status, op_id, name, config_json, ip_key, created_at, updated_at) VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?6)`).bind(requestId, opId, input.name || opId, JSON.stringify(requestConfig), key, now),
    ...hashedUsers.map((user) => env.DB.prepare(`INSERT INTO oidc_users (op_id, username, password_hash, password_salt, password_iterations, claims_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(opId, user.username, user.hash, user.salt, user.iterations, JSON.stringify({ sub: user.username, name: user.username, preferred_username: user.username }), now)),
  ];
  await env.DB.batch(statements);

  let dispatched = false;
  try { dispatched = await dispatchWorkflow(env, { request_id: requestId, op_id: opId }); } catch (error) { console.error("workflow dispatch failed", error); }
  if (!dispatched) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE registry_requests SET status = 'failed', error = 'dispatch_failed', config_json = NULL, updated_at = ?2 WHERE request_id = ?1`).bind(requestId, new Date().toISOString()),
      env.DB.prepare(`DELETE FROM oidc_users WHERE op_id = ?1`).bind(opId),
    ]);
    return errorResponse("dispatch_failed", "failed to start the generation workflow", 502);
  }
  return json({ request_id: requestId, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }, 202);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" } });
  if (request.method === "GET" && url.pathname === "/api/quota") return handleQuota(request, env);
  if (request.method === "GET" && url.pathname.startsWith("/api/requests/")) return handleStatus(decodeURIComponent(url.pathname.slice(14)), env);
  if (request.method === "POST" && url.pathname === "/api/apps") return handleCreate(request, env);
  return errorResponse("not_found", "route was not found", 404);
}

export default { async fetch(request: Request, env: Env): Promise<Response> { try { return await route(request, env); } catch (error) { console.error("portal request failed", error); return errorResponse("internal_error", "an internal error occurred", 500); } } } satisfies ExportedHandler<Env>;

export { HTML, allocateOpId, applyRateLimit, hashPassword, ipKey, parseInput, retryAfterUtcMidnight, route, validateInput, validateRedirectUrl };
