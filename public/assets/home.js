import {
  MAP_STATUS, api, currentSession, element, renderSession, showError,
  showFirstNotice, showMessage, setBusy
} from './common.js';

let user = null;
let selectedMap = null;

const list = document.querySelector('#map-list');
const listStatus = document.querySelector('#list-status');
const joinSection = document.querySelector('#join-section');
const joinForm = document.querySelector('#join-form');
const evidenceWrap = document.querySelector('#evidence-wrap');
const evidenceInput = document.querySelector('#join-evidence');
const candidates = document.querySelector('#identity-candidates');

function openJoin(map) {
  selectedMap = map;
  joinSection.hidden = false;
  document.querySelector('#join-title').textContent = `加入${map.displayName}`;
  evidenceWrap.hidden = !map.reviewRequired;
  evidenceInput.required = map.reviewRequired;
  joinForm.reset();
  candidates.replaceChildren();
  document.querySelector('#join-password').value = '';
  joinSection.scrollIntoView({ block: 'start' });
  document.querySelector('#join-game-name').focus();
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
    const join = element('button', {
      type: 'button', text: '加入', 'aria-disabled': user ? 'false' : 'true',
      className: user ? '' : 'disabled-button',
      onclick: () => {
        if (!user) {
          showMessage('请先注册或登录后再加入地图。', 'error');
          return;
        }
        openJoin(map);
      }
    });
    actions.append(join);
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

document.querySelector('#find-identities').addEventListener('click', async (event) => {
  if (!selectedMap) return;
  const gameName = document.querySelector('#join-game-name').value.trim();
  if (!gameName) {
    showMessage('请先输入游戏名。', 'error');
    return;
  }
  setBusy(event.currentTarget, true, '正在查询……');
  candidates.replaceChildren();
  try {
    const data = await api(`/maps/${encodeURIComponent(selectedMap.id)}/game-identities?gameName=${encodeURIComponent(gameName)}`);
    if (!data.candidates.length) {
      candidates.append(element('p', { className: 'muted', text: '没有已上报的同名候选，请手动填写游戏内 ID。' }));
    }
    for (const identity of data.candidates) {
      candidates.append(element('button', {
        type: 'button', text: `${identity.gameName} · ${identity.gameId}`,
        onclick: () => { document.querySelector('#join-game-id').value = identity.gameId; }
      }));
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
      gameId: document.querySelector('#join-game-id').value.trim(),
      joinPassword: document.querySelector('#join-password').value
    };
    if (selectedMap.reviewRequired) payload.evidence = evidenceInput.value.trim();
    const result = await api(`/maps/${encodeURIComponent(selectedMap.id)}/join-requests`, { method: 'POST', body: payload });
    showMessage(`申请已发送，状态：${result.status}。T 权限持有者和盟主任意一方同意即可加入。`);
    joinForm.reset();
    document.querySelector('#join-password').value = '';
  } catch (error) {
    showError(error);
  } finally {
    setBusy(submit, false);
  }
});

document.querySelector('#join-cancel').addEventListener('click', () => {
  joinSection.hidden = true;
  selectedMap = null;
});

async function initialize() {
  showFirstNotice();
  try {
    const session = await currentSession();
    user = session.user;
    renderSession(user);
  } catch (error) {
    showError(error);
  }
  await loadMaps();
}

initialize();
