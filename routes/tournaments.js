const express = require("express");
const AWS = require("aws-sdk");
const { v4: uuid } = require("uuid");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-north-1";
const TABLE = process.env.TOURNAMENTS_TABLE || "ScheduleItTournaments";
const TEAM_EVENT_CATEGORY_ID = "__team_event__";

AWS.config.update({ region: REGION });
const dynamo = new AWS.DynamoDB.DocumentClient();

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function toFiniteNumber(value, fallback = null) {
  if (value === "" || value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqStrings(values) {
  return [...new Set(asArray(values).map((x) => String(x || "").trim()).filter(Boolean))];
}

function getAuthUsername(req) {
  return (
    req.user?.username ||
    req.user?.hostUsername ||
    req.user?.email ||
    req.user?.userId ||
    req.user?.id ||
    req.user?.sub ||
    ""
  );
}

function getAuthUserId(req) {
  return (
    req.user?.userId ||
    req.user?.id ||
    req.user?.sub ||
    req.user?.username ||
    req.user?.email ||
    ""
  );
}

function getAuthDisplayName(req, fallback = "") {
  return req.user?.name || req.user?.username || req.user?.email || fallback;
}

function getOwnerCandidates(req) {
  return [
    req.user?.username,
    req.user?.hostUsername,
    req.user?.email,
    req.user?.userId,
    req.user?.id,
    req.user?.sub,
  ]
    .filter(Boolean)
    .map((x) => String(x).trim().toLowerCase());
}

function isOwner(req, tournament) {
  const owner = normalizeText(tournament?.hostUsername);
  if (!owner) return false;
  return getOwnerCandidates(req).includes(owner);
}

function normalizeCategories(cats) {
  if (!cats) return [];
  if (Array.isArray(cats)) return cats;
  if (typeof cats === "string") {
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
    gender: String(category?.gender || ""),
    ageGroup: String(category?.ageGroup || ""),
    playingLevel: String(category?.playingLevel || ""),
    teamSize,
    exactTeamSize,
  };
}

function isTeamTournament(tournament) {
  return normalizeText(tournament?.tournamentType) === "team";
}

function getAdvancedSettings(tournament) {
  return safeJson(tournament?.advancedSettings, tournament?.advancedSettings) || {};
}

function isPickleballTeamLeague(tournament) {
  return normalizeText(getAdvancedSettings(tournament)?.advancedMode) === "pickleball_team_league";
}

function defaultQualifierCount(tournament) {
  const adv = getAdvancedSettings(tournament);
  const explicit = toFiniteNumber(adv.qualifierCount, null);
  if (explicit && explicit > 0) return explicit;
  if (isPickleballTeamLeague(tournament)) return 4;
  return 4;
}

function resolveCategoryId(tournament, incomingCategoryId, options = {}) {
  const categories = normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
  const requested = String(incomingCategoryId || "").trim();
  const preferSyntheticForTeam = options.preferSyntheticForTeam !== false;

  if (isTeamTournament(tournament) && preferSyntheticForTeam) {
    if (!requested || requested === TEAM_EVENT_CATEGORY_ID) return TEAM_EVENT_CATEGORY_ID;
  }

  if (requested) {
    const exact = categories.find((c) => String(c.categoryId) === requested);
    if (exact) return exact.categoryId;
    if (isTeamTournament(tournament) && preferSyntheticForTeam) return TEAM_EVENT_CATEGORY_ID;
  }

  if (isTeamTournament(tournament) && preferSyntheticForTeam) return TEAM_EVENT_CATEGORY_ID;
  return categories[0]?.categoryId || null;
}

function getCategoryMeta(tournament, categoryId) {
  const categories = normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
  return categories.find((c) => String(c.categoryId) === String(categoryId)) || null;
}

function splitTeamName(value) {
  const text = String(value || "").trim();
  const up = text.toUpperCase();
  if (!text || up === "BYE" || up === "TBD") return [];
  return text.split(" + ").map((x) => x.trim()).filter(Boolean);
}

function makeMatchId() {
  return `M-${uuid()}`;
}

function ensureMatchMeta(match) {
  if (!match || typeof match !== "object") return match;
  if (!match.matchId) match.matchId = makeMatchId();
  if (!Array.isArray(match.homePlayers)) match.homePlayers = splitTeamName(match.home);
  if (!Array.isArray(match.awayPlayers)) match.awayPlayers = splitTeamName(match.away);
  if (!match.status) match.status = "pending";
  return match;
}

function normalizeFixtures(fixtures) {
  const safe = fixtures && typeof fixtures === "object" ? cloneJson(fixtures) : { categories: {} };
  safe.categories = safe.categories && typeof safe.categories === "object" ? safe.categories : {};
  Object.values(safe.categories).forEach((cat) => {
    if (!cat || typeof cat !== "object") return;
    if (Array.isArray(cat.matches)) cat.matches = cat.matches.map(ensureMatchMeta);
    if (Array.isArray(cat.rounds)) {
      cat.rounds = cat.rounds.map((round) => asArray(round).map(ensureMatchMeta));
    } else {
      cat.rounds = [];
    }
  });
  return safe;
}

function getPairKey(a, b) {
  return [String(a || "").trim(), String(b || "").trim()].sort().join("::");
}

function findCategoryBucket(fixtures, categoryId) {
  if (!fixtures?.categories || typeof fixtures.categories !== "object") return null;
  if (fixtures.categories[categoryId]) return fixtures.categories[categoryId];
  const entry = Object.entries(fixtures.categories).find(([cid]) => String(cid) === String(categoryId));
  return entry ? entry[1] : null;
}

function getMatchScoreNumbers(match) {
  if (!match) return { homePoints: 0, awayPoints: 0 };
  if (Number.isFinite(Number(match?.matchPointsHome)) || Number.isFinite(Number(match?.matchPointsAway))) {
    return {
      homePoints: Number(match?.matchPointsHome || 0),
      awayPoints: Number(match?.matchPointsAway || 0),
    };
  }

  if (match?.summary && (Number.isFinite(Number(match.summary.homeMatchPoints)) || Number.isFinite(Number(match.summary.awayMatchPoints)))) {
    return {
      homePoints: Number(match.summary.homeMatchPoints || 0),
      awayPoints: Number(match.summary.awayMatchPoints || 0),
    };
  }

  const comp = match?.score?.computed || {};
  if (Number.isFinite(Number(comp?.aValue)) || Number.isFinite(Number(comp?.bValue))) {
    return {
      homePoints: Number(comp?.aValue || 0),
      awayPoints: Number(comp?.bValue || 0),
    };
  }

  const stateA = match?.score?.state?.A || {};
  const stateB = match?.score?.state?.B || {};
  const a = stateA.points ?? stateA.score ?? stateA.goals ?? stateA.runs ?? 0;
  const b = stateB.points ?? stateB.score ?? stateB.goals ?? stateB.runs ?? 0;

  return {
    homePoints: Number(a || 0),
    awayPoints: Number(b || 0),
  };
}

function ensureLeaderboardRow(map, teamName) {
  const key = String(teamName || "").trim();
  if (!key || key.toUpperCase() === "BYE" || key.toUpperCase() === "TBD") return null;
  if (!map.has(key)) {
    map.set(key, {
      teamName: key,
      rank: 0,
      matchPoints: 0,
      leaguePoints: 0,
      tiesWon: 0,
      tiesLost: 0,
      tiesDrawn: 0,
      headToHead: "-",
      qualified: false,
    });
  }
  return map.get(key);
}

function computeHeadToHeadSummary(results, a, b) {
  const rec = results[getPairKey(a, b)] || [];
  if (!rec.length) return "-";
  const winsA = rec.filter((x) => x.winner === a).length;
  const winsB = rec.filter((x) => x.winner === b).length;
  if (winsA === winsB) return "-";
  return winsA > winsB ? `${a} lead` : `${b} lead`;
}

function computeLeaderboardRows(tournament, categoryId, fixturesOverride) {
  const snapshotByCategory = tournament?.leaderboardSnapshotByCategory || {};
  const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  const snapshot = snapshotByCategory[resolvedCategoryId];
  if (Array.isArray(snapshot) && snapshot.length) {
    return cloneJson(snapshot);
  }

  const fixtures = normalizeFixtures(fixturesOverride || tournament?.fixtures || { categories: {} });
  const bucket = findCategoryBucket(fixtures, resolvedCategoryId);
  if (!bucket) return [];

  const useMatchPointsRanking = isPickleballTeamLeague(tournament);
  const pointsRule = tournament?.leaguePoints || {};
  const map = new Map();
  const pairResults = {};

  asArray(bucket.rounds).forEach((round) => {
    asArray(round).forEach((match) => {
      if (!match) return;
      const stage = normalizeText(match?.stage || "league");
      if (stage === "knockout") return;

      const home = ensureLeaderboardRow(map, match.home);
      const away = ensureLeaderboardRow(map, match.away);
      if (!home || !away) return;

      const { homePoints, awayPoints } = getMatchScoreNumbers(match);
      home.matchPoints += homePoints;
      away.matchPoints += awayPoints;

      const winner = String(match?.winner || "").trim();
      const draw = !winner && normalizeText(match?.status) === "completed";

      if (winner && winner === home.teamName) {
        home.tiesWon += 1;
        away.tiesLost += 1;
        home.leaguePoints += toFiniteNumber(pointsRule.win, useMatchPointsRanking ? 0 : 3) || 0;
        away.leaguePoints += toFiniteNumber(pointsRule.loss, useMatchPointsRanking ? 0 : 0) || 0;
      } else if (winner && winner === away.teamName) {
        away.tiesWon += 1;
        home.tiesLost += 1;
        away.leaguePoints += toFiniteNumber(pointsRule.win, useMatchPointsRanking ? 0 : 3) || 0;
        home.leaguePoints += toFiniteNumber(pointsRule.loss, useMatchPointsRanking ? 0 : 0) || 0;
      } else if (draw) {
        home.tiesDrawn += 1;
        away.tiesDrawn += 1;
        const drawPts = toFiniteNumber(pointsRule.draw, useMatchPointsRanking ? 0 : 1) || 0;
        home.leaguePoints += drawPts;
        away.leaguePoints += drawPts;
      }

      const pairKey = getPairKey(home.teamName, away.teamName);
      pairResults[pairKey] = pairResults[pairKey] || [];
      pairResults[pairKey].push({ winner, home: home.teamName, away: away.teamName });
    });
  });

  const rows = Array.from(map.values());
  rows.sort((a, b) => {
    if (!useMatchPointsRanking && b.leaguePoints !== a.leaguePoints) return b.leaguePoints - a.leaguePoints;
    if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
    if (b.tiesWon !== a.tiesWon) return b.tiesWon - a.tiesWon;
    return a.teamName.localeCompare(b.teamName);
  });

  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });

  rows.forEach((row) => {
    const peers = rows.filter((x) => x !== row && x.matchPoints === row.matchPoints && x.tiesWon === row.tiesWon);
    if (peers.length === 1) {
      row.headToHead = computeHeadToHeadSummary(pairResults, row.teamName, peers[0].teamName);
    }
  });

  const qualifierCount = Math.min(defaultQualifierCount(tournament), rows.length);
  rows.forEach((row, idx) => {
    row.qualified = idx < qualifierCount;
  });

  return rows;
}

function getPlayers(tournament) {
  return asArray(tournament?.players).map((p) => ({ ...p }));
}

function getTeams(tournament) {
  return asArray(tournament?.teams).map((t) => ({ ...t, players: asArray(t?.players).map((p) => ({ ...p })) }));
}

function getTeamRequests(tournament) {
  return asArray(tournament?.teamRequests).map((r) => ({ ...r, invitedPlayers: asArray(r?.invitedPlayers).map((p) => ({ ...p })) }));
}

function getConfirmedCaptains(tournament) {
  return asArray(tournament?.captains?.confirmedCaptains).map((c) => ({ ...c }));
}

function buildPublicTournamentView(tournament, options = {}) {
  const includeAccessCode = Boolean(options.includeAccessCode);
  const players = getPlayers(tournament);
  const teams = getTeams(tournament);
  const requests = getTeamRequests(tournament);
  const categories = normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
  const fixtures = normalizeFixtures(tournament?.fixtures || { categories: {} });

  const visible = {
    tournamentId: tournament.tournamentId,
    tournamentName: tournament.tournamentName || "",
    sportName: tournament.sportName || "",
    tournamentDates: tournament.tournamentDates || "",
    venue: tournament.venue || "",
    isPublic: Boolean(tournament.isPublic),
    registrationsOpen: tournament.registrationsOpen !== false,
    tournamentType: tournament.tournamentType || "single",
    stageFormat: tournament.stageFormat || "",
    groupCount: toFiniteNumber(tournament.groupCount, null),
    categories,
    advancedSettings: getAdvancedSettings(tournament),
    tournamentRules: safeJson(tournament.tournamentRules, tournament.tournamentRules) || {},
    leaguePoints: safeJson(tournament.leaguePoints, tournament.leaguePoints) || {},
    courtCount: toFiniteNumber(tournament.courtCount, 1) || 1,
    courtNames: uniqStrings(tournament.courtNames),
    requirePayment: Boolean(tournament.requirePayment),
    entryFee: toFiniteNumber(tournament.entryFee, 0) || 0,
    accessCodeRequired: !Boolean(tournament.isPublic),
    totalRegistrations: players.length,
    totalTeams: teams.length,
    playersCount: players.length,
    teamsCount: teams.length,
    fixturesAvailable: Boolean(fixtures && fixtures.categories && Object.keys(fixtures.categories).length),
    leaderboardAvailable: Boolean(tournament?.leaderboardSnapshotByCategory && Object.keys(tournament.leaderboardSnapshotByCategory).length),
    createdAt: tournament.createdAt || null,
    updatedAt: tournament.updatedAt || null,
  };

  if (includeAccessCode) {
    visible.accessCode = tournament.accessCode || "";
  }

  if (options.includePrivateMeta) {
    visible.hostUsername = tournament.hostUsername || "";
    visible.playerDetails = tournament.playerDetails || "";
    visible.captains = tournament.captains || { selectedCaptainIds: [], confirmedCaptains: [] };
    visible.pools = tournament.pools || null;
    visible.teams = teams;
    visible.teamRequests = requests;
    visible.players = players;
    visible.fixtures = fixtures;
    visible.scoringSchemaDraft = tournament.scoringSchemaDraft || null;
    visible.scoringSchemaActiveByCategory = tournament.scoringSchemaActiveByCategory || {};
    visible.hostFormSnapshot = tournament.hostFormSnapshot || null;
    visible.lastSavedPayload = tournament.lastSavedPayload || null;
  }

  return visible;
}

function canSeePrivateAccessCode(req, tournament) {
  if (!req?.user) return false;
  if (isOwner(req, tournament)) return true;
  const userId = String(getAuthUserId(req));
  const username = normalizeText(getAuthUsername(req));
  const players = getPlayers(tournament);
  return players.some((p) => String(p?.userId || "") === userId || normalizeText(p?.username) === username);
}

function resolveJoinCategoryId(tournament, incomingCategoryId) {
  if (isTeamTournament(tournament)) return TEAM_EVENT_CATEGORY_ID;
  return resolveCategoryId(tournament, incomingCategoryId, { preferSyntheticForTeam: false });
}

function findPlayerByIdentifiers(players, identifiers) {
  const idSet = new Set(
    [
      identifiers.playerId,
      identifiers.userId,
      identifiers.username,
      identifiers.playerName,
      identifiers.phone,
    ]
      .filter(Boolean)
      .map((x) => normalizeText(x))
  );

  return players.find((p) => {
    const candidates = [p?.playerId, p?.userId, p?.username, p?.playerName, p?.phone]
      .filter(Boolean)
      .map((x) => normalizeText(x));
    return candidates.some((c) => idSet.has(c));
  });
}

function tournamentIncludesUser(tournament, req) {
  const userId = String(getAuthUserId(req));
  const username = normalizeText(getAuthUsername(req));
  const displayName = normalizeText(getAuthDisplayName(req));

  if (!userId && !username && !displayName) return false;

  const players = getPlayers(tournament);
  if (
    players.some((p) =>
      String(p?.userId || "") === userId ||
      normalizeText(p?.username) === username ||
      normalizeText(p?.playerName) === displayName
    )
  ) {
    return true;
  }

  const teams = getTeams(tournament);
  if (
    teams.some((team) =>
      asArray(team?.players).some((p) =>
        String(p?.userId || "") === userId ||
        normalizeText(p?.username) === username ||
        normalizeText(p?.playerName) === displayName
      )
    )
  ) {
    return true;
  }

  const requests = getTeamRequests(tournament);
  return requests.some((request) =>
    asArray(request?.invitedPlayers).some((invite) => {
      const accepted = normalizeText(invite?.inviteStatus || invite?.status) === "accepted";
      return (
        accepted &&
        (
          String(invite?.userId || "") === userId ||
          normalizeText(invite?.inviteeUsername || invite?.username) === username ||
          normalizeText(invite?.inviteeName || invite?.playerName) === displayName
        )
      );
    })
  );
}

async function getTournament(tournamentId) {
  const result = await dynamo.get({ TableName: TABLE, Key: { tournamentId } }).promise();
  return result.Item || null;
}

async function saveTournament(tournament) {
  const item = { ...cloneJson(tournament), updatedAt: nowIso() };
  await dynamo.put({ TableName: TABLE, Item: item }).promise();
  return item;
}

function validatePrivateCodeIfNeeded(tournament, incomingCode) {
  if (Boolean(tournament.isPublic)) return { ok: true };
  const stored = String(tournament.accessCode || "").trim().toUpperCase();
  const provided = String(incomingCode || "").trim().toUpperCase();
  if (!provided) return { ok: false, status: 400, message: "accessCode is required for private tournaments" };
  if (!stored) return { ok: false, status: 400, message: "Tournament has no access code set" };
  if (stored !== provided) return { ok: false, status: 403, message: "Invalid access code" };
  return { ok: true };
}

// -----------------------------------------------------------------------------
// LOOKUP / CODE VALIDATION
// -----------------------------------------------------------------------------
router.post("/lookup-by-code", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ message: "code is required" });

    const scan = await dynamo.scan({ TableName: TABLE }).promise();
    const item = asArray(scan.Items).find((t) => String(t?.accessCode || "").trim().toUpperCase() === code);
    if (!item) return res.status(404).json({ message: "Tournament not found for this code" });
    if (item.registrationsOpen === false) return res.status(409).json({ message: "Registrations are closed" });

    return res.json({ ok: true, tournament: buildPublicTournamentView(item) });
  } catch (err) {
    console.error("lookup-by-code error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/validate-code", async (req, res) => {
  try {
    const tournamentId = String(req.body?.tournamentId || "").trim();
    const code = String(req.body?.code || "").trim();

    let tournament = null;
    if (tournamentId) {
      tournament = await getTournament(tournamentId);
    } else if (code) {
      const scan = await dynamo.scan({ TableName: TABLE }).promise();
      tournament = asArray(scan.Items).find((t) => String(t?.accessCode || "").trim().toUpperCase() === code.toUpperCase()) || null;
    }

    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const verdict = validatePrivateCodeIfNeeded(tournament, code);
    if (!verdict.ok) return res.status(verdict.status).json({ message: verdict.message });
    if (tournament.registrationsOpen === false) return res.status(409).json({ message: "Registrations are closed" });

    return res.json({
      ok: true,
      tournamentId: tournament.tournamentId,
      tournamentName: tournament.tournamentName,
      isPublic: Boolean(tournament.isPublic),
    });
  } catch (err) {
    console.error("validate-code error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// READ: BROWSE / DETAIL / PLAYERS / FIXTURES / LEADERBOARD
// -----------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const result = await dynamo.scan({ TableName: TABLE }).promise();
    const items = asArray(result.Items)
      .sort((a, b) => String(b?.createdAt || "").localeCompare(String(a?.createdAt || "")))
      .map((t) => buildPublicTournamentView(t));

    return res.json(items);
  } catch (err) {
    console.error("GET tournaments error:", err);
    return res.status(500).json({ message: "Failed to load tournaments" });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const result = await dynamo.scan({ TableName: TABLE }).promise();
    const items = asArray(result.Items)
      .filter((t) => tournamentIncludesUser(t, req))
      .sort((a, b) => String(b?.createdAt || "").localeCompare(String(a?.createdAt || "")))
      .map((t) => buildPublicTournamentView(t, { includeAccessCode: true }));

    return res.json(items);
  } catch (err) {
    console.error("GET mine tournaments error:", err);
    return res.status(500).json({ message: "Failed to load joined tournaments" });
  }
});

router.get("/:tournamentId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    return res.json(
      buildPublicTournamentView(tournament, {
        includeAccessCode: canSeePrivateAccessCode(req, tournament),
        includePrivateMeta: true,
      })
    );
  } catch (err) {
    console.error("GET tournament detail error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/:tournamentId/players", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    return res.json(getPlayers(tournament));
  } catch (err) {
    console.error("GET players error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/:tournamentId/registrations", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    return res.json({ registrations: getPlayers(tournament), data: getPlayers(tournament) });
  } catch (err) {
    console.error("GET registrations error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/:tournamentId/fixtures", async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    return res.json(normalizeFixtures(tournament.fixtures || null));
  } catch (err) {
    console.error("GET fixtures error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/:tournamentId/leaderboard", async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const categoryId = String(req.query.categoryId || resolveCategoryId(tournament, null, { preferSyntheticForTeam: true }) || "").trim();
    if (!categoryId) return res.status(400).json({ message: "categoryId query param is required" });

    const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
    const rows = computeLeaderboardRows(tournament, resolvedCategoryId, tournament.fixtures || null);

    return res.json({
      ok: true,
      categoryId: resolvedCategoryId,
      mode: isPickleballTeamLeague(tournament) ? "pickleball_team_league" : "default",
      rows,
    });
  } catch (err) {
    console.error("GET leaderboard error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// JOIN / LEAVE COMPATIBILITY ALIASES
// -----------------------------------------------------------------------------
router.post("/:tournamentId/join", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (tournament.registrationsOpen === false) {
      return res.status(409).json({ message: "Registrations are closed for this tournament" });
    }

    const verdict = validatePrivateCodeIfNeeded(tournament, req.body?.accessCode || req.body?.code || "");
    if (!verdict.ok) return res.status(verdict.status).json({ message: verdict.message });

    const resolvedCategoryId = resolveJoinCategoryId(tournament, req.body?.categoryId);
    if (!resolvedCategoryId) {
      return res.status(400).json({ message: "No category available for this tournament" });
    }

    const userId = String(getAuthUserId(req));
    const username = String(req.user?.username || "").trim();
    const displayName = String(req.body?.playerName || getAuthDisplayName(req, "Player")).trim();

    const players = getPlayers(tournament);
    const duplicate = players.find((p) =>
      (String(p?.userId || "") === userId || normalizeText(p?.username) === normalizeText(username)) &&
      String(p?.categoryId || "") === String(resolvedCategoryId)
    );

    if (duplicate) {
      return res.status(409).json({ message: "You are already registered in this tournament" });
    }

    const player = {
      playerId: `${userId || username || uuid()}::${resolvedCategoryId}`,
      userId,
      username,
      playerName: displayName,
      phone: String(req.body?.phone || "").trim(),
      age: toFiniteNumber(req.body?.age, null),
      gender: String(req.body?.gender || "").trim(),
      teamName: String(req.body?.teamName || "").trim(),
      categoryId: String(resolvedCategoryId),
      status: "accepted",
      registrationStatus: "accepted",
      joinedVia: "tournaments_join_alias",
      accessCodeValidated: !Boolean(tournament.isPublic),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const nextPlayers = [...players, player];
    const updated = await saveTournament({ ...tournament, players: nextPlayers });

    return res.json({ ok: true, tournamentId: updated.tournamentId, player });
  } catch (err) {
    console.error("Join tournament alias error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/:tournamentId/leave", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const userId = String(getAuthUserId(req));
    const username = normalizeText(req.user?.username);
    const categoryId = String(req.body?.categoryId || req.query?.categoryId || resolveJoinCategoryId(tournament, null) || "").trim();

    const players = getPlayers(tournament);
    const filtered = players.filter((p) => {
      const sameUser = String(p?.userId || "") === userId || normalizeText(p?.username) === username;
      const sameCategory = !categoryId || String(p?.categoryId || "") === categoryId;
      return !(sameUser && sameCategory);
    });

    const updated = await saveTournament({ ...tournament, players: filtered });
    return res.json({ ok: true, tournamentId: updated.tournamentId });
  } catch (err) {
    console.error("Leave tournament alias error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// HOST-COMPAT PATCH ALIASES FOR PLAYER STATUS
// -----------------------------------------------------------------------------
router.patch("/:tournamentId/players/:playerId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });

    const nextStatus = String(req.body?.status || "").trim().toLowerCase();
    if (!nextStatus) return res.status(400).json({ message: "status is required" });

    const players = getPlayers(tournament);
    const updatedPlayers = players.map((p) =>
      String(p?.playerId || "") === String(req.params.playerId)
        ? { ...p, status: nextStatus, registrationStatus: nextStatus, updatedAt: nowIso() }
        : p
    );

    const updated = await saveTournament({ ...tournament, players: updatedPlayers });
    return res.json({ ok: true, players: updated.players || updatedPlayers });
  } catch (err) {
    console.error("PATCH players/:playerId error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/:tournamentId/players/:playerId/:status", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });

    const nextStatus = String(req.params.status || "").trim().toLowerCase();
    const players = getPlayers(tournament);
    const updatedPlayers = players.map((p) =>
      String(p?.playerId || "") === String(req.params.playerId)
        ? { ...p, status: nextStatus, registrationStatus: nextStatus, updatedAt: nowIso() }
        : p
    );

    const updated = await saveTournament({ ...tournament, players: updatedPlayers });
    return res.json({ ok: true, players: updated.players || updatedPlayers });
  } catch (err) {
    console.error("POST players/:playerId/:status error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:tournamentId/registrations/:playerId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });

    const nextStatus = String(req.body?.status || "").trim().toLowerCase();
    if (!nextStatus) return res.status(400).json({ message: "status is required" });

    const players = getPlayers(tournament);
    const updatedPlayers = players.map((p) =>
      String(p?.playerId || "") === String(req.params.playerId)
        ? { ...p, status: nextStatus, registrationStatus: nextStatus, updatedAt: nowIso() }
        : p
    );

    const updated = await saveTournament({ ...tournament, players: updatedPlayers });
    return res.json({ ok: true, registrations: updated.players || updatedPlayers });
  } catch (err) {
    console.error("PATCH registrations/:playerId error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/:tournamentId/registrations/:playerId/:status", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });

    const nextStatus = String(req.params.status || "").trim().toLowerCase();
    const players = getPlayers(tournament);
    const updatedPlayers = players.map((p) =>
      String(p?.playerId || "") === String(req.params.playerId)
        ? { ...p, status: nextStatus, registrationStatus: nextStatus, updatedAt: nowIso() }
        : p
    );

    const updated = await saveTournament({ ...tournament, players: updatedPlayers });
    return res.json({ ok: true, registrations: updated.players || updatedPlayers });
  } catch (err) {
    console.error("POST registrations/:playerId/:status error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:tournamentId/players", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });

    const nextStatus = String(req.body?.status || "").trim().toLowerCase();
    if (!nextStatus) return res.status(400).json({ message: "status is required" });

    const players = getPlayers(tournament);
    const found = findPlayerByIdentifiers(players, {
      playerId: req.body?.playerId,
      userId: req.body?.userId,
      username: req.body?.username,
      playerName: req.body?.playerName,
      phone: req.body?.phone,
    });

    if (!found) return res.status(404).json({ message: "Player not found" });

    const updatedPlayers = players.map((p) =>
      String(p?.playerId || "") === String(found.playerId)
        ? { ...p, status: nextStatus, registrationStatus: nextStatus, updatedAt: nowIso() }
        : p
    );

    const updated = await saveTournament({ ...tournament, players: updatedPlayers });
    return res.json({ ok: true, players: updated.players || updatedPlayers });
  } catch (err) {
    console.error("PATCH players fallback error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
