// 游戏内实际色值待用户对照确认；全站只从这里取查看者关系颜色。
export const VIEWER_COLORS = Object.freeze({
  self: '#ffffff',
  team: '#18cbd4',
  organization: '#3478d4',
  other: '#141210',
  unknown: '#141210'
});

export const VIEWER_COLOR_LEGEND = Object.freeze({
  self: VIEWER_COLORS.self,
  team: VIEWER_COLORS.team,
  organization: VIEWER_COLORS.organization
});

export function bodyOwnerGameId(features) {
  return features.ownerGameId || features.ownerId || features.playerGameId || null;
}

export function createViewerColorizer(db, map, member) {
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

  return (ownerGameId) => {
    let relation = 'other';
    if (!ownerGameId) relation = 'unknown';
    else if (viewerIdentity?.game_id === ownerGameId) relation = 'self';
    else if (viewerRoster && rosterByGameId.has(ownerGameId)) {
      const targetRoster = rosterByGameId.get(ownerGameId);
      relation = viewerRoster.team_id && viewerRoster.team_id === targetRoster.team_id ? 'team' : 'organization';
    }
    return { relation, color: VIEWER_COLORS[relation] };
  };
}
