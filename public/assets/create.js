import {
  api, copyText, currentUser, element, formatTime, goToLogin, renderSession,
  runtime, setBusy, showError, showMessage
} from './common.js';

const state = {
  step: 1, mapId: null, map: null, canContinue: false, canActivate: false,
  clientOnline: false, pollTimer: null
};
const backButton = document.querySelector('#wizard-back');
const nextButton = document.querySelector('#wizard-next');
const infoForm = document.querySelector('#map-info-form');

function passwordKey(mapId) { return `lagrange.wizard.${mapId}.joinPassword`; }

function syncNext() {
  nextButton.disabled = (state.step === 2 || state.step === 3) && !state.canContinue;
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
  if (step === 2) pollWizard();
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
  state.canContinue = Boolean(data.canContinueToInfo);
  state.canActivate = Boolean(data.canActivate);
  state.clientOnline = Boolean(data.client?.online);
  document.querySelector('#client-online').textContent = `客户端状态：${state.clientOnline ? '在线' : '不在线'}`;
  document.querySelector('#client-last-seen').textContent = `最近同步：${formatTime(data.client?.lastSeenAt)}`;
  document.querySelector('#first-data').textContent = `首批数据：${data.firstDataReceived ? '已到达' : '尚未到达'}`;

  const ready = state.canContinue;
  const creatorName = document.querySelector('#creator-game-name');
  if (data.map.creatorGameName && !creatorName.value) creatorName.value = data.map.creatorGameName;
  document.querySelector('#creator-waiting').hidden = ready;
  document.querySelector('#galaxy-auto').textContent = data.client?.galaxy?.name || '等待客户端上报';
  document.querySelector('#organization-auto').textContent = data.client?.organization?.name || '等待客户端上报';
  const nameInput = document.querySelector('#map-name');
  if (data.map.name) nameInput.value = data.map.name;
  else if (data.suggestedName && !nameInput.value) nameInput.value = data.suggestedName;
  for (const field of infoForm.querySelectorAll('input, select')) field.disabled = !ready;
  document.querySelector('#find-creator').disabled = !ready;
  syncNext();
  if (data.map.status === 'active' && state.step !== 4) setStep(4);
  return data;
}

async function pollWizard() {
  stopPolling();
  if (state.step !== 2 || !state.mapId) return;
  try {
    const data = await api(`/maps/${encodeURIComponent(state.mapId)}/wizard`);
    updateWizard(data);
  } catch (error) {
    showError(error);
  } finally {
    if (state.step === 2) state.pollTimer = window.setTimeout(pollWizard, 4000);
  }
}

async function prepareDeployment() {
  const data = await api('/maps', { method: 'POST', body: {} });
  state.mapId = data.map.id;
  state.map = data.map;
  window.history.replaceState({}, '', runtime.page('create.html', { id: state.mapId }));
  await issueToken();
}

function candidateLabel(candidate) {
  const organization = candidate.organization?.name || '联合体未知';
  const team = candidate.teamId ? `小队 ${candidate.teamId}` : '无小队信息';
  return `${candidate.gameName} · 角色 ID：${candidate.gameId}\n${organization} · ${team}${candidate.isLeader ? ' · 盟主' : ''}`;
}

function resetCreatorLookup() {
  document.querySelector('#creator-game-id').value = '';
  document.querySelector('#creator-candidates').replaceChildren();
  document.querySelector('#creator-warning').hidden = true;
}

async function findCreatorCandidates(event) {
  const gameName = document.querySelector('#creator-game-name').value.trim();
  if (!gameName) {
    showMessage('请先输入大号游戏角色名。', 'error');
    return;
  }
  resetCreatorLookup();
  const container = document.querySelector('#creator-candidates');
  const button = event.currentTarget;
  setBusy(button, true, '正在检索……');
  try {
    const data = await api(`/maps/${encodeURIComponent(state.mapId)}/creator-candidates?gameName=${encodeURIComponent(gameName)}`);
    if (!data.candidates.length) {
      const warning = document.querySelector('#creator-warning');
      warning.textContent = `未匹配到“${gameName}”的角色 ID。大号可能尚未进入观察小号视野；可以继续创建，暂时只保存角色名。`;
      warning.hidden = false;
      return;
    }
    if (data.candidates.length === 1) {
      document.querySelector('#creator-game-id').value = data.candidates[0].gameId;
      container.append(element('p', { className: 'muted', text: `已确认唯一匹配：\n${candidateLabel(data.candidates[0])}` }));
      return;
    }
    container.append(element('p', { className: 'muted', text: '存在重名，必须选择一个大号角色 ID：' }));
    for (const candidate of data.candidates) {
      container.append(element('button', {
        type: 'button', text: candidateLabel(candidate),
        onclick: (clickEvent) => {
          document.querySelector('#creator-game-id').value = candidate.gameId;
          for (const button of container.querySelectorAll('button')) button.removeAttribute('aria-pressed');
          clickEvent.currentTarget.setAttribute('aria-pressed', 'true');
        }
      }));
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
}

async function completeInfo() {
  if (!infoForm.reportValidity()) return false;
  const creatorGameId = document.querySelector('#creator-game-id').value;
  if (document.querySelectorAll('#creator-candidates button').length > 1 && !creatorGameId) {
    showMessage('存在重名，请先从候选列表选择大号角色 ID。', 'error');
    return false;
  }
  const joinPassword = document.querySelector('#new-join-password').value;
  const data = await api(`/maps/${encodeURIComponent(state.mapId)}/wizard`, {
    method: 'POST',
    body: {
      name: document.querySelector('#map-name').value.trim(),
      creatorGameName: document.querySelector('#creator-game-name').value.trim(),
      ...(creatorGameId ? { creatorGameId } : {}),
      reviewRequired: document.querySelector('#review-required').checked,
      joinPassword
    }
  });
  state.map = data.map;
  state.canActivate = true;
  if (data.creatorWarning) showMessage(data.creatorWarning, 'error');
  window.sessionStorage.setItem(passwordKey(state.mapId), joinPassword);
  return true;
}

nextButton.addEventListener('click', async () => {
  nextButton.disabled = true;
  nextButton.textContent = '正在处理……';
  try {
    if (state.step === 1) {
      if (!state.mapId) await prepareDeployment();
      setStep(2);
    } else if (state.step === 2) {
      setStep(3);
    } else if (state.step === 3) {
      if (!(await completeInfo())) return;
      await api(`/maps/${encodeURIComponent(state.mapId)}/activate`, { method: 'POST', body: {} });
      setStep(4);
    }
  } catch (error) {
    showError(error);
  } finally {
    nextButton.textContent = state.step === 3 ? '激活并完成' : '继续';
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

document.querySelector('#creator-game-name').addEventListener('input', resetCreatorLookup);
document.querySelector('#find-creator').addEventListener('click', findCreatorCandidates);

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
      const data = await api(`/maps/${encodeURIComponent(state.mapId)}/wizard`);
      updateWizard(data);
      setStep(data.map.status === 'active' ? 4 : data.map.wizardStep);
    } else {
      setStep(1);
    }
  } catch (error) {
    showError(error);
    nextButton.disabled = true;
  }
}

initialize();
