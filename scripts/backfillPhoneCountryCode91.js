const AWS = require("aws-sdk");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-north-1";
const USER_DETAILS_TABLE = process.env.SCHEDULEIT_USER_DETAILS_TABLE || "scheduleit-user-details";
const TOURNAMENT_META_TABLE = process.env.TOURNAMENT_META_TABLE || "ScheduleItTournamentMeta";
const LEGACY_TOURNAMENTS_TABLE =
  process.env.TOURNAMENTS_TABLE ||
  process.env.SCHEDULEIT_TOURNAMENTS_TABLE ||
  "ScheduleItTournaments";
const PENDING_PLAYER_LINKS_TABLE =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_TABLE || "ScheduleItPendingPlayerLinks";
const PENDING_PLAYER_LINKS_PARTITION_KEY =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_PARTITION_KEY || "phoneKey";
const PENDING_PLAYER_LINKS_SORT_KEY =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_SORT_KEY || "linkKey";

AWS.config.update({ region: REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePhone91(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function hasTenDigitLocalPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10;
}

async function scanAll(tableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.scan({ TableName: tableName, ExclusiveStartKey }).promise();
    items.push(...asArray(result.Items));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function batchWriteAll(requestItems) {
  let pending = requestItems;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await ddb.batchWrite({ RequestItems: pending }).promise();
    const next = result.UnprocessedItems || {};
    const hasUnprocessed = Object.values(next).some((rows) => Array.isArray(rows) && rows.length);
    if (!hasUnprocessed) return;
    pending = next;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  throw new Error("Country-code backfill still has unprocessed items");
}

function normalizePlayerPhoneFields(player = {}) {
  let changed = false;
  const next = { ...player };
  ["phone", "playerPhone"].forEach((field) => {
    if (!hasTenDigitLocalPhone(next[field])) return;
    next[field] = normalizePhone91(next[field]);
    changed = true;
  });
  return { next, changed };
}

function normalizeInvitePhoneFields(invite = {}) {
  let changed = false;
  const next = { ...invite };
  ["phone", "playerPhone"].forEach((field) => {
    if (!hasTenDigitLocalPhone(next[field])) return;
    next[field] = normalizePhone91(next[field]);
    changed = true;
  });
  return { next, changed };
}

function normalizeTournamentRecordPhones(tournament = {}) {
  let changed = false;
  const next = { ...tournament };

  next.players = asArray(tournament.players).map((player) => {
    const out = normalizePlayerPhoneFields(player);
    changed = changed || out.changed;
    return out.next;
  });

  next.teams = asArray(tournament.teams).map((team) => {
    let teamChanged = false;
    const nextTeam = { ...team };
    if (hasTenDigitLocalPhone(nextTeam.captainPhone)) {
      nextTeam.captainPhone = normalizePhone91(nextTeam.captainPhone);
      teamChanged = true;
    }
    nextTeam.players = asArray(team.players).map((player) => {
      const out = normalizePlayerPhoneFields(player);
      teamChanged = teamChanged || out.changed;
      return out.next;
    });
    changed = changed || teamChanged;
    return nextTeam;
  });

  next.teamRequests = asArray(tournament.teamRequests).map((request) => {
    let requestChanged = false;
    const nextRequest = { ...request };
    if (hasTenDigitLocalPhone(nextRequest.captainPhone)) {
      nextRequest.captainPhone = normalizePhone91(nextRequest.captainPhone);
      requestChanged = true;
    }
    nextRequest.invitedPlayers = asArray(request.invitedPlayers).map((invite) => {
      const out = normalizeInvitePhoneFields(invite);
      requestChanged = requestChanged || out.changed;
      return out.next;
    });
    changed = changed || requestChanged;
    return nextRequest;
  });

  next.umpires = asArray(tournament.umpires).map((umpire) => {
    if (!hasTenDigitLocalPhone(umpire?.phone)) return umpire;
    changed = true;
    return { ...umpire, phone: normalizePhone91(umpire.phone) };
  });

  return { next, changed };
}

async function main() {
  const apply = process.argv.includes("--apply");

  const [userDetails, metaTournaments, legacyTournaments, pendingLinks] = await Promise.all([
    scanAll(USER_DETAILS_TABLE),
    scanAll(TOURNAMENT_META_TABLE),
    scanAll(LEGACY_TOURNAMENTS_TABLE),
    scanAll(PENDING_PLAYER_LINKS_TABLE),
  ]);

  const userUpdates = userDetails
    .filter((row) => hasTenDigitLocalPhone(row.phone || row.phoneNumber || row.mobile))
    .map((row) => ({
      ...row,
      phone: normalizePhone91(row.phone || row.phoneNumber || row.mobile),
    }));

  const metaUpdates = metaTournaments
    .map((row) => normalizeTournamentRecordPhones(row))
    .filter((row) => row.changed)
    .map((row) => row.next);

  const legacyUpdates = legacyTournaments
    .map((row) => normalizeTournamentRecordPhones(row))
    .filter((row) => row.changed)
    .map((row) => row.next);

  const pendingDeletes = [];
  const pendingPuts = [];
  pendingLinks.forEach((row) => {
    const rawPhone = row[PENDING_PLAYER_LINKS_PARTITION_KEY] || row.phone;
    if (!hasTenDigitLocalPhone(rawPhone)) return;
    const normalizedPhone = normalizePhone91(rawPhone);
    pendingDeletes.push({
      [PENDING_PLAYER_LINKS_PARTITION_KEY]: row[PENDING_PLAYER_LINKS_PARTITION_KEY],
      [PENDING_PLAYER_LINKS_SORT_KEY]: row[PENDING_PLAYER_LINKS_SORT_KEY],
    });
    pendingPuts.push({
      ...row,
      [PENDING_PLAYER_LINKS_PARTITION_KEY]: normalizedPhone,
      phone: normalizedPhone,
    });
  });

  console.log(JSON.stringify({
    dryRun: !apply,
    userDetailsToUpdate: userUpdates.length,
    metaTournamentsToUpdate: metaUpdates.length,
    legacyTournamentsToUpdate: legacyUpdates.length,
    pendingLinksToRewrite: pendingPuts.length,
  }, null, 2));

  if (!apply) return;

  for (const row of userUpdates) {
    await ddb.put({ TableName: USER_DETAILS_TABLE, Item: row }).promise();
  }

  for (const row of metaUpdates) {
    await ddb.put({ TableName: TOURNAMENT_META_TABLE, Item: row }).promise();
  }

  for (const row of legacyUpdates) {
    await ddb.put({ TableName: LEGACY_TOURNAMENTS_TABLE, Item: row }).promise();
  }

  for (let i = 0; i < pendingDeletes.length; i += 25) {
    const deleteChunk = pendingDeletes.slice(i, i + 25);
    await batchWriteAll({
      [PENDING_PLAYER_LINKS_TABLE]: deleteChunk.map((key) => ({
        DeleteRequest: { Key: key },
      })),
    });
  }

  for (let i = 0; i < pendingPuts.length; i += 25) {
    const putChunk = pendingPuts.slice(i, i + 25);
    await batchWriteAll({
      [PENDING_PLAYER_LINKS_TABLE]: putChunk.map((item) => ({
        PutRequest: { Item: item },
      })),
    });
  }

  console.log(JSON.stringify({
    ok: true,
    userDetailsUpdated: userUpdates.length,
    metaTournamentsUpdated: metaUpdates.length,
    legacyTournamentsUpdated: legacyUpdates.length,
    pendingLinksRewritten: pendingPuts.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
