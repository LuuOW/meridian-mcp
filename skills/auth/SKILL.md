---
name: auth
description: JWT patterns, API key auth, Supabase Auth, OAuth2 flows, RBAC, FastAPI security dependencies
keywords: ["auth", "jwt", "api", "supabase", "oauth2", "rbac", "fastapi", "patterns", "key", "flows", "security", "dependencies"]
orb_class: trojan
---

# auth

Authentication and authorisation patterns across the stack: JWTs, API keys, Supabase Auth, and role-based access control.

## 1) JWT generation and verification (Python)

```python
from jose import jwt, JWTError
from datetime import datetime, timedelta, timezone

SECRET_KEY = os.getenv("JWT_SECRET")
ALGORITHM  = "HS256"

def create_token(user_id: str, role: str, expires_min: int = 60) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=expires_min),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError as e:
        raise HTTPException(401, detail=f"Invalid token: {e}")
```

## 2) FastAPI security dependency

```python
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

bearer = HTTPBearer()

async def get_current_user(
    creds: HTTPAuthorizationCredentials = Security(bearer),
) -> dict:
    return verify_token(creds.credentials)

async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    return user

# Route usage
@router.delete("/article/{slug}", dependencies=[Depends(require_admin)])
async def delete_article(slug: str): ...
```

## 3) API key authentication

```python
from fastapi import Header

API_KEYS = set(os.getenv("API_KEYS", "").split(","))   # comma-separated in .env

async def api_key_auth(x_api_key: str = Header(...)):
    if x_api_key not in API_KEYS:
        raise HTTPException(401, "Invalid API key")
    return x_api_key

# Rotating keys — store in Redis with expiry
async def validate_api_key(key: str) -> bool:
    return bool(await redis.get(f"apikey:{key}"))
```

## 4) Supabase Auth (server-side, Python)

```python
from supabase import create_client

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Verify a JWT from client
def verify_supabase_token(token: str) -> dict:
    user = supabase.auth.get_user(token)
    if not user.user:
        raise HTTPException(401, "Unauthenticated")
    return {"id": user.user.id, "email": user.user.email}

# Admin: create user
supabase.auth.admin.create_user({"email": "user@example.com", "password": "..."})

# Admin: list users
users = supabase.auth.admin.list_users()
```

## 5) Supabase Auth (client-side, JS/Astro)

```ts
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Sign in
const { data, error } = await supabase.auth.signInWithPassword({ email, password })

// Get current session
const { data: { session } } = await supabase.auth.getSession()

// Auto-refresh tokens
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') window.location.href = '/login'
})

// Pass token to API
const res = await fetch('/api/articles', {
  headers: { Authorization: `Bearer ${session.access_token}` }
})
```

## 6) RBAC (Role-Based Access Control)

```python
from enum import Enum

class Role(str, Enum):
    VIEWER = "viewer"
    EDITOR = "editor"
    ADMIN  = "admin"

PERMISSIONS = {
    Role.VIEWER: {"read"},
    Role.EDITOR: {"read", "write"},
    Role.ADMIN:  {"read", "write", "delete", "admin"},
}

def require_permission(action: str):
    async def check(user: dict = Depends(get_current_user)):
        role = Role(user.get("role", "viewer"))
        if action not in PERMISSIONS[role]:
            raise HTTPException(403, f"Action '{action}' requires higher role")
        return user
    return check

# Usage
@router.post("/publish", dependencies=[Depends(require_permission("write"))])
async def publish_article(...): ...
```

## 7) Secure cookie session (Node.js)

```js
import { serialize, parse } from 'cookie'
import { createHmac } from 'crypto'

const SECRET = process.env.SESSION_SECRET

function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64')
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifySession(cookie) {
  const [payload, sig] = cookie.split('.')
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url')
  if (sig !== expected) return null
  return JSON.parse(Buffer.from(payload, 'base64').toString())
}
```

## 8) .env pattern for secrets

```bash
# .env (never commit)
JWT_SECRET=<min 32 random bytes: openssl rand -hex 32>
API_KEYS=key1,key2,key3
SUPABASE_SERVICE_KEY=eyJ...   # server-side only — never expose client-side
SUPABASE_ANON_KEY=eyJ...      # client-safe

# Rotate keys without downtime: add new key to comma list, deploy, remove old key
API_KEYS=old_key,new_key   →   API_KEYS=new_key
```

## 9) Common auth pitfalls

| Mistake | Fix |
|---------|-----|
| Storing JWT in `localStorage` | Use `httpOnly` cookie or memory-only |
| No expiry on tokens | Always set `exp` claim |
| Service key in frontend code | Anon key client-side, service key server-side only |
| Checking role in JWT without verifying signature | Always verify before reading claims |
| Long-lived tokens without refresh | Short `access_token` (15min) + refresh token |

## 10) Checklist

- [ ] JWT secret is at least 32 random bytes (`openssl rand -hex 32`)
- [ ] All JWTs have `exp` claim
- [ ] Service keys (Supabase, OpenAI, etc.) only in server-side env vars
- [ ] API routes use dependency injection for auth — no manual header parsing
- [ ] RBAC checked at the route layer, not scattered through business logic
- [ ] Tokens invalidated on logout (Redis blocklist or Supabase `signOut`)
- [ ] `Authorization: Bearer` header — not query param (logs expose query params)
