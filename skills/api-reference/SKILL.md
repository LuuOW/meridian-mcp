---
name: api-reference
description: OpenAPI/AsyncAPI spec authoring, Swagger UI hosting, endpoint doc patterns, request/response examples, error catalogs, and SDK reference generation for REST and WebSocket APIs
---

# api-reference

Production patterns for writing, validating, and publishing machine-readable API reference documentation. Covers OpenAPI 3.1, AsyncAPI 2.x, doc generation from code annotations, and consumer-facing reference portals.

## OpenAPI 3.1 Document Skeleton

Start from a valid skeleton; fill in the gaps rather than building from scratch.

```yaml
# openapi.yaml
openapi: "3.1.0"

info:
  title: Acme API
  version: "2.4.0"
  description: |
    REST API for the Acme platform.
    
    **Base URL:** `https://api.acme.io/v2`  
    **Auth:** Bearer token via `Authorization` header  
    **Rate limits:** 1000 req/min per token  
  contact:
    name: Platform Team
    email: platform@acme.io
    url: https://status.acme.io
  license:
    name: Apache 2.0
    url: https://www.apache.org/licenses/LICENSE-2.0

servers:
  - url: https://api.acme.io/v2
    description: Production
  - url: https://sandbox.acme.io/v2
    description: Sandbox (no billing, safe to test)

tags:
  - name: widgets
    description: Create and manage widgets
  - name: auth
    description: Authentication and token management

paths:
  /widgets:
    get:
      operationId: listWidgets
      tags: [widgets]
      summary: List all widgets
      description: |
        Returns a paginated list of widgets owned by the authenticated account.
        Results are sorted by `created_at` descending.
      parameters:
        - $ref: "#/components/parameters/PageParam"
        - $ref: "#/components/parameters/LimitParam"
        - name: status
          in: query
          schema:
            type: string
            enum: [active, archived, draft]
          description: Filter by widget status
      responses:
        "200":
          description: Paginated list of widgets
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/WidgetList"
              examples:
                default:
                  $ref: "#/components/examples/WidgetListExample"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "429":
          $ref: "#/components/responses/RateLimited"

components:
  parameters:
    PageParam:
      name: page
      in: query
      schema:
        type: integer
        minimum: 1
        default: 1
    LimitParam:
      name: limit
      in: query
      schema:
        type: integer
        minimum: 1
        maximum: 100
        default: 20

  responses:
    Unauthorized:
      description: Missing or invalid authentication token
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
          example:
            code: UNAUTHORIZED
            message: "Bearer token is missing or expired"
    RateLimited:
      description: Rate limit exceeded
      headers:
        Retry-After:
          schema:
            type: integer
          description: Seconds until the rate limit resets
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"

  schemas:
    Error:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          description: Machine-readable error code
          example: VALIDATION_ERROR
        message:
          type: string
          description: Human-readable error description
        details:
          type: array
          items:
            type: object
            properties:
              field:
                type: string
              issue:
                type: string

  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

security:
  - BearerAuth: []
```

## Annotating FastAPI for Auto-Generated Docs

Let the framework write the OpenAPI skeleton; annotate to enrich it.

```python
from fastapi import FastAPI, Query, Path
from pydantic import BaseModel, Field
from typing import Annotated

app = FastAPI(
    title="Acme API",
    version="2.4.0",
    description="REST API for the Acme platform.",
    openapi_url="/openapi.json",
    docs_url="/docs",
    redoc_url="/redoc",
)

class Widget(BaseModel):
    id: str = Field(..., description="UUID of the widget", example="wgt_01j8k9...")
    name: str = Field(..., min_length=1, max_length=255, example="My Widget")
    status: Literal["active", "archived", "draft"] = Field(
        "draft",
        description="Lifecycle state of the widget"
    )

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {"id": "wgt_01j8k9abc", "name": "My Widget", "status": "active"}
            ]
        }
    )

@app.get(
    "/widgets/{widget_id}",
    summary="Get a widget",
    description="""
Retrieve a single widget by its ID.

Returns `404` if the widget does not exist or belongs to a different account.
    """,
    response_model=Widget,
    responses={
        404: {"description": "Widget not found"},
        401: {"description": "Unauthorized"},
    },
    tags=["widgets"],
    operation_id="getWidget",
)
async def get_widget(
    widget_id: Annotated[str, Path(description="The widget ID", example="wgt_01j8k9abc")],
) -> Widget:
    ...
```

## Error Catalog Pattern

Define a machine-readable error catalog. Consumers can map codes to localized messages without parsing human strings.

```yaml
# errors.yaml — source of truth, imported into OpenAPI and into code
errors:
  UNAUTHORIZED:
    http_status: 401
    message: "Bearer token is missing or expired."
    docs_url: "https://docs.acme.io/auth"

  RATE_LIMITED:
    http_status: 429
    message: "Rate limit exceeded. See Retry-After header."
    docs_url: "https://docs.acme.io/rate-limits"

  VALIDATION_ERROR:
    http_status: 422
    message: "One or more request fields failed validation."
    docs_url: "https://docs.acme.io/errors#validation"

  NOT_FOUND:
    http_status: 404
    message: "The requested resource does not exist or is not accessible."

  CONFLICT:
    http_status: 409
    message: "A resource with this identifier already exists."
```

```python
# Generate Python ErrorCode enum from catalog at build time
import yaml, enum

catalog = yaml.safe_load(open("errors.yaml"))
ErrorCode = enum.Enum("ErrorCode", {k: k for k in catalog["errors"]})
```

## Changelog in OpenAPI

Track breaking changes inside the spec itself using `x-` extensions.

```yaml
info:
  version: "3.0.0"
  x-changelog:
    - version: "3.0.0"
      date: "2026-03-15"
      breaking: true
      changes:
        - "Removed `GET /v2/legacy-widgets` — use `GET /v3/widgets`"
        - "Renamed field `widget.created` → `widget.created_at`"
    - version: "2.4.0"
      date: "2025-11-01"
      breaking: false
      changes:
        - "Added `status` filter to `GET /widgets`"
        - "Added `Retry-After` header to 429 responses"
```

## SDK Reference Generation

Generate typed SDK clients directly from the OpenAPI spec so reference docs stay in sync with the implementation.

```bash
# Install openapi-generator
brew install openapi-generator   # or: npm i -g @openapitools/openapi-generator-cli

# Generate TypeScript SDK
openapi-generator generate \
  -i openapi.yaml \
  -g typescript-axios \
  -o sdk/typescript \
  --additional-properties=npmName=@acme/sdk,npmVersion=2.4.0

# Generate Python SDK
openapi-generator generate \
  -i openapi.yaml \
  -g python \
  -o sdk/python \
  --additional-properties=packageName=acme_sdk,packageVersion=2.4.0

# Generate Go SDK
openapi-generator generate \
  -i openapi.yaml \
  -g go \
  -o sdk/go \
  --additional-properties=packageName=acmesdk
```

```yaml
# .github/workflows/sdk-gen.yml — regenerate SDK on spec changes
on:
  push:
    paths: ["openapi.yaml"]
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate TypeScript SDK
        run: |
          npx @openapitools/openapi-generator-cli generate \
            -i openapi.yaml -g typescript-axios -o sdk/typescript
      - name: Open PR with changes
        uses: peter-evans/create-pull-request@v6
        with:
          title: "chore: regenerate SDK from openapi.yaml"
          branch: chore/sdk-regen
```

## Hosting Reference Docs

```nginx
# nginx.conf — serve Swagger UI for the OpenAPI spec
server {
    listen 80;
    server_name docs.acme.io;

    # Redirect /api → /api/ (Swagger UI needs trailing slash)
    location = /api {
        return 301 /api/;
    }

    location /api/ {
        root /var/www/swagger-ui;
        index index.html;
        try_files $uri $uri/ /api/index.html;
    }

    # Serve the raw spec for tooling
    location /openapi.json {
        root /var/www/specs;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=60";
    }
}
```

```html
<!-- swagger-ui/index.html — pin Swagger UI version for reproducibility -->
<!DOCTYPE html>
<html>
<head>
  <title>Acme API Reference</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/openapi.json",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis],
      layout: "BaseLayout",
      deepLinking: true,
      persistAuthorization: true,
    });
  </script>
</body>
</html>
```

## Spec Validation in CI

```bash
# Validate OpenAPI spec (catches schema errors before merge)
npx @stoplight/spectral-cli lint openapi.yaml --ruleset .spectral.yaml

# .spectral.yaml — house rules on top of the OAS ruleset
extends: ["spectral:oas"]
rules:
  operation-operationId: error          # Every operation must have operationId
  operation-tags: error                 # Every operation must have at least one tag
  operation-description: warn           # Description is strongly recommended
  info-contact: error                   # Contact block required
  no-$ref-siblings: error
```

## Common Mistakes

- Putting examples inside `schema` objects instead of `examples` — examples in schemas don't render in Swagger UI
- Using `anyOf` where `oneOf` is correct — `anyOf` means "valid against one or more", `oneOf` means exactly one; wrong choice breaks generated validators
- Not versioning the spec file itself in git — `openapi.yaml` should be committed alongside application code, not generated at runtime
- Writing `description: string` with no actual description — remove the field rather than leaving a type annotation
- Forgetting `operationId` — without it, generated SDKs use unpredictable method names like `getWidgetsWidgetIdTagsTagId`
