import { runtime } from './runtime.js';

const BETA_WELCOME_PENDING = 'lagrange.beta-welcome.pending';
const form = document.querySelector('#beta-form');
const input = document.querySelector('#beta-code');
const submit = document.querySelector('#beta-submit');
const message = document.querySelector('#message');

function destination() {
  const fallback = runtime.page('index.html');
  const requested = new URL(window.location.href).searchParams.get('next') || '/';
  if (!requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) return fallback;
  const target = new URL(`.${requested}`, runtime.base);
  const betaPage = new URL('beta.html', runtime.base);
  if (target.origin !== window.location.origin || !target.pathname.startsWith(runtime.base.pathname) || target.pathname === betaPage.pathname) {
    return fallback;
  }
  return target.toString();
}

function showError(text) {
  message.textContent = text;
  message.className = 'message error';
  message.hidden = !text;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  submit.disabled = true;
  submit.textContent = '正在验证……';
  showError('');
  try {
    const response = await fetch(`${runtime.apiBase}/beta/enter`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: input.value.trim() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `验证失败（HTTP ${response.status}）`);
    if (data.required && data.boundName) {
      try { window.sessionStorage.setItem(BETA_WELCOME_PENDING, data.boundName); } catch { /* 无存储权限时仍允许进站 */ }
    }
    window.location.replace(destination());
  } catch (error) {
    showError(error.message || String(error));
    submit.disabled = false;
    submit.textContent = '进入战略地图';
    input.focus();
    input.select();
  }
});

fetch(`${runtime.apiBase}/beta/enter`, { credentials: 'same-origin' })
  .then((response) => response.json())
  .then((data) => { if (data.required === false) window.location.replace(destination()); })
  .catch(() => { /* 提交时仍会显示真实网络错误 */ });
