---
name: vector-store
description: Vector store authority — Qdrant operations, collection management, embedding submission, filtered semantic search, index optimization, payload indexing, and multi-tenant isolation patterns
keywords: ["vector", "store", "qdrant", "authority", "operations", "collection", "management", "embedding", "submission", "filtered", "semantic", "search", "index", "optimization", "payload"]
orb_class: moon
---

# vector-store

Covers production use of Qdrant as a vector database: collection lifecycle, batch upserts, hybrid search, payload filtering, snapshot management, and multi-tenant patterns.

## 1) Collection lifecycle

```python
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, OptimizersConfigDiff,
    HnswConfigDiff, PayloadSchemaType, QuantizationConfig,
    ScalarQuantizationConfig, ScalarType,
)

qdrant = QdrantClient(host="localhost", port=6333)

def create_collection(name: str, dim: int = 1536, on_disk: bool = True):
    qdrant.recreate_collection(
        collection_name=name,
        vectors_config=VectorParams(size=dim, distance=Distance.COSINE, on_disk=on_disk),
        hnsw_config=HnswConfigDiff(m=16, ef_construct=200, full_scan_threshold=10_000),
        optimizers_config=OptimizersConfigDiff(indexing_threshold=20_000),
        on_disk_payload=on_disk,
    )
    # Index frequently-filtered payload fields
    for field in ("domain", "type", "published_at"):
        qdrant.create_payload_index(name, field, PayloadSchemaType.KEYWORD)

def delete_collection(name: str):
    qdrant.delete_collection(name)

def collection_info(name: str) -> dict:
    info = qdrant.get_collection(name)
    return {
        "points": info.points_count,
        "vectors": info.vectors_count,
        "status": info.status,
        "segments": info.segments_count,
    }
```

## 2) Batch upsert patterns

```python
from qdrant_client.models import PointStruct, UpdateStatus
import uuid, hashlib

def doc_id_to_uuid(doc_id: str) -> str:
    """Deterministic UUID from string ID — Qdrant accepts UUIDs."""
    return str(uuid.UUID(bytes=hashlib.md5(doc_id.encode()).digest()))

async def upsert_batch(
    collection: str,
    documents: list[dict],   # each: {"id": str, "text": str, "payload": dict}
    embed_fn,                # async (list[str]) -> list[list[float]]
    batch_size: int = 100,
) -> int:
    total = 0
    for i in range(0, len(documents), batch_size):
        batch = documents[i : i + batch_size]
        texts = [d["text"] for d in batch]
        vectors = await embed_fn(texts)
        points = [
            PointStruct(
                id=doc_id_to_uuid(d["id"]),
                vector=vec,
                payload={**d["payload"], "text": d["text"], "_doc_id": d["id"]},
            )
            for d, vec in zip(batch, vectors)
        ]
        result = qdrant.upsert(collection_name=collection, points=points, wait=True)
        assert result.status == UpdateStatus.COMPLETED
        total += len(points)
    return total
```

## 3) Search patterns

```python
from qdrant_client.models import Filter, FieldCondition, MatchValue, Range, SearchParams

async def semantic_search(
    collection: str,
    query: str,
    embed_fn,
    domain: str | None = None,
    type_filter: str | None = None,
    limit: int = 10,
    score_threshold: float = 0.70,
) -> list[dict]:
    vector = await embed_fn(query)

    must_conditions = []
    if domain:
        must_conditions.append(FieldCondition(key="domain", match=MatchValue(value=domain)))
    if type_filter:
        must_conditions.append(FieldCondition(key="type", match=MatchValue(value=type_filter)))

    results = qdrant.search(
        collection_name=collection,
        query_vector=vector,
        query_filter=Filter(must=must_conditions) if must_conditions else None,
        limit=limit,
        score_threshold=score_threshold,
        search_params=SearchParams(hnsw_ef=128, exact=False),
        with_payload=True,
    )
    return [{"score": r.score, "_id": r.id, **r.payload} for r in results]

async def multi_query_search(collection: str, queries: list[str], embed_fn, **kwargs) -> list[dict]:
    """Run multiple queries and merge+deduplicate by doc ID."""
    from collections import defaultdict
    seen: dict[str, dict] = {}
    for q in queries:
        for r in await semantic_search(collection, q, embed_fn, **kwargs):
            doc_id = r.get("_doc_id", r["_id"])
            if doc_id not in seen or r["score"] > seen[doc_id]["score"]:
                seen[doc_id] = r
    return sorted(seen.values(), key=lambda r: r["score"], reverse=True)
```

## 4) Payload update without re-embedding

```python
from qdrant_client.models import SetPayload, PointIdsList

def update_payload(collection: str, doc_id: str, updates: dict):
    """Update metadata without touching vectors."""
    point_uuid = doc_id_to_uuid(doc_id)
    qdrant.set_payload(
        collection_name=collection,
        payload=updates,
        points=PointIdsList(points=[point_uuid]),
    )

def delete_points_by_filter(collection: str, domain: str):
    """Remove all points matching a filter (e.g. stale domain content)."""
    from qdrant_client.models import FilterSelector
    qdrant.delete(
        collection_name=collection,
        points_selector=FilterSelector(
            filter=Filter(must=[FieldCondition(key="domain", match=MatchValue(value=domain))])
        ),
    )
```

## 5) Multi-tenant isolation

```python
# Strategy 1: Per-tenant collection (strong isolation, higher overhead)
def tenant_collection(tenant_id: str) -> str:
    return f"articles_{tenant_id}"

# Strategy 2: Shared collection with tenant payload filter (efficient, simpler)
async def tenant_search(tenant_id: str, query: str, embed_fn, **kwargs) -> list[dict]:
    return await semantic_search(
        collection="articles",
        query=query,
        embed_fn=embed_fn,
        domain=tenant_id,    # reuse domain field as tenant discriminator
        **kwargs,
    )

# Strategy 3: Named vectors (multiple embedding models per point)
from qdrant_client.models import NamedVector

def create_multi_vector_collection(name: str):
    qdrant.recreate_collection(
        collection_name=name,
        vectors_config={
            "small": VectorParams(size=1536, distance=Distance.COSINE),
            "large": VectorParams(size=3072, distance=Distance.COSINE),
        },
    )

def search_named(collection: str, vector: list[float], vector_name: str = "small", **kwargs):
    return qdrant.search(
        collection_name=collection,
        query_vector=NamedVector(name=vector_name, vector=vector),
        **kwargs,
    )
```

## 6) Snapshot and backup

```python
def create_snapshot(collection: str) -> str:
    snap = qdrant.create_snapshot(collection_name=collection)
    return snap.name

def list_snapshots(collection: str) -> list[str]:
    return [s.name for s in qdrant.list_snapshots(collection_name=collection)]

def restore_snapshot(collection: str, snapshot_name: str, snapshot_path: str):
    qdrant.restore_snapshot(
        collection_name=collection,
        location=snapshot_path,
    )
```

## 7) Index health and optimization

```python
def optimize_collection(collection: str):
    """Trigger segment optimizer — run after large bulk uploads."""
    qdrant.update_collection(
        collection_name=collection,
        optimizers_config=OptimizersConfigDiff(indexing_threshold=0),  # force index now
    )

def check_index_health(collection: str) -> dict:
    info = qdrant.get_collection(collection)
    return {
        "indexed_vectors": info.indexed_vectors_count,
        "total_vectors": info.vectors_count,
        "index_coverage": (info.indexed_vectors_count or 0) / max(info.vectors_count or 1, 1),
        "optimizer_status": str(info.optimizer_status),
    }
```

## 8) Checklist — vector store

- [ ] `on_disk_payload: True` for collections > 50k points
- [ ] Payload fields used in filters have `.create_payload_index()` called
- [ ] HNSW `ef` tuned: `m=16, ef_construct=200` for recall/speed balance
- [ ] Batch upserts in chunks of 100 (avoid memory spikes)
- [ ] UUIDs derived deterministically from doc_id (idempotent re-ingestion)
- [ ] `score_threshold` set to avoid low-confidence results polluting RAG
- [ ] Multi-tenant isolation via payload filter (not separate collections unless required)
- [ ] Snapshot scheduled after large ingestion runs
- [ ] `optimize_collection()` called after bulk loads (forces HNSW indexing)
- [ ] Index coverage > 95% before going live (check `indexed_vectors_count`)
