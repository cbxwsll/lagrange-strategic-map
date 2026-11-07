import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { fail } from '../lib/errors.js';
import { upsertGameIdentity } from '../lib/identities.js';
import { archiveVersion, createVersion, getVersion } from '../lib/maps.js';
import { replaceRoster } from '../lib/roster.js';
import { hashToken, now, uuid } from '../lib/security.js';

export const SUPPORTED_PROTOCOL = 'weiyang-3.0';
const isoTime = z.string().datetime({ offset: true });
const identityInput = z.object({ gameId: z.string().trim().min(1).max(80), gameName: z.string().trim().min(1).max(80) });
const rosterInput = identityInput.extend({ isLeader: z.boolean().default(false), teamId: z.string().trim().min(1).max(80).optional() });
const bodyInput = z.object({
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  type: z.string().trim().min(1).max(80),
  x: z.number(), y: z.number(), z: z.number().default(0),
  features: z.record(z.string(), z.unknown()).default({})
});
const fleetInput = z.object({
  key: z.string().trim().min(1).max(120),
  ownerGameId: z.string().trim().min(1).max(80).optional(),
  state: z.enum(['real', 'estimated', 'invalid']),
  x: z.number(), y: z.number(), z: z.number().default(0),
  vx: z.number().optional(), vy: z.number().optional(), vz: z.number().optional(),
  payload: z.record(z.string(), z.unknown()).default({})
});
const snapshotInput = z.object({
  observedAt: isoTime,
  gameTime: z.string().max(80).optional(),
  bodies: z.array(bodyInput).max(20_000).default([]),
  fleets: z.array(fleetInput).max(20_000).default([]),
  sharing: z.object({ current: z.number(), target: z.number(), effect: z.string().max(200), visitsEquivalent: z.number().optional() }).optional()
});
const reportInput = z.object({
  batchId: z.string().trim().min(1).max(120),
  protocolVersion: z.literal(SUPPORTED_PROTOCOL),
  dataAccount: identityInput,
  galaxy: z.object({ id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(160) }),
  organization: z.object({ id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(160) }),
  serverStatus: z.enum(['online', 'maintenance', 'expedition_ended']).default('online'),
  roster: z.array(rosterInput).max(5000).optional(),
  snapshots: z.array(snapshotInput).min(1).max(200)
});

function clientAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'CLIENT_TOKEN_REQUIRED', message: '需要客户端 Bearer token' } });
  }
  const token = authorization.slice(7);
  const row = req.app.locals.db.prepare(`SELECT client_tokens.*, maps.status AS map_status FROM client_tokens
    JOIN maps ON maps.id = client_tokens.map_id
    WHERE client_tokens.token_hash = ? AND client_tokens.revoked_at IS NULL`).get(hashToken(token));
  if (!row) return res.status(401).json({ error: { code: 'CLIENT_TOKEN_INVALID', message: '客户端令牌无效或已撤销' } });
  if (row.map_status === 'merged') return res.status(409).json({ error: { code: 'MAP_MERGED', message: '地图已合并，请改用目标地图令牌' } });
  req.clientToken = row;
  req.app.locals.db.prepare('UPDATE client_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  next();
}

export function createClientRouter() {
  const router = Router();

  router.post('/report', clientAuth, (req, res) => {
    const input = reportInput.parse(req.body);
    const database = req.app.locals.db;
    const map = database.prepare('SELECT * FROM maps WHERE id = ?').get(req.clientToken.map_id);
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    const duplicate = database.prepare('SELECT * FROM ingest_batches WHERE map_id = ? AND external_id = ?').get(map.id, input.batchId);
    if (duplicate) {
      if (duplicate.payload_hash !== payloadHash) fail(409, 'BATCH_ID_REUSED', '相同 batchId 对应了不同数据');
      return res.json({ accepted: true, duplicate: true, batchId: input.batchId });
    }

    let response;
    database.transaction(() => {
      const timestamp = now();
      const identity = upsertGameIdentity(database, input.dataAccount);
      if (map.data_account_game_id && map.data_account_game_id !== input.dataAccount.gameId) {
        fail(409, 'DATA_ACCOUNT_MISMATCH', '地图已绑定其他数据号');
      }

      let version = getVersion(database, map.current_version_id);
      if (!version) {
        version = createVersion(database, map.id, {
          galaxyId: input.galaxy.id, galaxyName: input.galaxy.name,
          organizationId: input.organization.id, organizationName: input.organization.name,
          protocolVersion: input.protocolVersion
        });
        database.prepare('UPDATE maps SET current_version_id = ? WHERE id = ?').run(version.id, map.id);
      } else if (version.galaxy_id !== input.galaxy.id) {
        const previous = version;
        version = database.prepare('SELECT * FROM map_versions WHERE map_id = ? AND galaxy_id = ? ORDER BY started_at DESC LIMIT 1')
          .get(map.id, input.galaxy.id) || createVersion(database, map.id, {
            galaxyId: input.galaxy.id, galaxyName: input.galaxy.name,
            organizationId: input.organization.id, organizationName: input.organization.name,
            protocolVersion: input.protocolVersion
          });
        archiveVersion(database, map, previous, 'expedition_ended');
        if (map.status !== 'draft') database.prepare("UPDATE maps SET status = 'historical', updated_at = ? WHERE id = ?").run(timestamp, map.id);
      }

      if (input.serverStatus === 'maintenance') {
        database.prepare("UPDATE map_versions SET status = 'maintenance' WHERE id = ?").run(version.id);
        if (map.status !== 'draft') database.prepare("UPDATE maps SET status = 'maintenance', updated_at = ? WHERE id = ?").run(timestamp, map.id);
      } else if (input.serverStatus === 'online' && map.status === 'maintenance') {
        database.prepare("UPDATE map_versions SET status = 'active' WHERE id = ?").run(version.id);
        database.prepare("UPDATE maps SET status = 'active', updated_at = ? WHERE id = ?").run(timestamp, map.id);
      } else if (input.serverStatus === 'expedition_ended' && map.current_version_id === version.id) {
        archiveVersion(database, map, version, 'expedition_ended');
        if (map.status !== 'draft') database.prepare("UPDATE maps SET status = 'historical', updated_at = ? WHERE id = ?").run(timestamp, map.id);
      }

      const batchId = uuid();
      database.prepare(`INSERT INTO ingest_batches (id, map_id, token_id, external_id, payload_hash, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(batchId, map.id, req.clientToken.id, input.batchId, payloadHash, timestamp);
      database.prepare(`INSERT INTO client_contexts
        (map_id, token_id, game_identity_id, version_id, galaxy_id, galaxy_name, organization_id, organization_name,
         protocol_version, server_status, last_seen_at, first_data_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(map_id) DO UPDATE SET token_id = excluded.token_id, game_identity_id = excluded.game_identity_id,
          version_id = excluded.version_id, galaxy_id = excluded.galaxy_id, galaxy_name = excluded.galaxy_name,
          organization_id = excluded.organization_id, organization_name = excluded.organization_name,
          protocol_version = excluded.protocol_version, server_status = excluded.server_status, last_seen_at = excluded.last_seen_at`)
        .run(map.id, req.clientToken.id, identity.id, version.id, input.galaxy.id, input.galaxy.name,
          input.organization.id, input.organization.name, input.protocolVersion, input.serverStatus, timestamp, timestamp);
      database.prepare('UPDATE maps SET data_account_game_id = ?, updated_at = ? WHERE id = ?').run(input.dataAccount.gameId, timestamp, map.id);

      if (input.roster) {
        replaceRoster(database, { ...map, data_account_game_id: input.dataAccount.gameId }, version, input.roster);
      }

      for (const snapshot of input.snapshots) {
        const snapshotId = uuid();
        database.prepare(`INSERT INTO map_snapshots
          (id, map_id, version_id, batch_id, observed_at, game_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(snapshotId, map.id, version.id, batchId, snapshot.observedAt, snapshot.gameTime || null, timestamp);
        for (const body of snapshot.bodies) {
          database.prepare(`INSERT INTO celestial_bodies
            (snapshot_id, body_key, name, body_type, x, y, z, features_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(snapshotId, body.key, body.name, body.type, body.x, body.y, body.z, JSON.stringify(body.features));
        }
        for (const fleet of snapshot.fleets) {
          database.prepare(`INSERT INTO fleet_snapshots
            (snapshot_id, fleet_key, owner_game_id, display_state, x, y, z, vx, vy, vz, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(snapshotId, fleet.key, fleet.ownerGameId || null, fleet.state, fleet.x, fleet.y, fleet.z,
              fleet.vx ?? null, fleet.vy ?? null, fleet.vz ?? null, JSON.stringify(fleet.payload));
        }
        if (snapshot.sharing) {
          database.prepare(`INSERT INTO sharing_snapshots
            (snapshot_id, current_value, target_value, effect, visits_equivalent) VALUES (?, ?, ?, ?, ?)`)
            .run(snapshotId, snapshot.sharing.current, snapshot.sharing.target, snapshot.sharing.effect,
              snapshot.sharing.visitsEquivalent ?? null);
        }
      }
      audit(database, map.id, null, 'client.batch_accepted', batchId, { externalId: input.batchId, snapshots: input.snapshots.length });
      const latest = database.prepare('SELECT status FROM maps WHERE id = ?').get(map.id);
      response = { accepted: true, duplicate: false, batchId: input.batchId, versionId: version.id,
        snapshots: input.snapshots.length, mapStatus: latest.status, receivedAt: timestamp };
    })();
    res.status(202).json(response);
  });

  return router;
}
