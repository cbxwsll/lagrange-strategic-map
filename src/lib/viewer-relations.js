export function bodyOwnerGameId(features) {
  return features.ownerGameId || features.ownerId || features.playerGameId || null;
}

function normalizedMarker(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

function relationMarkers(entityKind, features) {
  const markers = [normalizedMarker(entityKind)];
  for (const value of Object.values(features || {})) {
    const marker = normalizedMarker(value);
    if (marker) markers.push(marker);
  }
  return markers;
}

// 所有实体关系只在这里判定；抓包字段明确后仅需调整本函数的标记读取。
export function classifyRelation(entityType, attribution = {}) {
  const {
    ownerGameId = null,
    entityKind = '',
    features = {},
    viewerGameId = null,
    viewerTeamId = null,
    targetTeamId = null,
    sameOrganization = false
  } = attribution;
  const markers = relationMarkers(entityKind, features);
  if (markers.some((marker) => /pirate|hostile|enemy|海盗|敌对/.test(marker))) return 'hostile';
  if (markers.some((marker) => /^(neutral|中立|中立阵营)$/.test(marker))) return 'neutral';
  if (!ownerGameId) return entityType === 'body' ? 'neutral' : 'other';
  if (viewerGameId === ownerGameId) return 'self';
  if (sameOrganization) {
    return viewerTeamId && viewerTeamId === targetTeamId ? 'team' : 'organization';
  }
  return 'other';
}

export function createViewerRelationClassifier(db, map, member) {
  const viewerIdentity = member?.game_identity_id
    ? db.prepare('SELECT id, game_id FROM game_identities WHERE id = ? AND is_observer = 0').get(member.game_identity_id)
    : null;
  const roster = map.current_version_id
    ? db.prepare(`SELECT map_roster.game_identity_id, map_roster.team_id, game_identities.game_id
      FROM map_roster JOIN game_identities ON game_identities.id = map_roster.game_identity_id
      WHERE map_roster.version_id = ? AND game_identities.is_observer = 0`).all(map.current_version_id)
    : [];
  const rosterByGameId = new Map(roster.map((entry) => [entry.game_id, entry]));
  const viewerRoster = viewerIdentity ? rosterByGameId.get(viewerIdentity.game_id) : null;

  return (entityType, attribution = {}) => {
    const targetRoster = attribution.ownerGameId ? rosterByGameId.get(attribution.ownerGameId) : null;
    return classifyRelation(entityType, {
      ...attribution,
      viewerGameId: viewerIdentity?.game_id || null,
      viewerTeamId: viewerRoster?.team_id || null,
      targetTeamId: targetRoster?.team_id || null,
      sameOrganization: Boolean(viewerRoster && targetRoster)
    });
  };
}
