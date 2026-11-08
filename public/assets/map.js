import {
  MAP_STATUS, api, connectMapSocket, currentUser, element, formatTime,
  renderSession, requiredMapId, showError, showMessage
} from './common.js';

const state = { user: null, mapId: null, map: null, display: null, focusBodyKey: null, socket: null, creatorTimer: null };
const canvas = document.querySelector('#map-canvas');
const featureKey = document.querySelector('#feature-key');
const featureValue = document.querySelector('#feature-value');
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });

function updateFeatureValues() {
  const selected = featureKey.value;
  const previous = featureValue.value;
  featureValue.replaceChildren(new Option('全部特征值', ''));
  const feature = state.display?.features.find((item) => item.key === selected);
  for (const value of feature?.values || []) featureValue.append(new Option(String(value), String(value)));
  featureValue.disabled = !selected;
  if ([...featureValue.options].some((option) => option.value === previous)) featureValue.value = previous;
}

function updateFeatureOptions() {
  const previous = featureKey.value;
  featureKey.replaceChildren(new Option('全部特征', ''));
  for (const feature of state.display?.features || []) featureKey.append(new Option(feature.key, feature.key));
  if ([...featureKey.options].some((option) => option.value === previous)) featureKey.value = previous;
  updateFeatureValues();
}

function renderSharing(sharing) {
  const target = document.querySelector('#sharing-text');
  if (!sharing) {
    target.textContent = '暂无共享度数据';
    return;
  }
  if (sharing.current >= sharing.target) {
    target.textContent = `共享度已达到目标（${sharing.effect}）`;
    return;
  }
  const remaining = numberFormat.format(sharing.target - sharing.current);
  const prefix = `距离（${sharing.effect}）还差（${remaining}）共享度`;
  target.textContent = sharing.visitsEquivalent === null || sharing.visitsEquivalent === undefined
    ? `${prefix}，拜访盟友换算数量待客户端上报。`
    : `${prefix}，大约等于拜访（${numberFormat.format(sharing.visitsEquivalent)}）个盟友`;
}

function renderBodies() {
  const results = document.querySelector('#body-results');
  results.replaceChildren();
  const bodies = state.display?.bodies || [];
  if (!bodies.length) {
    results.append(element('p', { className: 'muted', text: '暂无结果' }));
    return;
  }
  for (const body of bodies) {
    const features = Object.entries(body.features || {}).map(([key, value]) => `${key}=${value}`).join('，');
    results.append(element('button', {
      type: 'button',
      text: `${body.name} · ${body.type}${features ? `\n${features}` : ''}`,
      onclick: () => {
        state.focusBodyKey = body.key;
        drawMap();
      }
    }));
  }
}

function drawMap() {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(280, canvas.clientWidth);
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const paper = styles.getPropertyValue('--paper2').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  context.fillStyle = paper;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(20, 18, 16, .12)';
  context.lineWidth = 1;
  for (let index = 1; index < 10; index += 1) {
    const x = width * index / 10;
    const y = height * index / 10;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }

  const bodies = state.display?.bodies || [];
  const fleets = state.display?.fleets || [];
  document.querySelector('#map-empty').hidden = Boolean(bodies.length || fleets.length);
  if (!bodies.length && !fleets.length) return;
  const points = [...bodies, ...fleets];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  let minX = Math.min(...xs); let maxX = Math.max(...xs);
  let minY = Math.min(...ys); let maxY = Math.max(...ys);
  if (minX === maxX) { minX -= 1; maxX += 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const padding = 54;
  const scale = Math.min((width - padding * 2) / (maxX - minX), (height - padding * 2) / (maxY - minY));
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;
  const project = (point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: height - offsetY - (point.y - minY) * scale
  });

  context.font = '12px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  for (const body of bodies) {
    const point = project(body);
    context.globalAlpha = 1;
    context.fillStyle = paper;
    context.strokeStyle = ink;
    context.lineWidth = state.focusBodyKey === body.key ? 4 : 1.5;
    context.fillRect(point.x - 6, point.y - 6, 12, 12);
    context.strokeRect(point.x - 6, point.y - 6, 12, 12);
    context.fillStyle = ink;
    context.fillText(body.name, point.x + 10, point.y + 4);
  }
  for (const fleet of fleets) {
    const point = project(fleet);
    context.strokeStyle = ink;
    context.fillStyle = ink;
    context.lineWidth = 2;
    if (fleet.state === 'real') {
      context.globalAlpha = 1;
      context.beginPath(); context.arc(point.x, point.y, 7, 0, Math.PI * 2); context.fill();
    } else if (fleet.state === 'estimated') {
      context.globalAlpha = 0.4;
      context.beginPath(); context.arc(point.x, point.y, 7, 0, Math.PI * 2); context.fill();
      context.globalAlpha = 0.7;
      context.fillText('推算中', point.x + 10, point.y + 4);
    } else {
      context.globalAlpha = 1;
      context.beginPath();
      context.moveTo(point.x - 7, point.y - 7); context.lineTo(point.x + 7, point.y + 7);
      context.moveTo(point.x + 7, point.y - 7); context.lineTo(point.x - 7, point.y + 7);
      context.stroke();
      context.fillText('判错', point.x + 10, point.y + 4);
    }
  }
  context.globalAlpha = 1;
}

async function loadDisplay() {
  if (!state.mapId) return;
  const parameters = new URLSearchParams();
  const search = document.querySelector('#body-search').value.trim();
  if (search) parameters.set('search', search);
  if (featureKey.value) parameters.set('featureKey', featureKey.value);
  if (featureKey.value && featureValue.value) parameters.set('featureValue', featureValue.value);
  const suffix = parameters.size ? `?${parameters}` : '';
  try {
    state.display = await api(`/maps/${encodeURIComponent(state.mapId)}/display${suffix}`);
    updateFeatureOptions();
    renderSharing(state.display.sharing);
    renderBodies();
    document.querySelector('#observed-at').textContent = state.display.snapshot
      ? `观测时间：${formatTime(state.display.snapshot.observedAt)} · 建筑 ${state.display.bodies.length} · 舰队 ${state.display.fleets.length}`
      : '尚无快照';
    drawMap();
  } catch (error) {
    showError(error);
  }
}

async function loadCreatorStatus() {
  window.clearTimeout(state.creatorTimer);
  if (!state.map?.isCreator) return;
  try {
    const data = await api(`/maps/${encodeURIComponent(state.mapId)}/wizard`);
    document.querySelector('#creator-client-status').textContent = `客户端状态：${data.client.online ? '在线' : '不在线'} · 首批数据：${data.firstDataReceived ? '已到达' : '未到达'}`;
    document.querySelector('#creator-last-seen').textContent = `最近同步：${formatTime(data.client.lastSeenAt)}`;
  } catch (error) {
    document.querySelector('#creator-client-status').textContent = `客户端状态读取失败：${error.message}`;
  } finally {
    if (state.map?.isCreator) state.creatorTimer = window.setTimeout(loadCreatorStatus, 10_000);
  }
}

async function loadMergeTargets() {
  const select = document.querySelector('#merge-target');
  select.replaceChildren();
  const data = await api('/maps');
  const targets = data.maps.filter((map) => map.id !== state.mapId && map.status === 'active');
  if (!targets.length) select.append(new Option('暂无可合并的活跃地图', ''));
  for (const map of targets) select.append(new Option(`${map.displayName} · ${map.id}`, map.id));
  document.querySelector('#merge-form button[type="submit"]').disabled = !targets.length;
}

async function loadMergeRequests() {
  const list = document.querySelector('#merge-requests');
  list.replaceChildren();
  try {
    const data = await api(`/maps/${encodeURIComponent(state.mapId)}/merge-requests`);
    if (!data.requests.length) list.append(element('li', { className: 'muted', text: '暂无合并申请' }));
    for (const request of data.requests) {
      const item = element('li', {}, [
        element('p', { text: `${request.direction === 'incoming' ? '收到' : '发出'} · ${request.status}` }),
        element('p', { className: 'small code-value', text: `源：${request.sourceMapId}\n目标：${request.targetMapId}` })
      ]);
      if (request.direction === 'incoming' && request.status === 'pending') {
        const actions = element('div', { className: 'toolbar' });
        for (const decision of ['approve', 'reject']) {
          actions.append(element('button', {
            type: 'button', text: decision === 'approve' ? '同意合并' : '拒绝',
            onclick: async () => {
              if (decision === 'approve' && !window.confirm('确定同意合并？源地图将归档且客户端令牌会撤销。')) return;
              try {
                await api(`/maps/${encodeURIComponent(state.mapId)}/merge-requests/${request.id}/review`, {
                  method: 'POST', body: { decision }
                });
                showMessage(decision === 'approve' ? '已同意合并。' : '已拒绝合并。');
                await loadMergeRequests();
              } catch (error) { showError(error); }
            }
          }));
        }
        item.append(actions);
      }
      list.append(item);
    }
  } catch (error) { showError(error); }
}

async function loadArchives() {
  const list = document.querySelector('#archive-list');
  list.replaceChildren(element('li', { className: 'muted', text: '正在读取……' }));
  try {
    const data = await api(`/maps/${encodeURIComponent(state.mapId)}/archives`);
    list.replaceChildren();
    if (!data.archives.length) list.append(element('li', { className: 'muted', text: '暂无历史档案' }));
    for (const archive of data.archives) {
      const item = element('li', {}, [
        element('p', { text: `${archive.galaxyName} · ${archive.organizationName}` }),
        element('p', { className: 'muted small', text: `${archive.reason} · ${formatTime(archive.createdAt)} · 快照 ${archive.summary.snapshots ?? 0}` })
      ]);
      if (state.user && (state.map.isCreator || state.map.isTHolder || state.map.isLeader)) {
        item.append(element('button', {
          type: 'button', text: '删除档案',
          onclick: async () => {
            if (!window.confirm(`确定删除“${archive.galaxyName}”档案及其历史快照？`)) return;
            try {
              await api(`/maps/${encodeURIComponent(state.mapId)}/archives/${archive.id}`, { method: 'DELETE' });
              showMessage('档案已删除。');
              await loadArchives();
            } catch (error) { showError(error); }
          }
        }));
      }
      list.append(item);
    }
  } catch (error) {
    list.replaceChildren(element('li', { className: 'muted', text: error.message }));
  }
}

async function loadMap() {
  const data = await api(`/maps/${encodeURIComponent(state.mapId)}`);
  state.map = data.map;
  document.querySelector('#map-title').textContent = state.map.displayName;
  document.title = `${state.map.name} · 拉格朗日战略地图`;
  document.querySelector('#map-subtitle').textContent = `${MAP_STATUS[state.map.status] || state.map.status} · ${state.map.galaxy?.name || '星系待上报'} · 地图 ID：${state.map.id}`;
  document.querySelector('#creator-panel').hidden = !state.map.isCreator;
  document.querySelector('#resume-access').hidden = state.map.status !== 'suspended';
  if (state.map.isCreator) {
    await loadMergeTargets();
    await loadMergeRequests();
    loadCreatorStatus();
  }
}

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadDisplay();
});
featureKey.addEventListener('change', updateFeatureValues);
document.querySelector('#search-reset').addEventListener('click', () => {
  document.querySelector('#body-search').value = '';
  featureKey.value = '';
  updateFeatureValues();
  loadDisplay();
});
document.querySelector('#refresh-display').addEventListener('click', () => {
  loadDisplay();
  if (state.map?.isCreator) loadCreatorStatus();
});
window.addEventListener('resize', drawMap);

document.querySelector('#archives-toggle').addEventListener('click', () => {
  const section = document.querySelector('#archives-section');
  section.hidden = !section.hidden;
  if (!section.hidden) loadArchives();
});
document.querySelector('#merge-toggle').addEventListener('click', () => {
  const section = document.querySelector('#merge-section');
  section.hidden = !section.hidden;
  if (!section.hidden) { loadMergeTargets(); loadMergeRequests(); }
});
document.querySelector('#restore-toggle').addEventListener('click', () => {
  const section = document.querySelector('#restore-section');
  section.hidden = !section.hidden;
});

document.querySelector('#merge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const targetMapId = document.querySelector('#merge-target').value;
  if (!targetMapId) return;
  try {
    await api(`/maps/${encodeURIComponent(state.mapId)}/merge-requests`, { method: 'POST', body: { targetMapId } });
    showMessage('合并申请已发送，等待目标地图创建者批准。');
    await loadMergeRequests();
  } catch (error) { showError(error); }
});

for (const button of document.querySelectorAll('[data-restore-mode]')) {
  button.addEventListener('click', async () => {
    const mode = button.dataset.restoreMode;
    const wording = mode === 'same_organization' ? '仍是同一联合体' : '不是同一联合体';
    if (!window.confirm(`确认按“${wording}”恢复地图？旧版本将归档，并按 roster 校验成员。`)) return;
    try {
      await api(`/maps/${encodeURIComponent(state.mapId)}/restore`, { method: 'POST', body: { mode } });
      showMessage('地图已恢复。');
      await loadMap();
      await loadDisplay();
    } catch (error) { showError(error); }
  });
}

document.querySelector('#resume-access').addEventListener('click', async () => {
  try {
    await api(`/maps/${encodeURIComponent(state.mapId)}/resume-access`, { method: 'POST', body: {} });
    showMessage('地图访问已恢复。');
    await loadMap();
  } catch (error) { showError(error); }
});

window.addEventListener('pagehide', () => {
  state.socket?.close();
  window.clearTimeout(state.creatorTimer);
});

async function initialize() {
  try {
    state.user = await currentUser();
    renderSession(state.user);
    state.mapId = requiredMapId();
    await loadMap();
    await loadDisplay();
    state.socket = connectMapSocket(
      state.mapId,
      (text) => { document.querySelector('#ws-status').textContent = text; },
      (message) => {
        if (['snapshot', 'map.snapshot', 'map.updated', 'display.refresh'].includes(message.type)) loadDisplay();
      }
    );
  } catch (error) {
    showError(error);
    document.querySelector('#ws-status').textContent = 'WebSocket：未连接';
  }
}

initialize();
