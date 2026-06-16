import { spawn } from "node:child_process";
import assert from "node:assert";
import test from "node:test";
import crypto from "node:crypto";

const TEST_PORT = "5199";
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Helper: Wait for test server to be ready
function waitForServer() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (res.ok) {
          clearInterval(interval);
          resolve();
        }
      } catch (err) {
        if (attempts > 30) {
          clearInterval(interval);
          reject(new Error("Server failed to start on port " + TEST_PORT));
        }
      }
    }, 200);
  });
}

test("Prepwise AI Platform Integration Test Suite", async (t) => {
  // 1. Boot test server on TEST_PORT
  console.log(`Starting test server on port ${TEST_PORT}...`);
  const serverProcess = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: TEST_PORT,
      NODE_ENV: "production", // avoids booting Vite middleware during tests
    },
  });

  // Log server output to check for errors
  serverProcess.stderr.on("data", (data) => {
    console.error(`[Server Error]: ${data}`);
  });

  try {
    await waitForServer();
    console.log("Test server is online. Running test suites...");

    // Generate unique email address for signup
    const randomEmail = `test_${crypto.randomBytes(4).toString("hex")}@example.com`;
    const adminEmail = "admin@prepwise.ai";
    let userToken = "";
    let adminToken = "";
    let createdQuestionId = "";

    // Test 1: User Signup
    await t.test("POST /api/auth/signup - Successful Signup", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test User",
          email: randomEmail,
          password: "testpassword123",
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.token);
      assert.strictEqual(data.user.email, randomEmail.toLowerCase());
      assert.strictEqual(data.user.role, "user");
      userToken = data.token;
    });

    // Test 2: Duplicate Signup Prevention
    await t.test("POST /api/auth/signup - Prevent Duplicate Signups", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Duplicate User",
          email: randomEmail.toUpperCase(), // check uppercase normalization match
          password: "differentpassword",
        }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, "An account already exists with this email. Please sign in.");
    });

    // Test 3: User Signin with Email Normalization
    await t.test("POST /api/auth/signin - Signin with Email Normalization", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: randomEmail.toUpperCase(),
          password: "testpassword123",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.strictEqual(data.user.email, randomEmail.toLowerCase());
    });

    // Test 4: Access Protection Middlewares (User trying to access admin routes)
    await t.test("GET /api/admin/users - Rejects Non-Admin Token", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.error, "Access denied. Administrator privileges required.");
    });

    // Test 5: Access Protection Middlewares (Unauthenticated route)
    await t.test("GET /api/admin/users - Rejects Unauthenticated Request", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users`);
      assert.strictEqual(res.status, 401);
    });

    // Test 6: Admin Signin & Stats Fetching
    await t.test("POST /api/auth/signin - Admin Login", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: adminEmail,
          password: "admin123",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.strictEqual(data.user.role, "admin");
      adminToken = data.token;
    });

    await t.test("GET /api/admin/stats - Admin Stats", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.totalUsers > 0);
      assert.ok(data.totalQuestions > 0);
    });

    // Test 7: Question CRUD Operations
    await t.test("POST /api/questions - Create Question", async () => {
      const res = await fetch(`${BASE_URL}/api/questions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          question: "Test System Question?",
          category: "Technical",
          difficulty: "Easy",
          answer: "Expected System Answer",
          explanation: "Detailed test explanation.",
          tips: "Tip 1; Tip 2",
          tags: "TestTag; Custom",
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.id);
      assert.strictEqual(data.question, "Test System Question?");
      createdQuestionId = data.id;
    });

    await t.test("PUT /api/questions/:id - Update Question", async () => {
      const res = await fetch(`${BASE_URL}/api/questions/${createdQuestionId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          question: "Test System Question Updated?",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.question, "Test System Question Updated?");
    });

    await t.test("DELETE /api/questions/:id - Delete Question", async () => {
      const res = await fetch(`${BASE_URL}/api/questions/${createdQuestionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
    });

    // Test 8: Preparation Hub APIs
    await t.test("GET /api/prep/content - Retrieve learning content", async () => {
      const res = await fetch(`${BASE_URL}/api/prep/content`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.length > 0);
      assert.strictEqual(data[0].category, "DSA");
    });

    // Test 9: Practice Session telemetry
    await t.test("POST /api/practice-sessions - Save session and verify stats", async () => {
      const saveRes = await fetch(`${BASE_URL}/api/practice-sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          role: "Frontend Developer",
          score: 85,
          duration: 360,
          strengths: ["Clean code structure"],
          weaknesses: ["Add trade-off explain"],
          answers: [],
        }),
      });

      assert.strictEqual(saveRes.status, 201);

      const statsRes = await fetch(`${BASE_URL}/api/practice-sessions/stats`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(statsRes.status, 200);
      const statsData = await statsRes.json();
      assert.strictEqual(statsData.totalInterviews, 1);
      assert.strictEqual(statsData.averageScore, 85);
      assert.strictEqual(statsData.strongestTopics, "Frontend Developer");
    });

    // Test 10: Coding Playground APIs
    await t.test("GET /api/coding/questions - Retrieve Coding Problems", async () => {
      const res = await fetch(`${BASE_URL}/api/coding/questions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.length > 0);
      assert.ok(data[0].title);
    });

    await t.test("POST /api/coding/draft - Save and Get Draft", async () => {
      const qRes = await fetch(`${BASE_URL}/api/coding/questions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const questions = await qRes.json();
      const qId = questions[0].id;

      // Save draft
      const saveRes = await fetch(`${BASE_URL}/api/coding/draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          questionId: qId,
          language: "python",
          code: "print('draft')",
        }),
      });
      assert.ok(saveRes.status === 200 || saveRes.status === 201);

      // Get draft
      const getRes = await fetch(`${BASE_URL}/api/coding/draft/${qId}/python`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(getRes.status, 200);
      const draftData = await getRes.json();
      assert.strictEqual(draftData.code, "print('draft')");
    });

    await t.test("POST /api/coding/run - Execute Safe Code", async () => {
      const qRes = await fetch(`${BASE_URL}/api/coding/questions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const questions = await qRes.json();
      const qId = questions[0].id;

      const res = await fetch(`${BASE_URL}/api/coding/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          questionId: qId,
          language: "python",
          code: "import sys\nline = sys.stdin.read().strip()\nprint(f'Hello {line}')",
          customInput: "World",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, "success");
      assert.strictEqual(data.runtimeOutput.trim(), "Hello World");
    });

    await t.test("POST /api/coding/run - Block Malicious Code", async () => {
      const qRes = await fetch(`${BASE_URL}/api/coding/questions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const questions = await qRes.json();
      const qId = questions[0].id;

      const res = await fetch(`${BASE_URL}/api/coding/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          questionId: qId,
          language: "python",
          code: "import os\nos.system('dir')",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, "error");
      assert.ok(data.runtimeError.includes("Security Error"));
    });

    // Test 11: strict topic and subtopic filtering
    await t.test("GET /api/questions/role/:role - Strict HR topics", async () => {
      const res = await fetch(`${BASE_URL}/api/questions/role/HR`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.questions.length, 5);
      data.questions.forEach((q) => {
        assert.strictEqual(q.category, "HR");
      });
    });

    await t.test("GET /api/questions/role/:role - Strict Subtopic filtering", async () => {
      const res = await fetch(`${BASE_URL}/api/questions/role/Trees`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.questions.length > 0);
      data.questions.forEach((q) => {
        assert.ok(
          q.tags && q.tags.some((tag) => ["trees", "bst"].includes(tag.toLowerCase()))
        );
      });
    });

    // Test 12: AI Learning Assistant APIs
    await t.test("AI Learning Assistant APIs (Chat & Recommendations & Rate-limiting)", async (st) => {
      // 12.1. GET /api/ai/chat & /api/ai/mentor - initially empty
      const getChatRes = await fetch(`${BASE_URL}/api/ai/chat`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(getChatRes.status, 200);
      const chatLogs = await getChatRes.json();
      assert.ok(Array.isArray(chatLogs));

      const getMentorRes = await fetch(`${BASE_URL}/api/ai/mentor`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(getMentorRes.status, 200);
      const mentorLogs = await getMentorRes.json();
      assert.ok(Array.isArray(mentorLogs));
      assert.strictEqual(mentorLogs.length, chatLogs.length);

      // Verify POST /api/ai/mentor works and adheres to spec schema
      const postMentorRes1 = await fetch(`${BASE_URL}/api/ai/mentor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          message: "Explain hashing simply",
          context: { page: "preparation", topic: "hashing" },
          mode: "preparation"
        }),
      });
      assert.strictEqual(postMentorRes1.status, 200);
      const mentorData1 = await postMentorRes1.json();
      assert.strictEqual(mentorData1.success, true);
      assert.ok(mentorData1.response.includes("Concept Overview"));

      // 12.2. POST /api/ai/chat - Concept Explanation (hashing)
      const postChatRes1 = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          message: "Explain hashing simply",
          context: { screen: "prep_hub", topic: "hashing" },
        }),
      });
      assert.strictEqual(postChatRes1.status, 200);
      const chatData1 = await postChatRes1.json();
      assert.ok(chatData1.reply.includes("Concept Overview"));
      assert.ok(chatData1.reply.includes("Why It Is Used"));
      assert.ok(chatData1.reply.includes("How It Works"));

      // 12.3. POST /api/ai/chat - Progressive coding hints (Level 1)
      const postChatResLevel = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          message: "Level 1: Understand the problem",
          context: { screen: "coding", activeQuestion: "Two Sum" },
        }),
      });
      assert.strictEqual(postChatResLevel.status, 200);
      const chatDataLevel = await postChatResLevel.json();
      assert.ok(chatDataLevel.reply.includes("Level 1"));
      assert.ok(!chatDataLevel.reply.includes("def two_sum"));

      // 12.4. POST /api/ai/chat - Line-by-line code explainer
      const postChatResLine = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          message: "Explain the code line-by-line",
          context: { screen: "coding", code: "def solve():\n    pass" },
        }),
      });
      assert.strictEqual(postChatResLine.status, 200);
      const chatDataLine = await postChatResLine.json();
      assert.ok(chatDataLine.reply.includes("Line 1"));
      assert.ok(chatDataLine.reply.includes("What this line does"));
      assert.ok(chatDataLine.reply.includes("Why it is needed"));

      // 12.5. GET /api/ai/recommendations - personalized telemetry items
      const recsRes = await fetch(`${BASE_URL}/api/ai/recommendations`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(recsRes.status, 200);
      const recsData = await recsRes.json();
      assert.ok(Array.isArray(recsData.weakTopics));
      assert.ok(Array.isArray(recsData.strongTopics));
      assert.ok(recsData.preferredLanguage);
      assert.ok(Array.isArray(recsData.recommendedProblems));
      assert.ok(Array.isArray(recsData.mockInterviewSuggestions));

      // 12.6. POST /api/ai/chat/clear - Clear chat
      const clearRes = await fetch(`${BASE_URL}/api/ai/chat/clear`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(clearRes.status, 200);
      const clearData = await clearRes.json();
      assert.strictEqual(clearData.success, true);

      // Verify empty after clearing
      const getChatResAfter = await fetch(`${BASE_URL}/api/ai/chat`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const chatLogsAfter = await getChatResAfter.json();
      assert.strictEqual(chatLogsAfter.length, 0);

      // 12.7. Rate Limiting Check (20 submits per hour limit)
      for (let i = 0; i < 20; i++) {
        await fetch(`${BASE_URL}/api/ai/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ message: `Message ${i}` }),
        });
      }
      
      const resRateLimited = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ message: "Should be blocked" }),
      });
      assert.strictEqual(resRateLimited.status, 429);
      const limitErr = await resRateLimited.json();
      assert.strictEqual(limitErr.error, "AI Mentor hourly limit reached. Please try again in an hour.");

      // Test Support Analytics Tracking endpoint
      const trackRes = await fetch(`${BASE_URL}/api/support/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "button_click", location: "sidebar" }),
      });
      assert.strictEqual(trackRes.status, 200);
      const trackData = await trackRes.json();
      assert.strictEqual(trackData.success, true);
    });

  } finally {
    // 5. Tear down: Terminate test server subprocess
    console.log("Tearing down test server...");
    serverProcess.kill("SIGTERM");
  }
});
