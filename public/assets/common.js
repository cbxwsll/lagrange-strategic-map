import { runtime } from './runtime.js';

export { runtime };

export const MAP_STATUS = {
  draft: '创建中',
  active: '活跃',
  historical: '历史只读',
  maintenance: '游戏服维护',
  suspended: '数据号离盟，已暂停访问',
  merged: '已合并'
};

export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export async function api(path, options = {}) {
  const { method = 'GET', body, signal } = options;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${runtime.apiBase}${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error?.code === 'BETA_REQUIRED') {
      const entry = new URL(data.betaEntry || 'beta.html', runtime.base);
      const current = new URL(window.location.href);
      const basePath = runtime.base.pathname;
      const pagePath = current.pathname.startsWith(basePath) ? current.pathname.slice(basePath.length) : '';
      entry.searchParams.set('next', `/${pagePath}${current.search}${current.hash}`);
      window.location.replace(entry.toString());
    }
    const error = new Error(data.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = data.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function currentSession() {
  return api('/auth/session');
}

export async function currentUser() {
  return (await currentSession()).user;
}

export function renderSession(user) {
  const navigation = document.querySelector('#session-nav');
  navigation.replaceChildren();
  if (!user) {
    navigation.append(element('a', { href: './auth.html', text: '登录 / 注册' }));
    return;
  }
  navigation.append(
    element('span', { text: user.username, className: 'small' }),
    element('a', { href: './settings.html', text: '账号设置' }),
    element('button', {
      type: 'button', text: '退出',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* 本地会话仍返回列表 */ }
        window.location.href = runtime.page('index.html');
      }
    })
  );
}

export function goToLogin(mode = 'login') {
  window.location.href = runtime.page('auth.html', { mode });
}

export function showMessage(text, type = 'success', target = document.querySelector('#message')) {
  if (!target) return;
  target.textContent = text;
  target.className = `message ${type}`;
  target.hidden = !text;
}

export function showError(error, target) {
  showMessage(error?.message || String(error), 'error', target);
}

export function formatTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间格式未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}

export function setBusy(button, busy, busyText = '正在处理……') {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

const BETA_WELCOME_PENDING = 'lagrange.beta-welcome.pending';
const BETA_WELCOME_COPY = '本网站处于内测阶段：功能可能不稳定，内测期间的账号和地图数据不保证保留到正式版；遇到问题请联系站长反馈。本地客户端挂机采集数据存在游戏账号封禁风险，请自行评估后使用。';
let betaWelcomeOverlay = null;
const betaWelcomeCallbacks = [];

function closeBetaWelcome() {
  if (!betaWelcomeOverlay) return;
  try { window.sessionStorage.removeItem(BETA_WELCOME_PENDING); } catch { /* 无存储权限时仅本次关闭 */ }
  betaWelcomeOverlay.remove();
  betaWelcomeOverlay = null;
  const callbacks = betaWelcomeCallbacks.splice(0);
  for (const callback of callbacks) callback();
}

export function showBetaWelcome(onClose) {
  if (betaWelcomeOverlay) {
    if (onClose) betaWelcomeCallbacks.push(onClose);
    return true;
  }
  let boundName;
  try {
    boundName = window.sessionStorage.getItem(BETA_WELCOME_PENDING);
  } catch { return false; }
  if (!boundName) return false;
  if (onClose) betaWelcomeCallbacks.push(onClose);
  const accept = element('button', { id: 'beta-welcome-accept', type: 'button', className: 'primary', text: '我知道了', onclick: closeBetaWelcome });
  betaWelcomeOverlay = element('div', {
    id: 'beta-welcome', className: 'notice-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'beta-welcome-title'
  }, [element('div', { className: 'notice-box' }, [
    element('h2', { id: 'beta-welcome-title', text: `欢迎体验内测版本，${boundName}。` }),
    element('p', { text: BETA_WELCOME_COPY }),
    accept
  ])]);
  document.body.append(betaWelcomeOverlay);
  accept.focus();
  return true;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeBetaWelcome();
});

showBetaWelcome();

export function showFirstNotice() {
  if (showBetaWelcome(showFirstNotice)) return;
  const key = 'lagrange.notice.v1';
  try { if (window.localStorage.getItem(key) === 'seen') return; } catch { /* 存储不可用时仍显示 */ }
  const overlay = document.querySelector('#first-notice');
  const accept = document.querySelector('#notice-accept');
  overlay.hidden = false;
  accept.focus();
  accept.addEventListener('click', () => {
    try { window.localStorage.setItem(key, 'seen'); } catch { /* 无存储权限时仅本次关闭 */ }
    overlay.hidden = true;
  });
}

export function connectMapSocket(mapId, onStatus, onBusinessMessage = () => {}) {
  let socket;
  let reconnectTimer;
  let stopped = false;

  function connect() {
    if (stopped) return;
    onStatus('WebSocket：正在连接……');
    socket = new WebSocket(runtime.wsUrl);
    socket.addEventListener('open', () => {
      onStatus('WebSocket：已连接，正在订阅……');
      socket.send(JSON.stringify({ type: 'subscribe', mapId }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') {
        onStatus(message.businessEvents === false
          ? 'WebSocket：已连接（业务推送待后续开放）'
          : 'WebSocket：已连接');
      } else if (message.type === 'subscribed' && message.mapId === mapId) {
        onStatus('WebSocket：已订阅本地图');
      } else if (message.type === 'error') {
        onStatus(`WebSocket：${message.message || message.code || '通道错误'}`);
      } else {
        onBusinessMessage(message);
      }
    });
    socket.addEventListener('close', () => {
      if (stopped) return;
      onStatus('WebSocket：已断开，5 秒后重连');
      reconnectTimer = window.setTimeout(connect, 5000);
    });
    socket.addEventListener('error', () => onStatus('WebSocket：连接失败，将自动重试'));
  }

  connect();
  return {
    close() {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    }
  };
}

export async function copyText(text) {
  if (!text) throw new Error('没有可复制的令牌');
  if (!navigator.clipboard?.writeText) throw new Error('请选中令牌文本后手动复制');
  await navigator.clipboard.writeText(text);
}

export function requiredMapId() {
  const mapId = new URL(window.location.href).searchParams.get('id');
  if (!mapId) throw new Error('网址缺少地图 ID');
  return mapId;
}
