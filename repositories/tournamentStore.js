const AWS = require('aws-sdk');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-north-1';
const LEGACY_TABLE = process.env.TOURNAMENTS_TABLE || process.env.SCHEDULEIT_TOURNAMENTS_TABLE || 'ScheduleItTournaments';
const META_TABLE = process.env.TOURNAMENT_META_TABLE || 'ScheduleItTournamentMeta';
const MATCH_TABLE = process.env.TOURNAMENT_MATCHES_TABLE || 'ScheduleItTournamentMatchesV2';
const USE_SPLIT_TABLES = String(process.env.USE_SPLIT_TOURNAMENT_TABLES || 'true').toLowerCase() !== 'false';

AWS.config.update({ region: REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqStrings(values) {
  return [...new Set(asArray(values).map((x) => String(x || '').trim()).filter(Boolean))];
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toFiniteNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCategories(cats) {
  if (!cats) return [];
  if (Array.isArray(cats)) return cats;
  if (typeof cats === 'string') {
    try {
      const parsed = JSON.parse(cats);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeCategoryItem(category, index = 0) {
  const teamSize = toFiniteNumber(category?.teamSize, 1) || 1;
  const exactTeamSize = toFiniteNumber(category?.exactTeamSize, null);
  return {
    categoryId: String(category?.categoryId || category?.id || `CAT-${index + 1}`),
    eventName: String(category?.eventName || category?.name || `Category ${index + 1}`),
    gender: String(category?.gender || ''),
    ageGroup: String(category?.ageGroup || ''),
    playingLevel: String(category?.playingLevel || ''),
    teamSize,
    exactTeamSize,
  };
}

function splitTeamName(value) {
  const text = String(value || '').trim();
  const up = text.toUpperCase();
  if (!text || up === 'BYE' || up === 'TBD') return [];
  return text.split(' + ').map((x) => x.trim()).filter(Boolean);
}

function ensureMatchMeta(match, fallback = {}) {
  const next = cloneJson(match || {}) || {};
  if (!next.matchId) next.matchId = fallback.matchId || '';
  if (!Array.isArray(next.homePlayers)) next.homePlayers = splitTeamName(next.home);
  if (!Array.isArray(next.awayPlayers)) next.awayPlayers = splitTeamName(next.away);
  if (!next.status) next.status = 'pending';
  return next;
}

function normalizeFixtures(fixtures) {
  const safe = fixtures && typeof fixtures === 'object' ? cloneJson(fixtures) : { categories: {} };
  safe.categories = safe.categories && typeof safe.categories === 'object' ? safe.categories : {};
  Object.values(safe.categories).forEach((cat) => {
    if (!cat || typeof cat !== 'object') return;
    if (Array.isArray(cat.matches)) cat.matches = cat.matches.map((m) => ensureMatchMeta(m));
    if (Array.isArray(cat.rounds)) {
      cat.rounds = cat.rounds.map((round) => asArray(round).map((m) => ensureMatchMeta(m)));
    } else {
      cat.rounds = [];
    }
  });
  return safe;
}

function buildMatchKey(categoryId, roundIndex, matchIndex) {
  return `CAT#${categoryId}#ROUND#${Number(roundIndex)}#MATCH#${Number(matchIndex)}`;
}

function parseMatchKey(matchKey = '') {
  const m = String(matchKey).match(/^CAT#(.+)#ROUND#(\d+)#MATCH#(\d+)$/);
  if (!m) return null;
  return {
    categoryId: m[1],
    roundIndex: Number(m[2]),
    matchIndex: Number(m[3]),
  };
}

function deriveFixtureConfigByCategory(fixtures) {
  const out = {};
  const safe = normalizeFixtures(fixtures || { categories: {} });
  Object.entries(safe.categories || {}).forEach(([categoryId, bucket]) => {
    out[categoryId] = {
      label: String(bucket?.label || ''),
      displayMode: String(bucket?.displayMode || ''),
      totalRounds: Number(bucket?.totalRounds || asArray(bucket?.rounds).length || 0),
      teams: cloneJson(bucket?.teams || []),
    };
  });
  return out;
}

function extractMatchRowsFromFixtures(tournamentId, fixtures, options = {}) {
  const safe = normalizeFixtures(fixtures || { categories: {} });
  const rows = [];
  const createdAt = options.createdAt || nowIso();
  const updatedAt = options.updatedAt || nowIso();

  Object.entries(safe.categories || {}).forEach(([categoryId, bucket]) => {
    const rounds = asArray(bucket?.rounds);
    if (rounds.length) {
      rounds.forEach((round, roundIndex) => {
        asArray(round).forEach((match, matchIndex) => {
          const next = ensureMatchMeta(match, {
            matchId: `M-${tournamentId}-${categoryId}-${roundIndex}-${matchIndex}`,
          });

          rows.push({
            tournamentId,
            matchKey: buildMatchKey(categoryId, roundIndex, matchIndex),
            matchId: String(next.matchId || ''),
            categoryId,
            roundIndex,
            matchIndex,
            roundLabel: String(next.roundLabel || ''),
            stage: String(next.stage || ''),
            date: String(next.date || ''),
            time: String(next.time || ''),
            court: String(next.court || ''),
            home: String(next.home || ''),
            away: String(next.away || ''),
            homePlayers: asArray(next.homePlayers),
            awayPlayers: asArray(next.awayPlayers),
            status: String(next.status || 'pending'),
            winner: next.winner || null,
            winnerSide: next.winnerSide || null,
            matchPointsHome: toFiniteNumber(next.matchPointsHome, 0) || 0,
            matchPointsAway: toFiniteNumber(next.matchPointsAway, 0) || 0,
            score: cloneJson(next.score || null),
            submatches: cloneJson(asArray(next.submatches)),
            lineupApproval: cloneJson(next.lineupApproval || null),
            lineupLocked: Boolean(next.lineupLocked),
            createdAt: next.createdAt || createdAt,
            updatedAt,
          });
        });
      });
      return;
    }

    asArray(bucket?.matches).forEach((match, matchIndex) => {
      const next = ensureMatchMeta(match, {
        matchId: `M-${tournamentId}-${categoryId}-0-${matchIndex}`,
      });

      rows.push({
        tournamentId,
        matchKey: buildMatchKey(categoryId, 0, matchIndex),
        matchId: String(next.matchId || ''),
        categoryId,
        roundIndex: 0,
        matchIndex,
        roundLabel: String(next.roundLabel || ''),
        stage: String(next.stage || ''),
        date: String(next.date || ''),
        time: String(next.time || ''),
        court: String(next.court || ''),
        home: String(next.home || ''),
        away: String(next.away || ''),
        homePlayers: asArray(next.homePlayers),
        awayPlayers: asArray(next.awayPlayers),
        status: String(next.status || 'pending'),
        winner: next.winner || null,
        winnerSide: next.winnerSide || null,
        matchPointsHome: toFiniteNumber(next.matchPointsHome, 0) || 0,
        matchPointsAway: toFiniteNumber(next.matchPointsAway, 0) || 0,
        score: cloneJson(next.score || null),
        submatches: cloneJson(asArray(next.submatches)),
        lineupApproval: cloneJson(next.lineupApproval || null),
        lineupLocked: Boolean(next.lineupLocked),
        createdAt: next.createdAt || createdAt,
        updatedAt,
      });
    });
  });

  return rows;
}

function buildFixturesFromMatchRows(meta, matchRows) {
  const fixtureConfigByCategory = cloneJson(meta?.fixtureConfigByCategory || {});
  const fixtures = {
    tournamentType: normalizeText(meta?.tournamentType) === 'team' ? 'team' : 'individual',
    categories: {},
  };

  if (normalizeText(meta?.tournamentType) === 'team') {
    fixtures.teamCategories = normalizeCategories(meta?.categories).map(normalizeCategoryItem);
  }

  Object.entries(fixtureConfigByCategory).forEach(([categoryId, config]) => {
    fixtures.categories[categoryId] = {
      categoryId,
      label: String(config?.label || ''),
      displayMode: String(config?.displayMode || ''),
      totalRounds: Number(config?.totalRounds || 0),
      rounds: [],
      matches: [],
      teams: cloneJson(config?.teams || []),
    };
  });

  const sorted = asArray(matchRows)
    .map((row) => ({ ...cloneJson(row), _parsed: parseMatchKey(row?.matchKey) }))
    .sort((a, b) => {
      const aP = a._parsed || { categoryId: a.categoryId || '', roundIndex: a.roundIndex || 0, matchIndex: a.matchIndex || 0 };
      const bP = b._parsed || { categoryId: b.categoryId || '', roundIndex: b.roundIndex || 0, matchIndex: b.matchIndex || 0 };
      if (String(aP.categoryId) !== String(bP.categoryId)) return String(aP.categoryId).localeCompare(String(bP.categoryId));
      if (Number(aP.roundIndex) !== Number(bP.roundIndex)) return Number(aP.roundIndex) - Number(bP.roundIndex);
      return Number(aP.matchIndex) - Number(bP.matchIndex);
    });

  sorted.forEach((row) => {
    const parsed = row._parsed || {
      categoryId: row.categoryId,
      roundIndex: Number(row.roundIndex || 0),
      matchIndex: Number(row.matchIndex || 0),
    };

    const categoryId = String(parsed.categoryId || row.categoryId || '');
    if (!fixtures.categories[categoryId]) {
      fixtures.categories[categoryId] = {
        categoryId,
        label: '',
        displayMode: '',
        totalRounds: 0,
        rounds: [],
        matches: [],
        teams: [],
      };
    }

    const bucket = fixtures.categories[categoryId];
    const roundIndex = Number(parsed.roundIndex || 0);
    const matchIndex = Number(parsed.matchIndex || 0);

    const match = {
      matchId: row.matchId || undefined,
      roundLabel: row.roundLabel || '',
      stage: row.stage || '',
      date: row.date || '',
      time: row.time || '',
      court: row.court || '',
      home: row.home || '',
      away: row.away || '',
      homePlayers: asArray(row.homePlayers),
      awayPlayers: asArray(row.awayPlayers),
      status: row.status || 'pending',
      winner: row.winner || null,
      winnerSide: row.winnerSide || null,
      matchPointsHome: toFiniteNumber(row.matchPointsHome, 0) || 0,
      matchPointsAway: toFiniteNumber(row.matchPointsAway, 0) || 0,
      score: cloneJson(row.score || null),
      submatches: cloneJson(asArray(row.submatches)),
      lineupApproval: cloneJson(row.lineupApproval || null),
      lineupLocked: Boolean(row.lineupLocked),
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
    };

    if (!Array.isArray(bucket.rounds[roundIndex])) bucket.rounds[roundIndex] = [];
    bucket.rounds[roundIndex][matchIndex] = match;
    bucket.matches.push(match);
    bucket.totalRounds = Math.max(Number(bucket.totalRounds || 0), roundIndex + 1);
  });

  Object.values(fixtures.categories).forEach((bucket) => {
    bucket.rounds = asArray(bucket.rounds).map((round) => asArray(round).filter(Boolean));
    if (!bucket.totalRounds) bucket.totalRounds = bucket.rounds.length;
  });

  return normalizeFixtures(fixtures);
}

function stripFixturesForMeta(tournament) {
  const cloned = cloneJson(tournament || {}) || {};
  delete cloned.fixtures;
  delete cloned.fixtureRows;
  return cloned;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchWriteWithRetry(requestItems) {
  let unprocessed = requestItems;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await ddb.batchWrite({ RequestItems: unprocessed }).promise();
    const left = result.UnprocessedItems || {};
    const hasLeft = Object.values(left).some((items) => asArray(items).length > 0);
    if (!hasLeft) return;
    unprocessed = left;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * (attempt + 1))));
  }
  throw new Error('batchWrite still has unprocessed items after retries');
}

async function queryAll(tableName, keyConditionExpression, expressionAttributeValues) {
  let items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.query({
      TableName: tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey,
    }).promise();
    items = items.concat(result.Items || []);
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function scanAll(tableName) {
  let items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.scan({ TableName: tableName, ExclusiveStartKey }).promise();
    items = items.concat(result.Items || []);
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getLegacyTournament(tournamentId) {
  const result = await ddb.get({ TableName: LEGACY_TABLE, Key: { tournamentId } }).promise();
  return result.Item || null;
}

async function getTournamentMeta(tournamentId) {
  const result = await ddb.get({ TableName: META_TABLE, Key: { tournamentId } }).promise();
  return result.Item || null;
}

async function saveTournamentMeta(meta) {
  const item = { ...stripFixturesForMeta(meta), updatedAt: meta?.updatedAt || nowIso() };
  await ddb.put({ TableName: META_TABLE, Item: item }).promise();
  return item;
}

async function queryTournamentMatches(tournamentId) {
  const rows = await queryAll(MATCH_TABLE, 'tournamentId = :t', { ':t': tournamentId });
  return rows.sort((a, b) => String(a.matchKey || '').localeCompare(String(b.matchKey || '')));
}

async function deleteTournamentMatches(tournamentId) {
  const existing = await queryTournamentMatches(tournamentId);
  if (!existing.length) return 0;
  for (const batch of chunk(existing, 25)) {
    await batchWriteWithRetry({
      [MATCH_TABLE]: batch.map((row) => ({
        DeleteRequest: {
          Key: {
            tournamentId: row.tournamentId,
            matchKey: row.matchKey,
          },
        },
      })),
    });
  }
  return existing.length;
}

async function putTournamentMatches(matchRows) {
  const rows = asArray(matchRows);
  if (!rows.length) return 0;
  for (const batch of chunk(rows, 25)) {
    await batchWriteWithRetry({
      [MATCH_TABLE]: batch.map((Item) => ({ PutRequest: { Item } })),
    });
  }
  return rows.length;
}

async function deleteTournamentMatchRows(matchRows) {
  const rows = asArray(matchRows);
  if (!rows.length) return 0;
  for (const batch of chunk(rows, 25)) {
    await batchWriteWithRetry({
      [MATCH_TABLE]: batch.map((row) => ({
        DeleteRequest: {
          Key: {
            tournamentId: row.tournamentId,
            matchKey: row.matchKey,
          },
        },
      })),
    });
  }
  return rows.length;
}

async function replaceTournamentMatches(tournamentId, fixtures, options = {}) {
  const updatedAt = options.updatedAt || nowIso();
  const createdAt = options.createdAt || updatedAt;
  const rows = extractMatchRowsFromFixtures(tournamentId, fixtures, { createdAt, updatedAt });
  await deleteTournamentMatches(tournamentId);
  await putTournamentMatches(rows);
  return rows;
}

async function getTournamentAggregate(tournamentId) {
  if (!USE_SPLIT_TABLES) {
    return getLegacyTournament(tournamentId);
  }

  const meta = await getTournamentMeta(tournamentId);
  if (!meta) {
    return getLegacyTournament(tournamentId);
  }

  const matches = await queryTournamentMatches(tournamentId);
  return {
    ...cloneJson(meta),
    fixtures: buildFixturesFromMatchRows(meta, matches),
  };
}

async function listTournamentAggregates() {
  if (!USE_SPLIT_TABLES) {
    return scanAll(LEGACY_TABLE);
  }

  const metas = await scanAll(META_TABLE);
  if (!metas.length) {
    return scanAll(LEGACY_TABLE);
  }

  const out = [];
  for (const meta of metas) {
    const matches = await queryTournamentMatches(meta.tournamentId);
    out.push({
      ...cloneJson(meta),
      fixtures: buildFixturesFromMatchRows(meta, matches),
    });
  }
  return out;
}

async function saveTournamentAggregate(tournament) {
  if (!tournament?.tournamentId) {
    throw new Error('tournamentId is required');
  }

  if (!USE_SPLIT_TABLES) {
    const legacyItem = { ...cloneJson(tournament), updatedAt: tournament?.updatedAt || nowIso() };
    await ddb.put({ TableName: LEGACY_TABLE, Item: legacyItem }).promise();
    return legacyItem;
  }

  const updatedAt = tournament?.updatedAt || nowIso();
  const meta = stripFixturesForMeta({
    ...cloneJson(tournament),
    fixtureConfigByCategory: deriveFixtureConfigByCategory(tournament?.fixtures || { categories: {} }),
    updatedAt,
  });

  await saveTournamentMeta(meta);
  await replaceTournamentMatches(meta.tournamentId, tournament?.fixtures || { categories: {} }, {
    createdAt: meta.createdAt || updatedAt,
    updatedAt,
  });

  return {
    ...meta,
    fixtures: normalizeFixtures(tournament?.fixtures || { categories: {} }),
  };
}

async function updateTournamentAggregateFields(tournamentId, fields) {
  const current = await getTournamentAggregate(tournamentId);
  if (!current) return null;
  const next = {
    ...cloneJson(current),
    ...cloneJson(fields || {}),
    updatedAt: nowIso(),
  };
  return saveTournamentAggregate(next);
}

async function updateTournamentMetaFields(tournamentId, fields) {
  if (!USE_SPLIT_TABLES) {
    return updateTournamentAggregateFields(tournamentId, fields);
  }

  const current = await getTournamentMeta(tournamentId);
  if (!current) return null;

  const next = {
    ...cloneJson(current),
    ...cloneJson(fields || {}),
    updatedAt: nowIso(),
  };

  return saveTournamentMeta(next);
}

async function deleteTournamentAggregate(tournamentId) {
  const id = String(tournamentId || '').trim();
  if (!id) throw new Error('tournamentId is required');

  let removedMatches = 0;
  let removedMeta = false;
  let removedLegacy = false;

  if (USE_SPLIT_TABLES) {
    removedMatches = await deleteTournamentMatches(id);

    const meta = await getTournamentMeta(id);
    if (meta) {
      await ddb.delete({ TableName: META_TABLE, Key: { tournamentId: id } }).promise();
      removedMeta = true;
    }
  }

  const legacy = await getLegacyTournament(id);
  if (legacy) {
    await ddb.delete({ TableName: LEGACY_TABLE, Key: { tournamentId: id } }).promise();
    removedLegacy = true;
  }

  return {
    tournamentId: id,
    removedMatches,
    removedMeta,
    removedLegacy,
  };
}

module.exports = {
  REGION,
  LEGACY_TABLE,
  META_TABLE,
  MATCH_TABLE,
  USE_SPLIT_TABLES,
  nowIso,
  asArray,
  cloneJson,
  normalizeText,
  uniqStrings,
  safeJson,
  toFiniteNumber,
  normalizeCategories,
  normalizeCategoryItem,
  normalizeFixtures,
  buildMatchKey,
  parseMatchKey,
  deriveFixtureConfigByCategory,
  extractMatchRowsFromFixtures,
  buildFixturesFromMatchRows,
  getLegacyTournament,
  getTournamentMeta,
  saveTournamentMeta,
  queryTournamentMatches,
  deleteTournamentMatches,
  deleteTournamentMatchRows,
  putTournamentMatches,
  replaceTournamentMatches,
  getTournamentAggregate,
  listTournamentAggregates,
  saveTournamentAggregate,
  updateTournamentAggregateFields,
  updateTournamentMetaFields,
  deleteTournamentAggregate,
};
