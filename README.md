# Prepwise AI

An AI interview practice platform for students. It includes a polished landing page, local account flow, role-based mock interviews, browser speech recognition, adaptive answer evaluation, progress views, and a final coaching report.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:5173`.

## AI configuration

The app works immediately with a strict deterministic rubric that rejects nonsense and off-topic answers. To enable deeper model-based evaluation:

1. Copy `.env.example` to `.env`.
2. Add your server-side `OPENAI_API_KEY`.
3. The accuracy-first default is `gpt-5.5`; change `OPENAI_MODEL` if you prefer a lower-cost model.
4. Restart the development server.

The API key stays on the Express server and is never exposed to the browser.

## Current scope

- Authentication and per-user progress are local product demos backed by browser storage.
- New accounts begin with zero sessions and no generated sample progress.
- Production authentication should use a managed auth provider and database.
- Speech input uses the browser Web Speech API, with typed answers as a fallback.
- Interview evaluation automatically falls back to local coaching if the model API is unavailable.
"# PREPWISE-AI-INTERVIEW-PRACTICE-PLATFORM" 
