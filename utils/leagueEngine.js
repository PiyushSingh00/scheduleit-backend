const { randomUUID } = require("crypto");

const TEAM_EVENT_CATEGORY_ID = "__team_event__";

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
  const raw = category && typeof category === "object" ? category : {};
  return {
    ...raw,
    categoryId: String(raw.categoryId || raw.id || `category_${index + 1}`).trim(),
    eventName: String(raw.eventName || raw.categoryName || "").trim(),
  };
}

function getTournamentCategories(tournament) {
  return normalizeCategories(tournament?.categories).map(normalizeCategoryItem);
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

function getLeagueRoundsRequested(tournament) {
  const adv = getAdvancedSettings(tournament);
  return Math.max(0, toFiniteNumber(adv.roundRobinMatches, 0) || 0);
}

function defaultQualifierCount(tournament) {
  const adv = getAdvancedSettings(tournament);
  const explicit = toFiniteNumber(adv.qualifierCount, null);
  if (explicit && explicit > 0) return explicit;
  if (isPickleballTeamLeague(tournament)) return 4;
  return 4;
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

function categoryLabel(category) {
  if (!category || typeof category !== "object") return "Category";
  const age = String(category.ageGroup || "").trim();
  const gender = String(category.gender || "").trim();
  const level = String(category.playingLevel || "").trim();
  const size = Number(category.teamSize || 1);
  const exact = Number(category.exactTeamSize || 0);
  let type = "";
  if (size === 1) type = "Singles";
  else if (size === 2) type = "Doubles";
  else if (size === 3) type = "Triples";
  else if (size >= 4) type = exact ? `Team ${exact}` : "Team";
  const parts = [age, gender, level, type].filter(Boolean);
  return parts.length ? parts.join(" • ") : String(category.eventName || category.categoryId || "Category");
}

function getCategory(tournament, categoryId) {
  const resolved = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  if (!resolved) return null;
  if (resolved === TEAM_EVENT_CATEGORY_ID && isTeamTournament(tournament)) {
    return {
      categoryId: TEAM_EVENT_CATEGORY_ID,
      eventName: "Team event",
      synthetic: true,
      teamSize: 1,
    };
  }
  return getTournamentCategories(tournament).find((c) => String(c.categoryId) === String(resolved)) || null;
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

function getTeamRequests(tournament) {
  return asArray(tournament?.teamRequests).map((request) => ({
    ...request,
    invitedPlayers: asArray(request?.invitedPlayers).map((p) => ({ ...p })),
  }));
}

function getTeamNumberState(tournament) {
  const raw = tournament?.teamNumbers || tournament?.teamNumberState || {};
  if (Array.isArray(raw.assignments) && raw.assignments.length) {
    return {
      assignments: asArray(raw.assignments).map((a) => ({ ...a })),
      locked: Boolean(raw.locked),
      updatedAt: raw.updatedAt || null,
    };
  }

  const teams = buildTeamsFromTournament(tournament);
  return {
    assignments: teams.map((team, idx) => ({
      number: idx + 1,
      teamId: team.teamId,
      teamName: team.teamName,
      captainName: team.captainName,
      categoryId: team.categoryId,
    })),
    locked: false,
    updatedAt: null,
  };
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
      inviteStatus: "accepted",
      isCaptain: true,
    });
  }

  asArray(request?.invitedPlayers).forEach((p) => {
    const status = normalizeText(p?.inviteStatus || p?.status || "pending") || "pending";
    if (status !== "accepted") return;
    roster.push({
      playerId: String(p?.playerId || "").trim(),
      playerName: String(p?.playerName || p?.name || p?.inviteeName || p?.username || "").trim(),
      username: String(p?.username || "").trim(),
      phone: String(p?.phone || "").trim(),
      inviteStatus: status,
      isCaptain: false,
    });
  });

  const seen = new Set();
  return roster.filter((p) => {
    const key = `${String(p.playerId || "")}::${normalizeText(p.playerName || p.username)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildTeamsFromTournament(tournament, categoryId = null) {
  const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  const captains = getCaptainsState(tournament).confirmedCaptains;
  const requests = getTeamRequests(tournament);
  const explicitTeams = asArray(tournament?.teams).map((t) => ({ ...t, players: asArray(t?.players).map((p) => ({ ...p })) }));
  const map = new Map();

  explicitTeams.forEach((team) => {
    const key = String(team.teamId || team.captainPlayerId || team.teamName || randomUUID()).trim();
    map.set(key, {
      teamId: String(team.teamId || `team-${key}`),
      teamName: String(team.teamName || "Team").trim() || "Team",
      captainPlayerId: String(team.captainPlayerId || "").trim(),
      captainName: String(team.captainName || "Captain").trim(),
      captainUsername: String(team.captainUsername || "").trim(),
      categoryId: String(resolveCategoryId(tournament, team.categoryId, { preferSyntheticForTeam: true }) || ""),
      teamStatus: String(team.teamStatus || "pending").trim() || "pending",
      requestId: String(team.requestId || "").trim(),
      players: asArray(team.players).map((p) => ({ ...p })),
    });
  });

  captains.forEach((captain) => {
    const key = String(captain?.playerId || captain?.captainPlayerId || captain?.teamName || randomUUID()).trim();
    const category = resolveCategoryId(tournament, captain?.categoryId, { preferSyntheticForTeam: true });
    const existing = map.get(key) || {
      teamId: `team-${key}`,
      teamName: String(captain?.teamName || captain?.playerName || "Team").trim() || "Team",
      captainPlayerId: String(captain?.playerId || captain?.captainPlayerId || "").trim(),
      captainName: String(captain?.playerName || captain?.captainName || "Captain").trim(),
      captainUsername: String(captain?.username || captain?.captainUsername || "").trim(),
      categoryId: String(category || ""),
      teamStatus: String(captain?.teamStatus || "pending").trim() || "pending",
      requestId: "",
      players: asArray(captain?.teamRoster).map((p) => ({ ...p })),
    };

    existing.teamName = String(captain?.teamName || existing.teamName || captain?.playerName || "Team").trim() || "Team";
    existing.captainPlayerId = String(captain?.playerId || existing.captainPlayerId || "").trim();
    existing.captainName = String(captain?.playerName || existing.captainName || "Captain").trim();
    existing.captainUsername = String(captain?.username || captain?.captainUsername || existing.captainUsername || "").trim();
    existing.categoryId = String(category || existing.categoryId || "");
    existing.teamStatus = String(captain?.teamStatus || existing.teamStatus || "pending").trim() || "pending";

    if (!existing.players.length && Array.isArray(captain?.teamRoster)) {
      existing.players = captain.teamRoster.map((p) => ({ ...p }));
    } else if (!existing.players.length && Array.isArray(captain?.teamPlayers)) {
      existing.players = captain.teamPlayers.map((name) => ({
        playerId: String(name || "").trim(),
        playerName: String(name || "").trim(),
        username: "",
        inviteStatus: "accepted",
      }));
    }

    map.set(key, existing);
  });

  requests.forEach((request) => {
    const key = String(request?.captainPlayerId || request?.captainUsername || request?.captainName || request?.requestId || randomUUID()).trim();
    const category = resolveCategoryId(tournament, request?.categoryId, { preferSyntheticForTeam: true });
    const existing = map.get(key) || {
      teamId: `team-${key}`,
      teamName: String(request?.teamName || "My Team").trim() || "My Team",
      captainPlayerId: String(request?.captainPlayerId || "").trim(),
      captainName: String(request?.captainName || "Captain").trim(),
      captainUsername: String(request?.captainUsername || "").trim(),
      categoryId: String(category || ""),
      teamStatus: "pending",
      requestId: String(request?.requestId || "").trim(),
      players: [],
    };

    existing.requestId = String(request?.requestId || existing.requestId || "").trim();
    existing.teamName = String(request?.teamName || existing.teamName || "My Team").trim() || "My Team";
    existing.captainPlayerId = String(request?.captainPlayerId || existing.captainPlayerId || "").trim();
    existing.captainName = String(request?.captainName || existing.captainName || "Captain").trim();
    existing.captainUsername = String(request?.captainUsername || existing.captainUsername || "").trim();
    existing.categoryId = String(category || existing.categoryId || "");
    existing.players = buildRequestRoster(request);

    const allAccepted = existing.players.length > 0 && asArray(request?.invitedPlayers).every((p) => {
      const s = normalizeText(p?.inviteStatus || p?.status || "pending");
      return s === "accepted" || s === "rejected";
    });

    if (existing.players.length) {
      existing.teamStatus = allAccepted ? "accepted" : (existing.teamStatus || "pending");
    }

    map.set(key, existing);
  });

  let teams = Array.from(map.values());
  teams = teams.filter((team) => normalizeText(team.teamStatus) !== "rejected");

  if (resolvedCategoryId) {
    teams = teams.filter((team) => {
      if (resolvedCategoryId === TEAM_EVENT_CATEGORY_ID && isTeamTournament(tournament)) return true;
      return String(team.categoryId || "") === String(resolvedCategoryId);
    });
  }

  return teams;
}

function isLineupLocked(tournament, match) {
  if (Boolean(match?.lineupLocked || match?.locked)) return true;

  const rule = normalizeText(getAdvancedSettings(tournament)?.lineupLockRule || tournament?.tournamentRules?.lineupLockRule || "");
  const approval = match?.lineupApproval || {};
  const hasBothLineups = Boolean(match?.lineups?.home && match?.lineups?.away);

  if (["after_both_approved", "after_approval", "on_approval"].includes(rule)) {
    return normalizeText(approval.home) === "accepted" && normalizeText(approval.away) === "accepted";
  }

  if (["after_submission", "after_both_submitted", "on_submit"].includes(rule)) {
    return hasBothLineups;
  }

  return false;
}

function getSlotCategoryMeta(tournament, match, scoreIndex) {
  const submatch = asArray(match?.submatches)[Number(scoreIndex)];
  if (submatch?.categoryId) {
    const exact = getCategory(tournament, submatch.categoryId);
    if (exact) return exact;
  }

  const categories = getTournamentCategories(tournament);
  if (categories[Number(scoreIndex)]) return categories[Number(scoreIndex)];
  return null;
}

function getRequiredPlayersForSlot(slotCategory) {
  if (!slotCategory) return null;
  const size = toFiniteNumber(slotCategory.teamSize, 1) || 1;
  if (size >= 4) {
    const exact = toFiniteNumber(slotCategory.exactTeamSize, null);
    return exact && exact > 0 ? exact : size;
  }
  return size;
}

function validateLineupSubmission({ tournament, categoryId, team, match, assignments }) {
  if (!team) return { ok: false, message: "No matching team found" };
  if (!match) return { ok: false, message: "Tie not found" };
  if (isLineupLocked(tournament, match)) return { ok: false, message: "Lineup is locked for this tie" };

  const roster = asArray(team.players);
  if (!roster.length) return { ok: false, message: "Team roster is empty" };

  const rosterByKey = new Map();
  roster.forEach((p) => {
    const keys = uniqStrings([
      p?.playerId,
      p?.playerName,
      p?.username,
    ]);
    keys.forEach((k) => rosterByKey.set(k, p));
  });

  const maxMatchesPerPlayer = toFiniteNumber(tournament?.tournamentRules?.maxMatchesPerPlayer, null);
  const usage = new Map();
  const normalizedAssignments = [];
  const seenScoreIndexes = new Set();

  for (const slot of asArray(assignments)) {
    const scoreIndex = Number(slot?.scoreIndex);
    if (!Number.isFinite(scoreIndex) || scoreIndex < 0) {
      return { ok: false, message: "Invalid scoreIndex in lineup assignment" };
    }
    if (seenScoreIndexes.has(scoreIndex)) {
      return { ok: false, message: "Duplicate scoreIndex in lineup assignment" };
    }
    seenScoreIndexes.add(scoreIndex);

    const rawPlayers = asArray(slot?.players).map((v) => String(v || "").trim()).filter(Boolean);
    if (!rawPlayers.length) {
      return { ok: false, message: "Each submatch must have at least one selected player" };
    }

    const slotCategory = getSlotCategoryMeta(tournament, match, scoreIndex);
    const requiredPlayers = getRequiredPlayersForSlot(slotCategory);
    if (requiredPlayers != null && rawPlayers.length !== requiredPlayers) {
      return { ok: false, message: `Submatch ${scoreIndex + 1} requires exactly ${requiredPlayers} player(s)` };
    }

    const seenInSlot = new Set();
    const players = [];
    for (const raw of rawPlayers) {
      const found = rosterByKey.get(raw) || roster.find((p) => normalizeText(p?.playerName) === normalizeText(raw));
      if (!found) {
        return { ok: false, message: `Selected player not found in team roster: ${raw}` };
      }
      const pid = String(found?.playerId || found?.playerName || raw).trim();
      if (seenInSlot.has(pid)) {
        return { ok: false, message: `Duplicate player in the same submatch: ${found.playerName || raw}` };
      }
      seenInSlot.add(pid);
      usage.set(pid, (usage.get(pid) || 0) + 1);
      if (maxMatchesPerPlayer != null && usage.get(pid) > maxMatchesPerPlayer) {
        return { ok: false, message: `${found.playerName || raw} exceeds max matches per player (${maxMatchesPerPlayer})` };
      }
      players.push({
        playerId: pid,
        playerName: String(found?.playerName || raw).trim(),
        username: String(found?.username || "").trim(),
      });
    }

    normalizedAssignments.push({ scoreIndex, players });
  }

  return {
    ok: true,
    assignments: normalizedAssignments.sort((a, b) => a.scoreIndex - b.scoreIndex),
    usage: Object.fromEntries(usage.entries()),
    categoryId: resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true }),
  };
}

function applyLineupsToTie(match) {
  if (!match || typeof match !== "object") return match;
  const submatches = asArray(match.submatches);
  if (!submatches.length) return match;

  const homeAssignments = asArray(match?.lineups?.home?.assignments);
  const awayAssignments = asArray(match?.lineups?.away?.assignments);

  submatches.forEach((submatch, index) => {
    const home = homeAssignments.find((a) => Number(a?.scoreIndex) === index);
    const away = awayAssignments.find((a) => Number(a?.scoreIndex) === index);

    if (home) {
      submatch.homePlayers = asArray(home.players).map((p) => String(p?.playerName || p || "").trim()).filter(Boolean);
      submatch.homeLineup = cloneJson(home);
    }
    if (away) {
      submatch.awayPlayers = asArray(away.players).map((p) => String(p?.playerName || p || "").trim()).filter(Boolean);
      submatch.awayLineup = cloneJson(away);
    }

    if (submatch.homePlayers?.length) submatch.home = submatch.homePlayers.join(" + ");
    if (submatch.awayPlayers?.length) submatch.away = submatch.awayPlayers.join(" + ");
  });

  const approval = match.lineupApproval || {};
  const homeApproved = normalizeText(approval.home) === "accepted";
  const awayApproved = normalizeText(approval.away) === "accepted";
  if (homeApproved && awayApproved) {
    match.lineupLocked = true;
  }

  return match;
}

function makeMatchId() {
  return `M-${randomUUID()}`;
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
        roundLabel: null,
        scoreType: options.scoreType || "match",
        type: options.type || "match",
      }));
    }
    rounds.push(next);
  }

  return { rounds, totalRounds };
}

function getRoundLabel(roundIndex, totalRounds) {
  if (totalRounds <= 0) return "Round";
  const remaining = totalRounds - roundIndex;
  if (remaining === 1) return "Final";
  if (remaining === 2) return "Semi-final";
  if (remaining === 3) return "Quarter-final";
  return `Round ${roundIndex + 1}`;
}

function buildRoundRobinRounds(entrants) {
  const list = [...entrants];
  if (list.length < 2) return [];
  if (list.length % 2 === 1) list.push("BYE");

  let rotation = list.slice();
  const rounds = [];
  const n = rotation.length;

  for (let roundIndex = 0; roundIndex < n - 1; roundIndex += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const home = rotation[i];
      const away = rotation[n - 1 - i];
      if (home !== "BYE" && away !== "BYE") {
        pairs.push(ensureMatchMeta({
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

function parseTournamentStartDate(tournament) {
  const raw = String(tournament?.tournamentDates || "").trim();
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const dt = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T09:00:00`);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const dmy = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    const dt = new Date(`${year}-${month}-${day}T09:00:00`);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const dt = new Date();
  dt.setHours(9, 0, 0, 0);
  return dt;
}

function getAvailableCourtNames(tournament) {
  const adv = getAdvancedSettings(tournament);
  const desiredCount = Math.max(1, Number(tournament?.courtCount || adv?.courtCount || 0) || 0);

  const normalizeCourtList = (value) => {
    if (Array.isArray(value) && value.length) {
      const arr = value.map((x, i) => String(x || `Court ${i + 1}`).trim()).filter(Boolean);
      while (desiredCount && arr.length < desiredCount) arr.push(`Court ${arr.length + 1}`);
      return uniqStrings(arr);
    }
    if (typeof value === "string" && value.trim()) {
      const arr = value.split(",").map((x) => x.trim()).filter(Boolean);
      while (desiredCount && arr.length < desiredCount) arr.push(`Court ${arr.length + 1}`);
      return uniqStrings(arr);
    }
    return [];
  };

  const options = [tournament?.courtNames, adv?.courtNames, adv?.courts, tournament?.courts];
  for (const option of options) {
    const arr = normalizeCourtList(option);
    if (arr.length) return arr;
  }

  const fallbackCount = desiredCount || 3;
  return Array.from({ length: fallbackCount }, (_, i) => `Court ${i + 1}`);
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

function buildBalancedLeaguePairs(teamNames, requestedMatches) {
  const names = shuffle(teamNames.filter(Boolean));
  const teamCount = names.length;
  if (teamCount < 2) return { pairs: [], matchesPerTeam: 0 };

  let matchesPerTeam = Math.min(Math.max(1, Number(requestedMatches || 0)), teamCount - 1);
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
  for (let attempt = 0; attempt < 500; attempt += 1) {
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

function scheduleLeaguePairs(pairs, courtNames, baseDate, teamsByName = {}, submatchTemplates = []) {
  const matchDurationMs = 2 * 60 * 60 * 1000;
  const usableCourts = uniqStrings(courtNames).length ? uniqStrings(courtNames) : ["Court 1"];
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
    let bestChoice = null;

    usableCourts.forEach((court, courtIdx) => {
      const start = Math.max(
        baseTs,
        teamNext.get(pair.home) || baseTs,
        teamNext.get(pair.away) || baseTs,
        courtNext.get(court) || baseTs
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
        !bestChoice ||
        candidate.penalty < bestChoice.penalty ||
        (candidate.penalty === bestChoice.penalty && candidate.start < bestChoice.start) ||
        (candidate.penalty === bestChoice.penalty && candidate.start === bestChoice.start && candidate.usage < bestChoice.usage) ||
        (candidate.penalty === bestChoice.penalty && candidate.start === bestChoice.start && candidate.usage === bestChoice.usage && candidate.courtIdx < bestChoice.courtIdx)
      ) {
        bestChoice = candidate;
      }
    });

    const chosenCourt = bestChoice?.court || usableCourts[0];
    const chosenStart = bestChoice?.start || baseTs;
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
    const homeTeam = teamsByName[pair.home] || {};
    const awayTeam = teamsByName[pair.away] || {};

    return ensureMatchMeta({
      matchId: makeMatchId(),
      tieId: makeMatchId(),
      matchNo: index + 1,
      home: pair.home,
      away: pair.away,
      homeTeamId: homeTeam.teamId || "",
      awayTeamId: awayTeam.teamId || "",
      homePlayers: [pair.home],
      awayPlayers: [pair.away],
      date: formatDateInputValue(dt),
      time: formatTimeInputValue(dt),
      court: chosenCourt,
      stage: "league",
      type: "team_tie",
      roundLabel: `League Match ${index + 1}`,
      submatches: submatchTemplates.map((template, subIndex) => ({
        matchId: makeMatchId(),
        scoreIndex: subIndex,
        categoryId: template.categoryId,
        roundLabel: template.label,
        stage: "submatch",
        type: "submatch",
        home: pair.home,
        away: pair.away,
        homePlayers: [],
        awayPlayers: [],
        status: "pending",
      })),
      lineups: { home: null, away: null },
      lineupApproval: { home: "pending", away: "pending" },
      lineupLocked: false,
    });
  });
}

function getAcceptedPlayersForCategory(tournament, categoryId) {
  return getPlayers(tournament)
    .filter((p) => normalizeText(p?.status || "accepted") === "accepted")
    .filter((p) => String(p?.categoryId || "") === String(categoryId))
    .map((p) => String(p?.playerName || p?.name || p?.username || "").trim())
    .filter(Boolean);
}

function buildLeagueFixturesForCategory(tournament, categoryId, fixturesOverride) {
  const fixtures = normalizeFixtures(fixturesOverride || tournament?.fixtures || { categories: {} });
  const resolvedCategoryId = resolveCategoryId(tournament, categoryId, { preferSyntheticForTeam: true });
  if (!resolvedCategoryId) return { fixtures, teams: [], categoryId: null };

  if (isTeamTournament(tournament)) {
    const teams = buildTeamsFromTournament(tournament, resolvedCategoryId);
    const requestedRounds = getLeagueRoundsRequested(tournament) || Math.max(1, teams.length - 1);
    const { pairs, matchesPerTeam } = buildBalancedLeaguePairs(teams.map((t) => t.teamName), requestedRounds);
    const teamsByName = Object.fromEntries(teams.map((t) => [t.teamName, t]));
    const submatchTemplates = getTournamentCategories(tournament).map((category, idx) => ({
      categoryId: String(category.categoryId || `submatch_${idx + 1}`),
      label: category.eventName || categoryLabel(category) || `Submatch ${idx + 1}`,
    }));
    const scheduled = scheduleLeaguePairs(pairs, getAvailableCourtNames(tournament), parseTournamentStartDate(tournament), teamsByName, submatchTemplates);

    fixtures.tournamentType = "team";
    fixtures.teamCategories = getTournamentCategories(tournament);
    fixtures.categories[resolvedCategoryId] = {
      categoryId: resolvedCategoryId,
      label: `League schedule • ${matchesPerTeam} matches per team`,
      displayMode: "team_schedule",
      rounds: [scheduled],
      matches: scheduled,
      totalRounds: 1,
      teams: teams.map((t) => ({ teamId: t.teamId, teamName: t.teamName, captainName: t.captainName })),
    };

    return { fixtures, teams, categoryId: resolvedCategoryId };
  }

  const category = getCategory(tournament, resolvedCategoryId);
  const entrants = getAcceptedPlayersForCategory(tournament, resolvedCategoryId);
  const teamSize = toFiniteNumber(category?.teamSize, 1) || 1;
  const built = buildEntrants(entrants, teamSize);
  const rounds = buildRoundRobinRounds(built.entrants);

  fixtures.categories[resolvedCategoryId] = {
    categoryId: resolvedCategoryId,
    label: category?.eventName || category?.categoryId || "Category",
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

  if (scorePayload?.computed && typeof scorePayload.computed === "object") {
    const existing = scorePayload.computed;
    return {
      status: String(existing.status || "pending"),
      winnerSide: existing.winnerSide || null,
      winnerName: existing.winnerName || null,
      reason: existing.reason || "Provided by client",
      aValue: Number(existing.aValue || a || 0),
      bValue: Number(existing.bValue || b || 0),
    };
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

  if (nextMatch.type === "team_tie" && !Array.isArray(nextMatch.submatches)) {
    nextMatch.submatches = [];
  }
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

function getPairKey(a, b) {
  return [String(a || "").trim(), String(b || "").trim()].sort().join("::");
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
        const drawPoints = toFiniteNumber(pointsRule.draw, useMatchPointsRanking ? 0 : 1) || 0;
        home.leaguePoints += drawPoints;
        away.leaguePoints += drawPoints;
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

  const bracket = createBracket(
    entrants,
    Object.fromEntries(entrants.map((entry) => [entry, [entry]])),
    { stage: "knockout", type: isTeamTournament(tournament) ? "team_tie" : "match" }
  );
  if (!bracket) return { changed: false, fixtures };

  const submatchTemplates = isTeamTournament(tournament)
    ? getTournamentCategories(tournament).map((category, idx) => ({
        categoryId: String(category.categoryId || `submatch_${idx + 1}`),
        label: category.eventName || categoryLabel(category) || `Submatch ${idx + 1}`,
      }))
    : [];

  bracket.rounds.forEach((round, idx) => {
    round.forEach((match) => {
      match.stage = "knockout";
      match.roundLabel = getRoundLabel(idx, bracket.totalRounds);
      if (isTeamTournament(tournament)) {
        match.type = "team_tie";
        match.lineups = { home: null, away: null };
        match.lineupApproval = { home: "pending", away: "pending" };
        match.lineupLocked = false;
        match.submatches = submatchTemplates.map((template, subIndex) => ({
          matchId: makeMatchId(),
          scoreIndex: subIndex,
          categoryId: template.categoryId,
          roundLabel: template.label,
          stage: "submatch",
          type: "submatch",
          home: match.home,
          away: match.away,
          homePlayers: [],
          awayPlayers: [],
          status: "pending",
        }));
      }
    });
  });

  bucket.rounds = [...asArray(bucket.rounds), ...bracket.rounds];
  bucket.totalRounds = asArray(bucket.rounds).length;
  return { changed: true, fixtures };
}

module.exports = {
  TEAM_EVENT_CATEGORY_ID,
  normalizeText,
  getCategory,
  buildTeamsFromTournament,
  validateLineupSubmission,
  applyLineupsToTie,
  isLineupLocked,
  getTeamNumberState,
  buildLeagueFixturesForCategory,
  computeLeaderboardRows,
  appendKnockoutRoundsIfNeeded,
  propagateKnockoutWinner,
  findMatch,
  scoreIndividualMatch,
  summarizeTieMatch,
  isPickleballTeamLeague,
};
