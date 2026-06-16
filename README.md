# <p align="center"><img src="https://raw.githubusercontent.com/lucide-react/lucide/main/icons/brain-circuit.svg" width="48" height="48" alt="Prepwise AI Logo" style="vertical-align: middle;" /> <br>prepwise.ai</p>

<p align="center">
  <strong>An Intelligent, Adaptively Orchestrated AI Interview Preparation & Coding Platform</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18.3-61dafb?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/Express-5.1-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Vite-6.1-646cff?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/OpenAI-GPT--4o-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License" />
</p>

---

## 🌟 Introduction

**Prepwise AI** is a local-first, full-stack interactive mock interview and learning platform designed to help students and developers bridge the gap between technical knowledge and real-world performance. 

Unlike passive question-and-answer websites, Prepwise AI replicates the pressure and feedback of real tech interviews. It captures speech input, adaptively evaluates answer quality, generates custom coaching advice, and tracks progress across technical categories (Data Structures, Systems, and Frontend Frameworks) alongside a dedicated in-browser Coding Playground.

---

## ✨ Core Features

### 🎙️ 1. Multi-Modal AI Interview Room
*   **Adaptive Follow-Up System**: The interviewer adapts on-the-fly, pushing you with relevant follow-up questions tailored to your previous responses.
*   **Web Speech Integration**: Leverages native browser Web Speech API for seamless voice-to-text response capture, with full support for manual typing fallback.
*   **Audio Waveform Visualizer**: Smooth CSS-animated waveforms provide real-time visual feedback during recording segments.

### 🧠 2. Dual Evaluation Architecture
*   **Strict Local Rubric (Zero-Cost)**: A fast, deterministic rules engine that analyzes token density, structure, evidence-based metrics, and concept coverage to reject placeholders or off-topic responses.
*   **Structured GPT Evaluator**: When OpenAI is configured, details are passed to the GPT model using JSON Schema Structured Outputs, scoring clarity, relevance, impact, and supplying concrete feedback on missing concepts.

### 💻 3. Interactive Coding Workspace
*   **Code Editor & Dashboard**: An integrated coding dashboard containing standard DSA problems, full language syntax selectors, and execution tracking.
*   **Draft Preservation**: Automatic caching of code drafts, logs of execution attempts, and performance summaries.

### 📚 4. Preparation Hub
*   **Seeded Learning Portals**: Pre-configured documentation, FAQs, and interactive quick-quizzes across 9 core engineering tracks:
    *   *Data Structures & Algorithms (DSA)*
    *   *Java Core & Object-Oriented Programming*
    *   *Python Development & GIL Architecture*
    *   *Database Management Systems (DBMS) & SQL*
    *   *Operating Systems (Processes, Deadlocks, Virtual Memory)*
    *   *Computer Networks (OSI Layers, TCP/UDP Handshakes, DNS)*
    *   *React Framework Internals & Reconciliation*
    *   *Node.js Backend Architecture & Event Loops*
*   **Quiz Scoring**: Track correct/incorrect answers dynamically with detailed explanations.

### 📊 5. Telemetry & Analytics Dashboard
*   **Streaks & Trends**: Tracks continuous practice streaks and visualizes average score trends across session histories.
*   **Concept Analysis**: Highlights strongest and weakest concepts based on detailed feedback statistics.
*   **Activity Logs**: Sequential timeline recording quizzes taken, interviews finished, and bookmarks created.

### ⚙️ 6. Administration Control Center
*   **Question Bank Management**: Full CRUD interface for adding, deleting, or editing technical questions.
*   **Bulk Data Import**: Support for bulk-uploading custom question banks in standard CSV/JSON formats with built-in duplicate matching and validation checks.
*   **App Settings Panel**: System admins can globally modify timers (none, question-based, interview-based) and duration limits.

---

## 🛠️ Technology Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend** | **React 18.3** + **Vite 6** | Fast building and responsive UI components. |
| **Styling** | **Vanilla CSS3** | Custom themed system, glassmorphic dashboards, variables, and dark/light modes. |
| **Backend** | **Express 5.1** + **Node.js** | Modular API router with custom middleware stack. |
| **Database** | **Custom JSON `FileDB`** | Resilient local file storage with atomic writes, cascading deletes, and self-initializing schema collections. |
| **AI Integration** | **OpenAI SDK** | Structured response mapping with GPT-based evaluations. |
| **Icons** | **Lucide React** | Sleek SVG micro-indicator icons. |

---

## 📂 Project Architecture

```filepath
prepwise-ai/
├── data/                       # Local JSON database directories
│   ├── users.json
│   ├── questions.json
│   └── practice_sessions.json
├── src/                        # Client-side React Application
│   ├── main.jsx                # Application root mounting
│   ├── App.jsx                 # Single-file component workspace (Dashboard, Interview, Hub, Coding)
│   └── styles.css              # Glassmorphic, modern responsive layout variables and themes
├── db.js                       # FileDB interface wrapper (CRUD operations + Table instances)
├── seed.js                     # Seed scripting for default admin and technical learning material
├── server.js                   # Node/Express API Server (Auth, Evaluation routing, AI pipeline)
├── package.json                # Project dependencies and operational scripts
└── .env.example                # Sample environment configurations
```

---

## 🔒 Security & Resilience Design

*   **HMAC-SHA256 Token Sessions**: Generates secure JSON-Web-style tokens on the backend using constant key signatures to verify auth requests without database lookup.
*   **PBKDF2 Password Hashing**: Avoids plain-text leaks by using cryptographic key-derivation functions with unique salts.
*   **IP-Based Rate Limiting**: Built-in sliding-window map cache tracking requests per client IP to mitigate auth routing abuse.
*   **Graceful API Fallbacks**: The platform operates completely locally out-of-the-box, fallback-evaluating answers via local NLP rules if the OpenAI API key is missing or encounters a timeout/network error.

---

## 🚀 Installation & Local Setup

### 1. Prerequisites
Ensure you have **Node.js (v18+)** and **npm** installed on your system.

### 2. Clone and Install Dependencies
```bash
git clone https://github.com/Klusaketh/prepwise-ai.git
cd prepwise-ai
npm install
```

### 3. Configure AI Models (Optional)
Create a `.env` file in the root directory:
```bash
cp .env.example .env
```
Populate the keys in `.env`:
```env
PORT=5173
SESSION_SECRET=your_custom_secure_secret_key
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o
```
*Note: If no API key is specified, Prepwise AI automatically activates local heuristic evaluation.*

### 4. Run Seeding Script
Populate your database with the default admin credentials, standard tech topics, questions, and revision guides:
```bash
node seed.js
```

### 5. Start the Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🧑‍💻 Default User Credentials

After running `node seed.js`, you can sign in using these default credentials:

*   **Administrator Access**:
    *   **Email**: `admin@prepwise.ai`
    *   **Password**: `admin123`
*   **Student Demo Access**:
    *   Feel free to register a new local student account immediately via the Sign Up modal!

---

## 🤝 Support the Developer

If Prepwise AI has helped you structure your interview answers, learn new concepts, or improve your programming confidence, please consider supporting its development:

*   **Developer**: P Saketh
*   **UPI ID**: `8790994241@ibl`
*   In-app scanning is available via the **Support Development** modal directly in the sidebar or user profile settings.

---

## 📄 License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
