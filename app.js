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
      // photo is coming from frontend, but since we're not handling file upload here,
      // we can ignore it or accept a photoUrl string later
    } = req.body;

    if (!username || !password || !name || !phone || !role) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const normalizedUsername = username.trim().toLowerCase();

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

	const token = jwt.sign(
  	{
    	username: normalizedUsername
  	},
  	JWT_SECRET,
  	{ expiresIn: "7d" }
	);


    res.json({ token });

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




