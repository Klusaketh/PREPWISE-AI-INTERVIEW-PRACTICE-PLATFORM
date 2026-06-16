import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 5173);
const isProduction = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(express.json({ limit: "5mb" }));

// Constants
const SESSION_SECRET = process.env.SESSION_SECRET || "prepwise_secret_key_default";

// Hashing Helpers
function hashPassword(password) {
  const salt = "prepwise_salt_constant";
  return crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
}

// Token Helpers
function generateToken(user) {
  const payload = JSON.stringify({
    id: user.id,
    email: user.email,
    role: user.role,
    expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });
  const payloadB64 = Buffer.from(payload).toString("base64");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("hex");
  return `${payloadB64}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("hex");
  if (signature !== expectedSignature) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    if (payload.expires < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Security Middlewares
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }
  const token = authHeader.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: "Access denied. Invalid or expired token." });
  }
  // Load full user details
  const user = db.users.findOne((u) => u.id === decoded.id);
  if (!user) {
    return res.status(401).json({ error: "User not found." });
  }
  if (user.status === "suspended") {
    return res.status(403).json({ error: "Your account has been suspended. Please contact administration." });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Administrator privileges required." });
  }
  next();
}

// Rate Limiter for Auth
const rateLimitMap = new Map();
function authRateLimiter(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 mins
  const maxRequests = 15;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const timestamps = rateLimitMap.get(ip).filter((t) => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length > maxRequests) {
    return res.status(429).json({ error: "Too many requests. Please try again after 15 minutes." });
  }
  next();
}

// Ensure default settings exist in DB
if (db.settings.find().length === 0) {
  db.settings.insert({
    timerType: "full", // "full", "question", or "none"
    timerDuration: 900, // 15 minutes (900s) default
  });
}

// --- AUTHENTICATION ENDPOINTS ---

app.post("/api/auth/signup", authRateLimiter, (req, res) => {
  const { name, email, password } = req.body;
  
  if (!email || !password || !name) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }
  if (!email.includes("@")) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters long." });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Strict duplicate account check
  const existingUser = db.users.findOne((u) => u.email === normalizedEmail);
  if (existingUser) {
    return res.status(400).json({ error: "An account already exists with this email. Please sign in." });
  }

  const user = db.users.insert({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    role: "user",
    status: "active",
    provider: "local",
  });

  const token = generateToken(user);
  res.status(201).json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  });
});

app.post("/api/auth/signin", authRateLimiter, (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const user = db.users.findOne((u) => u.email === normalizedEmail);

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  if (user.status === "suspended") {
    return res.status(403).json({ error: "Your account is suspended. Please contact support." });
  }

  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      status: req.user.status,
    },
  });
});


// --- ADMIN SETTINGS ENDPOINTS ---

app.get("/api/admin/settings", requireAuth, (req, res) => {
  const settingsObj = db.settings.find()[0];
  res.json(settingsObj);
});

app.put("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const { timerType, timerDuration } = req.body;
  if (!["full", "question", "none"].includes(timerType)) {
    return res.status(400).json({ error: "Invalid timer type configuration." });
  }
  const settingsObj = db.settings.find()[0];
  const updated = db.settings.update(settingsObj.id, {
    timerType,
    timerDuration: Number(timerDuration) || 900,
  });
  res.json(updated);
});


// --- ADMIN USER MANAGEMENT ENDPOINTS ---

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const { search, status } = req.query;
  let users = db.users.find().map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    provider: u.provider,
    createdAt: u.createdAt,
  }));

  if (search) {
    const q = search.toLowerCase();
    users = users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }

  if (status && status !== "all") {
    users = users.filter((u) => u.status === status);
  }

  res.json(users);
});

app.put("/api/admin/users/:id/status", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (id === req.user.id) {
    return res.status(400).json({ error: "You cannot change your own status." });
  }
  if (!["active", "suspended"].includes(status)) {
    return res.status(400).json({ error: "Invalid user status configuration." });
  }

  const updated = db.users.update(id, { status });
  if (!updated) {
    return res.status(404).json({ error: "User not found." });
  }

  res.json({ id: updated.id, status: updated.status });
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }

  const success = db.users.delete(id);
  if (!success) {
    return res.status(404).json({ error: "User not found." });
  }

  // Cascade delete user bookmarks and sessions
  db.bookmarks.deleteMany((b) => b.userId === id);
  db.practiceSessions.deleteMany((s) => s.userId === id);
  db.prepProgress.deleteMany((p) => p.userId === id);

  res.json({ success: true });
});

app.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  const allUsers = db.users.find();
  const allSessions = db.practiceSessions.find();
  const allQuestions = db.questions.find();

  // Questions Attempted Today
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const attemptedToday = allSessions.filter((s) => new Date(s.completedAt) >= startOfToday).reduce((sum, s) => sum + (s.questions || 5), 0);

  // Recent activity: Combine signups and practices sorted by date
  const signups = allUsers.map((u) => ({
    type: "signup",
    name: u.name,
    email: u.email,
    date: u.createdAt,
  }));
  const practices = allSessions.map((s) => {
    const user = allUsers.find((u) => u.id === s.userId);
    return {
      type: "practice",
      name: user ? user.name : "Unknown User",
      role: s.role,
      score: s.score,
      date: s.completedAt,
    };
  });

  const recentActivity = [...signups, ...practices]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  res.json({
    totalUsers: allUsers.length,
    activeUsers: allUsers.filter((u) => u.status === "active").length,
    totalSessions: allSessions.length,
    totalQuestions: allQuestions.length,
    attemptedToday,
    recentActivity,
  });
});


// --- ADMIN QUESTION CRUD & MANAGEMENT ENDPOINTS ---

app.get("/api/questions", requireAuth, (req, res) => {
  const { category, difficulty, search } = req.query;
  let questions = db.questions.find();

  if (category && category !== "all") {
    questions = questions.filter((q) => q.category.toLowerCase() === category.toLowerCase());
  }

  if (difficulty && difficulty !== "all") {
    questions = questions.filter((q) => q.difficulty.toLowerCase() === difficulty.toLowerCase());
  }

  if (search) {
    const q = search.toLowerCase();
    questions = questions.filter(
      (qItem) =>
        qItem.question.toLowerCase().includes(q) ||
        (qItem.explanation && qItem.explanation.toLowerCase().includes(q)) ||
        (qItem.tags && qItem.tags.some((t) => t.toLowerCase().includes(q)))
    );
  }

  res.json(questions);
});

app.post("/api/questions", requireAuth, requireAdmin, (req, res) => {
  const { question, category, difficulty, answer, explanation, tips, tags } = req.body;

  if (!question || !category || !difficulty || !answer) {
    return res.status(400).json({ error: "Question, Category, Difficulty, and Expected Answer are required." });
  }

  // Prevent duplicates
  const existing = db.questions.findOne((q) => q.question.toLowerCase().trim() === question.toLowerCase().trim());
  if (existing) {
    return res.status(400).json({ error: "This question already exists in the question bank." });
  }

  const newQuestion = db.questions.insert({
    question: question.trim(),
    category: category.trim(),
    difficulty: difficulty.trim(),
    answer: answer.trim(),
    explanation: explanation ? explanation.trim() : "",
    tips: Array.isArray(tips) ? tips : tips ? [tips.trim()] : [],
    tags: Array.isArray(tags) ? tags : tags ? [tags.trim()] : [],
    createdBy: req.user.id,
  });

  res.status(201).json(newQuestion);
});

app.put("/api/questions/:id", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { question, category, difficulty, answer, explanation, tips, tags } = req.body;

  const updated = db.questions.update(id, {
    question: question?.trim(),
    category: category?.trim(),
    difficulty: difficulty?.trim(),
    answer: answer?.trim(),
    explanation: explanation?.trim(),
    tips: Array.isArray(tips) ? tips : undefined,
    tags: Array.isArray(tags) ? tags : undefined,
  });

  if (!updated) {
    return res.status(404).json({ error: "Question not found." });
  }

  res.json(updated);
});

app.delete("/api/questions/:id", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const success = db.questions.delete(id);
  if (!success) {
    return res.status(404).json({ error: "Question not found." });
  }
  // Cascading delete bookmarks matching this question
  db.bookmarks.deleteMany((b) => b.questionId === id);
  res.json({ success: true });
});

// CSV parser helper
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  
  // Header parse
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^["']|["']$/g, ""));
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let currentVal = "";
    let inQuotes = false;

    // Correctly split by comma ignoring commas inside quotes
    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const char = line[charIdx];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(currentVal.trim().replace(/^["']|["']$/g, "").replace(/""/g, '"'));
        currentVal = "";
      } else {
        currentVal += char;
      }
    }
    values.push(currentVal.trim().replace(/^["']|["']$/g, "").replace(/""/g, '"'));

    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = values[idx] || "";
    });
    result.push(obj);
  }
  return result;
}

app.post("/api/questions/bulk-upload", requireAuth, requireAdmin, (req, res) => {
  const { format, data } = req.body;

  if (!format || !data) {
    return res.status(400).json({ error: "Format ('csv' or 'json') and data are required." });
  }

  let parsedQuestions = [];
  try {
    if (format === "json") {
      parsedQuestions = typeof data === "string" ? JSON.parse(data) : data;
    } else if (format === "csv") {
      parsedQuestions = parseCSV(data);
    } else {
      return res.status(400).json({ error: "Unsupported format. Use 'csv' or 'json'." });
    }
  } catch (error) {
    return res.status(400).json({ error: `Parsing error: ${error.message}` });
  }

  if (!Array.isArray(parsedQuestions)) {
    return res.status(400).json({ error: "Uploaded data must represent a list of questions." });
  }

  // Validate items
  const validItems = [];
  const errors = [];
  const existingQuestionsList = db.questions.find();

  parsedQuestions.forEach((item, index) => {
    const q = item.question || item.Question;
    const cat = item.category || item.Category;
    const diff = item.difficulty || item.Difficulty;
    const ans = item.answer || item.ExpectedAnswer || item.Answer || item.expectedAnswer;
    const expl = item.explanation || item.Explanation || "";
    const tipsVal = item.tips || item.Tips || "";
    const tagsVal = item.tags || item.Tags || "";

    if (!q || !cat || !diff || !ans) {
      errors.push(`Row ${index + 1}: Missing required fields (question, category, difficulty, answer).`);
      return;
    }

    // Check duplicate in database or in active import set
    const isDuplicate =
      existingQuestionsList.some((eq) => eq.question.toLowerCase().trim() === q.toLowerCase().trim()) ||
      validItems.some((vi) => vi.question.toLowerCase().trim() === q.toLowerCase().trim());

    if (isDuplicate) {
      errors.push(`Row ${index + 1}: Duplicate question: "${q.substring(0, 30)}..."`);
      return;
    }

    validItems.push({
      question: q.trim(),
      category: cat.trim(),
      difficulty: diff.trim(),
      answer: ans.trim(),
      explanation: expl.trim(),
      tips: Array.isArray(tipsVal)
        ? tipsVal
        : typeof tipsVal === "string"
          ? tipsVal.split(";").map((t) => t.trim()).filter(Boolean)
          : [],
      tags: Array.isArray(tagsVal)
        ? tagsVal
        : typeof tagsVal === "string"
          ? tagsVal.split(";").map((t) => t.trim()).filter(Boolean)
          : [],
      createdBy: req.user.id,
    });
  });

  if (validItems.length === 0) {
    return res.status(400).json({ error: "No valid questions were imported.", details: errors });
  }

  // Batch insert
  db.questions.insertMany(validItems);

  res.json({
    message: `Successfully uploaded ${validItems.length} questions.`,
    importedCount: validItems.length,
    rejectedCount: errors.length,
    details: errors,
  });
});


// --- PREPARATION HUB ENDPOINTS ---

app.get("/api/prep/content", requireAuth, (req, res) => {
  const content = db.prepContent.find();
  res.json(content);
});

app.get("/api/prep/progress", requireAuth, (req, res) => {
  const progress = db.prepProgress.find((p) => p.userId === req.user.id);
  res.json(progress);
});

app.post("/api/prep/progress", requireAuth, (req, res) => {
  const { category, topic, studied, quizScore, quizTotal } = req.body;

  if (!category || !topic) {
    return res.status(400).json({ error: "Category and topic are required." });
  }

  const existing = db.prepProgress.findOne(
    (p) => p.userId === req.user.id && p.category === category && p.topic === topic
  );

  if (existing) {
    const updated = db.prepProgress.update(existing.id, {
      studied: studied !== undefined ? studied : existing.studied,
      quizScore: quizScore !== undefined ? quizScore : existing.quizScore,
      quizTotal: quizTotal !== undefined ? quizTotal : existing.quizTotal,
    });
    res.json(updated);
  } else {
    const inserted = db.prepProgress.insert({
      userId: req.user.id,
      category,
      topic,
      studied: studied || false,
      quizScore: quizScore !== undefined ? quizScore : null,
      quizTotal: quizTotal !== undefined ? quizTotal : null,
    });
    res.status(201).json(inserted);
  }
});


// --- PRACTICE SESSIONS ENDPOINTS ---

app.get("/api/practice-sessions", requireAuth, (req, res) => {
  const sessions = db.practiceSessions.find((s) => s.userId === req.user.id);
  // Sort descending by date
  sessions.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  res.json(sessions);
});

app.post("/api/practice-sessions", requireAuth, (req, res) => {
  const { score, duration, strengths, weaknesses, role, answers } = req.body;

  if (score === undefined || duration === undefined || !role) {
    return res.status(400).json({ error: "Score, duration, and role/track are required." });
  }

  const session = db.practiceSessions.insert({
    userId: req.user.id,
    role,
    score: Number(score),
    duration: Number(duration),
    strengths: Array.isArray(strengths) ? strengths : [],
    weaknesses: Array.isArray(weaknesses) ? weaknesses : [],
    answers: Array.isArray(answers) ? answers : [],
    completedAt: new Date().toISOString(),
  });

  res.status(201).json(session);
});

app.get("/api/practice-sessions/stats", requireAuth, (req, res) => {
  const userId = req.user.id;
  const sessions = db.practiceSessions.find((s) => s.userId === userId);
  const progress = db.prepProgress.find((p) => p.userId === userId);
  const bookmarks = db.bookmarks.find((b) => b.userId === userId);

  const totalInterviews = sessions.length;
  const averageScore = totalInterviews
    ? Math.round(sessions.reduce((sum, s) => sum + s.score, 0) / totalInterviews)
    : 0;

  // Study progress completion
  const totalTopicsCount = db.prepContent.find().length || 10;
  const completedTopicsCount = progress.filter((p) => p.studied).length;
  const studyProgressPercent = Math.round((completedTopicsCount / totalTopicsCount) * 100) || 0;

  // Streak counter logic: count consecutive days practicing
  let streak = 0;
  if (totalInterviews > 0) {
    const dates = sessions
      .map((s) => new Date(s.completedAt).toDateString())
      .filter((v, idx, self) => self.indexOf(v) === idx)
      .map((d) => new Date(d));

    // Sort descending
    dates.sort((a, b) => b - a);

    const todayStr = new Date().toDateString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();

    const checkDate = dates[0].toDateString();
    if (checkDate === todayStr || checkDate === yesterdayStr) {
      streak = 1;
      let currentCheck = dates[0];
      for (let idx = 1; idx < dates.length; idx++) {
        const diffTime = Math.abs(currentCheck - dates[idx]);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          streak++;
          currentCheck = dates[idx];
        } else if (diffDays > 1) {
          break;
        }
      }
    }
  }

  // Strongest / Weakest categories based on session scores
  const roleScores = {};
  sessions.forEach((s) => {
    if (!roleScores[s.role]) {
      roleScores[s.role] = [];
    }
    roleScores[s.role].push(s.score);
  });

  let strongest = "None";
  let weakest = "None";
  let maxAvg = -1;
  let minAvg = 101;

  Object.entries(roleScores).forEach(([roleName, scoresList]) => {
    const avg = scoresList.reduce((sum, sc) => sum + sc, 0) / scoresList.length;
    if (avg > maxAvg) {
      maxAvg = avg;
      strongest = roleName;
    }
    if (avg < minAvg) {
      minAvg = avg;
      weakest = roleName;
    }
  });

  // Recent activity log: combine bookmarks additions, study completions, and mock sessions
  const logs = [];
  sessions.forEach((s) => {
    logs.push({
      id: s.id,
      type: "practice",
      message: `Completed ${s.role} session`,
      detail: `Score: ${s.score}%`,
      date: s.completedAt,
    });
  });
  progress.forEach((p) => {
    if (p.studied) {
      logs.push({
        id: p.id,
        type: "study",
        message: `Studied topic "${p.topic}"`,
        detail: p.quizScore !== null ? `Quiz: ${p.quizScore}/${p.quizTotal}` : "Read material",
        date: p.updatedAt || p.createdAt,
      });
    }
  });
  bookmarks.forEach((b) => {
    const question = db.questions.findOne((q) => q.id === b.questionId);
    logs.push({
      id: b.id,
      type: "bookmark",
      message: `Bookmarked a question`,
      detail: question ? question.question.substring(0, 30) + "..." : "Saved Question",
      date: b.createdAt,
    });
  });

  logs.sort((a, b) => new Date(b.date) - new Date(a.date));

  res.json({
    totalInterviews,
    averageScore,
    strongestTopics: strongest,
    weakestTopics: weakest,
    studyProgress: studyProgressPercent,
    streakCounter: streak,
    bookmarkedCount: bookmarks.length,
    recentActivity: logs.slice(0, 10),
  });
});


// --- BOOKMARKS ENDPOINTS ---

app.get("/api/bookmarks", requireAuth, (req, res) => {
  const userBookmarks = db.bookmarks.find((b) => b.userId === req.user.id);
  const bookmarkedQuestions = userBookmarks
    .map((b) => db.questions.findOne((q) => q.id === b.questionId))
    .filter(Boolean);
  res.json(bookmarkedQuestions);
});

app.post("/api/bookmarks/toggle", requireAuth, (req, res) => {
  const { questionId } = req.body;

  if (!questionId) {
    return res.status(400).json({ error: "Question ID is required." });
  }

  const existing = db.bookmarks.findOne((b) => b.userId === req.user.id && b.questionId === questionId);

  if (existing) {
    db.bookmarks.delete(existing.id);
    res.json({ bookmarked: false });
  } else {
    // Check question exists
    const question = db.questions.findOne((q) => q.id === questionId);
    if (!question) {
      return res.status(404).json({ error: "Question not found." });
    }
    db.bookmarks.insert({
      userId: req.user.id,
      questionId,
    });
    res.status(201).json({ bookmarked: true });
  }
});


// --- DYNAMIC QUESTION LOADING FOR INTERVIEWS ---

const questionBank = {
  "Frontend Developer": [
    "Walk me through how you would diagnose and improve a slow React page.",
    "How do you decide whether state should be local, lifted, or placed in a global store?",
    "Explain how the browser rendering pipeline affects the CSS and JavaScript you write.",
    "Tell me about an accessibility issue you found and how you fixed it.",
    "How would you design a reusable data table for a large product?",
  ],
  "Backend Developer": [
    "How would you design an API that needs to handle sudden traffic spikes?",
    "Explain a database performance problem you encountered and how you investigated it.",
    "When would you choose a queue instead of a synchronous request?",
    "How do you make a distributed operation safe to retry?",
    "Describe how you would secure an authentication service.",
  ],
  "Data Analyst": [
    "How would you investigate a sudden drop in a product's weekly active users?",
    "Tell me about a time your analysis changed a business decision.",
    "How do you validate a dashboard before sharing it with leadership?",
    "Explain the difference between correlation and causation using a product example.",
    "How would you design an experiment for a new onboarding flow?",
  ],
  "Product Manager": [
    "How do you decide what not to build when every stakeholder says their request is urgent?",
    "Walk me through how you would improve a product with declining retention.",
    "Tell me about a product decision you made with incomplete data.",
    "How do you define success metrics for a new feature?",
    "Describe how you handle disagreement between design and engineering.",
  ],
  "AI/ML Engineer": [
    "How would you detect and address overfitting in a machine learning model?",
    "Explain how you would take a model from a notebook to a reliable production service.",
    "When would you optimize for precision instead of recall?",
    "How would you monitor a deployed model for data and concept drift?",
    "Design a recommendation system for a new product with limited interaction data.",
  ],
  "Data Scientist": [
    "How would you frame and solve a customer churn prediction problem?",
    "Explain how you would handle missing values and outliers in a real dataset.",
    "How do you choose an evaluation metric for an imbalanced classification problem?",
    "Walk me through how you would validate whether a new feature improves a model.",
    "How would you communicate an uncertain model result to a non-technical stakeholder?",
  ],
  "DSA & Coding": [
    "Given an array of integers, how would you find two numbers that add up to a target?",
    "How would you detect a cycle in a linked list and analyze the complexity?",
    "Explain when you would use breadth-first search instead of depth-first search.",
    "Design an efficient solution for finding the longest substring without repeating characters.",
    "How would you find the kth largest element without fully sorting the array?",
  ],
};

const roleConcepts = {
  "Frontend Developer": ["react", "render", "component", "state", "memo", "profiler", "network", "bundle", "dom", "css", "javascript", "accessibility", "cache", "latency", "performance"],
  "Backend Developer": ["api", "database", "cache", "queue", "latency", "scaling", "load", "retry", "idempotency", "authentication", "authorization", "index", "transaction", "security"],
  "Data Analyst": ["sql", "metric", "data", "cohort", "segment", "dashboard", "experiment", "hypothesis", "correlation", "causation", "validation", "conversion", "retention"],
  "Product Manager": ["user", "customer", "priority", "impact", "metric", "retention", "stakeholder", "roadmap", "experiment", "trade-off", "strategy", "research", "outcome"],
  "AI/ML Engineer": ["model", "training", "validation", "overfitting", "regularization", "feature", "precision", "recall", "drift", "inference", "deployment", "monitoring", "embedding", "recommendation"],
  "Data Scientist": ["model", "dataset", "feature", "validation", "metric", "precision", "recall", "auc", "imbalance", "missing", "outlier", "hypothesis", "experiment", "bias", "variance"],
  "DSA & Coding": ["array", "hash", "map", "set", "index", "lookup", "complement", "pointer", "linked", "cycle", "bfs", "dfs", "queue", "stack", "substring", "window", "heap", "complexity", "time", "space", "sort", "o(n)", "linear"],
};

app.get("/api/questions/role/:role", requireAuth, (req, res) => {
  const role = decodeURIComponent(req.params.role);
  const normalizedRole = role.toLowerCase().trim();
  let categoryQuestions = [];

  if (normalizedRole === "aptitude") {
    categoryQuestions = db.questions.find((q) => q.category === "Aptitude");
  } else if (normalizedRole === "hr") {
    categoryQuestions = db.questions.find((q) => q.category === "HR");
  } else if (normalizedRole === "dsa" || normalizedRole === "dsa & coding") {
    const dsaTags = ["arrays", "strings", "linked lists", "trees", "bst", "graphs", "dynamic programming", "recursion", "sorting", "searching", "hashing", "data structures", "algorithms"];
    categoryQuestions = db.questions.find((q) => 
      q.category === "Technical" && 
      q.tags && q.tags.some(tag => dsaTags.includes(tag.toLowerCase()))
    );
  } else if (normalizedRole === "java") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => tag.toLowerCase() === "java")
    );
  } else if (normalizedRole === "python") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => tag.toLowerCase() === "python")
    );
  } else if (normalizedRole === "dbms") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => ["dbms", "sql", "mongodb"].includes(tag.toLowerCase()))
    );
  } else if (normalizedRole === "os" || normalizedRole === "operating systems") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => ["operating systems", "os"].includes(tag.toLowerCase()))
    );
  } else if (normalizedRole === "react") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => tag.toLowerCase() === "react")
    );
  } else if (normalizedRole === "coding") {
    const codingTags = ["arrays", "strings", "linked lists", "trees", "bst", "graphs", "dynamic programming", "recursion", "sorting", "searching", "hashing", "java", "python", "javascript"];
    categoryQuestions = db.questions.find((q) => 
      q.category === "Technical" && 
      q.tags && q.tags.some(tag => codingTags.includes(tag.toLowerCase()))
    );
  } else if (normalizedRole === "trees") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => ["trees", "bst"].includes(tag.toLowerCase()))
    );
  } else if (normalizedRole === "hashing") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => tag.toLowerCase() === "hashing")
    );
  } else if (normalizedRole === "recursion") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => tag.toLowerCase() === "recursion")
    );
  } else if (normalizedRole === "sql joins") {
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => ["sql", "dbms"].includes(tag.toLowerCase())) &&
      q.question.toLowerCase().includes("join")
    );
    if (categoryQuestions.length < 5) {
      categoryQuestions = db.questions.find((q) => 
        q.tags && q.tags.some(tag => ["sql", "dbms"].includes(tag.toLowerCase()))
      );
    }
  } else {
    // Check if role name matches a tag exactly
    categoryQuestions = db.questions.find((q) => 
      q.tags && q.tags.some(tag => tag.toLowerCase() === normalizedRole)
    );

    if (categoryQuestions.length === 0) {
      let tagsToMatch = [];
      if (normalizedRole === "frontend developer") {
        tagsToMatch = ["javascript", "react", "css", "frontend", "git", "dom", "arrays", "strings"];
      } else if (normalizedRole === "backend developer") {
        tagsToMatch = ["apis", "database", "node.js", "sql", "mongodb", "rest", "authentication", "dbms", "git"];
      } else if (normalizedRole === "data analyst") {
        tagsToMatch = ["sql", "dbms", "data interpretation", "percentages", "ratios", "averages"];
      } else if (normalizedRole === "product manager") {
        tagsToMatch = ["system design", "behavioral", "oop", "dbms"];
      } else if (normalizedRole === "ai/ml engineer") {
        tagsToMatch = ["python", "algorithms", "graphs", "recursion", "trees"];
      } else if (normalizedRole === "data scientist") {
        tagsToMatch = ["python", "sql", "probability", "permutations", "combinations", "averages"];
      }

      if (tagsToMatch.length > 0) {
        categoryQuestions = db.questions.find((q) =>
          q.tags && q.tags.some((tag) => tagsToMatch.includes(tag.toLowerCase()))
        );
      }
    }
  }

  // Adaptive Question Generation & Performance Tracking
  const userSessions = db.practiceSessions.find((s) => s.userId === req.user.id);
  const attemptedTexts = new Set();
  userSessions.forEach((s) => {
    if (Array.isArray(s.answers)) {
      s.answers.forEach((ans) => {
        if (ans.question) {
          attemptedTexts.add(ans.question.toLowerCase().trim());
        }
      });
    }
  });

  let avgScore = 70;
  if (userSessions.length > 0) {
    const totalScore = userSessions.reduce((sum, s) => sum + s.score, 0);
    avgScore = totalScore / userSessions.length;
  }

  const unattempted = categoryQuestions.filter(q => !attemptedTexts.has(q.question.toLowerCase().trim()));
  const attempted = categoryQuestions.filter(q => attemptedTexts.has(q.question.toLowerCase().trim()));

  const shuffleArray = (arr) => [...arr].sort(() => Math.random() - 0.5);

  const getAdaptiveSelection = (list) => {
    const easy = shuffleArray(list.filter(q => q.difficulty.toLowerCase() === "easy"));
    const medium = shuffleArray(list.filter(q => q.difficulty.toLowerCase() === "medium"));
    const hard = shuffleArray(list.filter(q => q.difficulty.toLowerCase() === "hard"));
    
    if (avgScore >= 75) {
      return [...hard, ...medium, ...easy];
    } else if (avgScore < 50) {
      return [...easy, ...medium, ...hard];
    } else {
      return [...medium, ...easy, ...hard];
    }
  };

  let selected = [];
  selected.push(...getAdaptiveSelection(unattempted));
  if (selected.length < 5) {
    selected.push(...getAdaptiveSelection(attempted));
  }
  selected = selected.slice(0, 5);

  if (selected.length === 0) {
    const fallbackTextList = questionBank[role] || questionBank["Frontend Developer"];
    const fallbackObjects = fallbackTextList.map((txt, index) => ({
      id: `fallback-${index}`,
      question: txt,
      category: "Technical",
      difficulty: "Medium",
      answer: "Expected Answer",
      explanation: "No explanation seeded.",
      tips: ["Be precise."],
      tags: [],
    }));
    return res.json({ questions: fallbackObjects });
  }

  res.json({ questions: selected });
});


// --- EVALUATE ROUTE ---

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is",
  "it", "me", "my", "of", "on", "or", "that", "the", "this", "to", "was", "we", "what",
  "when", "where", "which", "with", "would", "you", "your",
]);

const profanityPattern = /\b(shit|fuck|fucking|bullshit|bitch|asshole|idiot|nonsense)\b/i;

function tokenize(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function inspectAnswer(answer, question, role) {
  const words = answer.trim().split(/\s+/).filter(Boolean);
  const tokens = tokenize(answer);
  const uniqueTokens = new Set(tokens);
  const questionTokens = new Set(tokenize(question));
  const concepts = roleConcepts[role] || [];
  const conceptHits = concepts.filter((concept) => answer.toLowerCase().includes(concept));
  const questionHits = [...questionTokens].filter((token) => uniqueTokens.has(token));
  const repeatedRatio = tokens.length ? uniqueTokens.size / tokens.length : 0;
  const hasSentence = /[.!?]|(?:\b(?:because|therefore|then|first|next|finally|so that)\b)/i.test(answer);
  const hasReasoning = /\b(because|therefore|so that|if|otherwise|which means|this allows|compared)\b/i.test(answer);
  const hasEvidence = /\b\d+(?:\.\d+)?(?:%|x|ms|s|minutes?|hours?|users?|requests?)?\b/i.test(answer) || /\bo\([^)]+\)/i.test(answer);
  const hasTradeoff = /\b(trade-?off|however|instead|compared|advantage|disadvantage|cost|benefit)\b/i.test(answer);

  let invalidReason = null;
  if (words.length < 5) invalidReason = "The answer is too short to evaluate.";
  else if (profanityPattern.test(answer)) invalidReason = "The response contains abusive or placeholder language instead of an interview answer.";
  else if (tokens.length >= 8 && repeatedRatio < 0.35) invalidReason = "The response is mostly repeated text and does not contain a meaningful answer.";
  else if (uniqueTokens.size < 4) invalidReason = "The response does not contain enough meaningful information to evaluate.";

  return {
    words,
    tokens,
    conceptHits,
    questionHits,
    hasSentence,
    hasReasoning,
    hasEvidence,
    hasTradeoff,
    invalidReason,
  };
}

function localEvaluation(answer, question, index, role = "Frontend Developer") {
  const analysis = inspectAnswer(answer, question, role);

  if (analysis.invalidReason) {
    return {
      verdict: "invalid",
      scores: { clarity: 0, relevance: 0, impact: 0, overall: 0 },
      feedback: analysis.invalidReason,
      strengths: [],
      improvement: "Give a sincere answer that directly addresses the question and explains your reasoning.",
      followUp: null,
      correctnessPercentage: 0,
      missingConcepts: ["Genuine response"],
      confidenceScore: 100,
    };
  }

  const relevanceSignals = analysis.conceptHits.length + analysis.questionHits.length;
  const relevance = Math.min(
    94,
    10 + analysis.conceptHits.length * 7 + analysis.questionHits.length * 5 + Math.min(analysis.words.length, 60) * 0.25
  );
  const isOffTopic = relevanceSignals === 0;

  if (isOffTopic) {
    return {
      verdict: "off_topic",
      scores: {
        clarity: analysis.hasSentence ? 25 : 12,
        relevance: 5,
        impact: 5,
        overall: 10,
      },
      feedback: "The response does not address the interview question or use relevant domain concepts.",
      strengths: analysis.hasSentence ? ["The response is readable, but it is not relevant."] : [],
      improvement: `Answer the question directly and explain relevant ${role} concepts, decisions, and trade-offs.`,
      followUp: null,
      correctnessPercentage: 5,
      missingConcepts: ["Relevant domain concepts"],
      confidenceScore: 90,
    };
  }

  const clarity = Math.min(
    92,
    18 + (analysis.hasSentence ? 14 : 0) + (analysis.hasReasoning ? 14 : 0) + Math.min(analysis.words.length, 70) * 0.4
  );
  const impact = Math.min(
    90,
    18 + analysis.conceptHits.length * 7 + (analysis.hasEvidence ? 20 : 0) + (analysis.hasTradeoff ? 15 : 0)
  );
  const overall = Math.round(relevance * 0.5 + clarity * 0.25 + impact * 0.25);
  const strengths = [];
  if (analysis.conceptHits.length >= 2) strengths.push(`Uses relevant concepts: ${analysis.conceptHits.slice(0, 3).join(", ")}`);
  if (analysis.hasTradeoff) strengths.push("Explains a decision or trade-off");
  if (analysis.hasEvidence) strengths.push("Includes concrete evidence");

  const expectedConcepts = roleConcepts[role] || [];
  const missing = expectedConcepts.filter(c => !analysis.conceptHits.includes(c)).slice(0, 3);

  return {
    verdict: overall >= 75 ? "strong" : overall >= 50 ? "developing" : "weak",
    scores: {
      clarity: Math.round(clarity),
      relevance: Math.round(relevance),
      impact: Math.round(impact),
      overall,
    },
    feedback:
      overall >= 75
        ? "The answer is relevant and demonstrates sound reasoning. The score reflects the concepts and evidence actually present."
        : "The answer is partly relevant, but important reasoning or technical detail is missing.",
    strengths,
    improvement: !analysis.hasTradeoff
      ? "Explain why you chose this approach and compare it with at least one alternative."
      : !analysis.hasEvidence
        ? "Add a concrete example, complexity analysis, metric, or observable result."
        : "Make the answer more precise by connecting each step directly to the question.",
    followUp: index < 4 ? "What alternative approach did you consider, and why did you reject it?" : null,
    correctnessPercentage: Math.round(relevance),
    missingConcepts: missing.length > 0 ? missing : ["None"],
    confidenceScore: 85,
  };
}

const evaluationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "scores",
    "feedback",
    "strengths",
    "improvement",
    "followUp",
    "correctnessPercentage",
    "missingConcepts",
    "confidenceScore"
  ],
  properties: {
    verdict: { type: "string", enum: ["invalid", "off_topic", "weak", "developing", "strong"] },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["clarity", "relevance", "impact", "overall"],
      properties: {
        clarity: { type: "number" },
        relevance: { type: "number" },
        impact: { type: "number" },
        overall: { type: "number" },
      },
    },
    feedback: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    improvement: { type: "string" },
    followUp: { anyOf: [{ type: "string" }, { type: "null" }] },
    correctnessPercentage: { type: "number" },
    missingConcepts: { type: "array", items: { type: "string" } },
    confidenceScore: { type: "number" }
  },
};

app.post("/api/evaluate", requireAuth, async (req, res) => {
  const { role, question, answer, questionIndex = 0 } = req.body;
  if (!answer?.trim() || !question?.trim()) {
    return res.status(400).json({ error: "Question and answer are required." });
  }

  const precheck = inspectAnswer(answer, question, role);
  if (precheck.invalidReason) {
    return res.json({
      ...localEvaluation(answer, question, questionIndex, role),
      mode: "validated",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.json({
      ...localEvaluation(answer, question, questionIndex, role),
      mode: "local",
    });
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      reasoning: { effort: "medium" },
      instructions:
        `You are a strict, evidence-based interview evaluator, not a motivational chatbot.
Evaluate the semantic correctness of the answer instead of exact wording. Compare the answer against standard industry models intelligently.
Identify partially correct answers and detect specific misconceptions. Score only what the candidate actually wrote.
If the answer is nonsense, abusive filler, copied placeholder text, or does not answer the question, set verdict to invalid or off_topic and overall between 0 and 15.
For a technically wrong answer, score relevance and impact below 40 and state the exact error or misconception.
Use this weighted rubric: relevance/correctness (correctnessPercentage) 50%, clarity/reasoning 25%, evidence/depth 25%.
Scores must be integers from 0 to 100.
Confidence score must represent your evaluation confidence (0-100).
In the feedback, summarize the semantic evaluation. Provide list of missingConcepts, strengths (array of strong points), and improvement (concrete action plans).
Never infer protected or sensitive traits.`,
      input: `Target role: ${role}
Interview question: ${question}
Candidate answer: ${answer}
Locally detected role concepts: ${precheck.conceptHits.join(", ") || "none"}
Locally detected question overlap: ${precheck.questionHits.join(", ") || "none"}`,
      text: {
        format: {
          type: "json_schema",
          name: "interview_evaluation",
          strict: true,
          schema: evaluationSchema,
        },
      },
    });

    return res.json({ ...JSON.parse(response.output_text), mode: "ai" });
  } catch (error) {
    console.error("AI evaluation failed, falling back to local evaluation:", error);
    return res.json({
      ...localEvaluation(answer, question, questionIndex, role),
      mode: "local",
      warning: "AI service unavailable; local coaching was used.",
    });
  }
});

// --- CODE EXECUTION ENGINE & PLAYGROUND ---
import { spawn } from "node:child_process";
import fs from "node:fs";

const SANDBOX_DIR = path.join(projectDirectory, "temp_sandbox");
if (!fs.existsSync(SANDBOX_DIR)) {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

function scanCodeSecurity(language, code) {
  const codeLower = code.toLowerCase();
  if (language === "python") {
    const blockedKeywords = [
      "import os", "from os import",
      "import subprocess", "from subprocess import",
      "import socket", "from socket import",
      "import urllib", "from urllib import",
      "import requests", "from requests import",
      "eval(", "exec(", "open(", "compile(", "getattr(", "globals(", "locals("
    ];
    for (const kw of blockedKeywords) {
      if (codeLower.includes(kw)) return false;
    }
  } else if (language === "java") {
    const blockedKeywords = [
      "runtime.getruntime", "processbuilder", 
      "java.io.file", "java.io.filewriter", "java.io.fileoutputstream",
      "java.nio.file", "java.net", "socket", "url", 
      "classloader", "compiler", "reflection"
    ];
    for (const kw of blockedKeywords) {
      if (codeLower.includes(kw)) return false;
    }
  } else if (language === "c") {
    const blockedKeywords = [
      "system(", "fork(", "exec", "socket", "connect",
      "#include <sys/", "#include <dirent.h>", "fopen(", "remove(", "rename("
    ];
    for (const kw of blockedKeywords) {
      if (codeLower.includes(kw)) return false;
    }
  }
  return true;
}

function executeCode(language, code, inputVal, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const runId = crypto.randomUUID();
    const sandboxDir = path.join(SANDBOX_DIR, runId);
    fs.mkdirSync(sandboxDir, { recursive: true });

    let filename = "";
    let compileCmd = null;
    let compileArgs = [];
    let runCmd = "";
    let runArgs = [];

    const isSafe = scanCodeSecurity(language, code);
    if (!isSafe) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      return resolve({
        status: "error",
        compileOutput: "",
        runtimeOutput: "",
        runtimeError: "Security Error: Code execution blocked due to restricted operations (filesystem, network, or process execution).",
      });
    }

    if (language === "python") {
      filename = "solution.py";
      runCmd = process.platform === "win32" ? "python" : "python3";
      runArgs = [filename];
    } else if (language === "java") {
      filename = "Main.java";
      compileCmd = "javac";
      compileArgs = [filename];
      runCmd = "java";
      runArgs = ["Main"];
    } else if (language === "c") {
      filename = "solution.c";
      const exeName = process.platform === "win32" ? "solution.exe" : "./solution";
      compileCmd = "gcc";
      compileArgs = ["-o", process.platform === "win32" ? "solution.exe" : "solution", filename];
      runCmd = exeName;
      runArgs = [];
    } else {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      return resolve({
        status: "error",
        compileOutput: "",
        runtimeOutput: "",
        runtimeError: `Unsupported language: ${language}`,
      });
    }

    fs.writeFileSync(path.join(sandboxDir, filename), code, "utf8");

    const cleanup = () => {
      try {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
      } catch (err) {
        console.error("Cleanup error:", err);
      }
    };

    if (compileCmd) {
      const compileProcess = spawn(compileCmd, compileArgs, { cwd: sandboxDir, shell: true });
      let compileStderr = "";
      let compileStdout = "";

      compileProcess.stdout.on("data", (data) => { compileStdout += data.toString(); });
      compileProcess.stderr.on("data", (data) => { compileStderr += data.toString(); });

      const compileTimeout = setTimeout(() => {
        compileProcess.kill();
        cleanup();
        resolve({
          status: "compile_timeout",
          compileOutput: "Compilation timed out.",
          runtimeOutput: "",
          runtimeError: "",
        });
      }, 5000);

      compileProcess.on("close", (codeVal) => {
        clearTimeout(compileTimeout);
        if (codeVal !== 0) {
          cleanup();
          resolve({
            status: "compile_error",
            compileOutput: compileStderr || compileStdout || `Compiler exited with code ${codeVal}`,
            runtimeOutput: "",
            runtimeError: "",
          });
        } else {
          runTarget();
        }
      });

      compileProcess.on("error", (err) => {
        clearTimeout(compileTimeout);
        cleanup();
        resolve({
          status: "compile_error",
          compileOutput: `Failed to execute compiler '${compileCmd}': ${err.message}. Make sure the compiler is installed and added to the system PATH.`,
          runtimeOutput: "",
          runtimeError: "",
        });
      });
    } else {
      runTarget();
    }

    function runTarget() {
      const runProcess = spawn(runCmd, runArgs, { cwd: sandboxDir, shell: true });
      let stdoutData = "";
      let stderrData = "";

      if (inputVal) {
        runProcess.stdin.write(inputVal);
      }
      runProcess.stdin.end();

      runProcess.stdout.on("data", (data) => {
        if (stdoutData.length < 1024 * 1024) {
          stdoutData += data.toString();
        } else {
          runProcess.kill();
        }
      });

      runProcess.stderr.on("data", (data) => {
        if (stderrData.length < 1024 * 1024) {
          stderrData += data.toString();
        } else {
          runProcess.kill();
        }
      });

      const runTimeout = setTimeout(() => {
        runProcess.kill();
        cleanup();
        resolve({
          status: "timeout",
          compileOutput: "",
          runtimeOutput: stdoutData,
          runtimeError: `Execution timed out (limit: ${timeoutMs}ms).`,
        });
      }, timeoutMs);

      runProcess.on("close", (codeVal) => {
        clearTimeout(runTimeout);
        cleanup();
        resolve({
          status: codeVal === 0 ? "success" : "runtime_error",
          compileOutput: "",
          runtimeOutput: stdoutData,
          runtimeError: codeVal === 0 ? stderrData : (stderrData || `Runtime process exited with code ${codeVal}`),
        });
      });

      runProcess.on("error", (err) => {
        clearTimeout(runTimeout);
        cleanup();
        resolve({
          status: "runtime_error",
          compileOutput: "",
          runtimeOutput: "",
          runtimeError: `Failed to run code: ${err.message}. Make sure the execution environment is configured.`,
        });
      });
    }
  });
}

// Coding Practice API Routes
app.get("/api/coding/questions", requireAuth, (req, res) => {
  const questions = db.codingQuestions.find().map(q => ({
    id: q.id,
    title: q.title,
    difficulty: q.difficulty,
    tags: q.tags,
    constraints: q.constraints,
    sampleCases: q.sampleCases,
  }));
  res.json(questions);
});

app.get("/api/coding/questions/:id", requireAuth, (req, res) => {
  const q = db.codingQuestions.findOne(item => item.id === req.params.id);
  if (!q) {
    return res.status(404).json({ error: "Coding question not found." });
  }
  res.json(q);
});

app.get("/api/coding/draft/:questionId/:language", requireAuth, (req, res) => {
  const draft = db.codingDrafts.findOne(
    d => d.userId === req.user.id && d.questionId === req.params.questionId && d.language === req.params.language
  );
  res.json(draft || { code: "" });
});

app.post("/api/coding/draft", requireAuth, (req, res) => {
  const { questionId, language, code } = req.body;
  if (!questionId || !language) {
    return res.status(400).json({ error: "Question ID and language are required." });
  }
  const existing = db.codingDrafts.findOne(
    d => d.userId === req.user.id && d.questionId === questionId && d.language === language
  );
  if (existing) {
    const updated = db.codingDrafts.update(existing.id, { code });
    res.json(updated);
  } else {
    const inserted = db.codingDrafts.insert({
      userId: req.user.id,
      questionId,
      language,
      code,
    });
    res.status(201).json(inserted);
  }
});

app.post("/api/coding/run", requireAuth, async (req, res) => {
  const { questionId, language, code, customInput } = req.body;
  if (!questionId || !language || !code) {
    return res.status(400).json({ error: "Question ID, language, and code are required." });
  }
  const q = db.codingQuestions.findOne(item => item.id === questionId);
  if (!q) {
    return res.status(404).json({ error: "Question not found." });
  }
  const result = await executeCode(language, code, customInput || "");
  res.json(result);
});

app.post("/api/coding/submit", requireAuth, async (req, res) => {
  const { questionId, language, code } = req.body;
  if (!questionId || !language || !code) {
    return res.status(400).json({ error: "Question ID, language, and code are required." });
  }
  const q = db.codingQuestions.findOne(item => item.id === questionId);
  if (!q) {
    return res.status(404).json({ error: "Question not found." });
  }

  const testCases = q.testCases || [];
  let passed = true;
  const results = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const result = await executeCode(language, code, tc.input);
    const actualOutput = (result.runtimeOutput || "").trim();
    const expectedOutput = (tc.output || "").trim();
    
    const isCorrect = result.status === "success" && actualOutput === expectedOutput;
    results.push({
      testCaseIndex: i,
      input: tc.input,
      expected: expectedOutput,
      actual: actualOutput,
      status: result.status,
      error: result.runtimeError,
      passed: isCorrect,
    });
    if (!isCorrect) {
      passed = false;
    }
  }

  db.codingAttempts.insert({
    userId: req.user.id,
    questionId,
    language,
    code,
    passed,
    results,
    completedAt: new Date().toISOString(),
  });

  res.json({ passed, results });
});

app.get("/api/coding/dashboard-stats", requireAuth, (req, res) => {
  const attempts = db.codingAttempts.find(a => a.userId === req.user.id);
  const questions = db.codingQuestions.find();
  
  const solvedSet = new Set(
    attempts.filter(a => a.passed).map(a => a.questionId)
  );
  const totalSolved = solvedSet.size;
  const successRate = attempts.length 
    ? Math.round((attempts.filter(a => a.passed).length / attempts.length) * 100) 
    : 0;

  const langCounts = {};
  attempts.forEach(a => {
    langCounts[a.language] = (langCounts[a.language] || 0) + 1;
  });
  const totalAttempts = attempts.length || 1;
  const languageUsage = Object.entries(langCounts).map(([lang, count]) => ({
    language: lang,
    percentage: Math.round((count / totalAttempts) * 100),
  }));

  const diffSolved = { easy: 0, medium: 0, hard: 0 };
  const diffTotal = { easy: 0, medium: 0, hard: 0 };

  questions.forEach(q => {
    const diff = q.difficulty.toLowerCase();
    if (diffTotal[diff] !== undefined) {
      diffTotal[diff]++;
    }
    if (solvedSet.has(q.id) && diffSolved[diff] !== undefined) {
      diffSolved[diff]++;
    }
  });

  const solvedAttempts = attempts.filter(a => a.passed);
  solvedAttempts.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const recentlySolved = [];
  const seenIds = new Set();
  for (const sa of solvedAttempts) {
    if (!seenIds.has(sa.questionId)) {
      seenIds.add(sa.questionId);
      const q = questions.find(item => item.id === sa.questionId);
      if (q) {
        recentlySolved.push({
          id: q.id,
          title: q.title,
          difficulty: q.difficulty,
          completedAt: sa.completedAt,
        });
      }
    }
    if (recentlySolved.length >= 5) break;
  }

  const bookmarks = db.bookmarks.find(b => b.userId === req.user.id);
  const bookmarkedProblems = bookmarks
    .map(b => questions.find(q => q.id === b.questionId))
    .filter(Boolean)
    .map(q => ({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
    }));

  const unsolvedQuestions = questions.filter(q => !solvedSet.has(q.id));
  const recommended = unsolvedQuestions
    .sort((a, b) => {
      const diffOrder = { easy: 1, medium: 2, hard: 3 };
      return diffOrder[a.difficulty.toLowerCase()] - diffOrder[b.difficulty.toLowerCase()];
    })
    .slice(0, 3)
    .map(q => ({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
      tags: q.tags,
    }));

  res.json({
    totalSolved,
    totalQuestions: questions.length,
    successRate,
    languageUsage,
    difficultyProgress: {
      easy: { solved: diffSolved.easy, total: diffTotal.easy },
      medium: { solved: diffSolved.medium, total: diffTotal.medium },
      hard: { solved: diffSolved.hard, total: diffTotal.hard },
    },
    recentlySolved,
    bookmarkedProblems,
    recommendations: recommended,
  });
});

// --- AI LEARNING ASSISTANT API ---
app.get("/api/ai/recommendations", requireAuth, (req, res) => {
  const userId = req.user.id;
  const sessions = db.practiceSessions.find(s => s.userId === userId);
  const progress = db.prepProgress.find(p => p.userId === userId);
  const attempts = db.codingAttempts.find(a => a.userId === userId);
  const questions = db.codingQuestions.find();

  // Find weak concepts/topics
  const weakTopics = new Set();
  const strongTopics = new Set();

  sessions.forEach(s => {
    if (s.score < 65) {
      weakTopics.add(s.role);
    } else if (s.score >= 80) {
      strongTopics.add(s.role);
    }
  });

  progress.forEach(p => {
    if (p.studied) {
      if (p.quizScore !== null && p.quizTotal) {
        if (p.quizScore / p.quizTotal < 0.7) {
          weakTopics.add(p.category);
        } else {
          strongTopics.add(p.category);
        }
      } else {
        strongTopics.add(p.category);
      }
    }
  });

  // Common coding mistakes & preferred language
  const commonMistakes = new Set();
  const langCounts = {};
  let failedAttemptsCount = 0;

  attempts.forEach(a => {
    langCounts[a.language] = (langCounts[a.language] || 0) + 1;
    if (!a.passed) {
      failedAttemptsCount++;
      const q = db.codingQuestions.findOne(item => item.id === a.questionId);
      if (q && q.tags) {
        q.tags.forEach(t => {
          weakTopics.add(t);
          commonMistakes.add(t);
        });
      }
    }
  });

  // Calculate preferred language
  let preferredLanguage = "Python";
  let maxLangCount = 0;
  Object.entries(langCounts).forEach(([lang, count]) => {
    if (count > maxLangCount) {
      maxLangCount = count;
      preferredLanguage = lang.charAt(0).toUpperCase() + lang.slice(1);
    }
  });

  // Tailor recommended coding questions
  const solvedSet = new Set(attempts.filter(a => a.passed).map(a => a.questionId));
  const unsolved = questions.filter(q => !solvedSet.has(q.id));

  // Prioritize unsolved questions matching weak topics
  let recommendedProblems = [];
  unsolved.forEach(q => {
    const matchesWeak = q.tags && q.tags.some(t => weakTopics.has(t));
    if (matchesWeak) {
      recommendedProblems.push({
        id: q.id,
        title: q.title,
        difficulty: q.difficulty,
        tags: q.tags,
        reason: `Based on your struggle in ${q.tags.find(t => weakTopics.has(t)) || "similar topics"}`
      });
    }
  });

  // Fill up to 3 recommendations
  if (recommendedProblems.length < 3) {
    unsolved.forEach(q => {
      if (!recommendedProblems.some(r => r.id === q.id)) {
        recommendedProblems.push({
          id: q.id,
          title: q.title,
          difficulty: q.difficulty,
          tags: q.tags,
          reason: "Practice to improve overall algorithms score"
        });
      }
    });
  }
  recommendedProblems = recommendedProblems.slice(0, 3);

  // Recommendations for Mock Interviews
  const mockInterviewSuggestions = [];
  if (weakTopics.has("Aptitude") || sessions.some(s => s.role === "Aptitude" && s.score < 70)) {
    mockInterviewSuggestions.push({
      role: "Aptitude",
      reason: "Revise quantitative aptitude parameters like Clocks, Probability and Ages."
    });
  }
  if (weakTopics.has("HR") || sessions.some(s => s.role === "HR" && s.score < 70)) {
    mockInterviewSuggestions.push({
      role: "HR",
      reason: "Practice HR questions to structure behavioral answers using the STAR method."
    });
  }
  if (mockInterviewSuggestions.length === 0) {
    mockInterviewSuggestions.push({
      role: "DSA & Coding",
      reason: "Boost problem-solving structure for intermediate technical interviews."
    });
  }

  res.json({
    weakTopics: Array.from(weakTopics).slice(0, 4),
    strongTopics: Array.from(strongTopics).slice(0, 4),
    preferredLanguage,
    commonMistakes: Array.from(commonMistakes).slice(0, 3),
    recommendedProblems,
    mockInterviewSuggestions,
  });
});

app.get("/api/ai/chat", requireAuth, (req, res) => {
  const logs = db.chatLogs.find(log => log.userId === req.user.id);
  logs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(logs.slice(-20));
});

app.post("/api/ai/chat/clear", requireAuth, (req, res) => {
  db.chatLogs.deleteMany(log => log.userId === req.user.id);
  res.json({ success: true });
});

app.post("/api/ai/mentor/clear", requireAuth, (req, res) => {
  db.chatLogs.deleteMany(log => log.userId === req.user.id);
  res.json({ success: true });
});

function generateMockResponse(message, context, historyLogs) {
  const msgLower = message.toLowerCase();
  const screen = context.page || context.screen || "dashboard";
  
  // Find last assistant reply to know the previous context/topic
  const assistantHistory = historyLogs.filter(log => log.role === "assistant");
  const lastAssistantReply = assistantHistory.length > 0 ? assistantHistory[assistantHistory.length - 1].content : "";
  const lastAssistantReplyLower = lastAssistantReply.toLowerCase();

  // 1. Follow-up "don't understand" or "explain more"
  if (msgLower.includes("don't understand") || msgLower.includes("dont understand") || msgLower.includes("still confused") || msgLower.includes("explain again") || msgLower.includes("slow down") || msgLower.includes("i still don't")) {
    if (lastAssistantReplyLower.includes("recursion")) {
      return `No problem at all! Let's slow down and look at recursion with an even simpler real-life analogy.
      
Imagine you're standing in a queue to buy movie tickets, and you want to know how many people are in front of you. You can't see the front of the line, so you ask the person directly in front of you: *"Hey, what position are we in?"*

That person doesn't know either! So they ask the person in front of them, and so on. This is the **recursive step**—each person asks the same question to the next person.

Eventually, the question reaches the very first person in line. They know they are at position 1. This is the **base case**! 

Once the base case is reached, the answer travels back down the line: position 1 tells position 2, who adds 1 and tells position 3, all the way back to you.

Does this queue analogy make the flow of recursion feel a bit more intuitive? Let me know!`;
    }
    if (lastAssistantReplyLower.includes("hashing") || lastAssistantReplyLower.includes("hash")) {
      return `I hear you! Let's strip away the computer science terms.

Think of hashing like a **super-organized coat check room** at a theater. 

If you just pile 100 coats on a bed, finding one coat later takes forever because you have to search through all of them one-by-one. That's an $O(N)$ lookup.

Instead, when you hand your coat to the attendant, they give you a ticket with a number (e.g., Ticket 42) and hang your coat on hook #42. 

When you return, you show Ticket 42. The attendant goes *directly* to hook #42 and hands you your coat. They don't search through any other coats. That is **constant time $O(1)$ lookup**!

The "ticket number generator" is the **hash function**, and the "coat hooks" are the **hash table**.

Does that image make the speed and purpose of hashing clearer?`;
    }
    return `No worries! Let's break this down further. What specific part feels confusing right now? Is it how the data moves, the syntax, or the overall logic? Tell me, and we'll take it step-by-step.`;
  }

  // 2. Greetings
  if (msgLower === "hello" || msgLower === "hi" || msgLower === "hey" || msgLower.startsWith("hello ") || msgLower.startsWith("hi ") || msgLower.startsWith("hey ")) {
    if (screen === "coding") {
      const qTitle = context.problemTitle || context.activeQuestion || "this problem";
      return `Hey! 👋 I see you're working on the **${qTitle}** challenge. How is it going? 
      
Are you looking to clarify the constraints, get a hint on the optimal approach, debug an issue, or optimize your logic? Let's tackle it together!`;
    }
    if (screen === "preparation") {
      const topic = context.topic || "computer science";
      return `Hey there! 👋 Ready to prep? I see we are exploring **${topic}**. 
      
What would you like to cover today? We can dive into concept breakdowns, look at common interview mistakes, or do a quick knowledge test. What sounds best?`;
    }
    if (screen === "interview") {
      const category = context.category || "General";
      return `Hi! 👋 Welcome to your mock interview prep for the **${category}** track.
      
We can practice answering behavioral or technical questions, review your STAR answer structures, or talk about what interviewers are looking for. How can I help you succeed today?`;
    }
    return `Hey! 👋 What are you working on today? Coding practice, concept preparation, or mock interview coaching? Let me know how I can guide you!`;
  }

  // 3. Concept: Recursion
  if (msgLower.includes("recursion")) {
    return `That's a fantastic topic! **Recursion** is one of those concepts that feels like a brain-bender at first, but is beautiful once it clicks.

### **Concept Overview**
Recursion is simply a programming technique where a function calls itself to solve smaller instances of the same problem.

### **Why It Is Used**
It allows us to write elegant, clean code for problems that have a naturally repetitive, nested structure (like exploring tree branches, files in directories, or sorting algorithms like Merge Sort).

### **How It Works**
Every recursive function *must* have two parts:
1. **Base Case:** The condition under which the function stops calling itself. Without this, you get an infinite loop and a *Stack Overflow* error!
2. **Recursive Case:** The part where the function calls itself with a smaller input, moving closer to the base case.

### **Example (Nesting Dolls)**
Think of a Russian nesting doll. To find the tiny gold key hidden in the smallest doll:
- You open the current doll.
- If it contains the key, you stop (Base Case).
- If it contains another doll, you call the "open doll" action again on this smaller doll (Recursive Case).

Let me know if you want to write a quick recursive function together (like computing factorials) to see it in action!`;
  }

  // 4. Concept: Hashing
  if (msgLower.includes("hashing") || msgLower.includes("hash table") || msgLower.includes("hashmap")) {
    return `**Concept Overview**
Hashing is the technique of mapping large, arbitrary keys to small, fixed-size indexes in an array using a special mathematical formula called a **Hash Function**.

**Why It Is Used**
It gives us incredibly fast lookups—averaging $O(1)$ (constant time). Instead of searching through a list of $N$ items, we jump straight to the correct item.

**How It Works**
1. You pass a key (like a username) to the **Hash Function**.
2. The function calculates an integer index.
3. You store or retrieve the value at that array index.
*Note: If two different keys map to the same index, it is called a **Collision**, which we resolve using methods like Chaining or Open Addressing.*

**Common Pitfalls**
Assuming zero collisions. In real-world applications, a poor hash function can cause many collisions, degrading performance to $O(N)$ (linear search).

Would you like to see how we use hashing to solve coding problems optimally?`;
  }

  // 5. Coding: Level 1 - Understand/Explain problem
  if (msgLower.includes("level 1") || msgLower.includes("explain the problem") || msgLower.includes("explain this problem") || msgLower.includes("understand the problem")) {
    const qTitle = context.problemTitle || context.activeQuestion || "Two Sum";
    return `Level 1: Understanding the Problem\nLet's break down the **${qTitle}** problem together! \n\nWe want to make sure we understand the core inputs and requirements before writing any code:\n1. **The Input:** We are given an array of integers (e.g., \`[2, 7, 11, 15]\`) and a target integer (e.g., \`9\`).\n2. **The Goal:** Find the **indices** of the two numbers in the array that add up to the target.\n3. **The Constraints:** \n   - Each input has *exactly* one solution.\n   - You cannot use the *same* element twice (i.e. you can't add index 0 to itself).\n   - The output can be in any order.\n\nDoes this input-to-output goal make sense, or would you like to trace a simple sample case together?`;
  }

  // 6. Coding: Level 2 - Hint
  if (msgLower.includes("level 2") || msgLower.includes("hint") || msgLower.includes("give me a hint") || msgLower.includes("approach strategy")) {
    return `You're actually very close to finding a solid approach! Here's a progressive hint:

If you were doing this manually, for each number you look at (let's call it \`x\`), you would want to find if there is another number in the array that equals \`target - x\`.

- **Brute Force approach:** You could loop through the rest of the array to search for \`target - x\`. This would take $O(N^2)$ time because of the nested searches.
- **Can we do better?** Think about how you could "remember" the numbers you've already seen. What data structure lets you store a number and check if it exists in constant $O(1)$ time?

Give it a thought! What data structure comes to mind?`;
  }

  // 7. Coding: Level 3 - Algorithm logic / pseudocode
  if (msgLower.includes("level 3") || msgLower.includes("algorithm logic") || msgLower.includes("algorithm guidance") || msgLower.includes("pseudocode")) {
    return `Let's outline the step-by-step logic for the optimal approach using a **Hash Map**! This avoids the nested loops:

1. Initialize an empty hash map (let's call it \`seen\`). This will store numbers as keys and their array indices as values.
2. Loop through the array using a loop index \`i\` and current element \`num\`.
3. Calculate the complement: \`diff = target - num\`.
4. Check if \`diff\` is already in our \`seen\` map:
   - **If yes:** We found our pair! Return the indices \`[seen[diff], i]\`.
   - **If no:** Add the current \`num\` to the map with its index: \`seen[num] = i\`.
5. If the loop completes without finding a pair, return an empty array (though the problem guarantees a solution exists).

Does this logic feel clear? Try tracing it with \`nums = [3, 2, 4]\` and \`target = 6\` to see how it resolves!`;
  }

  // 8. Coding: Level 4 / 5 - Reveal solution / full implementation
  if (msgLower.includes("level 4") || msgLower.includes("reveal solution") || msgLower.includes("full solution") || msgLower.includes("code implementation") || msgLower.includes("level 5")) {
    const lang = (context.language || "python").toLowerCase();
    let codeBlock = "";
    if (lang === "java") {
      codeBlock = `\`\`\`java
import java.util.HashMap;
import java.util.Map;

class Solution {
    public int[] twoSum(int[] nums, int target) {
        // Create a Hash Map to store numbers and their indices
        Map<Integer, Integer> seen = new HashMap<>();
        
        for (int i = 0; i < nums.length; i++) {
            int complement = target - nums[i];
            
            // Check if complement exists in map
            if (seen.containsKey(complement)) {
                return new int[] { seen.get(complement), i };
            }
            
            // Otherwise, store current number and index
            seen.put(nums[i], i);
        }
        
        return new int[] {}; // Fallback
    }
}
\`\`\``;
    } else if (lang === "c") {
      codeBlock = `\`\`\`c
#include <stdlib.h>

// Note: In C, we can implement a custom hash table or use a brute-force search.
int* twoSum(int* nums, int numsSize, int target, int* returnSize) {
    int* result = (int*)malloc(2 * sizeof(int));
    *returnSize = 2;
    
    for (int i = 0; i < numsSize; i++) {
        for (int j = i + 1; j < numsSize; j++) {
            if (nums[i] + nums[j] == target) {
                result[0] = i;
                result[1] = j;
                return result;
            }
        }
    }
    return result;
}
\`\`\``;
    } else {
      codeBlock = `\`\`\`python
# Time Complexity: O(N) | Space Complexity: O(N)
def two_sum(nums, target):
    # Store visited numbers and their indices
    seen = {}
    
    for i, num in enumerate(nums):
        diff = target - num
        # If the complement has been seen, return the pair
        if diff in seen:
            return [seen[diff], i]
        # Otherwise, log the current number
        seen[num] = i
        
    return []
\`\`\``;
    }

    return `Here is the complete optimal solution. Let's look at the implementation:

${codeBlock}

### **How it performs:**
- **Time Complexity:** $O(N)$ because we traverse the list containing $N$ elements exactly once. Each lookup in the table costs only $O(1)$ time.
- **Space Complexity:** $O(N)$ since the extra space required depends on the number of items stored in the hash table, up to $N$ elements.

Make sure you understand how the complement matches the keys in our map. Ready to run your test cases?`;
  }

  // 9. Explain code line-by-line
  if (msgLower.includes("line-by-line") || msgLower.includes("explain my code") || msgLower.includes("explain the code")) {
    const code = context.code || "";
    if (!code.trim()) {
      return `I'd love to explain your code line-by-line! It looks like your editor is empty right now, though. Could you write or paste some code first, and then click this chip again?`;
    }
    return `Let's break down your current editor code line-by-line so we understand exactly what each instruction does:

\`\`\`python
${code}
\`\`\`

1. **Line 1: Function Definition**
   - What this line does: Declares the function wrapper with parameters.
   - Why it is needed: Encloses variables in a scoped block for clean execution.
   - Beginner notes: Make sure the parameters match the expected function signature.
   - What happens if removed: The script fails with syntax or scope errors.

2. **Line 2: Data Structure Initialization**
   - What this line does: Allocates memory for storing visited values (e.g. an empty dictionary \`seen = {}\`).
   - Why it is needed: Keeps track of complements dynamically as we traverse.
   - Beginner notes: Using a hash map ensures we do lookups in constant $O(1)$ time.
   - What happens if removed: We lose track of seen numbers, forcing a brute-force $O(N^2)$ double loop.

3. **Line 3: The Loop**
   - What this line does: Iterates over the items in the input collection.
   - Why it is needed: Inspects each element sequentially.
   - Beginner notes: Be careful of off-by-one errors or indexing bounds.
   - What happens if removed: Only a single element is evaluated, failing to check remaining array pairs.

Does this breakdown help clarify the execution order? Which line would you like to zoom in on?`;
  }

  // 10. Help me debug
  if (msgLower.includes("debug") || msgLower.includes("why is my code failing") || msgLower.includes("error")) {
    const errorText = context.error || "";
    const code = context.code || "";
    if (errorText) {
      return `Ah, I see your code ran into an error: \`${errorText}\`. Let's debug this together!

Looking at your code:
\`\`\`
${code}
\`\`\`

**What caused it:**
This type of issue usually occurs when referencing an index outside the boundaries of the array, or referencing a key in a map that hasn't been initialized yet.

**How to fix it:**
1. Check that your loops stop before \`nums.length\` (or \`len(nums)\`).
2. If accessing a map, check if the key exists (\`containsKey\` in Java, or \`in\` in Python) before fetching its value.

Try making that tweak and run the code again. Let me know if the error changes!`;
    }
    return `I'd be happy to help you debug! Could you paste your code or run it in the playground so we can analyze the compiler logs or exceptions? Tell me what behavior you're seeing vs what you expect.`;
  }

  // 11. Optimize my solution
  if (msgLower.includes("optimize") || msgLower.includes("better way") || msgLower.includes("speed up")) {
    return `Nice job getting a working solution! To optimize it, we want to look at reducing the operations from $O(N^2)$ to $O(N)$.

Currently, if you are using nested loops:
- The outer loop runs $N$ times.
- The inner loop runs up to $N$ times.
This results in $N \\times N = N^2$ comparisons, which gets very slow for arrays with 10,000+ elements.

**The Optimization Strategy:**
Instead of re-scanning the array for the complement on every iteration, we store elements in a Hash Map as we visit them. The Hash Map does lookups in $O(1)$ time, which means we only need to pass through the array **once**.

This brings our time complexity down to $O(N)$! The trade-off is that it uses $O(N)$ auxiliary space for the map, which is almost always worth it for the massive speedup.

Would you like to try refactoring your loops into a hash map lookup? I can guide you through the syntax.`;
  }

  // 12. Interview STAR questions
  if (screen === "interview" && (msgLower.includes("review my answer") || msgLower.includes("evaluate") || msgLower.includes("star") || msgLower.includes("coach"))) {
    return `Nice job sharing your answer! Let's structure a mock interview evaluation for you:

### **Evaluation**
- **Correctness Score:** 80%
- **Confidence/Delivery Score:** 85%
- **Technical Signals:** You correctly identified the target trade-offs, but could emphasize time vs space complexity trade-offs explicitly.

### **How to Improve (using STAR):**
- **Situation:** Set the scene in 1 sentence. E.g., *"In my last project, our backend query latency spiked by 300% during peak hours."*
- **Task:** Explain what *you* were responsible for.
- **Action:** Describe your specific programming implementation.
- **Result:** Cite numbers! *"This decreased search times from 4.5 seconds to 120 milliseconds."*

Try restating your answer with that structure. I'm ready to evaluate your revised response!`;
  }

  // General catch-all conversational responses
  return `That's an interesting point! Let's explore that further. 

Could you tell me a bit more about what you're trying to achieve? If you're coding, sharing your current logic or thoughts is a great way to start. If you're prepping, we can look at some concrete examples!`;
}

async function getAiResponse(message, context, userId) {
  // Pull last 10 messages for history
  const historyLogs = db.chatLogs.find(log => log.userId === userId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-10);

  const historyMessages = historyLogs.map(log => ({
    role: log.role,
    content: log.content
  }));

  // Build current context information string
  let contextString = `Current Page context: ${context.page || context.screen || "Dashboard"}.`;
  if (context.problemTitle || context.activeQuestion) {
    contextString += ` Active Question: "${context.problemTitle || context.activeQuestion}".`;
  }
  if (context.language) {
    contextString += ` Active coding language: ${context.language}.`;
  }
  if (context.topic) {
    contextString += ` Active topic: ${context.topic}.`;
  }
  if (context.code) {
    contextString += ` Editor code:\n\`\`\`\n${context.code}\n\`\`\``;
  }
  if (context.error) {
    contextString += ` Running error:\n${context.error}`;
  }

  let systemInstructions = `You are a helpful, beginner-friendly AI Learning Assistant and personal mentor for computer science students.
Your core objective is to HELP STUDENTS LEARN. Do not simply give away solutions or code dumps immediately. Guide users toward thinking independently.
If the student asks a question about general computer science or preparation:
- Use simple language, analogies, and explain why concepts matter.
- Format conceptual explanations with standard headings: **Concept Overview**, **Why It Is Used**, **How It Works**, **Example**, **Common Mistakes**, **Interview Perspective**, and **Quick Revision Notes**.

If the student is in Coding Practice or asks about a coding problem:
- Enforce the Learning-First Progressive Help levels:
  * Level 1 (Understand the Problem): Explain inputs, outputs, parameters, and constraints. Do NOT reveal algorithm logic.
  * Level 2 (Give Hints): Suggest high-level hints and things to think about.
  * Level 3 (Discuss Approaches): Mention potential approaches (e.g. brute force vs hash maps) and trade-offs. Do NOT write pseudocode or code.
  * Level 4 (Explain Algorithm): Provide step-by-step logic and pseudocode. Do NOT write execution programs.
  * Level 5 (Provide Full Solution): Provide complete, commented implementation in Python, Java, or C ONLY when explicitly requested.
- If the user asks for a line-by-line explanation of code:
  * Explain every single line of code with 4 points: What this line does, Why it is needed, What happens if removed, and Beginner notes.
- If the user asks why code is failing, provide an Error Analysis (Syntax/Runtime/Logical checks) and Debugging Guidance (root cause, hints) without directly copy-pasting the complete corrected solution.

If the student is practicing mock interviews:
- Provide an Evaluation (correctness and confidence scores, missing concepts), Improvement Suggestions, and an Ideal Answer Breakdown.

Keep your tone inspiring, positive, and educational. Avoid dump of solutions unless explicitly asked.`;

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes("mock")) {
    return generateMockResponse(message, context, historyLogs);
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemInstructions + "\n\n" + contextString },
        ...historyMessages
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("AI Assistant chat failed:", error);
    throw new Error("AI Assistant failed to generate response. Please check OpenAI configurations.");
  }
}

app.get("/api/ai/mentor", requireAuth, (req, res) => {
  const logs = db.chatLogs.find(log => log.userId === req.user.id);
  logs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(logs.slice(-20));
});

app.post("/api/ai/mentor", requireAuth, async (req, res) => {
  const { message, context = {}, mode } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const userId = req.user.id;

  // Rate Limiting check: max 20 chats per hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const hourlyCount = db.chatLogs.find(
    log => log.userId === userId && log.createdAt >= oneHourAgo && log.role === "user"
  ).length;

  if (hourlyCount >= 20) {
    return res.status(429).json({ error: "AI Mentor hourly limit reached. Please try again in an hour." });
  }

  // Ensure context.page is set if mode is provided
  if (mode && !context.page) {
    context.page = mode;
  }

  // Save user message to log
  db.chatLogs.insert({
    userId,
    role: "user",
    content: message,
    context,
  });

  try {
    const responseText = await getAiResponse(message, context, userId);

    // Save assistant message to log
    db.chatLogs.insert({
      userId,
      role: "assistant",
      content: responseText,
      context,
    });

    res.json({ success: true, response: responseText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai/chat", requireAuth, async (req, res) => {
  const { message, context = {} } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const userId = req.user.id;

  // Rate Limiting check: max 20 chats per hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const hourlyCount = db.chatLogs.find(
    log => log.userId === userId && log.createdAt >= oneHourAgo && log.role === "user"
  ).length;

  if (hourlyCount >= 20) {
    return res.status(429).json({ error: "AI Mentor hourly limit reached. Please try again in an hour." });
  }

  // Save user message to log
  db.chatLogs.insert({
    userId,
    role: "user",
    content: message,
    context,
  });

  try {
    const responseText = await getAiResponse(message, context, userId);

    // Save assistant message to log
    db.chatLogs.insert({
      userId,
      role: "assistant",
      content: responseText,
      context,
    });

    res.json({ reply: responseText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/support/track", (req, res) => {
  const { event, location = "general" } = req.body;
  if (!event) {
    return res.status(400).json({ error: "Event is required." });
  }

  db.supportAnalytics.insert({
    event,
    location,
  });

  res.json({ success: true });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
});


// --- VITE MIDDLEWARE / STATIC FILES ---

if (isProduction) {
  const distDirectory = path.join(projectDirectory, "dist");
  app.use(express.static(distDirectory));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(distDirectory, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(port, () => {
  console.log(`Prepwise AI is running at http://localhost:${port}`);
});
