export const RELATION_KEYS = Object.freeze(['self', 'team', 'organization', 'hostile', 'neutral', 'other']);

// 游戏内实际色值待用户对照确认；前端默认配色只在这里修改。
export const DEFAULT_COLORS = Object.freeze({
  self: '#ffffff',
  team: '#18cbd4',
  organization: '#3478d4',
  hostile: '#d4382c',
  neutral: '#e6bd32',
  other: '#e88924'
});

export const COLOR_STORAGE_KEY = 'lagrange.relationColors.v1';
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function normalizeColors(value = {}) {
  const colors = { ...DEFAULT_COLORS };
  for (const relation of RELATION_KEYS) {
    if (COLOR_PATTERN.test(value?.[relation] || '')) colors[relation] = value[relation].toLowerCase();
  }
  return colors;
}

export function loadColors(storage) {
  try {
    const saved = storage?.getItem(COLOR_STORAGE_KEY);
    return normalizeColors(saved ? JSON.parse(saved) : {});
  } catch {
    return { ...DEFAULT_COLORS };
  }
}

export function saveColors(colors, storage) {
  const normalized = normalizeColors(colors);
  try {
    storage?.setItem(COLOR_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // 浏览器禁用本地存储时仍保留当前页面内的即时配色。
  }
  return normalized;
}

export function resetColors(storage) {
  try {
    storage?.removeItem(COLOR_STORAGE_KEY);
  } catch {
    // 恢复默认不依赖本地存储可用。
  }
  return { ...DEFAULT_COLORS };
}

// 所有地图标记描边统一按内芯色加深；后续细调只改这里。
export function darkenColor(color, ratio = 0.7) {
  const normalized = COLOR_PATTERN.test(color || '') ? color.slice(1) : '141210';
  const channels = [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
  return `#${channels.map((channel) => Math.round(channel * ratio).toString(16).padStart(2, '0')).join('')}`;
}
