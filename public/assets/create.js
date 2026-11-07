import {
  api, copyText, currentUser, formatTime, goToLogin, renderSession,
  runtime, showError, showMessage
} from './common.js';

const state = { step: 1, mapId: null, map: null, canActivate: false, clientOnline: false, pollTimer: null };
const backButton = document.querySelector('#wizard-back');
const nextButton = document.querySelector('#wizard-next');
const infoForm = document.querySelector('#map-info-form');

function passwordKey(mapId) { return `lagrange.wizard.${mapId}.joinPassword`; }

function syncNext() {
  nextButton.disabled = state.step === 3 && !(state.canActivate && state.clientOnline);
}

function stopPolling() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function setStep(step) {
  state.step = step;
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = Number(panel.dataset.panel) !== step;
  for (const item of document.querySelectorAll('#wizard-steps [data-step]')) {
    if (Number(item.dataset.step) === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  backButton.hidden = step === 4;
  nextButton.hidden = step === 4;
  backButton.disabled = step === 1;
  nextButton.textContent = step === 3 ? '激活并完成' : '继续';
  if (step === 3) pollWizard();
  else stopPolling();
  if (step === 4) showCompletion();
  syncNext();
  window.scrollTo({ top: 0 });
}

function showCompletion() {
  document.querySelector('#finished-map-id').textContent = state.mapId || '';
  const password = state.mapId ? window.sessionStorage.getItem(passwordKey(state.mapId)) : '';
  document.querySelector('#finished-join-password').textContent = password || '无法从当前标签页恢复，请使用创建时保存的密码';
  document.querySelector('#enter-map').href = runtime.page('map.html', { id: state.mapId });
}

async function loadPrep() {
  const data = await api('/maps/wizard-prep');
  const requirements = document.querySelector('#prep-requirements');
  requirements.replaceChildren();
  for (const text of data.requirements) {
    const item = document.createElement('li');
    item.textContent = text;
    requirements.append(item);
  }
  document.querySelector('#prep-why').textContent = data.why;
}

async function issueToken() {
  if (!state.mapId) return;
  const data = await api(`/maps/${encodeURIComponent(state.mapId)}/client-tokens`, {
    method: 'POST', body: { label: '创建向导客户端' }
  });
  document.querySelector('#client-token').value = data.token;
  showMessage('客户端令牌已生成，请立即复制。');
}

function updateWizard(data) {
  state.map = data.map;
  state.canActivate = data.canActivate;
  state.clientOnline = Boolean(data.client?.online);
  document.querySelector('#client-online').textContent = `客户端状态：${state.clientOnline ? '在线' : '不在线'}`;
  document.querySelector('#client-last-seen').textContent = `最近同步：${formatTime(data.client?.lastSeenAt)}`;
  document.querySelector('#first-data').textContent = `首批数据：${data.firstDataReceived ? '已到达' : '尚未到达'}`;
  syncNext();
  if (data.map.status === 'active' && state.step !== 4) setStep(4);
  return data;
}

async function pollWizard() {
  stopPolling();
  if (state.step !== 3 || !state.mapId) return;
  try {
    const data = await api(`/maps/${encodeURIComponent(state.mapId)}/wizard`);
    updateWizard(data);
  } catch (error) {
    showError(error);
  } finally {
    if (state.step === 3) state.pollTimer = window.setTimeout(pollWizard, 4000);
  }
}

async function createMap() {
  if (!infoForm.reportValidity()) return false;
  const joinPassword = document.querySelector('#new-join-password').value;
  const data = await api('/maps', {
    method: 'POST',
    body: {
      name: document.querySelector('#map-name').value.trim(),
      creatorGameName: document.querySelector('#creator-game-name').value.trim(),
      reviewRequired: document.querySelector('#review-required').checked,
      joinPassword
    }
  });
  state.mapId = data.map.id;
  state.map = data.map;
  window.sessionStorage.setItem(passwordKey(state.mapId), joinPassword);
  window.history.replaceState({}, '', runtime.page('create.html', { id: state.mapId }));
  for (const input of infoForm.querySelectorAll('input')) input.disabled = true;
  await issueToken();
  return true;
}

nextButton.addEventListener('click', async () => {
  const original = nextButton.textContent;
  nextButton.disabled = true;
  nextButton.textContent = '正在处理……';
  try {
    if (state.step === 1) {
      setStep(2);
    } else if (state.step === 2) {
      if (!state.mapId && !(await createMap())) return;
      setStep(3);
    } else if (state.step === 3) {
      await api(`/maps/${encodeURIComponent(state.mapId)}/activate`, { method: 'POST', body: {} });
      setStep(4);
    }
  } catch (error) {
    showError(error);
  } finally {
    nextButton.textContent = state.step === 3 ? '激活并完成' : original;
    if (state.step !== 3) nextButton.textContent = '继续';
    syncNext();
  }
});

backButton.addEventListener('click', () => {
  if (state.step > 1) setStep(state.step - 1);
});

infoForm.addEventListener('submit', (event) => {
  event.preventDefault();
  nextButton.click();
});

document.querySelector('#client-download').addEventListener('click', () => {
  showMessage('客户端下载链接将在客户端模块交付后填入，本波不上传虚假安装包。');
});

document.querySelector('#new-token').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { await issueToken(); } catch (error) { showError(error); }
  finally { event.currentTarget.disabled = false; }
});

document.querySelector('#copy-token').addEventListener('click', async () => {
  try {
    await copyText(document.querySelector('#client-token').value);
    showMessage('令牌已复制。');
  } catch (error) { showError(error); }
});

document.querySelector('#enter-map').addEventListener('click', () => {
  if (state.mapId) window.sessionStorage.removeItem(passwordKey(state.mapId));
});

window.addEventListener('pagehide', stopPolling);

async function initialize() {
  try {
    const user = await currentUser();
    if (!user) { goToLogin('register'); return; }
    renderSession(user);
    await loadPrep();
    state.mapId = new URL(window.location.href).searchParams.get('id');
    if (state.mapId) {
      for (const input of infoForm.querySelectorAll('input')) input.disabled = true;
      const data = await api(`/maps/${encodeURIComponent(state.mapId)}/wizard`);
      state.map = data.map;
      document.querySelector('#map-name').value = data.map.name;
      document.querySelector('#review-required').checked = data.map.reviewRequired;
      updateWizard(data);
      setStep(data.map.status === 'active' ? 4 : 3);
    } else {
      setStep(1);
    }
  } catch (error) {
    showError(error);
    nextButton.disabled = true;
  }
}

initialize();
