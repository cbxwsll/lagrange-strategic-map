import { Router } from 'express';
import { z } from 'zod';
import { mapViewAuthenticated, viewerForMap } from '../lib/member-auth.js';
import { getMap, requireMapView } from '../lib/maps.js';
import { bodyOwnerGameId, createViewerColorizer, VIEWER_COLOR_LEGEND } from '../lib/viewer-colors.js';

const filterInput = z.object({
  search: z.string().trim().max(160).optional().default(''),
  featureKey: z.string().trim().max(120).optional().default(''),
  featureValue: z.string().trim().max(500).optional().default('')
});

function featuresForSnapshot(db, snapshotId) {
  const rows = db.prepare(`SELECT feature.key AS feature_key, feature.value AS feature_value
    FROM celestial_bodies AS body JOIN json_each(body.features_json) AS feature
    WHERE body.snapshot_id = ? AND feature.type IN ('text', 'integer', 'real', 'true', 'false')
    GROUP BY feature.key, feature.value ORDER BY feature.key, feature.value LIMIT 500`).all(snapshotId);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.feature_key)) grouped.set(row.feature_key, new Set());
    grouped.get(row.feature_key).add(String(row.feature_value));
  }
  return [...grouped].map(([key, values]) => ({ key, values: [...values] }));
}

export function createDisplayRouter() {
  const router = Router();

  router.get('/:mapId/display', mapViewAuthenticated, (req, res) => {
    const input = filterInput.parse(req.query);
    const database = req.app.locals.db;
    const map = getMap(database, req.params.mapId);
    const viewer = viewerForMap(req, map.id);
    const { member } = requireMapView(database, map, viewer.userId, viewer.gameIdentityId);
    const colorize = createViewerColorizer(database, map, member);
    const empty = { mapId: map.id, empty: true, snapshot: null, bodies: [], fleets: [], sharing: null, features: [], colorLegend: VIEWER_COLOR_LEGEND };
    if (!map.current_version_id) return res.json(empty);
    const snapshot = database.prepare(`SELECT * FROM map_snapshots
      WHERE map_id = ? AND version_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1`)
      .get(map.id, map.current_version_id);
    if (!snapshot) return res.json(empty);

    const conditions = ['snapshot_id = ?'];
    const parameters = [snapshot.id];
    if (input.search) {
      conditions.push('instr(lower(name), lower(?)) > 0');
      parameters.push(input.search);
    }
    if (input.featureKey) {
      let featureCondition = `EXISTS (
        SELECT 1 FROM json_each(celestial_bodies.features_json) AS filter_feature
        WHERE filter_feature.key = ?`;
      parameters.push(input.featureKey);
      if (input.featureValue) {
        featureCondition += ' AND CAST(filter_feature.value AS TEXT) = ?';
        parameters.push(input.featureValue);
      }
      featureCondition += ')';
      conditions.push(featureCondition);
    }
    const bodies = database.prepare(`SELECT body_key, name, body_type, x, y, z, features_json
      FROM celestial_bodies WHERE ${conditions.join(' AND ')} ORDER BY name, body_key LIMIT 20000`)
      .all(...parameters).map((row) => {
        const features = JSON.parse(row.features_json);
        const ownerGameId = bodyOwnerGameId(features);
        return {
          key: row.body_key, name: row.name, type: row.body_type,
          x: row.x, y: row.y, z: row.z, features, ownerGameId, ...colorize(ownerGameId)
        };
      });
    const fleets = database.prepare(`SELECT * FROM fleet_snapshots WHERE snapshot_id = ? ORDER BY fleet_key LIMIT 20000`)
      .all(snapshot.id).map((row) => ({
        key: row.fleet_key, ownerGameId: row.owner_game_id, state: row.display_state,
        x: row.x, y: row.y, z: row.z, vx: row.vx, vy: row.vy, vz: row.vz,
        payload: JSON.parse(row.payload_json), ...colorize(row.owner_game_id)
      }));
    const sharingRow = database.prepare('SELECT * FROM sharing_snapshots WHERE snapshot_id = ?').get(snapshot.id);
    const sharing = sharingRow ? {
      current: sharingRow.current_value, target: sharingRow.target_value,
      effect: sharingRow.effect, visitsEquivalent: sharingRow.visits_equivalent
    } : null;
    res.json({
      mapId: map.id,
      empty: false,
      snapshot: { id: snapshot.id, observedAt: snapshot.observed_at, gameTime: snapshot.game_time },
      bodies,
      fleets,
      sharing,
      features: featuresForSnapshot(database, snapshot.id),
      colorLegend: VIEWER_COLOR_LEGEND,
      filters: input
    });
  });

  return router;
}
