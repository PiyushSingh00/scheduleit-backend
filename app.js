const express = require("express");
const AWS = require("aws-sdk");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "scheduleit_secret_key";
const PORT = process.env.PORT || 4000; // backend will listen here
const REGION = "eu-north-1"; // change if your DynamoDB region is different
const USERS_TABLE = "ScheduleItUsers";
const USER_DETAILS_TABLE="scheduleit-user-details";
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

    const isMatch = await bcrypt.compare(password, result.Item.passwordHash);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const details = await getUserDetails(normalizedUsername);
    const token = jwt.sign(
      {
        username: normalizedUsername
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    const user = details
      ? {
          ...details,
          phone: normalizePhone(
            details?.phone ||
            details?.phoneNumber ||
            details?.mobile ||
            ""
          ),
        }
      : {
          username: normalizedUsername,
        };

    res.json({ token, user });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
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

