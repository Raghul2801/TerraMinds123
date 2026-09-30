# TerraMinds — "I am your Personal assistant that works for you"
React (Vite) frontend · Node/Express backend · SQLite DB · LangGraph pipeline (+LangSmith tracing) · Ollama qwen2.5:3b · GitHub Actions → Vercel
## Run locally
1. `ollama pull qwen2.5:3b`  2. `npm install`  3. `npm run api` (API :8787, creates server/terraminds.db)  4. `npm run dev`
Student: demo@student.com / demo123 · Admin: `/#admin` admin@finexa.com / admin123
## Observability
Admin → "Observability & DB": per-node LangGraph traces (also stored in the `traces` table). For LangSmith set LANGSMITH_TRACING=true and LANGSMITH_API_KEY (see .env.example).
## Deploy
Frontend → Vercel (CI/CD in .github/workflows/ci-cd.yml; add secrets VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID). Backend (needs a persistent disk for SQLite) → Render/Railway/Fly; put its URL in vercel.json. The local LLM runs where the backend runs.
