const express = require("express");
const { v4: uuid } = require("uuid");
const AWS = require("aws-sdk");
const { requireAuth } = require("../middleware/auth");

const {
  getTournamentAggregate,
  listTournamentAggregates,
  saveTournamentAggregate,
  updateTournamentAggregateFields,
  updateTournamentMetaFields,
  extractMatchRowsFromFixtures,
  putTournamentMatches,
  putTournamentMatchRowsConditionally,
  deleteTournamentMatchRows,
  deleteTournamentMatchRowsConditionally,
  USE_SPLIT_TABLES,
  deleteTournamentAggregate,
} = require("../repositories/tournamentStore");

let OpenAI = null;
try {
  OpenAI = require("openai");
} catch {
  OpenAI = null;
}

const router = express.Router();
const dynamo = new AWS.DynamoDB.DocumentClient();

const TABLE = process.env.TOURNAMENTS_TABLE || "ScheduleItTournaments";
const USER_DETAILS_TABLE = process.env.SCHEDULEIT_USER_DETAILS_TABLE || "scheduleit-user-details";
const PENDING_PLAYER_LINKS_TABLE =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_TABLE || "ScheduleItPendingPlayerLinks";
const PENDING_PLAYER_LINKS_PARTITION_KEY =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_PARTITION_KEY || "phoneKey";
const PENDING_PLAYER_LINKS_SORT_KEY =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_SORT_KEY || "linkKey";
const TEAM_EVENT_CATEGORY_ID = "__team_event__";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-north-1";
AWS.config.update({ region: REGION });

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function getAuthDisplayName(req) {
  return req.user?.name || req.user?.username || req.user?.email || "";
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

function getLeagueRoundsRequested(tournament) {
  const adv = getAdvancedSettings(tournament);
  return Math.max(0, toFiniteNumber(adv.roundRobinMatches, 0) || 0);
}

function resolveCategoryId(tournament, incomingCategoryId, options = {}) {
  const cats = normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
  const requested = String(incomingCategoryId || "").trim();
  const preferSynthetic = options.preferSyntheticForTeam !== false;

  if (isTeamTournament(tournament) && preferSynthetic) {
    if (!requested || requested === TEAM_EVENT_CATEGORY_ID) return TEAM_EVENT_CATEGORY_ID;
  }

  if (requested) {
    const exact = cats.find((c) => String(c.categoryId) === requested);
    if (exact) return exact.categoryId;
    if (isTeamTournament(tournament) && preferSynthetic) return TEAM_EVENT_CATEGORY_ID;
  }

  if (isTeamTournament(tournament) && preferSynthetic) return TEAM_EVENT_CATEGORY_ID;
  return cats[0]?.categoryId || null;
}

function getCategoryMeta(tournament, categoryId) {
  const cats = normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
  return cats.find((c) => String(c.categoryId) === String(categoryId)) || null;
}

async function getTournament(tournamentId) {
  return getTournamentAggregate(tournamentId);
}

function assertOwner(req, tournament, res) {
  if (!tournament) {
    res.status(404).json({ message: "Tournament not found" });
    return false;
  }
  if (!isOwner(req, tournament)) {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function isPendingLinkEligiblePlayer(player = {}) {
  const phone = normalizePhone(player?.phone || player?.playerPhone || "");
  const status = normalizeText(player?.status || player?.registrationStatus || "accepted");
  return Boolean(phone) && ["accepted", "approved", "active", ""].includes(status);
}

function buildPendingPlayerLinks(tournament, players = []) {
  return asArray(players)
    .filter(isPendingLinkEligiblePlayer)
    .map((player) => {
      const phone = normalizePhone(player?.phone || player?.playerPhone || "");
      const categoryId = String(
        player?.categoryId ||
        (isTeamTournament(tournament) ? TEAM_EVENT_CATEGORY_ID : "")
      ).trim();
      const playerName = String(player?.playerName || player?.name || "").trim();
      const source = String(player?.source || player?.registeredVia || "").trim() || "host_player";
      const playerId = String(player?.playerId || player?.userId || playerName || phone).trim();

      return {
        [PENDING_PLAYER_LINKS_PARTITION_KEY]: phone,
        [PENDING_PLAYER_LINKS_SORT_KEY]: `${String(tournament?.tournamentId || "").trim()}#${categoryId || TEAM_EVENT_CATEGORY_ID}#${playerId}`,
        phone,
        linkId: `${String(tournament?.tournamentId || "").trim()}#${categoryId || TEAM_EVENT_CATEGORY_ID}#${playerId}`,
        tournamentId: String(tournament?.tournamentId || "").trim(),
        tournamentName: String(tournament?.tournamentName || "").trim(),
        hostUsername: String(tournament?.hostUsername || "").trim(),
        playerId,
        userId: String(player?.userId || "").trim() || null,
        username: String(player?.username || "").trim(),
        playerName,
        categoryId: categoryId || TEAM_EVENT_CATEGORY_ID,
        age: player?.age != null && player?.age !== "" ? Number(player.age) : null,
        gender: String(player?.gender || "").trim(),
        status: String(player?.status || player?.registrationStatus || "accepted").trim() || "accepted",
        source,
        createdAt: String(player?.createdAt || tournament?.createdAt || nowIso()).trim() || nowIso(),
        updatedAt: nowIso(),
      };
    });
}

async function batchWriteAll(requestItems) {
  let pending = requestItems;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await dynamo.batchWrite({ RequestItems: pending }).promise();
    const next = result.UnprocessedItems || {};
    const hasUnprocessed = Object.values(next).some((rows) => Array.isArray(rows) && rows.length);
    if (!hasUnprocessed) return;
    pending = next;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }

  throw new Error("Pending player links batch write still has unprocessed items");
}

async function queryPendingLinksByTournamentId(tournamentId) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const result = await dynamo.scan({
      TableName: PENDING_PLAYER_LINKS_TABLE,
      FilterExpression: "tournamentId = :tid",
      ExpressionAttributeValues: { ":tid": String(tournamentId || "").trim() },
      ExclusiveStartKey,
    }).promise();

    items.push(...asArray(result.Items));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

async function syncPendingPlayerLinksForTournament(tournament, players = []) {
  if (!tournament?.tournamentId) return;

  const existing = await queryPendingLinksByTournamentId(tournament.tournamentId);
  const nextLinks = buildPendingPlayerLinks(tournament, players);

  if (existing.length) {
    for (let i = 0; i < existing.length; i += 25) {
      const chunk = existing.slice(i, i + 25);
      await batchWriteAll({
        [PENDING_PLAYER_LINKS_TABLE]: chunk.map((item) => ({
          DeleteRequest: {
            Key: {
              [PENDING_PLAYER_LINKS_PARTITION_KEY]: item[PENDING_PLAYER_LINKS_PARTITION_KEY] || item.phone,
              [PENDING_PLAYER_LINKS_SORT_KEY]: item[PENDING_PLAYER_LINKS_SORT_KEY] || item.linkId,
            },
          },
        })),
      });
    }
  }

  if (nextLinks.length) {
    for (let i = 0; i < nextLinks.length; i += 25) {
      const chunk = nextLinks.slice(i, i + 25);
      await batchWriteAll({
        [PENDING_PLAYER_LINKS_TABLE]: chunk.map((item) => ({
          PutRequest: { Item: item },
        })),
      });
    }
  }
}

function getTournamentUmpires(tournament) {
  return asArray(tournament?.umpires).map((u) => ({ ...u }));
}

async function getCurrentUserProfileForAccess(req) {
  try {
    const username = String(getAuthUsername(req) || "").trim().toLowerCase();
    if (!username) return null;

    const result = await dynamo.get({
      TableName: USER_DETAILS_TABLE,
      Key: { username },
    }).promise();

    return result.Item || null;
  } catch (err) {
    console.warn("Could not load current user profile for access:", err?.message || err);
    return null;
  }
}

async function isUmpireForTournament(req, tournament) {
  const umpires = getTournamentUmpires(tournament);
  if (!umpires.length) return false;

  const profile = await getCurrentUserProfileForAccess(req);

  const myUsername = normalizeText(
    req.user?.username ||
    req.user?.email ||
    profile?.username ||
    ""
  );

  const myName = normalizeText(
    req.user?.name ||
    profile?.name ||
    ""
  );

  const myPhone = normalizePhone(
    req.user?.phone ||
    req.user?.phoneNumber ||
    req.user?.mobile ||
    profile?.phone ||
    profile?.phoneNumber ||
    profile?.mobile ||
    ""
  );

  return umpires.some((umpire) => {
    const umpireUsername = normalizeText(umpire?.username || "");
    const umpireName = normalizeText(umpire?.name || "");
    const umpirePhone = normalizePhone(umpire?.phone || "");

    return (
      (myPhone && umpirePhone && myPhone === umpirePhone) ||
      (myUsername && umpireUsername && myUsername === umpireUsername) ||
      (myName && umpireName && myName === umpireName)
    );
  });
}

async function assertOwnerOrUmpire(req, tournament, res) {
  if (!tournament) {
    res.status(404).json({ message: "Tournament not found" });
    return false;
  }

  if (isOwner(req, tournament)) return true;
  if (await isUmpireForTournament(req, tournament)) return true;

  res.status(403).json({ message: "Forbidden" });
  return false;
}

function getPlayers(tournament) {
  return asArray(tournament?.players).map((p) => ({ ...p }));
}

function getCaptainsState(tournament) {
  const raw = tournament?.captains || tournament?.captainState || {};
  return {
    selectedCaptainIds: asArray(raw.selectedCaptainIds).map(String),
    confirmedCaptains: asArray(raw.confirmedCaptains).map((c) => ({ ...c })),
    updatedAt: raw.updatedAt || null,
  };
}

function getPoolsState(tournament) {
  return tournament?.pools || null;
}

function getTeamRequests(tournament) {
  return asArray(tournament?.teamRequests).map((r) => ({ ...r, invitedPlayers: asArray(r?.invitedPlayers).map((p) => ({ ...p })) }));
}

function getLineupsState(tournament) {
  const raw = tournament?.lineups || {};
  return {
    ties: asArray(raw.ties).map((t) => ({ ...t, assignments: asArray(t?.assignments).map((a) => ({ ...a })) })),
  };
}

function getTeamNumbersState(tournament) {
  const raw = tournament?.teamNumbers || tournament?.teamNumberState || {};
  return {
    assignments: asArray(raw.assignments).map((a) => ({ ...a })),
    locked: Boolean(raw.locked),
    updatedAt: raw.updatedAt || null,
  };
}

function normalizeInviteStatus(value, fallback = "pending") {
  const s = normalizeText(value || fallback);
  if (["accepted", "approve", "approved", "joined", "active"].includes(s)) return "accepted";
  if (["rejected", "reject", "declined", "denied"].includes(s)) return "rejected";
  return "pending";
}

function normalizeTeamStatus(value, fallback = "pending") {
  const s = normalizeText(value || fallback);
  if (["accepted", "approve", "approved", "active"].includes(s)) return "accepted";
  if (["rejected", "reject", "declined", "denied"].includes(s)) return "rejected";
  return "pending";
}

function normalizeRequestInvite(player = {}) {
  return {
    playerId: String(player?.playerId || player?.inviteePlayerId || "").trim(),
    playerName: String(player?.playerName || player?.inviteeName || player?.name || player?.username || "Player").trim(),
    username: String(player?.username || player?.inviteeUsername || "").trim(),
    phone: String(player?.phone || "").trim(),
    inviteStatus: normalizeInviteStatus(player?.inviteStatus || player?.status || "pending"),
    isCaptain: Boolean(player?.isCaptain),
  };
}

function rosterEntriesOverlap(a = {}, b = {}) {
  const aId = String(a?.playerId || "").trim();
  const bId = String(b?.playerId || "").trim();
  const aUsername = normalizeText(a?.username || "");
  const bUsername = normalizeText(b?.username || "");
  const aPhone = String(a?.phone || "").trim();
  const bPhone = String(b?.phone || "").trim();
  const aName = normalizeText(a?.playerName || a?.username || "");
  const bName = normalizeText(b?.playerName || b?.username || "");

  if (aId && bId && aId === bId) return true;
  if (aUsername && bUsername && aUsername === bUsername) return true;
  if (aPhone && bPhone && aPhone === bPhone) return true;
  if (aName && bName && aName === bName) return true;

  return false;
}

function mergeUniqueRosterPlayers(players = []) {
  const out = [];

  asArray(players).forEach((raw) => {
    if (!raw) return;

    const item = normalizeRequestInvite(raw);
    const existing = out.find((candidate) => rosterEntriesOverlap(candidate, item));

    if (!existing) {
      out.push(item);
      return;
    }

    if (!existing.playerId && item.playerId) existing.playerId = item.playerId;
    if (!existing.username && item.username) existing.username = item.username;
    if (!existing.phone && item.phone) existing.phone = item.phone;
    if ((!existing.playerName || existing.playerName === "Player") && item.playerName) {
      existing.playerName = item.playerName;
    }
    existing.isCaptain = Boolean(existing.isCaptain || item.isCaptain);

    const existingStatus = normalizeInviteStatus(existing.inviteStatus || "pending");
    const incomingStatus = normalizeInviteStatus(item.inviteStatus || "pending");
    if (incomingStatus === "accepted" || (incomingStatus === "pending" && existingStatus === "rejected")) {
      existing.inviteStatus = incomingStatus;
    }
  });

  return out;
}

function buildCaptainRosterEntry(captain = {}, tournament = null) {
  const captainPlayerId = String(captain?.playerId || captain?.captainPlayerId || "").trim();

  let matchedPlayer = null;
  if (tournament) {
    matchedPlayer = getPlayers(tournament).find((p) => {
      const sameId =
        captainPlayerId &&
        String(p?.playerId || p?.registrationId || p?.id || "").trim() === captainPlayerId;

      const sameUsername =
        normalizeText(p?.username) &&
        normalizeText(p?.username) === normalizeText(captain?.username || captain?.captainUsername);

      const sameName =
        normalizeText(p?.playerName || p?.name) &&
        normalizeText(p?.playerName || p?.name) === normalizeText(captain?.playerName || captain?.captainName);

      return sameId || sameUsername || sameName;
    }) || null;
  }

  return {
    playerId: captainPlayerId || String(matchedPlayer?.playerId || matchedPlayer?.registrationId || matchedPlayer?.id || "").trim(),
    playerName: String(
      captain?.playerName ||
      captain?.captainName ||
      captain?.captainUsername ||
      matchedPlayer?.playerName ||
      matchedPlayer?.name ||
      matchedPlayer?.username ||
      "Captain"
    ).trim(),
    username: String(
      captain?.username ||
      captain?.captainUsername ||
      matchedPlayer?.username ||
      ""
    ).trim(),
    phone: String(captain?.phone || matchedPlayer?.phone || "").trim(),
    inviteStatus: "accepted",
    isCaptain: true,
  };
}

function requestMatchesCaptain(request, captainLike = {}, resolvedCategoryId = "", explicitRequestId = "") {
  const requestId = String(explicitRequestId || captainLike?.requestId || "").trim();
  if (requestId && String(request?.requestId || "").trim() === requestId) return true;

  const reqCategory = String(request?.categoryId || "").trim();
  if (resolvedCategoryId && reqCategory && reqCategory !== String(resolvedCategoryId)) return false;

  const captainPlayerId = String(captainLike?.playerId || captainLike?.captainPlayerId || "").trim();
  const captainUsername = normalizeText(captainLike?.username || captainLike?.captainUsername);
  const captainName = normalizeText(captainLike?.playerName || captainLike?.captainName);

  return (
    (captainPlayerId && String(request?.captainPlayerId || "").trim() === captainPlayerId) ||
    (captainUsername && normalizeText(request?.captainUsername) === captainUsername) ||
    (captainName && normalizeText(request?.captainName) === captainName)
  );
}

function findMatchingTeamRequest(requests, captainLike = {}, resolvedCategoryId = "", explicitRequestId = "") {
  return asArray(requests).find((request) =>
    requestMatchesCaptain(request, captainLike, resolvedCategoryId, explicitRequestId)
  ) || null;
}

function deriveTeamStatusFromInvites(invitedPlayers = [], fallback = "pending") {
  const statuses = asArray(invitedPlayers).map((p) =>
    normalizeInviteStatus(p?.inviteStatus || p?.status || fallback)
  );

  if (!statuses.length) return normalizeTeamStatus(fallback, "pending");
  if (statuses.some((s) => s === "pending")) return "pending";
  if (statuses.some((s) => s === "accepted")) return "accepted";
  if (statuses.every((s) => s === "rejected")) return "rejected";
  return normalizeTeamStatus(fallback, "pending");
}

function ensureCaptainBackedTeamRequests(tournamentLike) {
  const requests = getTeamRequests(tournamentLike);
  const captainsState = getCaptainsState(tournamentLike);
  const nextRequests = [...requests];

  captainsState.confirmedCaptains.forEach((captain) => {
    const resolvedCategoryId = resolveCategoryId(tournamentLike, captain?.categoryId, {
      preferSyntheticForTeam: isTeamTournament(tournamentLike),
    });

    const existing = findMatchingTeamRequest(nextRequests, captain, resolvedCategoryId);
    const captainEntry = buildCaptainRosterEntry(captain, tournamentLike);

    const legacyInvited = asArray(captain?.teamPlayers).map((name) =>
      normalizeRequestInvite({
        playerName: name,
        inviteStatus: "accepted",
      })
    );

    const mergedInvited = mergeUniqueRosterPlayers([
      ...(existing ? asArray(existing.invitedPlayers).map(normalizeRequestInvite) : []),
      ...legacyInvited,
    ]).filter((p) => !p.isCaptain);

    const nextRequest = {
      ...(existing || {}),
      requestId: String(existing?.requestId || captain?.requestId || uuid()).trim(),
      tournamentId: tournamentLike.tournamentId,
      tournamentName: String(tournamentLike?.tournamentName || existing?.tournamentName || "").trim(),
      teamName: String(existing?.teamName || captain?.teamName || captain?.playerName || "Team").trim() || "Team",
      categoryId: String(resolvedCategoryId || existing?.categoryId || "").trim(),
      categoryLabel: String(
        existing?.categoryLabel ||
        captain?.categoryLabel ||
        (isTeamTournament(tournamentLike) ? "Team event" : "")
      ).trim(),
      captainName: captainEntry.playerName,
      captainUsername: captainEntry.username,
      captainPlayerId: captainEntry.playerId,
      captainPhone: captainEntry.phone,
      createdBy: String(existing?.createdBy || captainEntry.username || captainEntry.playerName).trim(),
      invitedPlayers: mergedInvited,
      status: deriveTeamStatusFromInvites(
        mergedInvited,
        existing?.status || captain?.teamStatus || "pending"
      ),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    const existingIndex = nextRequests.findIndex((request) =>
      requestMatchesCaptain(
        request,
        captain,
        resolvedCategoryId,
        existing?.requestId || captain?.requestId
      )
    );

    if (existingIndex >= 0) nextRequests[existingIndex] = nextRequest;
    else nextRequests.push(nextRequest);
  });

  return nextRequests;
}

function buildRequestRoster(request) {
  const roster = [];
  const captainName = String(request?.captainName || request?.captainUsername || "").trim();
  const captainUsername = String(request?.captainUsername || "").trim();
  const captainPlayerId = String(request?.captainPlayerId || captainUsername || captainName || "").trim();

  if (captainName || captainUsername || captainPlayerId) {
    roster.push({
      playerId: captainPlayerId,
      playerName: captainName || captainUsername || "Captain",
      username: captainUsername || "",
      phone: String(request?.captainPhone || "").trim(),
      inviteStatus: "accepted",
      isCaptain: true,
    });
  }

  asArray(request?.invitedPlayers).forEach((p) => {
    roster.push({
      ...normalizeRequestInvite(p),
      isCaptain: false,
    });
  });

  return mergeUniqueRosterPlayers(roster);
}

function enrichCaptainsState(tournament) {
  const captainsState = getCaptainsState(tournament);
  const requests = ensureCaptainBackedTeamRequests(tournament);

  captainsState.confirmedCaptains = captainsState.confirmedCaptains.map((captain) => {
    const resolvedCategoryId = resolveCategoryId(tournament, captain?.categoryId, {
      preferSyntheticForTeam: isTeamTournament(tournament),
    });

    const match = findMatchingTeamRequest(
      requests,
      captain,
      resolvedCategoryId,
      captain?.requestId
    );

    const captainEntry = buildCaptainRosterEntry(captain, tournament);

    const legacyRoster = asArray(captain?.teamPlayers).map((name) =>
      normalizeRequestInvite({
        playerName: name,
        inviteStatus: "accepted",
      })
    );

    const roster = mergeUniqueRosterPlayers([
      captainEntry,
      ...(match ? asArray(match.invitedPlayers).map(normalizeRequestInvite) : []),
      ...legacyRoster,
    ]);

    const nonCaptainRoster = roster.filter((player) => {
      if (player?.isCaptain) return false;
      return !rosterEntriesOverlap(player, captainEntry);
    });

    return {
      ...captain,
      requestId: String(match?.requestId || captain?.requestId || "").trim(),
      teamName: String(match?.teamName || captain?.teamName || captain?.playerName || "Team").trim(),
      teamPlayers: nonCaptainRoster.map((p) => p.playerName).filter(Boolean),
      teamRoster: roster,
      teamStatus: normalizeTeamStatus(match?.status || captain?.teamStatus || "pending"),
      categoryId: String(resolvedCategoryId || match?.categoryId || captain?.categoryId || "").trim(),
    };
  });

  return captainsState;
}

function rebuildTeamsFromRequestsAndCaptains(tournament) {
  const requests = ensureCaptainBackedTeamRequests(tournament);
  const captainsState = getCaptainsState(tournament);
  const map = new Map();

  requests.forEach((request) => {
    const key = String(
      request?.captainPlayerId ||
      request?.captainUsername ||
      request?.captainName ||
      request?.requestId ||
      uuid()
    ).trim();

    const roster = buildRequestRoster(request);

    map.set(key, {
      teamId: `team-${key}`,
      teamName: String(request?.teamName || "Team").trim() || "Team",
      captainPlayerId: String(request?.captainPlayerId || "").trim(),
      captainName: String(request?.captainName || "Captain").trim(),
      captainUsername: String(request?.captainUsername || "").trim(),
      categoryId: String(request?.categoryId || "").trim(),
      teamStatus: normalizeTeamStatus(request?.status || "pending"),
      requestId: String(request?.requestId || "").trim(),
      players: roster,
    });
  });

  captainsState.confirmedCaptains.forEach((captain) => {
    const resolvedCategoryId = resolveCategoryId(tournament, captain?.categoryId, {
      preferSyntheticForTeam: isTeamTournament(tournament),
    });

    const match = findMatchingTeamRequest(
      requests,
      captain,
      resolvedCategoryId,
      captain?.requestId
    );

    if (match) return;

    const key = String(
      captain?.playerId ||
      captain?.captainPlayerId ||
      captain?.teamName ||
      uuid()
    ).trim();

    const roster = mergeUniqueRosterPlayers([
      buildCaptainRosterEntry(captain, tournament),
      ...asArray(captain?.teamPlayers).map((name) =>
        normalizeRequestInvite({
          playerName: name,
          inviteStatus: "accepted",
        })
      ),
    ]);

    map.set(key, {
      teamId: `team-${key}`,
      teamName: String(captain?.teamName || captain?.playerName || "Team").trim() || "Team",
      captainPlayerId: String(captain?.playerId || captain?.captainPlayerId || "").trim(),
      captainName: String(captain?.playerName || captain?.captainName || "Captain").trim(),
      captainUsername: String(captain?.username || captain?.captainUsername || "").trim(),
      categoryId: String(resolvedCategoryId || "").trim(),
      teamStatus: normalizeTeamStatus(captain?.teamStatus || "pending"),
      requestId: String(captain?.requestId || "").trim(),
      players: roster,
    });
  });

  return Array.from(map.values());
}

function makeMatchId() {
  return `M-${uuid()}`;
}

function splitTeamName(value) {
  const text = String(value || "").trim();
  const up = text.toUpperCase();
  if (!text || up === "BYE" || up === "TBD") return [];
  return text.split(" + ").map((x) => x.trim()).filter(Boolean);
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

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function buildEntrants(names, teamSize = 1) {
  const size = Math.max(1, Number(teamSize || 1));
  const shuffled = shuffle(names.filter(Boolean));
  const entrants = [];
  const dropped = [];
  const teamMap = {};

  if (size === 1) {
    shuffled.forEach((name) => {
      teamMap[name] = [name];
      entrants.push(name);
    });
    return { entrants, dropped, teamMap };
  }

  for (let i = 0; i < shuffled.length; i += size) {
    const chunk = shuffled.slice(i, i + size);
    if (chunk.length < size) {
      dropped.push(...chunk);
      continue;
    }
    const teamName = chunk.join(" + ");
    entrants.push(teamName);
    teamMap[teamName] = chunk;
  }

  return { entrants, dropped, teamMap };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createBracket(names, teamMap = {}, options = {}) {
  const entrants = shuffle(names.filter(Boolean));
  if (entrants.length < 2) return null;

  const size = nextPow2(entrants.length);
  while (entrants.length < size) entrants.push("BYE");

  const totalRounds = Math.log2(size);
  const rounds = [];

  function rosterOf(name) {
    if (!name || name === "BYE" || name === "TBD") return [];
    return teamMap[name] || splitTeamName(name);
  }

  const round1 = [];
  for (let i = 0; i < entrants.length; i += 2) {
    round1.push(ensureMatchMeta({
      home: entrants[i],
      away: entrants[i + 1],
      homePlayers: rosterOf(entrants[i]),
      awayPlayers: rosterOf(entrants[i + 1]),
      stage: options.stage || "knockout",
      roundLabel: options.roundLabel || null,
      scoreType: options.scoreType || "match",
      type: options.type || "match",
    }));
  }
  rounds.push(round1);

  for (let r = 1; r < totalRounds; r += 1) {
    const prev = rounds[r - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(ensureMatchMeta({
        home: "TBD",
        away: "TBD",
        homePlayers: [],
        awayPlayers: [],
        stage: options.stage || "knockout",
        type: options.type || "match",
      }));
    }
    rounds.push(next);
  }

  return { rounds, totalRounds };
}

function getRoundLabel(roundIndex, totalRounds) {
  const remaining = totalRounds - roundIndex;
  if (remaining === 1) return "Final";
  if (remaining === 2) return "Semi-final";
  if (remaining === 3) return "Quarter-final";
  return `Round ${roundIndex + 1}`;
}

function getAvailableCourtNames(tournament) {
  const adv = getAdvancedSettings(tournament);
  const desiredCount = Math.max(1, toFiniteNumber(tournament?.courtCount || adv.courtCount, 1) || 1);
  const sources = [tournament?.courtNames, adv.courtNames, adv.courts, tournament?.courts];

  for (const source of sources) {
    if (Array.isArray(source) && source.length) {
      const arr = uniqStrings(source);
      while (arr.length < desiredCount) arr.push(`Court ${arr.length + 1}`);
      return arr;
    }
    if (typeof source === "string" && source.trim()) {
      const arr = uniqStrings(source.split(","));
      while (arr.length < desiredCount) arr.push(`Court ${arr.length + 1}`);
      return arr;
    }
  }

  return Array.from({ length: desiredCount }, (_, i) => `Court ${i + 1}`);
}

function parseTournamentStartDate(tournament) {
  const raw = String(tournament?.tournamentDates || "").trim();
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const dt = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T09:00:00`);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const dmy = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    const yyyy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    const dt = new Date(`${yyyy}-${mm}-${dd}T09:00:00`);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const fallback = new Date();
  fallback.setHours(9, 0, 0, 0);
  return fallback;
}

function formatDateInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTimeInputValue(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function getPairKey(a, b) {
  return [a, b].sort().join("::");
}

function buildBalancedLeaguePairs(teamNames, requestedMatches) {
  const names = shuffle(teamNames.filter(Boolean));
  const teamCount = names.length;
  if (teamCount < 2) return { pairs: [], matchesPerTeam: 0 };

  let matchesPerTeam = Math.min(Math.max(1, Number(requestedMatches || teamCount - 1)), teamCount - 1);
  if ((teamCount * matchesPerTeam) % 2 !== 0) matchesPerTeam -= 1;
  if (matchesPerTeam < 1) return { pairs: [], matchesPerTeam: 0 };

  const allPairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      allPairs.push([names[i], names[j]]);
    }
  }

  let bestPairs = [];
  let bestScore = -1;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const counts = Object.fromEntries(names.map((name) => [name, 0]));
    const selected = [];
    const seen = new Set();

    for (const [a, b] of shuffle(allPairs)) {
      const key = getPairKey(a, b);
      if (seen.has(key)) continue;
      if (counts[a] >= matchesPerTeam || counts[b] >= matchesPerTeam) continue;
      selected.push({ home: a, away: b });
      counts[a] += 1;
      counts[b] += 1;
      seen.add(key);
    }

    const score = names.reduce((sum, name) => sum + counts[name], 0);
    if (score > bestScore) {
      bestScore = score;
      bestPairs = selected;
    }

    if (names.every((name) => counts[name] === matchesPerTeam)) break;
  }

  return { pairs: bestPairs, matchesPerTeam };
}

function scheduleLeaguePairs(pairs, courtNames, baseDate) {
  const matchDurationMs = 2 * 60 * 60 * 1000;
  const courts = uniqStrings(courtNames || []);
  const usableCourts = courts.length ? courts : ["Court 1"];
  const teamNext = new Map();
  const courtNext = new Map();
  const teamCourtHistory = new Map();
  const teamLastCourt = new Map();
  const courtUsageCounts = new Map();
  const baseTs = baseDate.getTime();

  usableCourts.forEach((court) => {
    courtNext.set(court, baseTs);
    courtUsageCounts.set(court, 0);
  });

  return pairs.map((pair, index) => {
    let best = null;

    usableCourts.forEach((court, courtIdx) => {
      const start = Math.max(
        baseTs,
        teamNext.get(pair.home) || baseTs,
        teamNext.get(pair.away) || baseTs,
        courtNext.get(court) || baseTs,
      );

      const homeHistory = teamCourtHistory.get(pair.home) || new Set();
      const awayHistory = teamCourtHistory.get(pair.away) || new Set();
      const homeLastCourt = teamLastCourt.get(pair.home) || "";
      const awayLastCourt = teamLastCourt.get(pair.away) || "";

      let penalty = 0;
      if (homeHistory.has(court)) penalty += 2;
      if (awayHistory.has(court)) penalty += 2;
      if (homeLastCourt === court) penalty += 1;
      if (awayLastCourt === court) penalty += 1;

      const candidate = {
        court,
        start,
        penalty,
        usage: courtUsageCounts.get(court) || 0,
        courtIdx,
      };

      if (
        !best ||
        candidate.penalty < best.penalty ||
        (candidate.penalty === best.penalty && candidate.start < best.start) ||
        (candidate.penalty === best.penalty && candidate.start === best.start && candidate.usage < best.usage) ||
        (candidate.penalty === best.penalty && candidate.start === best.start && candidate.usage === best.usage && candidate.courtIdx < best.courtIdx)
      ) {
        best = candidate;
      }
    });

    const chosenCourt = best?.court || usableCourts[0];
    const chosenStart = best?.start || baseTs;
    const end = chosenStart + matchDurationMs;

    teamNext.set(pair.home, end);
    teamNext.set(pair.away, end);
    courtNext.set(chosenCourt, end);
    courtUsageCounts.set(chosenCourt, (courtUsageCounts.get(chosenCourt) || 0) + 1);

    if (!teamCourtHistory.has(pair.home)) teamCourtHistory.set(pair.home, new Set());
    if (!teamCourtHistory.has(pair.away)) teamCourtHistory.set(pair.away, new Set());
    teamCourtHistory.get(pair.home).add(chosenCourt);
    teamCourtHistory.get(pair.away).add(chosenCourt);
    teamLastCourt.set(pair.home, chosenCourt);
    teamLastCourt.set(pair.away, chosenCourt);

    const dt = new Date(chosenStart);
    return ensureMatchMeta({
      matchId: makeMatchId(),
      matchNo: index + 1,
      home: pair.home,
      away: pair.away,
      homePlayers: [pair.home],
      awayPlayers: [pair.away],
      date: formatDateInputValue(dt),
      time: formatTimeInputValue(dt),
      court: chosenCourt,
      stage: "league",
      type: "team_tie",
      roundLabel: `League Match ${index + 1}`,
      submatches: [],
      lineupApproval: { home: "pending", away: "pending" },
      lineupLocked: false,
    });
  });
}

function buildRoundRobinRounds(entrants) {
  const list = [...entrants];
  if (list.length < 2) return [];
  const hasBye = list.length % 2 === 1;
  if (hasBye) list.push("BYE");

  const n = list.length;
  let rotation = list.slice();
  const rounds = [];

  for (let roundIndex = 0; roundIndex < n - 1; roundIndex += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const home = rotation[i];
      const away = rotation[n - 1 - i];
      if (home !== "BYE" && away !== "BYE") {
        pairs.push(ensureMatchMeta({
          matchId: makeMatchId(),
          home,
          away,
          stage: "league",
          roundLabel: `League Round ${roundIndex + 1}`,
        }));
      }
    }
    rounds.push(pairs);
    rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
  }

  return rounds;
}

function getConfirmedTeams(tournament) {
  return rebuildTeamsFromRequestsAndCaptains(tournament).filter((team) => normalizeText(team.teamStatus) !== "rejected");
}

function getAcceptedPlayersForCategory(tournament, categoryId) {
  return getPlayers(tournament)
    .filter((p) => normalizeText(p?.status || "accepted") === "accepted")
    .filter((p) => String(p?.categoryId || "") === String(categoryId))
    .map((p) => String(p?.playerName || p?.name || p?.username || "").trim())
    .filter(Boolean);
}

function buildLeagueFixturesForCategory(tournament, categoryId, existingFixtures) {
  const fixtures = normalizeFixtures(existingFixtures || tournament?.fixtures || { categories: {} });
  const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  const isTeam = isTeamTournament(tournament);

  if (!resolvedCategoryId) {
    return { fixtures, teams: [], categoryId: null };
  }

  if (isTeam) {
    const teams = getConfirmedTeams(tournament);
    const requestedRounds = getLeagueRoundsRequested(tournament) || Math.max(1, teams.length - 1);
    const { pairs, matchesPerTeam } = buildBalancedLeaguePairs(teams.map((t) => t.teamName), requestedRounds);
    const scheduled = scheduleLeaguePairs(pairs, getAvailableCourtNames(tournament), parseTournamentStartDate(tournament));

    fixtures.tournamentType = "team";
    fixtures.teamCategories = normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
    fixtures.categories[resolvedCategoryId] = {
      categoryId: resolvedCategoryId,
      label: `League schedule • ${matchesPerTeam} matches per team`,
      displayMode: "team_schedule",
      rounds: [scheduled],
      matches: scheduled,
      totalRounds: 1,
      teams: teams.map((t) => ({ teamName: t.teamName, captainName: t.captainName })),
    };

    return { fixtures, teams, categoryId: resolvedCategoryId };
  }

  const cat = getCategoryMeta(tournament, resolvedCategoryId);
  const entrants = getAcceptedPlayersForCategory(tournament, resolvedCategoryId);
  const teamSize = toFiniteNumber(cat?.teamSize, 1) || 1;
  const built = buildEntrants(entrants, teamSize);
  const rounds = buildRoundRobinRounds(built.entrants);

  fixtures.categories[resolvedCategoryId] = {
    categoryId: resolvedCategoryId,
    label: cat?.eventName || cat?.categoryId || "Category",
    rounds,
    totalRounds: rounds.length,
    displayMode: "league_rounds",
  };

  return { fixtures, teams: built.entrants, categoryId: resolvedCategoryId };
}

function findCategoryBucket(fixtures, categoryId) {
  const categories = fixtures?.categories || {};
  if (categories[categoryId]) return categories[categoryId];
  return Object.values(categories)[0] || null;
}

function findMatch(fixtures, categoryId, roundIndex, matchIndex) {
  const bucket = findCategoryBucket(fixtures, categoryId);
  if (!bucket) return null;
  const r = Number(roundIndex || 0);
  const m = Number(matchIndex || 0);
  if (Array.isArray(bucket.rounds?.[r]) && bucket.rounds[r][m]) return bucket.rounds[r][m];
  if (Array.isArray(bucket.matches) && bucket.matches[m]) return bucket.matches[m];
  return null;
}

function getSchemaScoreField(schema) {
  return String(schema?.winnerLogic?.field || "points").trim() || "points";
}

function getSideAggregate(state, field) {
  if (!state || typeof state !== "object") return 0;
  if (state[field] != null) return Number(state[field] || 0);
  if (field === "points" && state.score != null) return Number(state.score || 0);
  if (field === "score" && state.points != null) return Number(state.points || 0);
  if (field === "goals" && state.score != null) return Number(state.score || 0);
  if (field === "runs" && state.score != null) return Number(state.score || 0);
  return 0;
}

function computeWinnerFromSchema(schema, scorePayload, homeLabel, awayLabel) {
  const logic = schema?.winnerLogic || {};
  const stateA = scorePayload?.state?.A || {};
  const stateB = scorePayload?.state?.B || {};
  const config = scorePayload?.config || {};
  const field = getSchemaScoreField(schema);
  const a = getSideAggregate(stateA, field);
  const b = getSideAggregate(stateB, field);

  if (logic.type === "higherScoreWins") {
    if (a > b) return { status: "completed", winnerSide: "A", winnerName: homeLabel, reason: `${a} > ${b}`, aValue: a, bValue: b };
    if (b > a) return { status: "completed", winnerSide: "B", winnerName: awayLabel, reason: `${b} > ${a}`, aValue: a, bValue: b };
    return { status: "pending", winnerSide: null, winnerName: null, reason: "Equal scores", aValue: a, bValue: b };
  }

  if (logic.type === "firstToTarget") {
    const targetKey = logic.targetFrom || "targetPoints";
    const winByTwoKey = logic.winByTwoFrom || "winByTwo";
    const target = Number(config[targetKey] || 0);
    const winByTwo = Boolean(config[winByTwoKey]);
    if (!target) return { status: "pending", winnerSide: null, winnerName: null, reason: "Target not set", aValue: a, bValue: b };
    if (a >= target && (!winByTwo || a - b >= 2)) {
      return { status: "completed", winnerSide: "A", winnerName: homeLabel, reason: `Reached ${a}/${target}`, aValue: a, bValue: b };
    }
    if (b >= target && (!winByTwo || b - a >= 2)) {
      return { status: "completed", winnerSide: "B", winnerName: awayLabel, reason: `Reached ${b}/${target}`, aValue: a, bValue: b };
    }
    return { status: "pending", winnerSide: null, winnerName: null, reason: "Ongoing", aValue: a, bValue: b };
  }

  return { status: "pending", winnerSide: null, winnerName: null, reason: "Unknown logic", aValue: a, bValue: b };
}

function scoreIndividualMatch(match, schema, scorePayload) {
  const payload = cloneJson(scorePayload || {});
  const computed = payload?.computed && typeof payload.computed === "object"
    ? {
        ...payload.computed,
        ...computeWinnerFromSchema(schema, payload, match?.home || "Home", match?.away || "Away"),
      }
    : computeWinnerFromSchema(schema, payload, match?.home || "Home", match?.away || "Away");

  return {
    config: payload?.config || {},
    state: payload?.state || {},
    timer: payload?.timer || {},
    cricket: payload?.cricket || null,
    football: payload?.football || null,
    basketball: payload?.basketball || null,
    badminton: payload?.badminton || null,
    pickleball: payload?.pickleball || null,
    computed,
    updatedAt: nowIso(),
  };
}

function summarizeTieMatch(match) {
  const submatches = asArray(match?.submatches);
  let homeWins = 0;
  let awayWins = 0;
  let homeMatchPoints = 0;
  let awayMatchPoints = 0;
  let completedCount = 0;

  submatches.forEach((sub) => {
    const computed = sub?.score?.computed || {};
    const homeLabel = String(match?.home || "");
    const awayLabel = String(match?.away || "");
    const aValue = Number(computed?.aValue ?? sub?.score?.state?.A?.points ?? sub?.score?.state?.A?.score ?? sub?.score?.state?.A?.goals ?? sub?.score?.state?.A?.runs ?? 0);
    const bValue = Number(computed?.bValue ?? sub?.score?.state?.B?.points ?? sub?.score?.state?.B?.score ?? sub?.score?.state?.B?.goals ?? sub?.score?.state?.B?.runs ?? 0);

    homeMatchPoints += Number.isFinite(aValue) ? aValue : 0;
    awayMatchPoints += Number.isFinite(bValue) ? bValue : 0;

    if (computed?.status === "completed") completedCount += 1;
    if (computed?.winnerSide === "A" || computed?.winnerName === homeLabel) homeWins += 1;
    else if (computed?.winnerSide === "B" || computed?.winnerName === awayLabel) awayWins += 1;
  });

  match.homeWins = homeWins;
  match.awayWins = awayWins;
  match.matchPointsHome = homeMatchPoints;
  match.matchPointsAway = awayMatchPoints;

  if (homeWins > awayWins) {
    match.winner = match.home;
    match.winnerSide = "A";
    match.status = "completed";
  } else if (awayWins > homeWins) {
    match.winner = match.away;
    match.winnerSide = "B";
    match.status = "completed";
  } else if (completedCount === submatches.length && submatches.length > 0) {
    match.winner = null;
    match.winnerSide = null;
    match.status = "completed";
  } else {
    match.winner = null;
    match.winnerSide = null;
    match.status = "pending";
  }

  match.summary = {
    homeWins,
    awayWins,
    homeMatchPoints,
    awayMatchPoints,
    completedCount,
    totalSubmatches: submatches.length,
    updatedAt: nowIso(),
  };

  return match;
}

function propagateKnockoutWinner(fixtures, categoryId, roundIndex, matchIndex, match) {
  const bucket = findCategoryBucket(fixtures, categoryId);
  if (!bucket?.rounds?.[roundIndex]) return;
  const nextRoundIndex = Number(roundIndex) + 1;
  if (!bucket.rounds[nextRoundIndex]) return;

  const winnerName = match?.winner;
  if (!winnerName) return;

  const nextMatchIndex = Math.floor(Number(matchIndex) / 2);
  const slot = Number(matchIndex) % 2 === 0 ? "home" : "away";
  const nextMatch = bucket.rounds[nextRoundIndex]?.[nextMatchIndex];
  if (!nextMatch) return;

  nextMatch[slot] = winnerName;
  nextMatch[slot === "home" ? "homePlayers" : "awayPlayers"] = splitTeamName(winnerName);
  delete nextMatch.score;
  delete nextMatch.summary;
  nextMatch.status = "pending";
  nextMatch.winner = null;
}

function getMatchScoreNumbers(match) {
  if (!match) return { homePoints: 0, awayPoints: 0 };
  if (Number.isFinite(Number(match?.matchPointsHome)) || Number.isFinite(Number(match?.matchPointsAway))) {
    return {
      homePoints: Number(match?.matchPointsHome || 0),
      awayPoints: Number(match?.matchPointsAway || 0),
    };
  }
  const comp = match?.score?.computed || {};
  if (Number.isFinite(Number(comp?.aValue)) || Number.isFinite(Number(comp?.bValue))) {
    return {
      homePoints: Number(comp?.aValue || 0),
      awayPoints: Number(comp?.bValue || 0),
    };
  }
  return { homePoints: 0, awayPoints: 0 };
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
  const fixtures = normalizeFixtures(fixturesOverride || tournament?.fixtures || { categories: {} });
  const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
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

function appendKnockoutRoundsIfNeeded(tournament, categoryId, fixturesOverride) {
  const fixtures = normalizeFixtures(fixturesOverride || tournament?.fixtures || { categories: {} });
  const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  const bucket = findCategoryBucket(fixtures, resolvedCategoryId);
  if (!bucket) return { changed: false, fixtures };

  const format = normalizeText(tournament?.stageFormat);
  const needsKnockout = ["group_knockout", "round_robin_knockout"].includes(format) || isPickleballTeamLeague(tournament);
  if (!needsKnockout) return { changed: false, fixtures };

  const existingKnockout = asArray(bucket.rounds).flat().some((m) => normalizeText(m?.stage) === "knockout");
  if (existingKnockout) return { changed: false, fixtures };

  const rows = computeLeaderboardRows(tournament, resolvedCategoryId, fixtures);
  const qualified = rows.filter((r) => r.qualified);
  if (qualified.length < 2) return { changed: false, fixtures };

  let entrants = [];
  if (qualified.length >= 4) {
    entrants = [qualified[0]?.teamName, qualified[3]?.teamName, qualified[1]?.teamName, qualified[2]?.teamName].filter(Boolean);
  } else {
    entrants = qualified.slice(0, 2).map((r) => r.teamName).filter(Boolean);
  }

  const bracket = createBracket(entrants, Object.fromEntries(entrants.map((e) => [e, [e]])), { stage: "knockout", type: isTeamTournament(tournament) ? "team_tie" : "match" });
  if (!bracket) return { changed: false, fixtures };

  bracket.rounds.forEach((round, idx) => {
    round.forEach((match) => {
      match.stage = "knockout";
      match.roundLabel = getRoundLabel(idx, bracket.totalRounds);
      if (isTeamTournament(tournament)) {
        match.type = "team_tie";
        match.lineupApproval = { home: "pending", away: "pending" };
        match.lineupLocked = false;
        match.submatches = asArray(match.submatches);
      }
    });
  });

  bucket.rounds = [...asArray(bucket.rounds), ...bracket.rounds];
  bucket.totalRounds = asArray(bucket.rounds).length;
  return { changed: true, fixtures };
}

function defaultSchemaForSport(sportName = "") {
  const sport = String(sportName || "").toLowerCase();

  if (sport.includes("pickleball") || sport.includes("badminton") || sport.includes("table tennis") || sport.includes("volleyball")) {
    return {
      sport: sportName,
      version: "1.0",
      schemaId: `SCHEMA-${Date.now().toString(36)}`,
      inputs: [
        { key: "targetPoints", label: "Target points", type: "number", default: 11, min: 1, max: null, help: "Points required to win the match." },
        { key: "winByTwo", label: "Win by two", type: "boolean", default: true, min: null, max: null, help: "Require lead of two points to win." },
      ],
      playerFields: [
        { key: "points", label: "Points", type: "counter", default: 0, min: 0, max: null, help: "Main live score field.", group: "core", level: "basic", order: 1, options: null },
        { key: "aces", label: "Aces", type: "counter", default: 0, min: 0, max: null, help: "Direct winning serves.", group: "attack", level: "intermediate", order: 2, options: null },
      ],
      winnerLogic: { type: "firstToTarget", field: "points", targetFrom: "targetPoints", winByTwoFrom: "winByTwo" },
    };
  }

  if (sport.includes("football") || sport.includes("soccer")) {
    return {
      sport: sportName,
      version: "1.0",
      schemaId: `SCHEMA-${Date.now().toString(36)}`,
      inputs: [],
      playerFields: [
        { key: "goals", label: "Goals", type: "counter", default: 0, min: 0, max: null, help: "Goals scored.", group: "core", level: "basic", order: 1, options: null },
        { key: "assists", label: "Assists", type: "counter", default: 0, min: 0, max: null, help: "Goal assists.", group: "attack", level: "intermediate", order: 2, options: null },
        { key: "yellowCards", label: "Yellow cards", type: "counter", default: 0, min: 0, max: null, help: "Yellow cards received.", group: "discipline", level: "intermediate", order: 3, options: null },
        { key: "redCards", label: "Red cards", type: "counter", default: 0, min: 0, max: null, help: "Red cards received.", group: "discipline", level: "advanced", order: 4, options: null },
      ],
      winnerLogic: { type: "higherScoreWins", field: "goals", targetFrom: null, winByTwoFrom: null },
    };
  }

  if (sport.includes("cricket")) {
    return {
      sport: sportName,
      version: "1.0",
      schemaId: `SCHEMA-${Date.now().toString(36)}`,
      inputs: [],
      playerFields: [
        { key: "runs", label: "Runs", type: "counter", default: 0, min: 0, max: null, help: "Runs scored.", group: "core", level: "basic", order: 1, options: null },
        { key: "wickets", label: "Wickets", type: "counter", default: 0, min: 0, max: null, help: "Wickets taken.", group: "core", level: "basic", order: 2, options: null },
        { key: "boundaries", label: "Boundaries", type: "counter", default: 0, min: 0, max: null, help: "4s and 6s combined.", group: "attack", level: "intermediate", order: 3, options: null },
      ],
      winnerLogic: { type: "higherScoreWins", field: "runs", targetFrom: null, winByTwoFrom: null },
    };
  }

  return {
    sport: sportName,
    version: "1.0",
    schemaId: `SCHEMA-${Date.now().toString(36)}`,
    inputs: [],
    playerFields: [
      { key: "score", label: "Score", type: "counter", default: 0, min: 0, max: null, help: "Main match score.", group: "core", level: "basic", order: 1, options: null },
    ],
    winnerLogic: { type: "higherScoreWins", field: "score", targetFrom: null, winByTwoFrom: null },
  };
}

function normalizeFieldDefinition(field) {
  return {
    key: String(field?.key || "").trim(),
    label: String(field?.label || field?.key || "Field").trim(),
    type: String(field?.type || "counter").trim(),
    default: field?.default ?? 0,
    min: field?.min ?? 0,
    max: field?.max ?? null,
    help: field?.help ?? null,
    group: String(field?.group || "custom").trim(),
    level: String(field?.level || "pro").trim(),
    order: Number.isFinite(Number(field?.order)) ? Number(field.order) : 999,
    options: Array.isArray(field?.options) ? field.options : null,
  };
}

function normalizeSchema(schema, tournament) {
  const base = defaultSchemaForSport(tournament?.sportName || tournament?.sport || "");
  const src = schema && typeof schema === "object" ? schema : base;
  const fields = asArray(src.playerFields).map(normalizeFieldDefinition).filter((f) => f.key);
  return {
    sport: String(src.sport || tournament?.sportName || tournament?.sport || base.sport || ""),
    version: String(src.version || "1.0"),
    schemaId: String(src.schemaId || `SCHEMA-${Date.now().toString(36)}`),
    inputs: asArray(src.inputs).map((x) => ({
      key: String(x?.key || "").trim(),
      label: String(x?.label || x?.key || "Input").trim(),
      type: String(x?.type || "number").trim(),
      default: x?.default ?? null,
      min: x?.min ?? null,
      max: x?.max ?? null,
      help: x?.help ?? null,
    })).filter((x) => x.key),
    playerFields: fields.length ? fields : base.playerFields,
    winnerLogic: src.winnerLogic || base.winnerLogic,
    updatedAt: nowIso(),
  };
}

async function buildSuggestedSchema(tournament, requestBody = {}) {
  const sportName = String(tournament?.sportName || tournament?.sport || "").trim();
  const fallback = defaultSchemaForSport(sportName);

  if (!process.env.OPENAI_API_KEY || !OpenAI) {
    return { draft: fallback, meta: { provider: "fallback", generatedAt: nowIso() } };
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const categoryLabel = requestBody?.categoryLabel || "";
    const contextStr = JSON.stringify({
      sportName,
      categoryLabel,
      tournamentType: tournament?.tournamentType || "",
      advancedSettings: tournament?.advancedSettings || null,
      context: requestBody?.context || null,
    });

    const prompt = [
      "Generate a strict JSON scoring schema for a sports tournament app.",
      `Context: ${contextStr}`,
      "Return fields: sport, version, inputs, playerFields, winnerLogic.",
      "Use professional but compact fields. Prefer counter fields.",
      "For racket sports use firstToTarget on points. For football/cricket use higherScoreWins.",
    ].join(" ");

    const response = await client.responses.create({
      model: process.env.OPENAI_SCHEMA_MODEL || "gpt-4.1-mini",
      input: prompt,
      text: { format: { type: "json_object" } },
    });

    let parsed = null;
    if (response?.output_text) {
      parsed = JSON.parse(response.output_text);
    } else {
      const candidate = response?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text;
      if (candidate) parsed = JSON.parse(candidate);
    }

    return { draft: normalizeSchema(parsed || fallback, tournament), meta: { provider: "openai", generatedAt: nowIso() } };
  } catch (err) {
    console.warn("Schema suggestion fallback used:", err?.message || err);
    return { draft: fallback, meta: { provider: "fallback_after_error", generatedAt: nowIso(), error: err?.message || String(err) } };
  }
}

async function updateTournamentFields(tournamentId, fields) {
  return updateTournamentAggregateFields(tournamentId, fields);
}

function mapRowsByMatchKey(rows) {
  const map = new Map();
  asArray(rows).forEach((row) => {
    const key = String(row?.matchKey || "").trim();
    if (key) map.set(key, row);
  });
  return map;
}

function rowsEqual(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function getPosterSettingsDefaults(tournament = {}) {
  return {
    organizerName: "",
    sponsorNames: [],
    venueLabel: String(tournament?.venue || "").trim(),
    cityName: "",
    tagline: "",
    socialHandle: "",
    customFields: [],
    visibility: {
      organizerName: true,
      sponsorNames: true,
      venueLabel: false,
      cityName: false,
      tagline: false,
      socialHandle: false,
    },
    updatedAt: null,
    updatedBy: "",
  };
}

function normalizePosterSettings(input, tournament = {}) {
  const defaults = getPosterSettingsDefaults(tournament);
  const raw = input && typeof input === "object" ? cloneJson(input) : {};
  const visibility = raw?.visibility && typeof raw.visibility === "object" ? raw.visibility : {};

  const sponsorNames = Array.isArray(raw?.sponsorNames)
    ? raw.sponsorNames
    : String(raw?.sponsorNames || "")
        .split(/\r?\n|,/)
        .map((value) => String(value || "").trim())
        .filter(Boolean);

  const customFields = asArray(raw?.customFields)
    .map((field) => ({
      label: String(field?.label || "").trim().slice(0, 40),
      value: String(field?.value || "").trim().slice(0, 120),
      position: String(field?.position || "bottom").trim().toLowerCase() === "top" ? "top" : "bottom",
      enabled: field?.enabled !== false,
    }))
    .filter((field) => field.label && field.value)
    .slice(0, 4);

  return {
    organizerName: String(raw?.organizerName || defaults.organizerName).trim().slice(0, 120),
    sponsorNames: uniqStrings(sponsorNames).slice(0, 12),
    venueLabel: String(raw?.venueLabel || defaults.venueLabel).trim().slice(0, 120),
    cityName: String(raw?.cityName || defaults.cityName).trim().slice(0, 80),
    tagline: String(raw?.tagline || defaults.tagline).trim().slice(0, 180),
    socialHandle: String(raw?.socialHandle || defaults.socialHandle).trim().slice(0, 80),
    customFields,
    visibility: {
      organizerName: Boolean(visibility.organizerName ?? defaults.visibility.organizerName),
      sponsorNames: Boolean(visibility.sponsorNames ?? defaults.visibility.sponsorNames),
      venueLabel: Boolean(visibility.venueLabel ?? defaults.visibility.venueLabel),
      cityName: Boolean(visibility.cityName ?? defaults.visibility.cityName),
      tagline: Boolean(visibility.tagline ?? defaults.visibility.tagline),
      socialHandle: Boolean(visibility.socialHandle ?? defaults.visibility.socialHandle),
    },
    updatedAt: raw?.updatedAt || defaults.updatedAt,
    updatedBy: String(raw?.updatedBy || defaults.updatedBy || "").trim(),
  };
}

async function persistScoredFixtures(tournament, fixtures, fields = {}) {
  if (!USE_SPLIT_TABLES) {
    return updateTournamentFields(tournament.tournamentId, {
      ...fields,
      fixtures,
    });
  }

  const currentRows = extractMatchRowsFromFixtures(tournament.tournamentId, tournament.fixtures || { categories: {} }, {
    createdAt: tournament.createdAt || nowIso(),
    updatedAt: tournament.updatedAt || nowIso(),
  });

  const nextRows = extractMatchRowsFromFixtures(tournament.tournamentId, fixtures || { categories: {} }, {
    createdAt: tournament.createdAt || nowIso(),
    updatedAt: nowIso(),
  });

  const currentByKey = mapRowsByMatchKey(currentRows);
  const nextByKey = mapRowsByMatchKey(nextRows);

  const rowsToPut = [];
  const rowsToDelete = [];

  nextByKey.forEach((row, key) => {
    if (!rowsEqual(currentByKey.get(key), row)) rowsToPut.push(row);
  });

  currentByKey.forEach((row, key) => {
    if (!nextByKey.has(key)) rowsToDelete.push(row);
  });

  if (rowsToDelete.length) {
    await deleteTournamentMatchRowsConditionally(rowsToDelete, currentByKey);
  }
  if (rowsToPut.length) {
    await putTournamentMatchRowsConditionally(rowsToPut, currentByKey);
  }

  const metaFields = cloneJson(fields || {});
  const metaUpdated = await updateTournamentMetaFields(tournament.tournamentId, metaFields);
  if (!metaUpdated) {
    return updateTournamentFields(tournament.tournamentId, {
      ...metaFields,
      fixtures,
    });
  }

  return {
    ...cloneJson(tournament),
    ...cloneJson(metaFields),
    fixtures: normalizeFixtures(fixtures || { categories: {} }),
    updatedAt: nowIso(),
  };
}

function getLineupsForResponse(tournament, req, categoryId) {
  const state = getLineupsState(tournament);
  const ownerView = isOwner(req, tournament);

  let ties = state.ties;
  if (categoryId) {
    ties = ties.filter((tie) => String(tie?.categoryId || "") === String(categoryId));
  }

  if (ownerView) return { ties };

  const meU = normalizeText(req.user?.username);
  const meN = normalizeText(req.user?.name);
  ties = ties.filter((tie) => {
    const sameCaptain = normalizeText(tie?.captainUsername) === meU || normalizeText(tie?.captainName) === meN;
    if (sameCaptain) return true;
    return asArray(tie?.teamPlayers || tie?.roster || []).some((p) => {
      const pname = normalizeText(p?.playerName || p?.name || "");
      const pun = normalizeText(p?.username || "");
      return pname === meN || pun === meU;
    });
  });

  return { ties };
}

// -----------------------------------------------------------------------------
// TOURNAMENT CRUD
// -----------------------------------------------------------------------------
router.post("/tournaments", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const tournamentName = String(body.tournamentName || "").trim();
    const sportName = String(body.sportName || "").trim();
    const accessCode = String(body.accessCode || "").trim();
    const hostUsername = String(getAuthUsername(req) || "").trim();

    if (!tournamentName || !sportName || !accessCode) {
      return res.status(400).json({ message: "tournamentName, sportName and accessCode are required" });
    }
    if (!hostUsername) return res.status(401).json({ message: "Invalid auth payload (no username)" });

    const categories = normalizeCategories(body.categories).map(normalizeCategoryItem);
    const createdAt = nowIso();
    const tournamentId = uuid();

    const item = {
      tournamentId,
      PK: `TOURNAMENT#${tournamentId}`,
      SK: "META",
      hostUsername,
      hostDisplayName: getAuthDisplayName(req),
      tournamentName,
      sportName,
      tournamentDates: String(body.tournamentDates || "").trim(),
      venue: String(body.venue || "").trim(),
      playerDetails: String(body.playerDetails || "").trim(),
      accessCode,
      isPublic: Boolean(body.isPublic),
      registrationsOpen: body.registrationsOpen !== false,
      tournamentType: String(body.tournamentType || "single").trim() || "single",
      stageFormat: String(body.stageFormat || "").trim(),
      groupCount: body.stageFormat === "group_knockout" ? toFiniteNumber(body.groupCount, null) : null,
      advancedSettings: {
        advancedMode: getAdvancedSettings(body).advancedMode || body?.advancedSettings?.advancedMode || null,
        roundRobinMatches: toFiniteNumber(body?.advancedSettings?.roundRobinMatches, null),
        qualifierCount: toFiniteNumber(body?.advancedSettings?.qualifierCount, null),
        tieSubmatchCount: toFiniteNumber(body?.advancedSettings?.tieSubmatchCount, null),
        lineupLockRule: body?.advancedSettings?.lineupLockRule || null,
        participationRule: body?.advancedSettings?.participationRule || null,
        tiebreakRule: body?.advancedSettings?.tiebreakRule || null,
        semifinalPairing: body?.advancedSettings?.semifinalPairing || null,
      },
      categories,
      tournamentRules: {
        maxMatchesPerPlayer: toFiniteNumber(body?.tournamentRules?.maxMatchesPerPlayer, null),
        bestOfSets: toFiniteNumber(body?.tournamentRules?.bestOfSets, null),
        pointsPerSet: toFiniteNumber(body?.tournamentRules?.pointsPerSet, null),
        minPlayersPerTeam: toFiniteNumber(body?.tournamentRules?.minPlayersPerTeam, null),
        maxPlayersPerTeam: toFiniteNumber(body?.tournamentRules?.maxPlayersPerTeam, null),
      },
      leaguePoints: body.leaguePoints ? {
        win: toFiniteNumber(body?.leaguePoints?.win, null),
        loss: toFiniteNumber(body?.leaguePoints?.loss, null),
        draw: toFiniteNumber(body?.leaguePoints?.draw, null),
      } : null,
      courtCount: Math.max(1, toFiniteNumber(body.courtCount, 1) || 1),
      courtNames: uniqStrings(body.courtNames || []),
      requirePayment: Boolean(body.requirePayment),
      entryFee: Boolean(body.requirePayment) ? toFiniteNumber(body.entryFee ?? body.amount, 0) || 0 : 0,
      players: [],
      umpires: [],
      captains: { selectedCaptainIds: [], confirmedCaptains: [], updatedAt: null },
      pools: null,
      teamRequests: [],
      teams: [],
      teamNumbers: { assignments: [], locked: false, updatedAt: null },
      teamNumberState: { assignments: [], locked: false, updatedAt: null },
      lineups: { ties: [] },
      fixtures: { tournamentType: isTeamTournament(body) ? "team" : "individual", categories: {} },
      leaderboardSnapshotByCategory: {},
      scoringSchemaDraft: null,
      scoringSchemaDraftMeta: null,
      scoringSchemaActiveByCategory: {},
      createdAt,
      updatedAt: createdAt,
      createdBy: hostUsername,
      hostFormSnapshot: cloneJson(body),
      lastSavedPayload: cloneJson(body),
    };

    await saveTournamentAggregate(item);
    return res.json({ ok: true, tournamentId, tournament: item });
  } catch (err) {
    console.error("Create tournament error:", err);
    return res.status(500).json({ message: "Failed to create tournament" });
  }
});

router.get("/tournaments", requireAuth, async (req, res) => {
  try {
    const items = await listTournamentAggregates();
    const mine = asArray(items).filter((t) => isOwner(req, t));
    return res.json(mine);
  } catch (err) {
    console.error("Fetch host tournaments error:", err);
    return res.status(500).json({ message: "Failed to load tournaments" });
  }
});

router.get("/tournaments/:tournamentId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!(await assertOwnerOrUmpire(req, tournament, res))) return;
    return res.json(tournament);
  } catch (err) {
    console.error("Get tournament error:", err);
    return res.status(500).json({ message: "Failed to load tournament" });
  }
});

router.get("/tournaments/:tournamentId/poster-settings", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    return res.json({
      ok: true,
      settings: normalizePosterSettings(tournament?.sharePosterConfig || null, tournament),
    });
  } catch (err) {
    console.error("Get poster settings error:", err);
    return res.status(500).json({ message: "Failed to load poster settings" });
  }
});

router.put("/tournaments/:tournamentId/poster-settings", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const sharePosterConfig = {
      ...normalizePosterSettings(req.body || {}, tournament),
      updatedAt: nowIso(),
      updatedBy: getAuthUsername(req),
    };

    const updated = await updateTournamentMetaFields(req.params.tournamentId, {
      sharePosterConfig,
      updatedBy: getAuthUsername(req),
    });

    return res.json({
      ok: true,
      settings: normalizePosterSettings(updated?.sharePosterConfig || sharePosterConfig, tournament),
    });
  } catch (err) {
    console.error("Update poster settings error:", err);
    return res.status(500).json({ message: "Failed to save poster settings" });
  }
});

router.put("/tournaments/:tournamentId", requireAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const existing = await getTournament(tournamentId);
    if (!assertOwner(req, existing, res)) return;

    const body = req.body || {};
    const next = {
      ...existing,
      tournamentName: body.tournamentName ?? existing.tournamentName,
      sportName: body.sportName ?? existing.sportName,
      tournamentDates: body.tournamentDates ?? existing.tournamentDates,
      venue: body.venue ?? existing.venue,
      playerDetails: body.playerDetails ?? existing.playerDetails,
      accessCode: body.accessCode != null ? String(body.accessCode).trim() : existing.accessCode,
      isPublic: body.isPublic != null ? Boolean(body.isPublic) : existing.isPublic,
      registrationsOpen: body.registrationsOpen != null ? Boolean(body.registrationsOpen) : existing.registrationsOpen,
      tournamentType: body.tournamentType ?? existing.tournamentType,
      stageFormat: body.stageFormat ?? existing.stageFormat,
      groupCount: body.groupCount !== undefined ? toFiniteNumber(body.groupCount, null) : existing.groupCount,
      advancedSettings: body.advancedSettings ? {
        advancedMode: body?.advancedSettings?.advancedMode || null,
        roundRobinMatches: toFiniteNumber(body?.advancedSettings?.roundRobinMatches, null),
        qualifierCount: toFiniteNumber(body?.advancedSettings?.qualifierCount, null),
        tieSubmatchCount: toFiniteNumber(body?.advancedSettings?.tieSubmatchCount, null),
        lineupLockRule: body?.advancedSettings?.lineupLockRule || null,
        participationRule: body?.advancedSettings?.participationRule || null,
        tiebreakRule: body?.advancedSettings?.tiebreakRule || null,
        semifinalPairing: body?.advancedSettings?.semifinalPairing || null,
      } : existing.advancedSettings,
      categories: body.categories ? normalizeCategories(body.categories).map(normalizeCategoryItem) : existing.categories,
      tournamentRules: body.tournamentRules ? {
        maxMatchesPerPlayer: toFiniteNumber(body?.tournamentRules?.maxMatchesPerPlayer, null),
        bestOfSets: toFiniteNumber(body?.tournamentRules?.bestOfSets, null),
        pointsPerSet: toFiniteNumber(body?.tournamentRules?.pointsPerSet, null),
        minPlayersPerTeam: toFiniteNumber(body?.tournamentRules?.minPlayersPerTeam, null),
        maxPlayersPerTeam: toFiniteNumber(body?.tournamentRules?.maxPlayersPerTeam, null),
      } : existing.tournamentRules,
      leaguePoints: body.leaguePoints === null
        ? null
        : body.leaguePoints
          ? {
              win: toFiniteNumber(body?.leaguePoints?.win, null),
              loss: toFiniteNumber(body?.leaguePoints?.loss, null),
              draw: toFiniteNumber(body?.leaguePoints?.draw, null),
            }
          : existing.leaguePoints,
      courtCount: body.courtCount != null ? Math.max(1, toFiniteNumber(body.courtCount, 1) || 1) : existing.courtCount,
      courtNames: body.courtNames ? uniqStrings(body.courtNames) : existing.courtNames,
      requirePayment: body.requirePayment != null ? Boolean(body.requirePayment) : existing.requirePayment,
      entryFee: body.entryFee != null || body.amount != null ? (toFiniteNumber(body.entryFee ?? body.amount, 0) || 0) : existing.entryFee,
      updatedAt: nowIso(),
      updatedBy: getAuthUsername(req),
      hostFormSnapshot: cloneJson(body),
      lastSavedPayload: cloneJson(body),
    };

    await saveTournamentAggregate(next);
    return res.json({ ok: true, tournament: next });
  } catch (err) {
    console.error("Update tournament error:", err);
    return res.status(500).json({ message: "Failed to update tournament" });
  }
});

router.patch("/tournaments/:tournamentId/registrations-open", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const registrationsOpen = Boolean(req.body?.registrationsOpen);
    const updated = await updateTournamentFields(req.params.tournamentId, { registrationsOpen, updatedBy: getAuthUsername(req) });
    return res.json({ ok: true, registrationsOpen: Boolean(updated?.registrationsOpen) });
  } catch (err) {
    console.error("Toggle registrations error:", err);
    return res.status(500).json({ message: "Failed to update registrations status" });
  }
});

router.delete("/tournaments/:tournamentId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const result = await deleteTournamentAggregate(req.params.tournamentId);
    await syncPendingPlayerLinksForTournament({ tournamentId: req.params.tournamentId }, []);
    return res.json({ ok: true, ...result, removedPendingLinks: true });
  } catch (err) {
    console.error("Delete tournament error:", err);
    return res.status(500).json({ message: "Failed to delete tournament" });
  }
});

// -----------------------------------------------------------------------------
// PLAYERS / REGISTRATIONS
// -----------------------------------------------------------------------------
function normalizeHostPlayerForCreate(tournament, payload = {}) {
  const teamEvent = isTeamTournament(tournament);
  const resolvedCategoryId = resolveCategoryId(tournament, payload.categoryId, { preferSyntheticForTeam: teamEvent });
  return {
    playerId: String(payload.playerId || `manual-${uuid()}`),
    userId: payload.userId != null ? String(payload.userId) : null,
    username: String(payload.username || "").trim(),
    playerName: String(payload.playerName || payload.name || "").trim(),
    age: payload.age !== undefined && payload.age !== null && payload.age !== "" ? Number(payload.age) : null,
    gender: String(payload.gender || "").trim(),
    phone: normalizePhone(payload.phone || payload.playerPhone || ""),    categoryId: teamEvent ? TEAM_EVENT_CATEGORY_ID : String(resolvedCategoryId || payload.categoryId || "").trim(),
    status: normalizeText(payload.status || "accepted") || "accepted",
    createdByHost: Boolean(payload.createdByHost || true),
    createdAt: payload.createdAt || nowIso(),
    teamEvent: teamEvent,
  };
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function getTournamentUmpires(tournament) {
  return asArray(tournament?.umpires).map((u) => ({ ...u }));
}

function normalizeHostUmpireForCreate(payload = {}) {
  return {
    umpireId: String(payload.umpireId || payload.officialId || `umpire-${uuid()}`).trim(),
    role: "umpire",
    userId: payload.userId != null ? String(payload.userId).trim() : null,
    username: String(payload.username || "").trim(),
    name: String(payload.name || payload.umpireName || payload.fullName || "").trim(),
    phone: normalizePhone(payload.phone || payload.phoneNumber || payload.mobile || ""),
    createdAt: payload.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

async function findUserDetailsMatchForHostAddedUmpire(payload = {}) {
  const wantedPhone = normalizePhone(payload.phone || payload.phoneNumber || payload.mobile || "");
  const wantedUsername = normalizeText(payload.username || "");
  const wantedEmail = normalizeText(payload.email || "");

  if (!wantedPhone && !wantedUsername && !wantedEmail) return null;

  try {
    const scan = await dynamo.scan({ TableName: USER_DETAILS_TABLE }).promise();
    return asArray(scan.Items).find((row) => {
      const rowPhone = normalizePhone(row?.phone || row?.phoneNumber || row?.mobile || "");
      const rowUsername = normalizeText(row?.username || "");
      const rowEmail = normalizeText(row?.email || "");

      if (wantedPhone && rowPhone && rowPhone === wantedPhone) return true;
      if (wantedUsername && rowUsername && rowUsername === wantedUsername) return true;
      if (wantedEmail && rowEmail && rowEmail === wantedEmail) return true;
      return false;
    }) || null;
  } catch (err) {
    console.warn("Could not resolve host-added umpire identity:", err?.message || err);
    return null;
  }
}

async function enrichHostAddedUmpireIdentity(umpire = {}, rawPayload = {}) {
  const matched = await findUserDetailsMatchForHostAddedUmpire({ ...rawPayload, ...umpire });

  return {
    ...umpire,
    userId: String(umpire?.userId || matched?.userId || matched?.id || "").trim() || null,
    username: String(umpire?.username || matched?.username || matched?.email || "").trim(),
    phone: normalizePhone(
      umpire?.phone ||
      matched?.phone ||
      matched?.phoneNumber ||
      matched?.mobile ||
      rawPayload?.phone ||
      rawPayload?.phoneNumber ||
      rawPayload?.mobile ||
      ""
    ),
    updatedAt: nowIso(),
  };
}

function hostUmpireMatches(existing = {}, incoming = {}) {
  const existingUserId = String(existing?.userId || "").trim();
  const incomingUserId = String(incoming?.userId || "").trim();

  const existingUsername = normalizeText(existing?.username || "");
  const incomingUsername = normalizeText(incoming?.username || "");

  const existingPhone = normalizePhone(existing?.phone || "");
  const incomingPhone = normalizePhone(incoming?.phone || "");

  const existingName = normalizeText(existing?.name || "");
  const incomingName = normalizeText(incoming?.name || "");

  if (existingUserId && incomingUserId && existingUserId === incomingUserId) return true;
  if (existingUsername && incomingUsername && existingUsername === incomingUsername) return true;
  if (existingPhone && incomingPhone && existingPhone === incomingPhone) return true;
  if (!existingPhone && !incomingPhone && existingName && incomingName && existingName === incomingName) return true;

  return false;
}

async function handleHostAddUmpire(req, res) {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const body = req.body || {};
    const requestedRole = normalizeText(body.role || "umpire");
    if (requestedRole && requestedRole !== "umpire") {
      return res.status(400).json({ message: "Only role=umpire is supported here" });
    }

    const rawName = String(body.name || body.umpireName || "").trim();
    const rawPhone = normalizePhone(body.phone || body.phoneNumber || body.mobile || "");

    if (!rawName || !rawPhone) {
      return res.status(400).json({ message: "name and phone are required" });
    }

    const baseUmpire = normalizeHostUmpireForCreate({
      ...body,
      name: rawName,
      phone: rawPhone,
    });

    const umpire = await enrichHostAddedUmpireIdentity(baseUmpire, body);

    const umpires = getTournamentUmpires(tournament);
    const existingIndex = umpires.findIndex((existing) => hostUmpireMatches(existing, umpire));

    let savedUmpire = umpire;

    if (existingIndex >= 0) {
      savedUmpire = {
        ...umpires[existingIndex],
        ...umpire,
        umpireId: umpires[existingIndex]?.umpireId || umpire.umpireId,
        role: "umpire",
        createdAt: umpires[existingIndex]?.createdAt || umpire.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      umpires[existingIndex] = savedUmpire;
    } else {
      umpires.push(savedUmpire);
    }

    tournament.umpires = umpires;
    tournament.updatedAt = nowIso();

    await saveTournamentAggregate(tournament);

    return res.json({
      ok: true,
      umpire: savedUmpire,
      umpires,
    });
  } catch (err) {
    console.error("Add umpire by host error:", err);
    return res.status(500).json({ message: "Failed to add umpire" });
  }
}

async function findUserDetailsMatchForHostAddedPlayer(payload = {}) {
  const wantedPhone = normalizePhone(payload.phone || payload.playerPhone || "");
  const wantedUsername = normalizeText(payload.username || "");
  const wantedEmail = normalizeText(payload.email || "");

  if (!wantedPhone && !wantedUsername && !wantedEmail) return null;

  try {
    const scan = await dynamo.scan({ TableName: USER_DETAILS_TABLE }).promise();
    return asArray(scan.Items).find((row) => {
      const rowPhone = normalizePhone(row?.phone || row?.phoneNumber || row?.mobile || "");
      const rowUsername = normalizeText(row?.username || "");
      const rowEmail = normalizeText(row?.email || "");

      if (wantedPhone && rowPhone && rowPhone === wantedPhone) return true;
      if (wantedUsername && rowUsername && rowUsername === wantedUsername) return true;
      if (wantedEmail && rowEmail && rowEmail === wantedEmail) return true;
      return false;
    }) || null;
  } catch (err) {
    console.warn("Could not resolve host-added player identity:", err?.message || err);
    return null;
  }
}

async function enrichHostAddedPlayerIdentity(player = {}, rawPayload = {}) {
  const matched = await findUserDetailsMatchForHostAddedPlayer({ ...rawPayload, ...player });

  return {
    ...player,
    userId: String(player?.userId || matched?.userId || matched?.id || "").trim() || null,
    username: String(player?.username || matched?.username || matched?.email || "").trim(),
    phone: normalizePhone(
      player?.phone ||
      matched?.phone ||
      matched?.phoneNumber ||
      matched?.mobile ||
      rawPayload?.phone ||
      rawPayload?.playerPhone ||
      ""
    ),
    source: String(player?.source || rawPayload?.source || "host_manual_add").trim(),
    registeredVia: String(player?.registeredVia || rawPayload?.registeredVia || "host").trim(),
    updatedAt: nowIso(),
  };
}

function hostPlayerMatches(existing = {}, incoming = {}, tournament) {
  const sameCategory = isTeamTournament(tournament)
    ? true
    : String(existing?.categoryId || "").trim() === String(incoming?.categoryId || "").trim();

  if (!sameCategory) return false;

  const existingUserId = String(existing?.userId || "").trim();
  const incomingUserId = String(incoming?.userId || "").trim();
  const existingUsername = normalizeText(existing?.username || "");
  const incomingUsername = normalizeText(incoming?.username || "");
  const existingPhone = normalizePhone(existing?.phone || "");
  const incomingPhone = normalizePhone(incoming?.phone || "");
  const existingName = normalizeText(existing?.playerName || existing?.name || "");
  const incomingName = normalizeText(incoming?.playerName || incoming?.name || "");

  if (existingUserId && incomingUserId && existingUserId === incomingUserId) return true;
  if (existingUsername && incomingUsername && existingUsername === incomingUsername) return true;
  if (existingPhone && incomingPhone && existingPhone === incomingPhone) return true;
  if (existingPhone && incomingPhone && existingPhone === incomingPhone && existingName && incomingName && existingName === incomingName) return true;

  return false;
}

async function savePlayers(tournamentId, players, extra = {}) {
  const updated = await updateTournamentFields(tournamentId, { players, ...extra });
  await syncPendingPlayerLinksForTournament(updated || { tournamentId }, players);
  return updated;
}

router.get("/tournaments/:tournamentId/players", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });
    return res.json(getPlayers(tournament));
  } catch (err) {
    console.error("Get players error:", err);
    return res.status(500).json({ message: "Failed to load players" });
  }
});

router.get("/tournaments/:tournamentId/registrations", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (!isOwner(req, tournament)) return res.status(403).json({ message: "Forbidden" });
    return res.json(getPlayers(tournament));
  } catch (err) {
    console.error("Get registrations error:", err);
    return res.status(500).json({ message: "Failed to load registrations" });
  }
});

async function handleHostAddPlayer(req, res) {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const player = await enrichHostAddedPlayerIdentity(
      normalizeHostPlayerForCreate(tournament, req.body || {}),
      req.body || {}
    );

    if (!player.playerName) {
      return res.status(400).json({ message: "playerName is required" });
    }
    if (!isTeamTournament(tournament) && !player.categoryId) {
      return res.status(400).json({ message: "categoryId is required for individual events" });
    }

    const players = getPlayers(tournament);
    const duplicateIndex = players.findIndex((existing) =>
      hostPlayerMatches(existing, player, tournament)
    );

    if (duplicateIndex >= 0) {
      const mergedPlayer = {
        ...players[duplicateIndex],
        ...player,
        status: "accepted",
        updatedAt: nowIso(),
      };

      players[duplicateIndex] = mergedPlayer;
      await savePlayers(req.params.tournamentId, players, { updatedBy: getAuthUsername(req) });
      return res.json({ ok: true, alreadyRegistered: true, player: mergedPlayer });
    }

    players.push(player);
    await savePlayers(req.params.tournamentId, players, { updatedBy: getAuthUsername(req) });
    return res.json({ ok: true, player });
  } catch (err) {
    console.error("Add player by host error:", err);
    return res.status(500).json({ message: "Failed to add player" });
  }
}

router.post("/tournaments/:tournamentId/players/bulk", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const incomingPlayers = Array.isArray(req.body?.players) ? req.body.players : [];
    if (!incomingPlayers.length) {
      return res.status(400).json({ message: "players array is required" });
    }

    const existingPlayers = getPlayers(tournament);
    const nextPlayers = [...existingPlayers];
    const saved = [];
    const failed = [];

    for (let i = 0; i < incomingPlayers.length; i += 1) {
      const raw = incomingPlayers[i] || {};
      const player = await enrichHostAddedPlayerIdentity(
        normalizeHostPlayerForCreate(tournament, raw),
        raw
      );

      if (!player.playerName) {
        failed.push({
          index: i,
          playerName: raw.playerName || "",
          message: "playerName is required",
        });
        continue;
      }

      if (!player.age || Number(player.age) <= 0) {
        failed.push({
          index: i,
          playerName: raw.playerName || "",
          message: "Valid age is required",
        });
        continue;
      }

      if (!player.gender) {
        failed.push({
          index: i,
          playerName: raw.playerName || "",
          message: "gender is required",
        });
        continue;
      }

      if (!player.phone) {
        failed.push({
          index: i,
          playerName: raw.playerName || "",
          message: "phone is required",
        });
        continue;
      }

      if (!isTeamTournament(tournament) && !player.categoryId) {
        failed.push({
          index: i,
          playerName: raw.playerName || "",
          message: "categoryId is required for individual events",
        });
        continue;
      }

      const duplicateIndex = nextPlayers.findIndex((existing) =>
        hostPlayerMatches(existing, player, tournament)
      );

      if (duplicateIndex >= 0) {
        const mergedPlayer = {
          ...nextPlayers[duplicateIndex],
          ...player,
          status: "accepted",
          updatedAt: nowIso(),
        };
        nextPlayers[duplicateIndex] = mergedPlayer;
        saved.push({ ...mergedPlayer, alreadyRegistered: true });
        continue;
      }

      nextPlayers.push(player);
      saved.push(player);
    }

    await savePlayers(req.params.tournamentId, nextPlayers, {
      updatedBy: getAuthUsername(req),
    });

    return res.json({
      ok: true,
      savedCount: saved.length,
      failedCount: failed.length,
      saved,
      failed,
    });
  } catch (err) {
    console.error("Bulk add players error:", err);
    return res.status(500).json({ message: "Failed to bulk add players" });
  }
});

router.post("/tournaments/:tournamentId/players", requireAuth, handleHostAddPlayer);
router.post("/tournaments/:tournamentId/players/add", requireAuth, handleHostAddPlayer);
router.post("/tournaments/:tournamentId/registrations", requireAuth, handleHostAddPlayer);

router.post("/tournaments/:tournamentId/umpires", requireAuth, handleHostAddUmpire);
router.post("/tournaments/:tournamentId/officials", requireAuth, handleHostAddUmpire);

router.get("/tournaments/:tournamentId/umpires", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    return res.json({
      ok: true,
      umpires: getTournamentUmpires(tournament),
    });
  } catch (err) {
    console.error("Get umpires error:", err);
    return res.status(500).json({ message: "Failed to load umpires" });
  }
});

async function handleHostUpdateRegistrationStatus(req, res) {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const nextStatus = normalizeText(req.body?.status || req.params.status || "");
    if (!["accepted", "rejected", "pending"].includes(nextStatus)) {
      return res.status(400).json({ message: "status must be accepted/rejected/pending" });
    }

    const targetId = String(req.params.playerId || "").trim();
    const fallbackName = normalizeText(req.body?.playerName);
    const fallbackPhone = String(req.body?.phone || "").trim();
    const fallbackUsername = normalizeText(req.body?.username);

    const players = getPlayers(tournament).map((p) => {
      const pid = String(p?.playerId || p?.registrationId || p?.id || p?._id || p?.userId || "").trim();
      const samePlayerId = targetId && (pid === targetId || String(p?.userId || "") === targetId);
      const sameFallback = !targetId && (
        (fallbackName && normalizeText(p?.playerName || p?.name) === fallbackName) ||
        (fallbackPhone && String(p?.phone || "").trim() === fallbackPhone) ||
        (fallbackUsername && normalizeText(p?.username) === fallbackUsername)
      );
      return samePlayerId || sameFallback ? { ...p, status: nextStatus, updatedAt: nowIso() } : p;
    });

    await savePlayers(req.params.tournamentId, players, { updatedBy: getAuthUsername(req) });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Update registration status error:", err);
    return res.status(500).json({ message: "Failed to update registration status" });
  }
}

router.patch("/tournaments/:tournamentId/players/:playerId", requireAuth, handleHostUpdateRegistrationStatus);
router.post("/tournaments/:tournamentId/players/:playerId/:status", requireAuth, handleHostUpdateRegistrationStatus);
router.patch("/tournaments/:tournamentId/registrations/:playerId", requireAuth, handleHostUpdateRegistrationStatus);
router.post("/tournaments/:tournamentId/registrations/:playerId/:status", requireAuth, handleHostUpdateRegistrationStatus);
router.patch("/tournaments/:tournamentId/players", requireAuth, handleHostUpdateRegistrationStatus);

// -----------------------------------------------------------------------------
// CAPTAINS / TEAMS / POOLS / TEAM NUMBERS
// -----------------------------------------------------------------------------
router.get("/tournaments/:tournamentId/captains", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    return res.json(enrichCaptainsState(tournament));
  } catch (err) {
    console.error("Get captains error:", err);
    return res.status(500).json({ message: "Failed to load captains" });
  }
});

router.put("/tournaments/:tournamentId/captains", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const payload = {
      selectedCaptainIds: asArray(req.body?.selectedCaptainIds).map(String),
      confirmedCaptains: asArray(req.body?.confirmedCaptains).map((c) => ({ ...c })),
      updatedAt: nowIso(),
    };

    const baseTournament = {
      ...tournament,
      captains: payload,
    };

    let syncedRequests = ensureCaptainBackedTeamRequests(baseTournament);

    syncedRequests = syncedRequests.filter((request) =>
      payload.confirmedCaptains.some((captain) => {
        const resolvedCategoryId = resolveCategoryId(baseTournament, captain?.categoryId, {
          preferSyntheticForTeam: isTeamTournament(baseTournament),
        });

        return requestMatchesCaptain(
          request,
          captain,
          resolvedCategoryId,
          captain?.requestId
        );
      })
    );

    const syncedTournament = {
      ...baseTournament,
      teamRequests: syncedRequests,
    };

    const syncedCaptains = enrichCaptainsState(syncedTournament);
    const teams = rebuildTeamsFromRequestsAndCaptains({
      ...syncedTournament,
      captains: syncedCaptains,
    });

    const updated = await updateTournamentFields(req.params.tournamentId, {
      captains: syncedCaptains,
      teamRequests: syncedRequests,
      teams,
      updatedBy: getAuthUsername(req),
    });

    return res.json({
      ok: true,
      captains: enrichCaptainsState(updated),
      teamRequests: getTeamRequests(updated),
      teams: rebuildTeamsFromRequestsAndCaptains(updated),
    });
  } catch (err) {
    console.error("Save captains error:", err);
    return res.status(500).json({ message: "Failed to save captains" });
  }
});

router.get("/tournaments/:tournamentId/teams", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json({ ok: true, teams: rebuildTeamsFromRequestsAndCaptains(tournament) });
  } catch (err) {
    console.error("Get teams error:", err);
    return res.status(500).json({ message: "Failed to load teams" });
  }
});


router.get("/tournaments/:tournamentId/pools", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json(getPoolsState(tournament));
  } catch (err) {
    console.error("Get pools error:", err);
    return res.status(500).json({ message: "Failed to load pools" });
  }
});

router.put("/tournaments/:tournamentId/pools", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const pools = req.body?.pools || req.body || null;
    const updated = await updateTournamentFields(req.params.tournamentId, { pools, updatedBy: getAuthUsername(req) });
    return res.json({ ok: true, pools: updated?.pools || null });
  } catch (err) {
    console.error("Save pools error:", err);
    return res.status(500).json({ message: "Failed to save pools" });
  }
});

router.get("/tournaments/:tournamentId/team-numbers", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json(getTeamNumbersState(tournament));
  } catch (err) {
    console.error("Get team numbers error:", err);
    return res.status(500).json({ message: "Failed to load team numbers" });
  }
});

router.put("/tournaments/:tournamentId/team-numbers", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const payload = {
      assignments: asArray(req.body?.assignments).map((a) => ({ ...a })),
      locked: Boolean(req.body?.locked),
      updatedAt: nowIso(),
    };
    const updated = await updateTournamentFields(req.params.tournamentId, {
      teamNumbers: payload,
      teamNumberState: payload,
      updatedBy: getAuthUsername(req),
    });
    return res.json({ ok: true, ...(updated?.teamNumbers || payload) });
  } catch (err) {
    console.error("Save team numbers error:", err);
    return res.status(500).json({ message: "Failed to save team numbers" });
  }
});

router.get("/tournaments/:tournamentId/team-number-state", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json(getTeamNumbersState(tournament));
  } catch (err) {
    console.error("Get team number state error:", err);
    return res.status(500).json({ message: "Failed to load team number state" });
  }
});

router.put("/tournaments/:tournamentId/team-number-state", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const payload = {
      assignments: asArray(req.body?.assignments).map((a) => ({ ...a })),
      locked: Boolean(req.body?.locked),
      updatedAt: nowIso(),
    };
    await updateTournamentFields(req.params.tournamentId, {
      teamNumbers: payload,
      teamNumberState: payload,
      updatedBy: getAuthUsername(req),
    });
    return res.json({ ok: true, teamNumberState: payload });
  } catch (err) {
    console.error("Save team number state error:", err);
    return res.status(500).json({ message: "Failed to save team number state" });
  }
});

// -----------------------------------------------------------------------------
// TEAM REQUESTS / INVITES
// -----------------------------------------------------------------------------
router.get("/tournaments/:tournamentId/team-requests", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json(getTeamRequests(tournament));
  } catch (err) {
    console.error("Get team requests error:", err);
    return res.status(500).json({ message: "Failed to load team requests" });
  }
});

router.post("/tournaments/:tournamentId/team-requests", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const body = req.body || {};
    const requests = ensureCaptainBackedTeamRequests(tournament);

    const captainPlayerId = String(body.captainPlayerId || body.createdBy || getAuthUsername(req) || "").trim();
    const captainUsername = String(body.captainUsername || getAuthUsername(req) || "").trim();
    const captainName = String(body.captainName || getAuthDisplayName(req) || captainUsername || "Captain").trim();

    const categoryId = resolveCategoryId(tournament, body.categoryId, {
      preferSyntheticForTeam: isTeamTournament(tournament),
    });

    const existing = findMatchingTeamRequest(
      requests,
      {
        playerId: captainPlayerId,
        captainPlayerId,
        captainUsername,
        captainName,
        requestId: body.requestId,
      },
      categoryId,
      body.requestId
    );

    const mergedInvitedPlayers = mergeUniqueRosterPlayers([
      ...(existing ? asArray(existing.invitedPlayers).map(normalizeRequestInvite) : []),
      ...asArray(body.invitedPlayers).map(normalizeRequestInvite),
    ]).filter((p) => !p.isCaptain);

const captainsState = getCaptainsState(tournament);

const matchedCaptain = captainsState.confirmedCaptains.find((captain) => {
  return (
    String(captain?.playerId || captain?.captainPlayerId || "").trim() === captainPlayerId ||
    normalizeText(captain?.username || captain?.captainUsername) === normalizeText(captainUsername) ||
    normalizeText(captain?.playerName || captain?.captainName) === normalizeText(captainName)
  );
});


    const nextRequest = {
      ...(existing || {}),
      requestId: String(existing?.requestId || body.requestId || uuid()).trim(),
      tournamentId: req.params.tournamentId,
      tournamentName: String(tournament.tournamentName || body.tournamentName || "").trim(),
teamName: String(
  body.teamName ||
  existing?.teamName ||
  matchedCaptain?.teamName ||
  captainName ||
  "My Team"
).trim() || "My Team",
      categoryId: String(categoryId || "").trim(),
      categoryLabel: String(
        body.categoryLabel ||
        existing?.categoryLabel ||
        (isTeamTournament(tournament) ? "Team event" : "")
      ).trim(),
      captainName,
      captainUsername,
      captainPlayerId,
      captainPhone: String(body.captainPhone || existing?.captainPhone || "").trim(),
      createdBy: String(body.createdBy || existing?.createdBy || captainUsername || captainName).trim(),
      invitedPlayers: mergedInvitedPlayers,
      status: body.status
        ? normalizeTeamStatus(body.status)
        : deriveTeamStatusFromInvites(
            mergedInvitedPlayers,
            existing?.status || "pending"
          ),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    const nextRequests = requests.filter(
      (request) => String(request.requestId || "") !== String(existing?.requestId || "")
    );
    nextRequests.push(nextRequest);

    const syncedTournament = {
      ...tournament,
      teamRequests: nextRequests,
    };

    const syncedCaptains = enrichCaptainsState(syncedTournament);
    const teams = rebuildTeamsFromRequestsAndCaptains({
      ...syncedTournament,
      captains: syncedCaptains,
    });

    const updated = await updateTournamentFields(req.params.tournamentId, {
      teamRequests: nextRequests,
      captains: syncedCaptains,
      teams,
      updatedBy: getAuthUsername(req),
    });

    return res.json({
      ok: true,
      request: nextRequest,
      teamRequests: getTeamRequests(updated),
      teams: rebuildTeamsFromRequestsAndCaptains(updated),
    });
  } catch (err) {
    console.error("Create team request error:", err);
    return res.status(500).json({ message: "Failed to create team request" });
  }
});

router.patch("/tournaments/:tournamentId/team-requests/:requestId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const requestId = String(req.params.requestId || "").trim();
    const playerId = String(req.body?.playerId || "").trim();
    const status = normalizeInviteStatus(req.body?.status || "");
    const meOwner = isOwner(req, tournament);
    const meU = normalizeText(req.user?.username);
    const meN = normalizeText(req.user?.name);

    const requests = ensureCaptainBackedTeamRequests(tournament);

    const updatedRequests = requests.map((request) => {
      if (String(request.requestId || "") !== requestId) return request;

      let invitedPlayers = asArray(request.invitedPlayers).map(normalizeRequestInvite);

      invitedPlayers = invitedPlayers.map((invite) => {
        const pid = String(invite?.playerId || "").trim();

        const allowed =
          meOwner ||
          (playerId && pid === playerId) ||
          normalizeText(invite?.username) === meU ||
          normalizeText(invite?.playerName) === meN;

        if (!allowed) return invite;
        if (playerId && pid && pid !== playerId && !meOwner) return invite;

        return {
          ...invite,
          inviteStatus: status,
          updatedAt: nowIso(),
        };
      });

      return {
        ...request,
        invitedPlayers,
        status: deriveTeamStatusFromInvites(invitedPlayers, request?.status || "pending"),
        updatedAt: nowIso(),
      };
    });

    const syncedTournament = {
      ...tournament,
      teamRequests: updatedRequests,
    };

    const syncedCaptains = enrichCaptainsState(syncedTournament);
    const teams = rebuildTeamsFromRequestsAndCaptains({
      ...syncedTournament,
      captains: syncedCaptains,
    });

    await updateTournamentFields(req.params.tournamentId, {
      teamRequests: updatedRequests,
      captains: syncedCaptains,
      teams,
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Update team request error:", err);
    return res.status(500).json({ message: "Failed to update team request" });
  }
});

router.patch("/tournaments/:tournamentId/teams/by-captain/:captainPlayerId", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const captainPlayerId = String(req.params.captainPlayerId || "").trim();
    if (!captainPlayerId) {
      return res.status(400).json({ message: "captainPlayerId is required" });
    }

    const requests = ensureCaptainBackedTeamRequests(tournament);
    const captainsState = enrichCaptainsState(tournament);

    const captain = captainsState.confirmedCaptains.find(
      (c) => String(c?.playerId || c?.captainPlayerId || "").trim() === captainPlayerId
    );

    const resolvedCategoryId = resolveCategoryId(
      tournament,
      req.body?.categoryId || captain?.categoryId,
      { preferSyntheticForTeam: isTeamTournament(tournament) }
    );

    const existing = findMatchingTeamRequest(
      requests,
      {
        playerId: captainPlayerId,
        captainPlayerId,
        captainUsername: req.body?.captainUsername || captain?.captainUsername || captain?.username,
        captainName: req.body?.captainName || captain?.playerName || captain?.captainName,
        requestId: req.body?.requestId || captain?.requestId,
      },
      resolvedCategoryId,
      req.body?.requestId || captain?.requestId
    );

    let invitedPlayers = existing
      ? asArray(existing.invitedPlayers).map(normalizeRequestInvite)
      : [];

    if (Array.isArray(req.body?.invitedPlayers)) {
      invitedPlayers = mergeUniqueRosterPlayers(
        req.body.invitedPlayers.map(normalizeRequestInvite)
      ).filter((p) => !p.isCaptain);
    }

    if (req.body?.addPlayer) {
      invitedPlayers = mergeUniqueRosterPlayers([
        ...invitedPlayers,
        normalizeRequestInvite({
          ...req.body.addPlayer,
          inviteStatus: req.body?.addPlayer?.inviteStatus || "accepted",
        }),
      ]).filter((p) => !p.isCaptain);
    }

    const removePlayerId = String(req.body?.removePlayerId || "").trim();
    const removePlayerName = normalizeText(req.body?.removePlayerName);

    if (removePlayerId || removePlayerName) {
      invitedPlayers = invitedPlayers.filter((player) => {
        const sameId = removePlayerId && String(player?.playerId || "").trim() === removePlayerId;
        const sameName = removePlayerName && normalizeText(player?.playerName) === removePlayerName;
        return !(sameId || sameName);
      });
    }

    const captainEntry = buildCaptainRosterEntry(
      {
        playerId: captainPlayerId,
        playerName: req.body?.captainName || captain?.playerName || captain?.captainName,
        username: req.body?.captainUsername || captain?.captainUsername || captain?.username,
      },
      tournament
    );

    const nextRequest = {
      ...(existing || {}),
      requestId: String(existing?.requestId || req.body?.requestId || uuid()).trim(),
      tournamentId: req.params.tournamentId,
      tournamentName: String(tournament?.tournamentName || "").trim(),
      teamName: String(req.body?.teamName || existing?.teamName || captain?.teamName || captainEntry.playerName || "Team").trim() || "Team",
      categoryId: String(resolvedCategoryId || "").trim(),
      categoryLabel: String(
        req.body?.categoryLabel ||
        existing?.categoryLabel ||
        (isTeamTournament(tournament) ? "Team event" : "")
      ).trim(),
      captainName: captainEntry.playerName,
      captainUsername: captainEntry.username,
      captainPlayerId: captainEntry.playerId,
      captainPhone: captainEntry.phone,
      createdBy: String(existing?.createdBy || captainEntry.username || captainEntry.playerName).trim(),
      invitedPlayers,
      status: req.body?.teamStatus
        ? normalizeTeamStatus(req.body.teamStatus)
        : deriveTeamStatusFromInvites(invitedPlayers, existing?.status || captain?.teamStatus || "pending"),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    const nextRequests = requests.filter(
      (request) => String(request.requestId || "") !== String(existing?.requestId || "")
    );
    nextRequests.push(nextRequest);

    const syncedTournament = {
      ...tournament,
      teamRequests: nextRequests,
    };

    const syncedCaptains = enrichCaptainsState(syncedTournament);
    const teams = rebuildTeamsFromRequestsAndCaptains({
      ...syncedTournament,
      captains: syncedCaptains,
    });

    const updated = await updateTournamentFields(req.params.tournamentId, {
      teamRequests: nextRequests,
      captains: syncedCaptains,
      teams,
      updatedBy: getAuthUsername(req),
    });

    return res.json({
      ok: true,
      request: nextRequest,
      captains: enrichCaptainsState(updated),
      teams: rebuildTeamsFromRequestsAndCaptains(updated),
    });
  } catch (err) {
    console.error("Host team update by captain error:", err);
    return res.status(500).json({ message: "Failed to update host-side team" });
  }
});

// -----------------------------------------------------------------------------
// LINEUPS
// -----------------------------------------------------------------------------
router.get("/tournaments/:tournamentId/lineups", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const categoryId = String(req.query.categoryId || "").trim();
    return res.json(getLineupsForResponse(tournament, req, categoryId || null));
  } catch (err) {
    console.error("Get lineups error:", err);
    return res.status(500).json({ message: "Failed to load lineups" });
  }
});

router.post("/tournaments/:tournamentId/lineups", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const incoming = req.body || {};
    const lineups = getLineupsState(tournament);
    const categoryId = resolveCategoryId(tournament, incoming.categoryId, { preferSyntheticForTeam: isTeamTournament(tournament) });
    const tieId = String(incoming.tieId || uuid());

    const nextTie = {
      tieId,
      tieLabel: String(incoming.tieLabel || "Tie").trim(),
      teamA: String(incoming.teamA || incoming.teamName || "").trim(),
      teamB: String(incoming.teamB || "").trim(),
      teamKey: String(incoming.teamKey || "").trim(),
      categoryId: categoryId || "",
      captainUsername: String(incoming.captainUsername || getAuthUsername(req) || "").trim(),
      captainName: String(incoming.captainName || getAuthDisplayName(req) || "").trim(),
      teamPlayers: asArray(incoming.teamPlayers || incoming.roster).map((p) => ({ ...p })),
      assignments: asArray(incoming.assignments || incoming.submatches).map((x) => ({ ...x })),
      locked: Boolean(incoming.locked),
      submittedAt: nowIso(),
      updatedAt: nowIso(),
    };

    lineups.ties = lineups.ties.filter((tie) => String(tie.tieId) !== tieId);
    lineups.ties.push(nextTie);

    await updateTournamentFields(req.params.tournamentId, {
      lineups,
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true, tie: nextTie });
  } catch (err) {
    console.error("Save lineup error:", err);
    return res.status(500).json({ message: "Failed to save lineup" });
  }
});

router.patch("/tournaments/:tournamentId/lineups/:tieId/lock", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const tieId = String(req.params.tieId || "").trim();
    const locked = Boolean(req.body?.locked);
    const lineups = getLineupsState(tournament);
    lineups.ties = lineups.ties.map((tie) => String(tie.tieId) === tieId ? { ...tie, locked, updatedAt: nowIso() } : tie);
    await updateTournamentFields(req.params.tournamentId, { lineups, updatedBy: getAuthUsername(req) });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Lock lineup error:", err);
    return res.status(500).json({ message: "Failed to lock lineup" });
  }
});

router.post("/tournaments/:tournamentId/lineups/review", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const { categoryId, tieId, side, action } = req.body || {};
    if (!categoryId || !tieId || !side || !action) {
      return res.status(400).json({ message: "categoryId, tieId, side, action are required" });
    }

    const fixtures = normalizeFixtures(tournament.fixtures || { categories: {} });
    const bucket = findCategoryBucket(fixtures, resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true }));
    const rounds = asArray(bucket?.rounds);
    let found = null;

    rounds.forEach((round) => {
      asArray(round).forEach((m) => {
        if (!found && String(m?.tieId || m?.matchId || "") === String(tieId)) found = m;
      });
    });

    if (!found) {
      const lineups = getLineupsState(tournament);
      lineups.ties = lineups.ties.map((tie) => {
        if (String(tie.tieId) !== String(tieId)) return tie;
        const lineupApproval = { ...(tie.lineupApproval || { home: "pending", away: "pending" }) };
        let locked = Boolean(tie.locked || tie.lineupLocked);
        if (action === "approve") lineupApproval[side] = "approved";
        else if (action === "reject") lineupApproval[side] = "rejected";
        else if (action === "lock") locked = true;
        else if (action === "unlock") locked = false;
        return { ...tie, lineupApproval, locked, lineupLocked: locked, updatedAt: nowIso() };
      });
      await updateTournamentFields(req.params.tournamentId, { lineups, updatedBy: getAuthUsername(req) });
      return res.json({ ok: true });
    }

    found.lineupApproval = found.lineupApproval || { home: "pending", away: "pending" };
    if (action === "approve") found.lineupApproval[side] = "approved";
    else if (action === "reject") found.lineupApproval[side] = "rejected";
    else if (action === "lock") found.lineupLocked = true;
    else if (action === "unlock") found.lineupLocked = false;
    else return res.status(400).json({ message: "Invalid action" });

    await updateTournamentFields(req.params.tournamentId, { fixtures, updatedBy: getAuthUsername(req) });
    return res.json({ ok: true, tie: found });
  } catch (err) {
    console.error("Host POST lineups/review error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// FIXTURES
// -----------------------------------------------------------------------------
router.get("/tournaments/:tournamentId/fixtures", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json(normalizeFixtures(tournament.fixtures || null));
  } catch (err) {
    console.error("Host GET fixtures error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/fixtures", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const incoming = normalizeFixtures(req.body || {});
    if (!incoming.categories || typeof incoming.categories !== "object") {
      return res.status(400).json({ message: "Fixtures must have categories object" });
    }
    if (tournament.fixtures && Object.keys(tournament.fixtures.categories || {}).length) {
      return res.status(409).json({ message: "Fixtures already generated. Use manual update." });
    }
    const updated = await updateTournamentFields(req.params.tournamentId, {
      fixtures: incoming,
      fixturesUpdatedAt: nowIso(),
      updatedBy: getAuthUsername(req),
    });
    return res.json(updated.fixtures);
  } catch (err) {
    console.error("Host POST fixtures error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/fixtures/update", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const incoming = normalizeFixtures(req.body || {});
    if (!incoming.categories || typeof incoming.categories !== "object") {
      return res.status(400).json({ message: "Fixtures must have categories object" });
    }
    const updated = await updateTournamentFields(req.params.tournamentId, {
      fixtures: incoming,
      fixturesUpdatedAt: nowIso(),
      updatedBy: getAuthUsername(req),
    });
    return res.json(updated.fixtures);
  } catch (err) {
    console.error("Host POST fixtures update error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/fixtures/generate-league", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const categoryId = String(req.body?.categoryId || "").trim();
    if (!categoryId) return res.status(400).json({ message: "categoryId is required" });

    const out = buildLeagueFixturesForCategory(tournament, categoryId, tournament.fixtures || null);
    const rows = computeLeaderboardRows(tournament, out.categoryId, out.fixtures);
    const snapshotKey = String(out.categoryId || categoryId);

    const updated = await updateTournamentFields(req.params.tournamentId, {
      fixtures: out.fixtures,
      leaderboardSnapshotByCategory: {
        ...(tournament.leaderboardSnapshotByCategory || {}),
        [snapshotKey]: rows,
      },
      fixturesUpdatedAt: nowIso(),
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true, fixtures: updated.fixtures, teams: out.teams, rows });
  } catch (err) {
    console.error("Generate league fixtures error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// LEADERBOARD / PROGRESSION
// -----------------------------------------------------------------------------
router.get("/tournaments/:tournamentId/leaderboard", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const categoryId = String(req.query.categoryId || "").trim();
    if (!categoryId) return res.status(400).json({ message: "categoryId query param is required" });

    const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
    const rows = computeLeaderboardRows(tournament, resolvedCategoryId, tournament.fixtures || null);
    return res.json({ ok: true, rows, categoryId: resolvedCategoryId });
  } catch (err) {
    console.error("Host GET leaderboard error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/progression/finalize", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const categoryId = String(req.body?.categoryId || "").trim();
    if (!categoryId) return res.status(400).json({ message: "categoryId is required" });

    const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
    const out = appendKnockoutRoundsIfNeeded(tournament, resolvedCategoryId, tournament.fixtures || null);
    const rows = computeLeaderboardRows(tournament, resolvedCategoryId, out.fixtures);

    await updateTournamentFields(req.params.tournamentId, {
      fixtures: out.fixtures,
      leaderboardSnapshotByCategory: {
        ...(tournament.leaderboardSnapshotByCategory || {}),
        [resolvedCategoryId]: rows,
      },
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true, changed: out.changed, leaderboard: rows, fixtures: out.fixtures });
  } catch (err) {
    console.error("Finalize progression error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// SCORING SCHEMA
// -----------------------------------------------------------------------------
router.get("/tournaments/:tournamentId/scoring-schema", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    return res.json({
      ok: true,
      draft: tournament.scoringSchemaDraft || tournament.scoringSchema || null,
      activeByCategory: tournament.scoringSchemaActiveByCategory || {},
    });
  } catch (err) {
    console.error("GET scoring schema error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/scoring-schema", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;

    const incomingSchema = req.body?.schema || req.body?.scoringSchema || req.body;
    if (!incomingSchema || typeof incomingSchema !== "object") {
      return res.status(400).json({ message: "Invalid schema" });
    }

    const categoryId = resolveCategoryId(tournament, req.body?.categoryId, { preferSyntheticForTeam: true });
    const normalized = normalizeSchema(incomingSchema, tournament);
    const activeMap = { ...(tournament.scoringSchemaActiveByCategory || {}) };
    if (categoryId) activeMap[categoryId] = normalized;

    const updated = await updateTournamentFields(req.params.tournamentId, {
      scoringSchemaDraft: normalized,
      scoringSchema: normalized,
      scoringSchemaActiveByCategory: activeMap,
      scoringSchemaDraftMeta: { provider: "manual", generatedAt: nowIso() },
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true, scoringSchema: normalized, activeByCategory: updated.scoringSchemaActiveByCategory || activeMap });
  } catch (err) {
    console.error("POST scoring schema error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/scoring-schema/auto", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const built = await buildSuggestedSchema(tournament, req.body || {});
    const updated = await updateTournamentFields(req.params.tournamentId, {
      scoringSchemaDraft: built.draft,
      scoringSchemaDraftMeta: built.meta,
      updatedBy: getAuthUsername(req),
    });
    return res.json({ ok: true, scoringSchema: updated.scoringSchemaDraft });
  } catch (err) {
    console.error("Auto scoring schema error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/scoring-schema/suggest", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const built = await buildSuggestedSchema(tournament, req.body || {});
    await updateTournamentFields(req.params.tournamentId, {
      scoringSchemaDraft: built.draft,
      scoringSchemaDraftMeta: built.meta,
      updatedBy: getAuthUsername(req),
    });
    return res.json({ ok: true, draft: built.draft });
  } catch (err) {
    console.error("Suggest schema error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/scoring-schema/finalize", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const categoryId = resolveCategoryId(tournament, req.body?.categoryId, { preferSyntheticForTeam: true });
    if (!categoryId) return res.status(400).json({ message: "categoryId required" });

    let active = null;
    if (req.body?.scoringSchema && typeof req.body.scoringSchema === "object") {
      active = normalizeSchema(req.body.scoringSchema, tournament);
    } else if (req.body?.schema && typeof req.body.schema === "object") {
      active = normalizeSchema(req.body.schema, tournament);
    } else {
      const draft = tournament.scoringSchemaDraft || defaultSchemaForSport(tournament?.sportName || tournament?.sport || "");
      const selectedKeys = asArray(req.body?.selectedKeys).map(String);
      const customFields = asArray(req.body?.customFields).map(normalizeFieldDefinition).filter((f) => f.key);
      const fieldMap = new Map(asArray(draft.playerFields).map((f) => [String(f.key), normalizeFieldDefinition(f)]));
      const selected = selectedKeys.map((k) => fieldMap.get(k)).filter(Boolean);
      const merged = [];
      const seen = new Set();
      [...selected, ...customFields].forEach((f) => {
        if (!f?.key || seen.has(f.key)) return;
        seen.add(f.key);
        merged.push(f);
      });
      active = normalizeSchema({ ...draft, playerFields: merged.length ? merged : asArray(draft.playerFields) }, tournament);
    }

    const activeByCategory = {
      ...(tournament.scoringSchemaActiveByCategory || {}),
      [categoryId]: active,
    };

    await updateTournamentFields(req.params.tournamentId, {
      scoringSchemaActiveByCategory: activeByCategory,
      scoringSchemaDraft: active,
      scoringSchemaDraftMeta: { provider: "finalized", generatedAt: nowIso(), categoryId },
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true, active });
  } catch (err) {
    console.error("Finalize schema error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/tournaments/:tournamentId/scoring-schema/active", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const categoryId = resolveCategoryId(tournament, req.query?.categoryId, { preferSyntheticForTeam: true });
    if (!categoryId) return res.status(400).json({ message: "categoryId query param required" });
    const active = tournament?.scoringSchemaActiveByCategory?.[categoryId] || tournament?.scoringSchemaDraft || null;
    return res.json({ ok: true, data: active });
  } catch (err) {
    console.error("GET active scoring schema error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/tournaments/:tournamentId/scoring-schema/add-field", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!assertOwner(req, tournament, res)) return;
    const categoryId = resolveCategoryId(tournament, req.body?.categoryId, { preferSyntheticForTeam: true });
    if (!categoryId) return res.status(400).json({ message: "categoryId is required" });
    const field = normalizeFieldDefinition(req.body?.field || {});
    if (!field.key) return res.status(400).json({ message: "field.key is required" });

    const current = normalizeSchema(tournament?.scoringSchemaActiveByCategory?.[categoryId] || tournament?.scoringSchemaDraft || {}, tournament);
    const nextFields = asArray(current.playerFields).filter((f) => f.key !== field.key);
    nextFields.push(field);
    nextFields.sort((a, b) => Number(a.order || 999) - Number(b.order || 999));

    const active = { ...current, playerFields: nextFields, updatedAt: nowIso() };
    const activeByCategory = { ...(tournament.scoringSchemaActiveByCategory || {}), [categoryId]: active };

    await updateTournamentFields(req.params.tournamentId, {
      scoringSchemaActiveByCategory: activeByCategory,
      updatedBy: getAuthUsername(req),
    });

    return res.json({ ok: true, active });
  } catch (err) {
    console.error("Add scoring field error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// MATCH SCORING
// -----------------------------------------------------------------------------
router.put("/tournaments/:tournamentId/matches/score", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!(await assertOwnerOrUmpire(req, tournament, res))) return;

    const categoryId = resolveCategoryId(tournament, req.body?.categoryId, { preferSyntheticForTeam: true });
    const roundIndex = req.body?.roundIndex ?? req.body?.round;
    const matchIndex = req.body?.matchIndex ?? req.body?.match;
    const scoreIndex = toFiniteNumber(req.body?.scoreIndex, 0) || 0;
    const scorePayload = req.body?.score || {};

    if (categoryId == null || roundIndex === undefined || matchIndex === undefined || !scorePayload) {
      return res.status(400).json({ message: "Missing categoryId/roundIndex/matchIndex/score" });
    }

    const fixtures = normalizeFixtures(tournament.fixtures || { categories: {} });
    const match = findMatch(fixtures, categoryId, roundIndex, matchIndex);
    if (!match) return res.status(400).json({ message: "Match not found at given round/match index" });

    const schema = tournament?.scoringSchemaActiveByCategory?.[categoryId]
      || tournament?.scoringSchemaDraft
      || tournament?.scoringSchema
      || defaultSchemaForSport(tournament?.sportName || tournament?.sport || "");

    if (Array.isArray(match.submatches) && match.submatches.length) {
      const sub = match.submatches[Number(scoreIndex)];
      if (!sub) return res.status(400).json({ message: "Invalid scoreIndex for tie" });
      sub.home = match.home;
      sub.away = match.away;
      sub.homePlayers = asArray(sub.homePlayers).length ? sub.homePlayers : asArray(match.homePlayers).slice(0, 2);
      sub.awayPlayers = asArray(sub.awayPlayers).length ? sub.awayPlayers : asArray(match.awayPlayers).slice(0, 2);
      sub.score = scoreIndividualMatch(sub, schema, scorePayload);
      sub.status = sub.score.computed.status;
      sub.winner = sub.score.computed.winnerName || null;
      summarizeTieMatch(match);
    } else {
      match.score = scoreIndividualMatch(match, schema, scorePayload);
      match.status = match.score.computed.status;
      match.winner = match.score.computed.winnerName || null;
      match.winnerSide = match.score.computed.winnerSide || null;
      const { homePoints, awayPoints } = getMatchScoreNumbers(match);
      match.matchPointsHome = homePoints;
      match.matchPointsAway = awayPoints;
    }

    if (normalizeText(match?.stage) === "knockout" && normalizeText(match?.status) === "completed" && match?.winner) {
      propagateKnockoutWinner(fixtures, categoryId, Number(roundIndex), Number(matchIndex), match);
    }

    const progressionOut = appendKnockoutRoundsIfNeeded(tournament, categoryId, fixtures);
    const rows = computeLeaderboardRows(tournament, categoryId, progressionOut.fixtures);

    const updated = await persistScoredFixtures(tournament, progressionOut.fixtures, {
      leaderboardSnapshotByCategory: {
        ...(tournament.leaderboardSnapshotByCategory || {}),
        [categoryId]: rows,
      },
      updatedBy: getAuthUsername(req),
    });

    return res.json({
      ok: true,
      match,
      scoreIndex: Number(scoreIndex),
      leaderboard: rows,
      fixtures: updated.fixtures,
    });
  } catch (err) {
    console.error("Save match score error:", err);
    if (err?.code === "ConditionalCheckFailedException") {
      return res.status(409).json({
        message: "This match was updated from another device. Refresh and try again.",
      });
    }
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
