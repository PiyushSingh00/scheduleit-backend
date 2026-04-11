const AWS = require("aws-sdk");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-north-1";
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
const TEAM_EVENT_CATEGORY_ID = "__team_event__";

AWS.config.update({ region: REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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
  throw new Error("Pending player links backfill still has unprocessed items");
}

function buildLinkRows(tournament = {}) {
  const tournamentId = String(tournament?.tournamentId || "").trim();
  const tournamentName = String(tournament?.tournamentName || "").trim();
  const hostUsername = String(tournament?.hostUsername || "").trim();
  const isTeam = normalizeText(tournament?.tournamentType) === "team";

  return asArray(tournament?.players)
    .map((player) => {
      const phone = normalizePhone(player?.phone || player?.playerPhone || "");
      if (!phone) return null;

      const status = normalizeText(player?.status || player?.registrationStatus || "accepted");
      if (!["accepted", "approved", "active", ""].includes(status)) return null;

      const categoryId = String(
        player?.categoryId || (isTeam ? TEAM_EVENT_CATEGORY_ID : "")
      ).trim() || TEAM_EVENT_CATEGORY_ID;
      const playerName = String(player?.playerName || player?.name || "").trim();
      const playerId = String(player?.playerId || player?.userId || playerName || phone).trim();

      return {
        [PENDING_PLAYER_LINKS_PARTITION_KEY]: phone,
        [PENDING_PLAYER_LINKS_SORT_KEY]: `${tournamentId}#${categoryId}#${playerId}`,
        phone,
        linkId: `${tournamentId}#${categoryId}#${playerId}`,
        tournamentId,
        tournamentName,
        hostUsername,
        playerId,
        userId: String(player?.userId || "").trim() || null,
        username: String(player?.username || "").trim(),
        playerName,
        categoryId,
        age: player?.age != null && player?.age !== "" ? Number(player.age) : null,
        gender: String(player?.gender || "").trim(),
        status: String(player?.status || player?.registrationStatus || "accepted").trim() || "accepted",
        source: String(player?.source || player?.registeredVia || "backfill").trim() || "backfill",
        createdAt: String(player?.createdAt || tournament?.createdAt || nowIso()).trim() || nowIso(),
        updatedAt: nowIso(),
      };
    })
    .filter(Boolean);
}

async function main() {
  const dryRun = !hasFlag("apply");
  const tournamentIdFilter = String(getArg("tournament-id", "")).trim();

  const [metaTournaments, legacyTournaments] = await Promise.all([
    scanAll(TOURNAMENT_META_TABLE),
    scanAll(LEGACY_TOURNAMENTS_TABLE),
  ]);

  const tournamentsById = new Map();
  [...legacyTournaments, ...metaTournaments].forEach((tournament) => {
    const tournamentId = String(tournament?.tournamentId || "").trim();
    if (!tournamentId) return;
    if (tournamentIdFilter && tournamentId !== tournamentIdFilter) return;
    tournamentsById.set(tournamentId, tournament);
  });

  const linkRows = [];
  tournamentsById.forEach((tournament) => {
    linkRows.push(...buildLinkRows(tournament));
  });

  const uniqueRows = [];
  const seen = new Set();
  linkRows.forEach((row) => {
    const key = `${row.phone}#${row.linkId}`;
    if (seen.has(key)) return;
    seen.add(key);
    uniqueRows.push(row);
  });

  const summary = {
    dryRun,
    tournamentCount: tournamentsById.size,
    linkCount: uniqueRows.length,
    sample: uniqueRows.slice(0, 20).map((row) => ({
      phone: row.phone,
      tournamentId: row.tournamentId,
      tournamentName: row.tournamentName,
      playerName: row.playerName,
      categoryId: row.categoryId,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (dryRun) return;
  if (!uniqueRows.length) return;

  for (let i = 0; i < uniqueRows.length; i += 25) {
    const chunk = uniqueRows.slice(i, i + 25);
    await batchWriteAll({
      [PENDING_PLAYER_LINKS_TABLE]: chunk.map((item) => ({
        PutRequest: { Item: item },
      })),
    });
  }

  console.log(JSON.stringify({ ok: true, wrote: uniqueRows.length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
