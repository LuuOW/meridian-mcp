---
name: knowledge
description: Knowledge systems authority — RAG pipelines, vector search with Qdrant, embedding generation, semantic chunking, knowledge graph construction, retrieval evaluation, and citation-aware QA patterns
---

# knowledge

Covers how to build, maintain, and query knowledge systems: embedding pipelines, vector stores, RAG architecture, and retrieval quality evaluation.

## 1) Embedding generation

```python
from openai import AsyncOpenAI
import anthropic

client_oai = AsyncOpenAI(api_key=OPENAI_API_KEY)

async def embed_text(text: str, model: str = "text-embedding-3-small") -> list[float]:
    res = await client_oai.embeddings.create(input=text, model=model)
    return res.data[0].embedding

# Batch embedding (efficient)
async def embed_batch(texts: list[str], model: str = "text-embedding-3-small") -> list[list[float]]:
    res = await client_oai.embeddings.create(input=texts, model=model)
    return [r.embedding for r in res.data]

# Dimensions by model
EMBEDDING_DIMS = {
    "text-embedding-3-small": 1536,   # cheap, good for most use cases
    "text-embedding-3-large": 3072,   # better recall, 6× cost
    "text-embedding-ada-002":  1536,   # legacy
}
```

## 2) Semantic chunking

```python
def chunk_document(text: str, chunk_size: int = 512, overlap: int = 64) -> list[str]:
    """Sliding window chunking with overlap to preserve context at boundaries."""
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size - overlap):
        chunk = " ".join(words[i:i + chunk_size])
        if chunk.strip():
            chunks.append(chunk)
    return chunks

def chunk_by_section(text: str) -> list[dict]:
    """Prefer semantic boundaries (headings) over fixed windows."""
    import re
    sections = re.split(r'\n(?=#{1,3} )', text)
    return [
        {"content": s.strip(), "heading": (re.match(r'^#+\s+(.+)', s) or [None, ""])[1]}
        for s in sections if len(s.strip()) > 50
    ]
```

## 3) Qdrant vector store patterns

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

qdrant = QdrantClient(host="localhost", port=6333)

# Create collection
qdrant.create_collection(
    collection_name="articles",
    vectors_config=VectorParams(size=1536, distance=Distance.COSINE),
)

# Upsert vectors
async def upsert_document(doc_id: str, text: str, metadata: dict):
    embedding = await embed_text(text)
    qdrant.upsert(
        collection_name="articles",
        points=[PointStruct(
            id=hash(doc_id) % (2**63),   # Qdrant needs integer or UUID
            vector=embedding,
            payload={**metadata, "text": text, "doc_id": doc_id},
        )],
    )

# Semantic search with metadata filter
async def search(query: str, domain: str = None, limit: int = 5) -> list[dict]:
    embedding = await embed_text(query)
    filter_ = Filter(must=[FieldCondition(key="domain", match=MatchValue(value=domain))]) if domain else None
    results = qdrant.search(
        collection_name="articles",
        query_vector=embedding,
        query_filter=filter_,
        limit=limit,
        with_payload=True,
    )
    return [{"score": r.score, **r.payload} for r in results]
```

## 4) RAG pipeline (Retrieval-Augmented Generation)

```python
async def rag_answer(question: str, domain: str = None, k: int = 5) -> str:
    # 1. Retrieve relevant chunks
    chunks = await search(question, domain=domain, limit=k)

    # 2. Re-rank by relevance (optional, use cross-encoder for precision)
    # chunks = await rerank(question, chunks)

    # 3. Build context block
    context = "\n\n---\n\n".join(
        f"[Source: {c['doc_id']} | Score: {c['score']:.3f}]\n{c['text']}"
        for c in chunks
    )

    # 4. Generate answer with citations
    prompt = f"""Answer the question using only the provided context.
If the context doesn't contain the answer, say "I don't have enough information."
Cite sources using [Source: doc_id] notation.

Context:
{context}

Question: {question}
"""
    return await llm_call(prompt, temperature=0)
```

## 5) Retrieval quality evaluation

```python
# Metrics: Precision@K, Recall@K, MRR, NDCG
def precision_at_k(retrieved: list[str], relevant: list[str], k: int) -> float:
    top_k = retrieved[:k]
    return len(set(top_k) & set(relevant)) / k

def mean_reciprocal_rank(retrieved: list[str], relevant: set[str]) -> float:
    for i, doc_id in enumerate(retrieved, 1):
        if doc_id in relevant:
            return 1.0 / i
    return 0.0

# Ragas-style faithfulness check (LLM-as-judge)
FAITHFULNESS_PROMPT = """
Given the context and the answer, determine if the answer is faithful
(only uses information from context, no hallucinations).

Context: {context}
Answer: {answer}

Output JSON: {{"faithful": bool, "unsupported_claims": list[str]}}
"""
```

## 6) Knowledge graph patterns

```python
# Entity extraction for knowledge graph construction
ENTITY_EXTRACTION_PROMPT = """
Extract entities and relationships from this text.
Output JSON: {
  "entities": [{"name": str, "type": str, "description": str}],
  "relationships": [{"subject": str, "predicate": str, "object": str}]
}

Text: {text}
"""

# Simple in-memory graph
from collections import defaultdict

class KnowledgeGraph:
    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.edges: dict[str, list] = defaultdict(list)

    def add_entity(self, name: str, type_: str, **props):
        self.nodes[name] = {"type": type_, **props}

    def add_relation(self, subject: str, predicate: str, object_: str):
        self.edges[subject].append({"predicate": predicate, "object": object_})

    def neighbours(self, entity: str, hops: int = 1) -> list[str]:
        visited, frontier = {entity}, [entity]
        for _ in range(hops):
            next_frontier = []
            for node in frontier:
                for edge in self.edges.get(node, []):
                    if edge["object"] not in visited:
                        visited.add(edge["object"])
                        next_frontier.append(edge["object"])
            frontier = next_frontier
        return list(visited - {entity})
```

## 7) Citation-aware QA

```python
# Store citation metadata at indexing time
async def index_with_citations(article: dict):
    chunks = chunk_by_section(article["body"])
    for i, chunk in enumerate(chunks):
        await upsert_document(
            doc_id=f"{article['slug']}_chunk_{i}",
            text=chunk["content"],
            metadata={
                "slug":       article["slug"],
                "domain":     article["domain"],
                "heading":    chunk["heading"],
                "citations":  article.get("citations", []),
                "published":  article["published_at"],
            },
        )

# GEO citation gap detection via knowledge base
async def find_uncited_claims(slug: str, body: str) -> list[str]:
    """Find factual claims that lack citations."""
    chunks = chunk_by_section(body)
    gaps = []
    for chunk in chunks:
        similar = await search(chunk["content"], limit=3)
        well_cited = [s for s in similar if len(s.get("citations", [])) >= 2]
        if not well_cited:
            gaps.append(chunk["heading"])
    return gaps
```

## 8) Checklist — knowledge system

- [ ] Chunk size appropriate for model context (512 tokens for retrieval, 2048 for reading)
- [ ] Overlap between chunks (10-15%) to avoid context loss at boundaries
- [ ] Metadata stored with vectors: doc_id, domain, heading, published date
- [ ] Filter by domain/metadata in queries (never search entire corpus blindly)
- [ ] Retrieval quality evaluated (Precision@5 ≥ 0.70 target)
- [ ] Faithfulness check on generated answers (catch hallucinations)
- [ ] Citations included in payloads for GEO-aware workflows
- [ ] Index refreshed after content updates (not just on new content)
- [ ] Qdrant collection has `on_disk_payload: true` for large corpora
