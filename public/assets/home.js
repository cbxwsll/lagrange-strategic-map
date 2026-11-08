import {
  MAP_STATUS, api, currentSession, element, renderSession, runtime, showError,
  showFirstNotice, showMessage, setBusy
} from './common.js';

let selectedMap = null;
let pollTimer = null;

const list = document.querySelector('#map-list');
const listStatus = document.querySelector('#list-status');
const joinSection = document.querySelector('#join-section');
const joinForm = document.querySelector('#join-form');
const evidenceWrap = document.querySelector('#evidence-wrap');
const evidenceInput = document.querySelector('#join-evidence');
const candidates = document.querySelector('#identity-candidates');
const requestStatus = document.querySelector('#join-request-status');

function receiptKey(mapId) { return `lagrange.join.${mapId}`; }

function savedRequest(mapId) {
  try { return JSON.parse(window.sessionStorage.getItem(receiptKey(mapId)) || 'null'); }
  catch { return null; }
}

function saveRequest(mapId, request) {
  try { window.sessionStorage.setItem(receiptKey(mapId), JSON.stringify(request)); } catch { /* 当前页仍可轮询 */ }
}

function clearRequest(mapId) {
  try { window.sessionStorage.removeItem(receiptKey(mapId)); } catch { /* 无存储权限 */ }
}

function stopPolling() {
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

function openJoin(map) {
  stopPolling();
  selectedMap = map;
  joinSection.hidden = false;
  document.querySelector('#join-title').textContent = `加入${map.displayName}`;
  evidenceWrap.hidden = !map.reviewRequired;
  evidenceInput.required = map.reviewRequired;
  joinForm.reset();
  candidates.replaceChildren();
  requestStatus.hidden = true;
  document.querySelector('#join-game-id').value = '';
  document.querySelector('#join-password').value = '';
  joinSection.scrollIntoView({ block: 'start' });
  document.querySelector('#join-game-name').focus();
  const pending = savedRequest(map.id);
  if (pending) pollRequest(map.id, pending);
}

function mapRow(map) {
  const title = map.joined
    ? element('a', { href: `./map.html?id=${encodeURIComponent(map.id)}`, text: map.displayName })
    : element('span', { text: map.displayName });
  const heading = element('h2', {}, [title]);
  if (map.joined) heading.append(element('span', { className: 'badge', text: '我的地图' }));
  const description = element('div', {}, [
    heading,
    element('p', { className: 'muted small', text: `${MAP_STATUS[map.status] || map.status} · 地图 ID：${map.id}` })
  ]);
  const actions = element('div', { className: 'row-actions' });
  if (map.joined) {
    actions.append(element('a', { className: 'button primary', href: `./map.html?id=${encodeURIComponent(map.id)}`, text: '进入地图' }));
  } else {
    actions.append(element('button', { type: 'button', text: '加入', onclick: () => openJoin(map) }));
  }
  return element('li', { className: 'map-row' }, [description, actions]);
}

async function loadMaps() {
  listStatus.textContent = '正在读取地图……';
  list.replaceChildren();
  try {
    const data = await api('/maps');
    listStatus.textContent = data.maps.length ? `共 ${data.maps.length} 张地图` : '暂无已创建地图';
    for (const map of data.maps) list.append(mapRow(map));
  } catch (error) {
    listStatus.textContent = '地图读取失败';
    showError(error);
  }
}

async function pollRequest(mapId, request) {
  stopPolling();
  if (!selectedMap || selectedMap.id !== mapId) return;
  requestStatus.hidden = false;
  requestStatus.textContent = '申请已发送，正在等待 T 权限持有者或盟主审批……';
  try {
    const result = await api(`/maps/${encodeURIComponent(mapId)}/join-requests/${encodeURIComponent(request.id)}/session`, {
      method: 'POST', body: { receipt: request.receipt }
    });
    if (result.status === 'approved') {
      clearRequest(mapId);
      requestStatus.textContent = `已通过，正在以 ${result.member.gameName} 的游戏身份进入地图……`;
      window.location.href = runtime.page('map.html', { id: mapId });
      return;
    }
    if (result.status === 'rejected' || result.status === 'cancelled') {
      clearRequest(mapId);
      requestStatus.textContent = result.status === 'rejected' ? '申请已被拒绝，可以修改信息后重新申请。' : '申请已取消。';
      return;
    }
    saveRequest(mapId, request);
    pollTimer = window.setTimeout(() => pollRequest(mapId, request), 4000);
  } catch (error) {
    requestStatus.textContent = `审批状态读取失败：${error.message}，将自动重试。`;
    pollTimer = window.setTimeout(() => pollRequest(mapId, request), 6000);
  }
}

document.querySelector('#join-game-name').addEventListener('input', () => {
  document.querySelector('#join-game-id').value = '';
  candidates.replaceChildren();
});

document.querySelector('#find-identities').addEventListener('click', async (event) => {
  if (!selectedMap) return;
  const gameName = document.querySelector('#join-game-name').value.trim();
  if (!gameName) {
    showMessage('请先输入游戏名。', 'error');
    return;
  }
  setBusy(event.currentTarget, true, '正在查询……');
  candidates.replaceChildren();
  document.querySelector('#join-game-id').value = '';
  try {
    const data = await api(`/maps/${encodeURIComponent(selectedMap.id)}/game-identities?gameName=${encodeURIComponent(gameName)}`);
    if (!data.candidates.length) {
      candidates.append(element('p', { className: 'muted', text: '没有客户端上报的同名身份，请确认游戏名或等待客户端同步。' }));
    } else if (data.candidates.length === 1) {
      document.querySelector('#join-game-id').value = data.candidates[0].gameId;
      candidates.append(element('p', { className: 'muted', text: `已确认：${data.candidates[0].gameName} · ${data.candidates[0].gameId}` }));
    } else {
      candidates.append(element('p', { className: 'muted', text: '存在重名，请选择一个游戏内 ID：' }));
    }
    if (data.candidates.length > 1) {
      for (const identity of data.candidates) {
        candidates.append(element('button', {
          type: 'button', text: `${identity.gameName} · ${identity.gameId}`,
          onclick: (clickEvent) => {
            document.querySelector('#join-game-id').value = identity.gameId;
            for (const button of candidates.querySelectorAll('button')) button.removeAttribute('aria-pressed');
            clickEvent.currentTarget.setAttribute('aria-pressed', 'true');
          }
        }));
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(event.currentTarget, false);
  }
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedMap) return;
  const submit = event.submitter;
  setBusy(submit, true, '正在发送……');
  try {
    const payload = {
      gameName: document.querySelector('#join-game-name').value.trim(),
      joinPassword: document.querySelector('#join-password').value
    };
    const gameId = document.querySelector('#join-game-id').value.trim();
    if (gameId) payload.gameId = gameId;
    if (selectedMap.reviewRequired) payload.evidence = evidenceInput.value.trim();
    const result = await api(`/maps/${encodeURIComponent(selectedMap.id)}/join-requests`, { method: 'POST', body: payload });
    const request = { id: result.id, receipt: result.receipt };
    saveRequest(selectedMap.id, request);
    document.querySelector('#join-password').value = '';
    showMessage('申请已发送。T 权限持有者和盟主任意一方同意即可加入。');
    pollRequest(selectedMap.id, request);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(submit, false);
  }
});

document.querySelector('#join-cancel').addEventListener('click', () => {
  stopPolling();
  joinSection.hidden = true;
  selectedMap = null;
});

window.addEventListener('pagehide', stopPolling);

async function initialize() {
  showFirstNotice();
  try {
    const session = await currentSession();
    renderSession(session.user);
  } catch (error) {
    showError(error);
  }
  await loadMaps();
}

initialize();
