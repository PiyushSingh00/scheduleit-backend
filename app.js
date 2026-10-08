const express = require("express");
const AWS = require("aws-sdk");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const crypto = require("crypto");
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "scheduleit_secret_key";
const PORT = process.env.PORT || 4000; // backend will listen here
const REGION = "eu-north-1"; // change if your DynamoDB region is different
const USERS_TABLE = "ScheduleItUsers";
const USER_DETAILS_TABLE="scheduleit-user-details";
const GOOGLE_OAUTH_SCOPE = "openid email profile";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SECURITY_QUESTIONS = {
  first_school: "What was the name of your first school?",
  childhood_nickname: "What was your childhood nickname?",
  first_coach: "What was the name of your first coach?",
  favorite_teacher: "What was the name of your favorite teacher?",
  birth_city: "In which city were you born?",
};
// AWS SDK config (EC2 role will supply credentials automatically)
AWS.config.update({ region: REGION });
const ddb = new AWS.DynamoDB.DocumentClient();
const jwt = require("jsonwebtoken");

app.set("trust proxy", true);

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function normalizeSecurityQuestionKey(value) {
  const key = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(SECURITY_QUESTIONS, key) ? key : "";
}

function normalizeSecurityAnswer(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function getUserDetails(username) {
  const result = await ddb.get({
    TableName: USER_DETAILS_TABLE,
    Key: { username },
  }).promise();
  return result.Item || null;
}

function createAuthToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function signState(payload) {
  const encoded = toBase64Url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyState(state) {
  try {
    const [encoded, sig] = String(state || "").split(".");
    if (!encoded || !sig) return null;

    const expected = crypto.createHmac("sha256", JWT_SECRET).update(encoded).digest("base64url");
    if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const payload = JSON.parse(fromBase64Url(encoded));
    if (!payload?.createdAt || Date.now() - Number(payload.createdAt) > 10 * 60 * 1000) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function getGoogleRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${baseUrl.replace(/\/+$/, "")}/api/auth/google/callback`;
}

function getSafeNextPath(value) {
  const next = String(value || "").trim().toLowerCase();
  if (next === "host" || next === "host.html") return "host.html";
  if (next === "join" || next === "join.html") return "join.html";
  return "";
}

function redirectGoogleResult(res, params) {
  const fragment = new URLSearchParams(params).toString();
  return res.redirect(`/index.html#${fragment}`);
}

function normalizeGoogleUsername(email) {
  const localPart = String(email || "").split("@")[0] || "googleuser";
  return localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32) || "googleuser";
}

async function usernameExists(username) {
  const result = await ddb.get({
    TableName: USERS_TABLE,
    Key: { username },
  }).promise();
  return Boolean(result.Item);
}

async function createUniqueGoogleUsername(email) {
  const base = normalizeGoogleUsername(email);
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    if (!(await usernameExists(candidate))) return candidate;
  }

  return `google-${crypto.randomUUID().slice(0, 8)}`;
}

async function findUserDetailsByGoogleProfile(profile) {
  const email = String(profile.email || "").trim().toLowerCase();
  const googleSub = String(profile.sub || "").trim();

  const result = await ddb.scan({
    TableName: USER_DETAILS_TABLE,
    FilterExpression: "googleSub = :googleSub OR email = :email",
    ExpressionAttributeValues: {
      ":googleSub": googleSub,
      ":email": email,
    },
  }).promise();

  const items = result.Items || [];
  return (
    items.find((item) => String(item.googleSub || "") === googleSub) ||
    items.find((item) => String(item.email || "").toLowerCase() === email) ||
    null
  );
}

async function updateGoogleLink(username, profile, now) {
  await ddb.update({
    TableName: USER_DETAILS_TABLE,
    Key: { username },
    UpdateExpression: [
      "SET googleSub = :googleSub",
      "googleEmail = :googleEmail",
      "emailVerified = :emailVerified",
      "authProvider = if_not_exists(authProvider, :authProvider)",
      "lastLoginAt = :lastLoginAt",
    ].join(", "),
    ExpressionAttributeValues: {
      ":googleSub": profile.sub,
      ":googleEmail": profile.email,
      ":emailVerified": Boolean(profile.email_verified),
      ":authProvider": "google",
      ":lastLoginAt": now,
    },
  }).promise();
}

async function findOrCreateGoogleUser(profile) {
  const now = new Date().toISOString();
  const existing = await findUserDetailsByGoogleProfile(profile);

  if (existing?.username) {
    await updateGoogleLink(existing.username, profile, now);
    return existing.username;
  }

  const username = await createUniqueGoogleUsername(profile.email);
  const name = String(profile.name || profile.email || username).trim();

  await ddb.put({
    TableName: USERS_TABLE,
    Item: {
      username,
      authProvider: "google",
      googleSub: profile.sub,
      createdAt: now,
    },
    ConditionExpression: "attribute_not_exists(username)",
  }).promise();

  await ddb.put({
    TableName: USER_DETAILS_TABLE,
    Item: {
      username,
      name,
      email: String(profile.email || "").trim().toLowerCase(),
      phone: "",
      role: "both",
      mode: "player",
      authProvider: "google",
      googleSub: profile.sub,
      googleEmail: String(profile.email || "").trim().toLowerCase(),
      emailVerified: Boolean(profile.email_verified),
      photoUrl: profile.picture || null,
      createdAt: now,
      lastLoginAt: now,
    },
  }).promise();

  return username;
}

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cors()); // okay since frontend is same origin, but fine to keep

const hostRoutes = require("./routes/host");
app.use("/api/host", hostRoutes);
console.log("Host routes registered");

const tournamentRoutes = require("./routes/tournaments");
const sportsRoutes = require("./routes/sports");

app.use("/api/tournaments", tournamentRoutes);
app.use("/api/sports", sportsRoutes);


const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // No token sent
  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  // Format: "Bearer TOKEN"
  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Attach user info to request
    req.user = decoded;

    next(); // allow request to continue
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};


const playerRoutes = require("./routes/player");
app.use("/api/player", authMiddleware, playerRoutes);
console.log("Player routes registered");
// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Register new user

app.post("/api/register", async (req, res) => {
  try {
    const {
      username,
      password,
      name,
      email,
      phone,
      role,
      securityQuestion,
      securityAnswer,
      // photo is coming from frontend, but since we're not handling file upload here,
      // we can ignore it or accept a photoUrl string later
    } = req.body;

    if (!username || !password || !name || !phone || !role || !securityQuestion || !securityAnswer) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const normalizedSecurityQuestion = normalizeSecurityQuestionKey(securityQuestion);
    const normalizedSecurityAnswer = normalizeSecurityAnswer(securityAnswer);

    if (!normalizedSecurityQuestion) {
      return res.status(400).json({ message: "Invalid security question" });
    }

    if (!normalizedSecurityAnswer) {
      return res.status(400).json({ message: "Security answer is required" });
    }

    // 1. check if username already exists in auth table
    const existing = await ddb
      .get({
        TableName: USERS_TABLE,
        Key: { username: normalizedUsername },
      })
      .promise();

    if (existing.Item) {
      return res.status(409).json({ message: "Username already taken" });
    }

    // 2. hash password
    const passwordHash = await bcrypt.hash(password, 10);
    const securityAnswerHash = await bcrypt.hash(normalizedSecurityAnswer, 10);

    const now = new Date().toISOString();

    // 3. create auth user
    const authPut = ddb
      .put({
        TableName: USERS_TABLE,
        Item: {
          username: normalizedUsername,
          passwordHash,
          createdAt: now,
        },
      })
      .promise();

    // 4. create user details
    // 4. create user details


const detailsPut = ddb
  .put({
    TableName: USER_DETAILS_TABLE,
    Item: {
      username: normalizedUsername,
      name,
      email: email || null,
      phone: normalizePhone(phone),

      role: role || "both",   // 👈 no restriction anymore
      mode: "player",         // 👈 DEFAULT LANDING MODE
      securityQuestionKey: normalizedSecurityQuestion,
      securityQuestionLabel: SECURITY_QUESTIONS[normalizedSecurityQuestion],
      securityAnswerHash,
      securityQuestionSetAt: now,

      photoUrl: null,
      createdAt: now,
    },
  })
  .promise();

    // 5. execute both writes in parallel
    await Promise.all([authPut, detailsPut]);

    return res.status(201).json({
      username: normalizedUsername,
      role,
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/forgot-password/question", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const phone = normalizePhone(req.body?.phone || "");

    if (!username || !phone) {
      return res.status(400).json({ message: "Username and phone are required" });
    }

    const details = await getUserDetails(username);
    if (!details) {
      return res.status(404).json({ message: "Account not found" });
    }

    const savedPhone = normalizePhone(
      details.phone ||
      details.phoneNumber ||
      details.mobile ||
      ""
    );

    if (!savedPhone || savedPhone !== phone) {
      return res.status(403).json({ message: "Username and phone do not match" });
    }

    return res.json({
      ok: true,
      username,
      phone,
    });
  } catch (err) {
    console.error("Forgot password question error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/forgot-password/reset", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const phone = normalizePhone(req.body?.phone || "");
    const newPassword = String(req.body?.newPassword || "");

    if (!username || !phone || !newPassword) {
      return res.status(400).json({ message: "Username, phone, and new password are required" });
    }

    const userAuth = await ddb.get({
      TableName: USERS_TABLE,
      Key: { username },
    }).promise();

    if (!userAuth.Item) {
      return res.status(404).json({ message: "Account not found" });
    }

    const details = await getUserDetails(username);
    if (!details) {
      return res.status(404).json({ message: "Account details not found" });
    }

    const savedPhone = normalizePhone(
      details.phone ||
      details.phoneNumber ||
      details.mobile ||
      ""
    );

    if (!savedPhone || savedPhone !== phone) {
      return res.status(403).json({ message: "Username and phone do not match" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await ddb.update({
      TableName: USERS_TABLE,
      Key: { username },
      UpdateExpression: "SET passwordHash = :passwordHash",
      ExpressionAttributeValues: {
        ":passwordHash": passwordHash,
      },
    }).promise();

    return res.json({ ok: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Forgot password reset error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});




// Login

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Missing username or password" });
    }

    const normalizedUsername = username.trim().toLowerCase();

    const result = await ddb.get({
      TableName: USERS_TABLE,
      Key: { username: normalizedUsername },
    }).promise();

    if (!result.Item) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!result.Item.passwordHash) {
      return res.status(401).json({ message: "Use Google login for this account" });
    }

    const isMatch = await bcrypt.compare(password, result.Item.passwordHash);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = createAuthToken(normalizedUsername);

    res.json({ token });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/auth/google/config", (req, res) => {
  res.json({
    enabled: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  });
});

app.get("/api/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return redirectGoogleResult(res, {
      google_error: "Google login is not configured yet.",
    });
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", getGoogleRedirectUri(req));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
  authUrl.searchParams.set("state", signState({
    createdAt: Date.now(),
    next: getSafeNextPath(req.query.next),
  }));
  authUrl.searchParams.set("prompt", "select_account");

  return res.redirect(authUrl.toString());
});

app.get("/api/auth/google/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return redirectGoogleResult(res, {
        google_error: "Google login was cancelled.",
      });
    }

    const code = String(req.query.code || "");
    const state = verifyState(req.query.state);

    if (!code || !state) {
      return redirectGoogleResult(res, {
        google_error: "Google login could not be verified.",
      });
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: getGoogleRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });

    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenPayload.access_token) {
      console.error("Google token exchange failed:", tokenPayload);
      return redirectGoogleResult(res, {
        google_error: "Google login failed during token exchange.",
      });
    }

    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
      },
    });

    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified === false) {
      console.error("Google profile fetch failed:", profile);
      return redirectGoogleResult(res, {
        google_error: "Google account email could not be verified.",
      });
    }

    const username = await findOrCreateGoogleUser({
      ...profile,
      email: String(profile.email || "").trim().toLowerCase(),
    });

    return redirectGoogleResult(res, {
      google_token: createAuthToken(username),
      next: state.next || "",
    });
  } catch (err) {
    console.error("Google login callback error:", err);
    return redirectGoogleResult(res, {
      google_error: "Google login failed. Please try again.",
    });
  }
});


// Start server
console.log("🔥 PROCESS PORT =", process.env.PORT);
app.listen(PORT, () => {
  console.log(`Auth server running on port ${PORT}`);
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;

    const result = await ddb.get({
      TableName: USER_DETAILS_TABLE,
      Key: { username }
    }).promise();

    if (!result.Item) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
  ...result.Item,
  phone: normalizePhone(
    result.Item?.phone ||
    result.Item?.phoneNumber ||
    result.Item?.mobile ||
    ""
  ),
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/user/mode", authMiddleware, async (req, res) => {
  try {
    const { mode } = req.body;
    if (!["host", "player"].includes(mode)) {
      return res.status(400).json({ message: "Invalid mode" });
    }

    const username = req.user.username;

    await ddb.update({
      TableName: USER_DETAILS_TABLE,
      Key: { username },
      UpdateExpression: "SET #m = :m",
      ExpressionAttributeNames: { "#m": "mode" },
      ExpressionAttributeValues: { ":m": mode }
    }).promise();

    res.json({ mode });
  } catch (err) {
    console.error("Update mode error:", err);
    res.status(500).json({ message: "Server error" });
  }
});
