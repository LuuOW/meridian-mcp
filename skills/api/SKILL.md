---
name: api
description: FastAPI + async/sync HTTP client patterns, JWT auth, multi-provider routing, Pydantic request/response models, CORS, background tasks, and typed frontend API clients — synthesized from lead-gen-engine and seo-geo-aeo-engine
keywords: ["api", "fastapi", "http", "jwt", "pydantic", "cors", "async/sync", "client", "patterns", "auth", "multi-provider", "routing", "request/response", "models", "background", "tasks"]
orb_class: planet
---

# api

Production patterns for building and consuming APIs in the Python/FastAPI + TypeScript/React stack used across lead-gen-engine and seo-geo-aeo-engine.

## 1) FastAPI App Structure

```python
# api/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: init DB pool, Redis, scheduler
    await db.connect()
    yield
    # Shutdown: close pool
    await db.disconnect()

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3002"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
from api.routes import auth, campaigns, prospects
app.include_router(auth.router, prefix="/api/auth")
app.include_router(campaigns.router, prefix="/api/campaigns")
app.include_router(prospects.router, prefix="/api")
```

## 2) Route Module Pattern

```python
# api/routes/campaigns.py
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from api.deps import get_db, get_current_user

router = APIRouter()

class OnboardRequest(BaseModel):
    name: str
    domain: str
    target_icp: str | None = None

class CampaignResponse(BaseModel):
    id: int
    name: str
    status: str

@router.post("/campaigns/onboard", response_model=CampaignResponse)
def onboard_campaign(body: OnboardRequest, db=Depends(get_db)):
    campaign = db.insert("campaigns", {"name": body.name, "domain": body.domain})
    return campaign

@router.get("/campaigns", response_model=list[CampaignResponse])
def list_campaigns(status: str | None = None, db=Depends(get_db)):
    filters = {"status": status} if status else {}
    return db.fetch_many("campaigns", filters)
```

## 3) JWT Auth Pattern

```python
# shared/auth.py
import os
from datetime import datetime, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "change-me-in-production")
ALGORITHM = "HS256"
EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "480"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(minutes=EXPIRE_MINUTES)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return {"id": payload["sub"], "email": payload["email"], "role": payload["role"]}
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)
```

```python
# api/routes/auth.py
from fastapi.security import OAuth2PasswordRequestForm

@router.post("/login")
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = get_user_by_email(form_data.username)
    if not user or not verify_password(form_data.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    token = create_access_token({"sub": str(user["id"]), "email": user["email"], "role": user["role"]})
    return {"access_token": token, "token_type": "bearer"}
```

## 4) Sync httpx Client (lead-gen pattern)

```python
# shared/external_api.py
import os
import httpx

_DEFAULT_TIMEOUT = 30

def _get_api_key(env_var: str, service: str, signup_url: str) -> str:
    key = os.environ.get(env_var, "").strip()
    if not key:
        raise EnvironmentError(
            f"{env_var} is not set. Add it to your .env file. "
            f"Get your key at: {signup_url}"
        )
    return key

def _handle_response(response: httpx.Response, context: str) -> dict:
    if response.status_code in (200, 201):
        return response.json() if response.content else {"ok": True}
    if response.status_code in (401, 403):
        raise PermissionError(f"{context}: authentication failed — check your API key")
    if response.status_code == 429:
        raise RuntimeError(f"{context}: rate limited")
    if response.status_code == 404:
        raise LookupError(f"{context}: resource not found")
    raise RuntimeError(f"{context}: unexpected {response.status_code} — {response.text[:200]}")

def search_organizations(query: dict) -> list[dict]:
    from shared.mock_helper import is_mock_mode, load_fixture
    if is_mock_mode():
        return load_fixture("organizations.json")

    key = _get_api_key("APOLLO_API_KEY", "Apollo", "https://app.apollo.io/")
    with httpx.Client(timeout=_DEFAULT_TIMEOUT) as client:
        resp = client.post(
            "https://api.apollo.io/v1/mixed_people/search",
            headers={"X-Api-Key": key, "Content-Type": "application/json"},
            json=query,
        )
        return _handle_response(resp, "Apollo search")["people"]
```

## 5) Async httpx Client (seo-geo-aeo pattern)

```python
# core/llm_client.py
import httpx
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

async def call_llm(prompt: str, system: str = "", provider: str = "anthropic") -> str:
    settings = get_settings()

    if provider == "anthropic":
        client = AsyncAnthropic(api_key=settings.anthropic_api_key)
        msg = await client.messages.create(
            model="claude-opus-4-6",
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text

    if provider == "openai":
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content

    # Generic OpenAI-compatible provider (Moonshot, Gemini, etc.)
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            settings.generic_llm_base_url + "/chat/completions",
            headers={"Authorization": f"Bearer {settings.generic_llm_api_key}"},
            json={
                "model": settings.generic_llm_model,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
```

## 6) Background Tasks with Job ID Polling

```python
# api/routes/agents.py
import uuid
from fastapi import APIRouter, BackgroundTasks
from core.redis import get_redis

router = APIRouter()

@router.post("/agents/e1/run")
async def trigger_e1(background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    redis = await get_redis()
    await redis.set(f"job:{job_id}:status", "queued")
    background_tasks.add_task(run_e1_agent, job_id)
    return {"job_id": job_id, "status": "queued"}

@router.get("/agents/jobs/{job_id}")
async def get_job_status(job_id: str):
    redis = await get_redis()
    status = await redis.get(f"job:{job_id}:status")
    result = await redis.get(f"job:{job_id}:result")
    return {"job_id": job_id, "status": status, "result": result}

async def run_e1_agent(job_id: str):
    redis = await get_redis()
    await redis.set(f"job:{job_id}:status", "running")
    try:
        result = await e1_crawl_and_audit()
        await redis.set(f"job:{job_id}:result", result)
        await redis.set(f"job:{job_id}:status", "done")
    except Exception as exc:
        await redis.set(f"job:{job_id}:status", f"error: {exc}")
```

## 7) Slack HMAC Signature Verification

```python
# api/routes/slack.py
import hashlib, hmac, time
from fastapi import APIRouter, Request, HTTPException

router = APIRouter()

def verify_slack_signature(request_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False  # Replay attack guard
    base = f"v0:{timestamp}:{request_body.decode()}"
    expected = "v0=" + hmac.new(secret.encode(), base.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)

@router.post("/slack/commands")
async def slack_command(request: Request):
    body = await request.body()
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")
    secret = get_settings().slack_signing_secret

    if not verify_slack_signature(body, timestamp, signature, secret):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    form = await request.form()
    command = form.get("command")
    # ... handle command
```

## 8) Typed Frontend API Client (axios + TanStack Query)

```ts
// src/api/client.ts
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:9002',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('app_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('app_token');
      window.dispatchEvent(new Event('auth:logout'));
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// Typed endpoint wrappers
export const authLogin = (email: string, password: string) =>
  api.post<{ access_token: string; email: string; role: string }>(
    '/api/auth/login',
    new URLSearchParams({ username: email, password })
  );

export const getCampaigns = (status?: string) =>
  api.get<Campaign[]>('/api/campaigns', { params: { status } });

export default api;
```

```ts
// src/hooks/useCampaigns.ts  — TanStack Query wrapper
import { useQuery } from '@tanstack/react-query';
import { getCampaigns } from '@/api/client';

export function useCampaigns(status?: string) {
  return useQuery({
    queryKey: ['campaigns', status],
    queryFn: () => getCampaigns(status).then((r) => r.data),
  });
}
```

## 9) API Dependency Injection

```python
# api/deps.py
from fastapi import Depends
from database.connection import get_adapter
from shared.auth import get_current_user

def get_db():
    """Yields a database adapter; releases connection on exit."""
    db = get_adapter()
    try:
        yield db
    finally:
        db.close()

# Usage in route:
# @router.get("/me")
# def me(user=Depends(get_current_user), db=Depends(get_db)):
```

## 10) Checklist

- [ ] All external API keys fetched via `_get_api_key()` — never bare `os.environ.get()`
- [ ] `_handle_response()` used for every httpx call — maps status codes to typed exceptions
- [ ] Mock mode guard at top of every external API function
- [ ] JWT `SECRET_KEY` loaded from env, never hardcoded
- [ ] CORS origins locked to known frontend URLs
- [ ] `BackgroundTasks` jobs return `job_id` immediately — never block the request
- [ ] Slack endpoints verify HMAC before processing
- [ ] Frontend axios instance has 401 interceptor → logout + redirect
- [ ] `response_model=` set on all FastAPI routes for auto-serialization
