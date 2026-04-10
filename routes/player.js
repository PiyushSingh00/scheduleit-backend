const express = require("express");
const AWS = require("aws-sdk");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");

const {
  getTournamentAggregate,
  listTournamentAggregates,
  saveTournamentAggregate,
} = require("../repositories/tournamentStore");

const router = express.Router();

const REGION = process.env.AWS_REGION || "eu-north-1";
const TABLE = process.env.SCHEDULEIT_TOURNAMENTS_TABLE || "ScheduleItTournaments";
const TEAM_EVENT_CATEGORY_ID = "__team_event__";

const USER_DETAILS_TABLE = process.env.SCHEDULEIT_USER_DETAILS_TABLE || "scheduleit-user-details";
const PENDING_PLAYER_LINKS_TABLE =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_TABLE || "ScheduleItPendingPlayerLinks";
const PENDING_PLAYER_LINKS_PARTITION_KEY =
  process.env.SCHEDULEIT_PENDING_PLAYER_LINKS_PARTITION_KEY || "phoneKey";

AWS.config.update({ region: REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function getAuthUserId(req) {
  return String(
    req.user?.userId ||
      req.user?.id ||
      req.user?.username ||
      req.user?.email ||
      ""
  ).trim();
}

function getAuthUsername(req) {
  return String(req.user?.username || req.user?.email || getAuthUserId(req) || "").trim();
}

function getAuthDisplayName(req, body = {}) {
  return String(
    body?.playerName ||
      req.user?.name ||
      req.user?.username ||
      req.user?.email ||
      "Player"
  ).trim();
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

function normalizeCategoryItem(c, index = 0) {
  const raw = c && typeof c === "object" ? c : {};
  return {
    ...raw,
    categoryId: String(raw.categoryId || raw.id || `category_${index + 1}`).trim(),
  };
}

function getTournamentCategories(tournament) {
  return normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
}

function isTeamTournament(tournament) {
  return normalizeText(tournament?.tournamentType) === "team";
}

function resolveCategoryId(tournament, incomingCategoryId, options = {}) {
  const categories = getTournamentCategories(tournament);
  const requested = String(incomingCategoryId || "").trim();
  const preferSynthetic = options.preferSyntheticForTeam !== false;

  if (isTeamTournament(tournament) && preferSynthetic) {
    if (!requested || requested === TEAM_EVENT_CATEGORY_ID) return TEAM_EVENT_CATEGORY_ID;
  }

  if (requested) {
    const exact = categories.find((c) => String(c.categoryId) === requested);
    if (exact) return exact.categoryId;
    if (isTeamTournament(tournament) && preferSynthetic) return TEAM_EVENT_CATEGORY_ID;
  }

  if (isTeamTournament(tournament) && preferSynthetic) return TEAM_EVENT_CATEGORY_ID;
  return categories[0]?.categoryId || null;
}

function getCategoryMeta(tournament, categoryId) {
  return getTournamentCategories(tournament).find(
    (c) => String(c.categoryId) === String(categoryId)
  ) || null;
}

async function getTournament(tournamentId) {
  return getTournamentAggregate(tournamentId);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

async function getPendingLinkedTournamentIds(req, profile = null) {
  const phone = normalizePhone(
    profile?.phone ||
    profile?.phoneNumber ||
    profile?.mobile ||
    req.user?.phone ||
    req.user?.phoneNumber ||
    req.user?.mobile ||
    ""
  );

  if (!phone) return new Set();

  try {
    const result = await ddb.query({
      TableName: PENDING_PLAYER_LINKS_TABLE,
      KeyConditionExpression: `${PENDING_PLAYER_LINKS_PARTITION_KEY} = :phone`,
      ExpressionAttributeValues: {
        ":phone": phone,
      },
    }).promise();

    return new Set(
      asArray(result.Items)
        .map((item) => String(item?.tournamentId || "").trim())
        .filter(Boolean)
    );
  } catch (err) {
    console.warn("Could not load pending player links in player route:", err?.message || err);
    return new Set();
  }
}

async function getPendingLinkRowsForCurrentUser(req, profile = null, tournamentId = "") {
  const phone = normalizePhone(
    profile?.phone ||
    profile?.phoneNumber ||
    profile?.mobile ||
    req.user?.phone ||
    req.user?.phoneNumber ||
    req.user?.mobile ||
    ""
  );

  if (!phone) return [];

  try {
    const result = await ddb.query({
      TableName: PENDING_PLAYER_LINKS_TABLE,
      KeyConditionExpression: `${PENDING_PLAYER_LINKS_PARTITION_KEY} = :phone`,
      ExpressionAttributeValues: {
        ":phone": phone,
      },
    }).promise();

    return asArray(result.Items).filter((item) =>
      !tournamentId || String(item?.tournamentId || "").trim() === String(tournamentId || "").trim()
    );
  } catch (err) {
    console.warn("Could not load pending player link rows in player route:", err?.message || err);
    return [];
  }
}

async function getCurrentUserProfile(req) {
  const directPhone = normalizePhone(
    req.user?.phone ||
    req.user?.phoneNumber ||
    req.user?.mobile ||
    ""
  );

  if (directPhone) {
    return {
      userId: getAuthUserId(req),
      username: getAuthUsername(req),
      email: String(req.user?.email || "").trim(),
      phone: directPhone,
    };
  }

  try {
    const meUserId = String(getAuthUserId(req) || "").trim();
    const meUsername = normalizeText(getAuthUsername(req));
    const meEmail = normalizeText(req.user?.email || "");

    const scan = await ddb.scan({ TableName: USER_DETAILS_TABLE }).promise();
    const item = asArray(scan.Items).find((row) => {
      return (
        String(row?.userId || row?.id || "").trim() === meUserId ||
        normalizeText(row?.username) === meUsername ||
        normalizeText(row?.email) === meEmail
      );
    });

    return item || null;
  } catch (err) {
    console.warn("Could not load current user profile for phone lookup:", err?.message || err);
    return null;
  }
}

function getPossiblePhones(req, profile = null, body = {}) {
  const values = [
    body?.phone,
    req.user?.phone,
    req.user?.phoneNumber,
    req.user?.mobile,
    profile?.phone,
    profile?.phoneNumber,
    profile?.mobile,
  ];

  return [...new Set(values.map(normalizePhone).filter(Boolean))];
}

function playerBelongsToCurrentUser(player, req, profile = null) {
  const meUserId = String(getAuthUserId(req) || "").trim();
  const meUsername = normalizeText(getAuthUsername(req));
  const phones = new Set(getPossiblePhones(req, profile));

  const playerUserId = String(player?.userId || "").trim();
  const playerUsername = normalizeText(player?.username);
  const playerPhone = normalizePhone(player?.phone);

  if (meUserId && playerUserId && playerUserId === meUserId) return true;
  if (meUsername && playerUsername && playerUsername === meUsername) return true;
  if (playerPhone && phones.has(playerPhone)) return true;

  return false;
}

function getMyTournamentPlayerRecords(tournament, req, profile = null) {
  return getPlayers(tournament).filter((player) =>
    playerBelongsToCurrentUser(player, req, profile)
  );
}

function getMyTournamentIdentityState(tournament, req, profile = null) {
  const myPlayers = getMyTournamentPlayerRecords(tournament, req, profile);

  const playerIds = new Set();
  const usernames = new Set();
  const phones = new Set(getPossiblePhones(req, profile));

  const authUserId = String(getAuthUserId(req) || "").trim();
  const authUsername = normalizeText(getAuthUsername(req));

  if (authUserId) playerIds.add(authUserId);
  if (authUsername) usernames.add(authUsername);

  myPlayers.forEach((player) => {
    const pid = String(
      player?.playerId ||
      player?.registrationId ||
      player?.id ||
      player?.userId ||
      ""
    ).trim();

    const username = normalizeText(player?.username);
    const phone = normalizePhone(player?.phone);

    if (pid) playerIds.add(pid);
    if (username) usernames.add(username);
    if (phone) phones.add(phone);
  });

  return { playerIds, usernames, phones };
}

function inviteBelongsToCurrentUser(invite, tournament, req, profile = null) {
  const { playerIds, usernames, phones } = getMyTournamentIdentityState(tournament, req, profile);

  const invitePlayerId = String(
    invite?.playerId ||
    invite?.inviteePlayerId ||
    ""
  ).trim();

  const inviteUsername = normalizeText(
    invite?.username ||
    invite?.inviteeUsername ||
    ""
  );

  const invitePhone = normalizePhone(
    invite?.phone ||
    invite?.playerPhone ||
    ""
  );

  if (invitePlayerId && playerIds.has(invitePlayerId)) return true;
  if (inviteUsername && usernames.has(inviteUsername)) return true;
  if (invitePhone && phones.has(invitePhone)) return true;

  return false;
}

function teamBelongsToCurrentUser(team, tournament, req, profile = null) {
  const { playerIds, usernames, phones } = getMyTournamentIdentityState(tournament, req, profile);

  const captainPlayerId = String(team?.captainPlayerId || "").trim();
  const captainUsername = normalizeText(team?.captainUsername || "");
  const captainPhone = normalizePhone(team?.captainPhone || "");

  if (captainPlayerId && playerIds.has(captainPlayerId)) return true;
  if (captainUsername && usernames.has(captainUsername)) return true;
  if (captainPhone && phones.has(captainPhone)) return true;

  return asArray(team?.players).some((player) => {
    const pid = String(player?.playerId || "").trim();
    const username = normalizeText(player?.username || "");
    const phone = normalizePhone(player?.phone || "");

    return (
      (pid && playerIds.has(pid)) ||
      (username && usernames.has(username)) ||
      (phone && phones.has(phone))
    );
  });
}

function claimPlayerForCurrentUser(player, req, profile = null) {
  const phones = getPossiblePhones(req, profile);
  return {
    ...player,
    userId: String(getAuthUserId(req) || player?.userId || "").trim() || null,
    username: String(getAuthUsername(req) || player?.username || "").trim(),
    phone: normalizePhone(player?.phone || phones[0] || ""),
    updatedAt: nowIso(),
  };
}

async function reconcileTournamentPlayersForCurrentUser(tournament, req, profile = null) {
  const players = getPlayers(tournament);
  let changed = false;

  const nextPlayers = players.map((player) => {
    if (!playerBelongsToCurrentUser(player, req, profile)) return player;

    const desiredUserId = String(getAuthUserId(req) || "").trim();
    const desiredUsername = String(getAuthUsername(req) || "").trim();
    const desiredPhone = getPossiblePhones(req, profile)[0] || "";

    const currentUserId = String(player?.userId || "").trim();
    const currentUsername = String(player?.username || "").trim();
    const currentPhone = normalizePhone(player?.phone);

    const alreadyLinked =
      currentUserId === desiredUserId &&
      normalizeText(currentUsername) === normalizeText(desiredUsername) &&
      (!desiredPhone || currentPhone === desiredPhone);

    if (alreadyLinked) return player;

    changed = true;
    return claimPlayerForCurrentUser(player, req, profile);
  });

  if (!changed) {
    return {
      ...tournament,
      players: nextPlayers,
    };
  }

  const updatedTournament = {
    ...tournament,
    players: nextPlayers,
    updatedAt: nowIso(),
  };

  await putTournament(updatedTournament);
  return updatedTournament;
}

function getTournamentUmpires(tournament) {
  return asArray(tournament?.umpires).map((u) => ({ ...u }));
}

function umpireBelongsToCurrentUser(umpire, req, profile = null) {
  const meUserId = String(getAuthUserId(req) || "").trim();
  const meUsername = normalizeText(getAuthUsername(req));
  const phones = new Set(getPossiblePhones(req, profile));

  const umpireUserId = String(umpire?.userId || "").trim();
  const umpireUsername = normalizeText(umpire?.username || "");
  const umpirePhone = normalizePhone(umpire?.phone || "");

  if (meUserId && umpireUserId && meUserId === umpireUserId) return true;
  if (meUsername && umpireUsername && meUsername === umpireUsername) return true;
  if (umpirePhone && phones.has(umpirePhone)) return true;

  return false;
}

function claimUmpireForCurrentUser(umpire, req, profile = null) {
  const phones = getPossiblePhones(req, profile);
  return {
    ...umpire,
    userId: String(getAuthUserId(req) || umpire?.userId || "").trim() || null,
    username: String(getAuthUsername(req) || umpire?.username || "").trim(),
    phone: normalizePhone(umpire?.phone || phones[0] || ""),
    updatedAt: nowIso(),
  };
}

async function reconcileTournamentUmpiresForCurrentUser(tournament, req, profile = null) {
  const umpires = getTournamentUmpires(tournament);
  let changed = false;

  const nextUmpires = umpires.map((umpire) => {
    if (!umpireBelongsToCurrentUser(umpire, req, profile)) return umpire;

    const claimed = claimUmpireForCurrentUser(umpire, req, profile);

    const alreadyLinked =
      String(umpire?.userId || "").trim() === String(claimed?.userId || "").trim() &&
      normalizeText(umpire?.username || "") === normalizeText(claimed?.username || "") &&
      normalizePhone(umpire?.phone || "") === normalizePhone(claimed?.phone || "");

    if (alreadyLinked) return umpire;

    changed = true;
    return claimed;
  });

  if (!changed) {
    return {
      ...tournament,
      umpires: nextUmpires,
    };
  }

  const updatedTournament = {
    ...tournament,
    umpires: nextUmpires,
    updatedAt: nowIso(),
  };

  await putTournament(updatedTournament);
  return updatedTournament;
}

async function putTournament(item) {
  return saveTournamentAggregate(item);
}

function getPlayers(tournament) {
  return asArray(tournament?.players).map((p) => ({ ...p }));
}

function getTeamRequests(tournament) {
  return asArray(tournament?.teamRequests).map((r) => ({
    ...r,
    invitedPlayers: asArray(r?.invitedPlayers).map((p) => ({ ...p })),
  }));
}

function getCaptainsState(tournament) {
  const raw = tournament?.captains || tournament?.captainState || {};
  return {
    selectedCaptainIds: asArray(raw.selectedCaptainIds).map(String),
    confirmedCaptains: asArray(raw.confirmedCaptains).map((c) => ({ ...c })),
    updatedAt: raw.updatedAt || null,
  };
}

function getLineupsState(tournament) {
  const raw = tournament?.lineups || {};
  return {
    ties: asArray(raw.ties).map((t) => ({
      ...t,
      assignments: asArray(t?.assignments).map((a) => ({
        ...a,
        players: asArray(a?.players).map((p) => (typeof p === "object" ? { ...p } : p)),
      })),
    })),
  };
}

function makePlayerRecord(req, tournament, body = {}, profile = null) {
  const categoryId = resolveCategoryId(tournament, body.categoryId, { preferSyntheticForTeam: true });
  const playerId = String(body.playerId || `${getAuthUserId(req)}-${categoryId || TEAM_EVENT_CATEGORY_ID}`).trim();

  return {
    playerId,
    userId: getAuthUserId(req),
    username: getAuthUsername(req),
    playerName: getAuthDisplayName(req, body),
    phone: getPossiblePhones(req, profile, body)[0] || "",
    age:
      body.age !== undefined && body.age !== null && body.age !== ""
        ? Number(body.age)
        : null,
    gender: String(body.gender || "").trim(),
    teamName: String(body.teamName || "").trim(),
    categoryId: String(categoryId || ""),
    status: "accepted",
    source: String(body.source || "player_register").trim() || "player_register",
    registeredVia: String(body.registeredVia || "player").trim() || "player",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function findPlayerForUser(tournament, req, categoryId = null, profile = null) {
  return getPlayers(tournament).find((p) => {
    const sameUser = playerBelongsToCurrentUser(p, req, profile);
    if (!sameUser) return false;
    if (!categoryId) return true;
    return String(p?.categoryId || "") === String(categoryId);
  }) || null;
}

function getAcceptedInvitePlayers(request) {
  return asArray(request?.invitedPlayers)
    .filter((p) => normalizeText(p?.inviteStatus || p?.status || "pending") === "accepted")
    .map((p) => ({
      playerId: String(p?.playerId || "").trim(),
      playerName: String(p?.playerName || p?.name || p?.inviteeName || p?.username || "Player").trim(),
      username: String(p?.username || "").trim(),
      phone: String(p?.phone || "").trim(),
      inviteStatus: "accepted",
      isCaptain: false,
    }));
}

function teamRosterEntriesOverlap(a = {}, b = {}) {
  const aId = String(a?.playerId || "").trim();
  const bId = String(b?.playerId || "").trim();
  const aUsername = normalizeText(a?.username || "");
  const bUsername = normalizeText(b?.username || "");
  const aPhone = normalizePhone(a?.phone || "");
  const bPhone = normalizePhone(b?.phone || "");
  const aName = normalizeText(a?.playerName || a?.username || "");
  const bName = normalizeText(b?.playerName || b?.username || "");

  if (aId && bId && aId === bId) return true;
  if (aUsername && bUsername && aUsername === bUsername) return true;
  if (aPhone && bPhone && aPhone === bPhone) return true;
  if (aName && bName && aName === bName) return true;

  return false;
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

  getAcceptedInvitePlayers(request).forEach((p) => roster.push(p));

  const out = [];
  roster.forEach((item) => {
    const existing = out.find((candidate) => teamRosterEntriesOverlap(candidate, item));
    if (!existing) {
      out.push({ ...item });
      return;
    }

    if (!existing.playerId && item.playerId) existing.playerId = item.playerId;
    if (!existing.username && item.username) existing.username = item.username;
    if (!existing.phone && item.phone) existing.phone = item.phone;
    if ((!existing.playerName || existing.playerName === "Player") && item.playerName) {
      existing.playerName = item.playerName;
    }
    existing.isCaptain = Boolean(existing.isCaptain || item.isCaptain);
  });

  return out;
}

function rebuildTeamsFromTournament(tournament) {
  const captains = getCaptainsState(tournament).confirmedCaptains;
  const requests = getTeamRequests(tournament);
  const map = new Map();

  captains.forEach((captain) => {
    const categoryId = resolveCategoryId(tournament, captain?.categoryId, { preferSyntheticForTeam: true });
    const key = String(captain?.playerId || captain?.captainPlayerId || captain?.teamName || randomUUID());
    map.set(key, {
      teamId: `team-${key}`,
      teamName: String(captain?.teamName || captain?.playerName || "Team").trim() || "Team",
      captainPlayerId: String(captain?.playerId || captain?.captainPlayerId || "").trim(),
      captainName: String(captain?.playerName || captain?.captainName || "Captain").trim(),
      captainUsername: String(captain?.username || captain?.captainUsername || "").trim(),
      captainPhone: String(captain?.phone || captain?.captainPhone || "").trim(),
      categoryId: String(categoryId || ""),
      teamStatus: String(captain?.teamStatus || "pending").trim() || "pending",
      requestId: null,
      players: asArray(captain?.teamRoster).map((p) => ({ ...p })),
    });
  });

  requests.forEach((request) => {
    const key = String(request?.captainPlayerId || request?.captainUsername || request?.captainName || request?.requestId || randomUUID()).trim();
    const categoryId = resolveCategoryId(tournament, request?.categoryId, { preferSyntheticForTeam: true });
    const existing = map.get(key) || {
      teamId: `team-${key}`,
      teamName: String(request?.teamName || "My Team").trim() || "My Team",
      captainPlayerId: String(request?.captainPlayerId || "").trim(),
      captainName: String(request?.captainName || "Captain").trim(),
      captainUsername: String(request?.captainUsername || "").trim(),
      captainPhone: String(request?.captainPhone || "").trim(),
      categoryId: String(categoryId || ""),
      teamStatus: "pending",
      requestId: String(request?.requestId || "").trim(),
      players: [],
    };

    existing.requestId = String(request?.requestId || existing.requestId || "").trim();
    existing.teamName = String(request?.teamName || existing.teamName || "My Team").trim() || "My Team";
    existing.categoryId = String(categoryId || existing.categoryId || "");
    existing.captainPhone = String(request?.captainPhone || existing.captainPhone || "").trim();
    existing.players = buildRequestRoster(request);
    if (existing.players.length) existing.teamStatus = "accepted";

    map.set(key, existing);
  });

  return Array.from(map.values());
}

function getMyTeams(tournament, req, profile = null) {
  return rebuildTeamsFromTournament(tournament).filter((team) =>
    teamBelongsToCurrentUser(team, tournament, req, profile)
  );
}

function getMyTeamForCategory(tournament, categoryId, req, profile = null) {
  const resolved = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  const teams = getMyTeams(tournament, req, profile);
  return (
    teams.find((team) => String(team.categoryId || "") === String(resolved || "")) ||
    teams[0] ||
    null
  );
}

function getFixturesCategoryBucket(tournament, categoryId) {
  const fixtures = tournament?.fixtures && typeof tournament.fixtures === "object" ? tournament.fixtures : {};
  const categories = fixtures.categories && typeof fixtures.categories === "object" ? fixtures.categories : {};
  return categories[String(categoryId || "")] || null;
}

function splitFixtureNames(value) {
  const text = String(value || "").trim();
  const upper = text.toUpperCase();
  if (!text || upper === "BYE" || upper === "TBD") return [];
  return text.split(" + ").map((entry) => entry.trim()).filter(Boolean);
}

function getCurrentUserMatchNames(tournament, req, profile = null) {
  const values = new Set();
  const push = (value) => {
    const normalized = normalizeText(value);
    if (normalized) values.add(normalized);
  };

  push(req.user?.name);
  push(req.user?.username);
  push(req.user?.email);

  getMyTournamentPlayerRecords(tournament, req, profile).forEach((player) => {
    push(player?.playerName);
    push(player?.name);
    push(player?.username);
  });

  getMyTeams(tournament, req, profile).forEach((team) => {
    push(team?.captainName);
    push(team?.captainUsername);
    asArray(team?.players).forEach((player) => {
      push(player?.playerName);
      push(player?.name);
      push(player?.username);
    });
  });

  return values;
}

function getCurrentUserMatchNamesWithPendingLinks(tournament, req, profile = null, pendingLinks = []) {
  const values = getCurrentUserMatchNames(tournament, req, profile);
  asArray(pendingLinks).forEach((link) => {
    const playerName = normalizeText(link?.playerName || link?.name || "");
    if (playerName) values.add(playerName);
    const username = normalizeText(link?.username || "");
    if (username) values.add(username);
  });
  return values;
}

function playerGroupContainsCurrentUser(players, tournament, req, profile = null) {
  const mine = getCurrentUserMatchNames(tournament, req, profile);
  return asArray(players).some((player) => mine.has(normalizeText(player)));
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

  const sponsorSource = Array.isArray(raw?.sponsorNames)
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
    organizerName: String(raw?.organizerName || defaults.organizerName).trim(),
    sponsorNames: sponsorSource.map((value) => String(value || "").trim()).filter(Boolean),
    venueLabel: String(raw?.venueLabel || defaults.venueLabel).trim(),
    cityName: String(raw?.cityName || defaults.cityName).trim(),
    tagline: String(raw?.tagline || defaults.tagline).trim(),
    socialHandle: String(raw?.socialHandle || defaults.socialHandle).trim(),
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

function tournamentContainsCurrentUser(tournament, req, profile = null, pendingLinks = []) {
  const registered = getPlayers(tournament).some((player) => playerBelongsToCurrentUser(player, req, profile));
  const invited = getTeamRequests(tournament).some((request) =>
    asArray(request?.invitedPlayers).some((invite) => inviteBelongsToCurrentUser(invite, tournament, req, profile))
  );
  const assignedAsUmpire = getTournamentUmpires(tournament).some((umpire) =>
    umpireBelongsToCurrentUser(umpire, req, profile)
  );
  const myNames = getCurrentUserMatchNamesWithPendingLinks(tournament, req, profile, pendingLinks);
  const fixtures = tournament?.fixtures && typeof tournament.fixtures === "object" ? tournament.fixtures : { categories: {} };
  const categories = fixtures.categories && typeof fixtures.categories === "object" ? fixtures.categories : {};

  const playedInFixtures = Object.values(categories).some((bucket) => {
    const rounds = asArray(bucket?.rounds).length ? asArray(bucket.rounds) : [asArray(bucket?.matches)];
    return rounds.some((round) =>
      asArray(round).some((match) => {
        const topLevelNames = [
          ...asArray(match?.homePlayers),
          ...asArray(match?.awayPlayers),
          ...splitFixtureNames(match?.home),
          ...splitFixtureNames(match?.away),
        ];
        if (topLevelNames.some((name) => myNames.has(normalizeText(name)))) return true;

        return asArray(match?.submatches).some((submatch) =>
          [...asArray(submatch?.homePlayers), ...asArray(submatch?.awayPlayers)].some((name) =>
            myNames.has(normalizeText(name))
          )
        );
      })
    );
  });

  const linkedByPendingPhone = asArray(pendingLinks).length > 0;
  return registered || invited || assignedAsUmpire || playedInFixtures || linkedByPendingPhone;
}

function buildMyMatches(tournament, req, profile = null, pendingLinks = []) {
  const fixtures = tournament?.fixtures && typeof tournament.fixtures === "object"
    ? tournament.fixtures
    : { categories: {} };
  const categories = fixtures.categories && typeof fixtures.categories === "object"
    ? fixtures.categories
    : {};

  const matches = [];

  Object.entries(categories).forEach(([categoryId, bucket]) => {
    const rounds = asArray(bucket?.rounds).length
      ? asArray(bucket?.rounds)
      : [asArray(bucket?.matches)];
    const categoryMeta = getCategoryMeta(tournament, categoryId);
    const categoryLabel = String(bucket?.label || categoryMeta?.eventName || categoryId || "Category").trim();
    const displayMode = String(bucket?.displayMode || "").trim();
    const isTeamSchedule = displayMode.toLowerCase() === "team_schedule" || String(categoryId) === TEAM_EVENT_CATEGORY_ID;

    rounds.forEach((round, roundIndex) => {
      asArray(round).forEach((match, matchIndex) => {
        const myNames = getCurrentUserMatchNamesWithPendingLinks(tournament, req, profile, pendingLinks);
        const submatches = asArray(match?.submatches).map((submatch, submatchIndex) => {
          const homeMine = asArray(submatch?.homePlayers).some((player) => myNames.has(normalizeText(player)));
          const awayMine = asArray(submatch?.awayPlayers).some((player) => myNames.has(normalizeText(player)));
          return {
            ...cloneJson(submatch || {}),
            submatchIndex,
            isMine: homeMine || awayMine,
            mySide: homeMine ? "home" : awayMine ? "away" : null,
          };
        });

        const homeMine = asArray(match?.homePlayers).some((player) => myNames.has(normalizeText(player)));
        const awayMine = asArray(match?.awayPlayers).some((player) => myNames.has(normalizeText(player)));
          const mySubmatches = submatches.filter((submatch) => submatch.isMine);

        if (!homeMine && !awayMine && !mySubmatches.length) return;

        matches.push({
          tournamentId: tournament.tournamentId,
          tournamentName: tournament.tournamentName || "",
          sportName: tournament.sportName || "",
          categoryId,
          categoryLabel,
          displayMode,
          isTeamSchedule,
          roundIndex,
          matchIndex,
          roundLabel: match?.roundLabel || (isTeamSchedule ? `Match ${matchIndex + 1}` : `Round ${roundIndex + 1}`),
          matchId: String(match?.matchId || match?.tieId || `${categoryId}-${roundIndex}-${matchIndex}`),
          stage: String(match?.stage || "").trim(),
          status: String(match?.status || "pending").trim(),
          date: String(match?.date || "").trim(),
          time: String(match?.time || "").trim(),
          court: String(match?.court || "").trim(),
          home: String(match?.home || "Home").trim(),
          away: String(match?.away || "Away").trim(),
          homePlayers: asArray(match?.homePlayers),
          awayPlayers: asArray(match?.awayPlayers),
          score: cloneJson(match?.score || null),
          submatches,
          matchPointsHome: Number(match?.matchPointsHome || 0) || 0,
          matchPointsAway: Number(match?.matchPointsAway || 0) || 0,
          participation: {
            mySide: homeMine ? "home" : awayMine ? "away" : null,
            submatchIndexes: mySubmatches.map((submatch) => Number(submatch.submatchIndex)),
          },
        });
      });
    });
  });

  return matches.sort((a, b) => {
    const statusRank = (status) => {
      const normalized = normalizeText(status);
      if (normalized === "live") return 0;
      if (normalized === "completed") return 1;
      return 2;
    };

    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;
    if (Number(a.roundIndex) !== Number(b.roundIndex)) return Number(a.roundIndex) - Number(b.roundIndex);
    return Number(a.matchIndex) - Number(b.matchIndex);
  });
}

function findTieInTournament(tournament, categoryId, tieId) {
  const bucket = getFixturesCategoryBucket(tournament, categoryId);
  const rounds = asArray(bucket?.rounds);
  let target = null;
  rounds.forEach((round) => {
    asArray(round).forEach((match) => {
      if (target) return;
      const mid = String(match?.tieId || match?.matchId || "").trim();
      if (mid && mid === String(tieId || "").trim()) target = match;
    });
  });
  return target;
}

function isLineupLockedSimple(match) {
  return Boolean(match?.lineupLocked || match?.locked);
}

function validateAssignments(team, assignments) {
  const roster = asArray(team?.players);
  const rosterMap = new Map(
    roster.map((p) => [String(p?.playerId || p?.playerName || "").trim(), p])
  );
  const usage = new Map();
  const normalizedAssignments = [];

  for (const slot of asArray(assignments)) {
    const scoreIndex = Number(slot?.scoreIndex);
    const rawPlayers = asArray(slot?.players).map((value) => String(value || "").trim()).filter(Boolean);
    if (!Number.isFinite(scoreIndex)) {
      return { ok: false, message: "Invalid scoreIndex in lineup assignment" };
    }
    if (!rawPlayers.length) {
      return { ok: false, message: "Each submatch must have at least one selected player" };
    }

    const seenInSlot = new Set();
    const players = [];
    for (const raw of rawPlayers) {
      const rosterPlayer = rosterMap.get(raw) || roster.find((p) => String(p?.playerName || "").trim() === raw);
      if (!rosterPlayer) {
        return { ok: false, message: `Selected player not found in team roster: ${raw}` };
      }
      const pid = String(rosterPlayer?.playerId || rosterPlayer?.playerName || raw).trim();
      if (seenInSlot.has(pid)) {
        return { ok: false, message: `Duplicate player in same submatch: ${rosterPlayer.playerName || raw}` };
      }
      seenInSlot.add(pid);
      usage.set(pid, (usage.get(pid) || 0) + 1);
      players.push({
        playerId: pid,
        playerName: String(rosterPlayer?.playerName || raw).trim(),
        username: String(rosterPlayer?.username || "").trim(),
      });
    }

    normalizedAssignments.push({ scoreIndex, players });
  }

  return { ok: true, assignments: normalizedAssignments, usage: Object.fromEntries(usage.entries()) };
}

function upsertRegisteredPlayerForAcceptedInvite(tournament, req, request, invitePlayer, profile = null) {
  const categoryId = resolveCategoryId(tournament, request?.categoryId, { preferSyntheticForTeam: true });
  const players = getPlayers(tournament);

  const duplicate = players.find(
    (player) =>
      playerBelongsToCurrentUser(player, req, profile) &&
      String(player?.categoryId || "") === String(categoryId || "")
  );

  if (duplicate) return players;

  const userId = getAuthUserId(req);
  const username = getAuthUsername(req);

  players.push({
    playerId: String(invitePlayer?.playerId || `${userId}-${categoryId}`).trim(),
    userId,
    username,
    playerName: String(
      invitePlayer?.inviteeName ||
      invitePlayer?.playerName ||
      req.user?.name ||
      username ||
      "Player"
    ).trim(),
    phone: normalizePhone(invitePlayer?.phone || ""),
    age: invitePlayer?.age != null && invitePlayer?.age !== "" ? Number(invitePlayer.age) : null,
    gender: String(invitePlayer?.gender || "").trim(),
    teamName: String(request?.teamName || "").trim(),
    categoryId: String(categoryId || ""),
    status: "accepted",
    source: "team_invite_accept",
    registeredVia: "player_invite_accept",
    teamRequestId: String(request?.requestId || "").trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  return players;
}

function buildMyTournamentList(items, req, profile = null, linkedTournamentIds = new Set()) {
  return items
    .filter((tournament) => {
      const linked = linkedTournamentIds.has(String(tournament?.tournamentId || "").trim());
      if (linked) return true;

      const registered = getPlayers(tournament).some((player) =>
        playerBelongsToCurrentUser(player, req, profile)
      );

      const invited = getTeamRequests(tournament).some((request) =>
        asArray(request?.invitedPlayers).some((invite) => {
          return (
            inviteBelongsToCurrentUser(invite, tournament, req, profile) &&
            normalizeText(invite?.inviteStatus || "pending") === "accepted"
          );
        })
      );

      const assignedAsUmpire = getTournamentUmpires(tournament).some((umpire) =>
        umpireBelongsToCurrentUser(umpire, req, profile)
      );

      return registered || invited || assignedAsUmpire;
    })
    .map((tournament) => {
      const myUmpireAssignments = getTournamentUmpires(tournament).filter((umpire) =>
        umpireBelongsToCurrentUser(umpire, req, profile)
      );

      return {
        tournamentId: tournament.tournamentId,
        tournamentName: tournament.tournamentName,
        sportName: tournament.sportName,
        tournamentDates: tournament.tournamentDates,
        venue: tournament.venue || "",
        registrationsOpen: tournament.registrationsOpen !== false,
        categories: getTournamentCategories(tournament),
        isPublic: Boolean(tournament.isPublic),
        accessCodeRequired: !Boolean(tournament.isPublic),
        tournamentType: tournament.tournamentType || "single",
        stageFormat: tournament.stageFormat || "",
        advancedSettings: tournament.advancedSettings || {},
        umpires: getTournamentUmpires(tournament),
        myUmpireAssignments,
        myPlayers: getPlayers(tournament).filter((player) =>
          playerBelongsToCurrentUser(player, req, profile)
        ),
        myTeams: getMyTeams(tournament, req, profile),
      };
    });
}

function getMyVisibleTeamRequests(items, req, profile = null) {
  const out = [];

  items.forEach((tournament) => {
    getTeamRequests(tournament).forEach((request) => {
      const visibleInvites = asArray(request?.invitedPlayers)
        .map((invite) => ({ ...invite }))
        .filter((invite) => inviteBelongsToCurrentUser(invite, tournament, req, profile));

      if (!visibleInvites.length) return;

      out.push({
        ...request,
        tournamentId: tournament.tournamentId,
        tournamentName: request?.tournamentName || tournament.tournamentName || "",
        sportName: tournament.sportName || "",
        tournamentDates: tournament.tournamentDates || "",
        invitedPlayers: visibleInvites,
      });
    });
  });

  return out.sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(
      String(a.updatedAt || a.createdAt || "")
    )
  );
}

router.post("/tournaments/:tournamentId/register", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    if (tournament.registrationsOpen === false) {
      return res.status(409).json({ message: "Registrations are closed for this tournament" });
    }

    const body = req.body || {};
    const categoryId = resolveCategoryId(tournament, body.categoryId, { preferSyntheticForTeam: true });
    if (!categoryId) return res.status(400).json({ message: "categoryId could not be resolved" });

    if (!Boolean(tournament.isPublic)) {
      const storedCode = String(tournament.accessCode || "").trim().toUpperCase();
      const incomingCode = String(body.accessCode || "").trim().toUpperCase();
      if (!incomingCode) return res.status(400).json({ message: "accessCode is required for private tournaments" });
      if (storedCode !== incomingCode) return res.status(403).json({ message: "Invalid access code" });
    }

    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const profile = await getCurrentUserProfile(req);
    const players = getPlayers(tournament);

    const duplicate = players.find(
      (p) =>
        playerBelongsToCurrentUser(p, req, profile) &&
        String(p?.categoryId || "") === String(categoryId)
    );

    if (duplicate) {
      const claimed = claimPlayerForCurrentUser(duplicate, req, profile);

      tournament.players = players.map((p) =>
        String(p?.playerId || "") === String(duplicate?.playerId || "") ? claimed : p
      );

      tournament.updatedAt = nowIso();
      await putTournament(tournament);

      return res.json({
        ok: true,
        alreadyRegistered: true,
        player: claimed,
        categoryId,
      });
    }

    const newPlayer = makePlayerRecord(req, tournament, body, profile);
    players.push(newPlayer);

    tournament.players = players;
    tournament.updatedAt = nowIso();
    await putTournament(tournament);

    return res.json({ ok: true, player: newPlayer, categoryId });
  } catch (err) {
    console.error("Player register error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.delete("/tournaments/:tournamentId/register", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const body = req.body || {};
    const categoryId = resolveCategoryId(tournament, req.query.categoryId || body.categoryId, { preferSyntheticForTeam: true });
    const profile = await getCurrentUserProfile(req);

    tournament.players = getPlayers(tournament).filter((p) => {
      const sameUser = playerBelongsToCurrentUser(p, req, profile);
      if (!sameUser) return true;
      if (!categoryId) return false;
      return String(p?.categoryId || "") !== String(categoryId);
    });

    tournament.updatedAt = nowIso();
    await putTournament(tournament);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Player leave error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.post("/tournaments/:tournamentId/leave", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const categoryId = resolveCategoryId(tournament, req.body?.categoryId || req.query?.categoryId, { preferSyntheticForTeam: true });
    const profile = await getCurrentUserProfile(req);

    tournament.players = getPlayers(tournament).filter((p) => {
      const sameUser = playerBelongsToCurrentUser(p, req, profile);
      if (!sameUser) return true;
      if (!categoryId) return false;
      return String(p?.categoryId || "") !== String(categoryId);
    });

    tournament.updatedAt = nowIso();
    await putTournament(tournament);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Player leave alias error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.get("/tournaments", requireAuth, async (req, res) => {
  try {
    const all = await listTournamentAggregates();
    const profile = await getCurrentUserProfile(req);
    const linkedTournamentIds = await getPendingLinkedTournamentIds(req, profile);

    const reconciledItems = [];
    for (const item of asArray(all)) {
      const reconciledPlayers = await reconcileTournamentPlayersForCurrentUser(item, req, profile);
      const reconciled = await reconcileTournamentUmpiresForCurrentUser(reconciledPlayers, req, profile);
      reconciledItems.push(reconciled);
    }

    const rows = buildMyTournamentList(reconciledItems, req, profile, linkedTournamentIds);
    return res.json(rows);
  } catch (err) {
    console.error("GET /api/player/tournaments error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.get("/team-requests", requireAuth, async (req, res) => {
  try {
    const all = await listTournamentAggregates();
    const profile = await getCurrentUserProfile(req);
    const requests = getMyVisibleTeamRequests(asArray(all), req, profile);
    return res.json(requests);
  } catch (err) {
    console.error("GET /api/player/team-requests error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});


router.get("/tournaments/:tournamentId/team-requests", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    const profile = await getCurrentUserProfile(req);
    const requests = getMyVisibleTeamRequests([tournament], req, profile);
    return res.json(requests);
  } catch (err) {
    console.error("GET /api/player/tournaments/:tournamentId/team-requests error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.get("/tournaments/:tournamentId/teams", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    const profile = await getCurrentUserProfile(req);
    const pendingLinks = await getPendingLinkRowsForCurrentUser(req, profile, req.params.tournamentId);
    let teams = getMyTeams(tournament, req, profile);

    if (!teams.length && pendingLinks.length) {
      const linkedNames = new Set(
        pendingLinks.map((link) => normalizeText(link?.playerName || "")).filter(Boolean)
      );
      teams = rebuildTeamsFromTournament(tournament).filter((team) => {
        const captainName = normalizeText(team?.captainName || "");
        if (captainName && linkedNames.has(captainName)) return true;
        return asArray(team?.players).some((player) =>
          linkedNames.has(normalizeText(player?.playerName || player?.name || ""))
        );
      });
    }

    return res.json({
      ok: true,
      teams,
    });
  } catch (err) {
    console.error("GET /api/player/tournaments/:tournamentId/teams error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.get("/tournaments/:tournamentId/my-matches", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    const profile = await getCurrentUserProfile(req);
    const pendingLinks = await getPendingLinkRowsForCurrentUser(req, profile, req.params.tournamentId);
    if (!tournamentContainsCurrentUser(tournament, req, profile, pendingLinks)) {
      return res.status(403).json({ message: "You are not part of this tournament" });
    }

    return res.json({
      ok: true,
      tournamentId: tournament.tournamentId,
      tournamentName: tournament.tournamentName || "",
      sportName: tournament.sportName || "",
      posterSettings: normalizePosterSettings(tournament?.sharePosterConfig || null, tournament),
      matches: buildMyMatches(tournament, req, profile, pendingLinks),
    });
  } catch (err) {
    console.error("GET /api/player/tournaments/:tournamentId/my-matches error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

async function handleInviteStatusUpdate(req, res) {
  try {
    const { tournamentId, requestId } = req.params;
    const nextStatus = normalizeText(req.body?.status || "");

    if (!["accepted", "rejected"].includes(nextStatus)) {
      return res.status(400).json({ message: "status must be accepted or rejected" });
    }

    const tournament = await getTournament(tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const profile = await getCurrentUserProfile(req);
    const requests = getTeamRequests(tournament);

    let matchedRequest = null;
    let matchedInvite = null;

    const updatedRequests = requests.map((request) => {
      if (String(request?.requestId || "") !== String(requestId)) return request;

      const invitedPlayers = asArray(request?.invitedPlayers).map((invite) => {
        const sameUser = inviteBelongsToCurrentUser(invite, tournament, req, profile);

        if (!sameUser) return { ...invite };

        matchedRequest = request;
        matchedInvite = invite;

        return {
          ...invite,
          inviteStatus: nextStatus,
          respondedAt: nowIso(),
          updatedAt: nowIso(),
        };
      });

      return {
        ...request,
        invitedPlayers,
        updatedAt: nowIso(),
      };
    });

    if (!matchedRequest || !matchedInvite) {
      return res.status(404).json({ message: "Invite not found for this user" });
    }

    tournament.teamRequests = updatedRequests;

    if (nextStatus === "accepted") {
      tournament.players = upsertRegisteredPlayerForAcceptedInvite(
        tournament,
        req,
        matchedRequest,
        matchedInvite,
        profile
      );
    }

    tournament.updatedAt = nowIso();
    await putTournament(tournament);

    return res.json({ ok: true, status: nextStatus });
  } catch (err) {
    console.error("PATCH player team request status error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
}

router.patch("/team-requests/:tournamentId/:requestId", requireAuth, handleInviteStatusUpdate);
router.patch("/tournaments/:tournamentId/team-requests/:requestId", requireAuth, handleInviteStatusUpdate);

router.get("/tournaments/:tournamentId/lineups", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const categoryId = resolveCategoryId(tournament, req.query.categoryId, { preferSyntheticForTeam: true });
    if (!categoryId) return res.status(400).json({ message: "categoryId query param is required" });

  const profile = await getCurrentUserProfile(req);
  const myTeam = getMyTeamForCategory(tournament, categoryId, req, profile);
    if (!myTeam) return res.status(404).json({ message: "No team found for this user" });

    const bucket = getFixturesCategoryBucket(tournament, categoryId);
    const rounds = asArray(bucket?.rounds);
    const ties = rounds
      .flat()
      .filter((match) => {
        const homeTeamId = String(match?.homeTeamId || "");
        const awayTeamId = String(match?.awayTeamId || "");
        const myTeamId = String(myTeam.teamId || "");
        const myName = String(myTeam.teamName || "");
        return (
          homeTeamId === myTeamId ||
          awayTeamId === myTeamId ||
          String(match?.home || "") === myName ||
          String(match?.away || "") === myName
        );
      })
      .map((match) => ({
        ...cloneJson(match),
        lineupLocked: isLineupLockedSimple(match),
        mySide:
          String(match?.homeTeamId || "") === String(myTeam.teamId || "") || String(match?.home || "") === String(myTeam.teamName || "")
            ? "home"
            : "away",
      }));

    return res.json({ ok: true, team: myTeam, ties });
  } catch (err) {
    console.error("GET player lineups error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

router.post("/tournaments/:tournamentId/lineups", requireAuth, async (req, res) => {
  try {
    const tournament = await getTournament(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const body = req.body || {};
    const categoryId = resolveCategoryId(tournament, body.categoryId, { preferSyntheticForTeam: true });
    const tieId = String(body.tieId || "").trim();
    const assignments = asArray(body.assignments);

    if (!categoryId || !tieId) {
      return res.status(400).json({ message: "categoryId and tieId are required" });
    }

    const profile = await getCurrentUserProfile(req);
    const myTeam = getMyTeamForCategory(tournament, categoryId, req, profile);

    if (!myTeam) return res.status(403).json({ message: "No matching team for this user" });

    const targetMatch = findTieInTournament(tournament, categoryId, tieId);
    if (!targetMatch) return res.status(404).json({ message: "Tie not found" });
    if (isLineupLockedSimple(targetMatch)) {
      return res.status(409).json({ message: "Lineup is locked for this tie" });
    }

    const validation = validateAssignments(myTeam, assignments);
    if (!validation.ok) {
      return res.status(400).json({ message: validation.message });
    }

    const isHome =
      String(targetMatch?.homeTeamId || "") === String(myTeam.teamId || "") ||
      String(targetMatch?.home || "") === String(myTeam.teamName || "");
    const side = isHome ? "home" : "away";

    targetMatch.lineups = targetMatch.lineups || { home: null, away: null };
    targetMatch.lineupApproval = targetMatch.lineupApproval || { home: "pending", away: "pending" };
    targetMatch.lineups[side] = {
      teamId: myTeam.teamId,
      teamName: myTeam.teamName,
      submittedBy: getAuthUsername(req),
      submittedAt: nowIso(),
      assignments: validation.assignments,
      usage: validation.usage,
    };
    targetMatch.lineupApproval[side] = "pending";
    targetMatch.updatedAt = nowIso();

    tournament.updatedAt = nowIso();
    await putTournament(tournament);

    return res.json({ ok: true, tie: targetMatch });
  } catch (err) {
    console.error("POST player lineup error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  }
});

module.exports = router;
