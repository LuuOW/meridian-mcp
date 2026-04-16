---
name: vector-databases
description: Vector database engineering covering Pinecone, Weaviate, Chroma, Qdrant, pgvector, and FAISS — including embedding pipeline design, HNSW index parameter tuning, hybrid dense+sparse (BM25) search, metadata filtering, namespace and tenant sharding, and RAG retrieval patterns for production knowledge systems.
orb_class: moon
keywords: ["vector-database", "pinecone", "weaviate", "chroma", "qdrant", "pgvector", "faiss", "hnsw", "hybrid-search", "bm25", "embeddings", "rag", "semantic-search", "approximate-nearest-neighbor", "metadata-filtering", "namespace", "sharding", "dense-retrieval", "sparse-retrieval", "reranking"]
---

# Vector Databases

Vector databases are the retrieval layer for semantic search and RAG (Retrieval-Augmented Generation) systems, storing high-dimensional embedding vectors and enabling approximate nearest-neighbor (ANN) search at scale. This skill covers the full engineering stack: choosing and configuring a vector store, building embedding pipelines, tuning ANN indices for the accuracy/latency/memory trade-off, implementing hybrid retrieval, and wiring everything into production RAG architectures. It orbits the llm-integration and knowledge skills.

## Core Concepts

### Embedding Pipelines

Embeddings are the foundation — garbage in, garbage out. Model selection matters: `text-embedding-3-large` (OpenAI, 3072 dims, reducible via `dimensions` param), `voyage-3` (Voyage AI, strong for code/technical), `embed-english-v3.0` (Cohere, supports int8 quantization natively), `nomic-embed-text-v1.5` (open-source, Matryoshka — supports variable output dims). For multilingual: `multilingual-e5-large` or Cohere's multilingual model.

Batching: always batch embedding calls. OpenAI allows up to 2048 inputs per call. Local models via `sentence-transformers`: `model.encode(texts, batch_size=64, show_progress_bar=True, normalize_embeddings=True)`. Normalize to unit sphere if using cosine similarity (makes dot product equivalent, faster in FAISS/Qdrant).

Chunking strategy is retrieval-critical: fixed-size (512 tokens with 50-token overlap) works as a baseline. Semantic chunking (split on embedding similarity drops) improves coherence. For structured docs (PDFs, HTML), prefer element-aware chunking via `unstructured` library — respects headings, tables, lists. Store `chunk_index` and `parent_doc_id` as metadata to enable parent-document retrieval (fetch surrounding chunks at query time).

### FAISS

FAISS is the reference ANN library (Meta). Index types:
- `IndexFlatL2` / `IndexFlatIP`: exact brute-force, no approximation. Use for < 1M vectors or as ground truth for recall benchmarking.
- `IndexIVFFlat`: inverted file index. `nlist` = number of Voronoi cells (rule of thumb: `sqrt(N)` to `4*sqrt(N)`). At query time, `nprobe` cells searched — trade recall for speed. Requires training: `index.train(vectors)`.
- `IndexIVFPQ`: adds Product Quantization compression. `m` subquantizers (must divide `d`), `nbits=8` standard. Dramatic memory reduction (32x with `m=d/4, nbits=8`) at modest recall cost.
- `IndexHNSWFlat`: HNSW graph index. `M` = edges per node (16-64, higher = better recall + more memory), `efConstruction` = search width during build (200-500). At query time: `index.hnsw.efSearch` (32-256). No training required.
- `IndexIVFPQ` + `HNSW` coarse quantizer: best recall/memory/latency for large-scale production.

GPU FAISS: `faiss.index_cpu_to_gpu(res, 0, index)` — dramatically faster for large batch queries.

### Pinecone

Serverless (preferred) vs. pod-based. Index creation: `pc.create_index(name='my-index', dimension=1536, metric='cosine', spec=ServerlessSpec(cloud='aws', region='us-east-1'))`. Upsert: `index.upsert(vectors=[('id1', embedding, {'key': 'value'})])` — batch up to 100 vectors per call, 1000 for async. Query: `index.query(vector=q_emb, top_k=10, filter={'category': {'$eq': 'legal'}}, include_metadata=True)`. Namespaces: logical partitions within an index, zero overhead — use for tenant isolation or dataset versioning. Filter operators: `$eq`, `$ne`, `$in`, `$gt`, `$gte`, `$lt`, `$lte`, `$and`, `$or`.

Gotcha: Pinecone's serverless index has eventual consistency on upserts — newly upserted vectors may not appear immediately. For strict consistency requirements, add a short wait or use a `fetch` to confirm before querying.

### Weaviate

Schema-based: define `class` with `properties` and `vectorizer` module. Modules: `text2vec-openai`, `text2vec-cohere`, `text2vec-transformers` (self-hosted). Hybrid search built-in: `with_hybrid(query='...', alpha=0.75)` where `alpha=1.0` is pure vector, `alpha=0.0` is pure BM25. BM25 is computed over all `text` properties automatically. Multi-tenancy: enable with `multiTenancyConfig: {enabled: true}` at class creation; tenant isolation is complete (separate vector index per tenant). GraphQL query API; also `weaviate-client` Python SDK v4 (collection-based API, not the older v3 class API).

Batch import: `with client.batch.dynamic() as batch: batch.add_object(...)` — dynamic batching auto-tunes batch size based on server response times. Use `batch.failed_objects` to handle partial failures.

### Qdrant

Rust-based, strong on filtering performance. Collections: `client.create_collection(collection_name='docs', vectors_config=VectorParams(size=1536, distance=Distance.COSINE))`. Payload (metadata) filtering is tightly integrated with HNSW — filtered ANN without full post-filtering. `Filter(must=[FieldCondition(key='category', match=MatchValue(value='legal'))])` is pushed into the HNSW graph traversal. Named vectors: one point can have multiple named vector spaces (e.g., `dense` + `sparse` + `colbert`) — enables multi-vector retrieval in a single collection. Sparse vectors: `SparseVectorParams()` for BM25/SPLADE hybrid search natively.

Quantization: `ScalarQuantization(type=ScalarType.INT8)` halves memory, ~5-10% recall loss. `BinaryQuantization` for extreme compression (32x) — requires `rescore=True` with the raw vectors for re-ranking top candidates.

### Chroma

Lightweight, embedded-first (good for dev/testing). `chromadb.PersistentClient(path='./chroma_db')`. Collections: `client.get_or_create_collection(name='docs', metadata={'hnsw:space': 'cosine'})`. `collection.add(documents=[...], embeddings=[...], metadatas=[...], ids=[...])`. Querying: `collection.query(query_embeddings=[...], n_results=10, where={'category': 'legal'})`. Multi-modal: use `embedding_function` param for automatic embedding on add/query. Not suitable for > 10M vectors or multi-node production — migrate to Qdrant or Weaviate at scale.

### pgvector

Postgres extension — `CREATE EXTENSION vector;`. Column type: `embedding vector(1536)`. Index: `CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);` or `USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`. Query: `SELECT id, content, embedding <=> $1 AS distance FROM docs ORDER BY distance LIMIT 10;` (`<=>` cosine, `<->` L2, `<#>` inner product). For filtered search, partial indexes on predicates dramatically improve latency: `CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops) WHERE category = 'legal';`.

pgvector shines when you already run Postgres and want to avoid another infrastructure dependency. For > 5M vectors or sub-10ms p99 requirements, dedicated vector DBs outperform.

### HNSW Index Tuning

HNSW (Hierarchical Navigable Small World) is the dominant ANN algorithm. Parameters:
- `M` (max connections per node): 8-64. Higher = better recall, more memory (roughly `M * 8 bytes * N`). Default 16 is a good start; use 32-64 for high-recall requirements.
- `efConstruction`: search beam width during index build. Higher = better recall but slower build. 100-400 typical. Does not affect query-time performance.
- `ef` (efSearch / hnsw.ef): query-time beam width. Tune this at query time to hit recall targets without rebuilding the index. `ef >= top_k` always; `ef = 100` for 0.95+ recall at `top_k=10` is typical.

Recall benchmarking: use ANN-benchmarks or a held-out query set with brute-force ground truth. Target: 0.95 recall@10 for most RAG applications. Below 0.90 means the retriever will miss relevant chunks too often to trust generation quality.

### Hybrid Search (Dense + Sparse)

Sparse vectors encode term-frequency signals (BM25, TF-IDF, SPLADE). SPLADE (trained sparse encoder) outperforms BM25 on out-of-domain text but requires inference. Reciprocal Rank Fusion (RRF) is the standard score combination:

```python
def rrf(dense_ranks, sparse_ranks, k=60):
    scores = {}
    for doc_id, rank in dense_ranks:
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank)
    for doc_id, rank in sparse_ranks:
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

Alternatively, linear combination: `score = alpha * dense_score + (1 - alpha) * sparse_score`. Tune `alpha` on a validation set with NDCG@10. For domain-specific corpora with unique terminology (product SKUs, medical codes), sparse search often pulls the decisive result that dense retrieval misses.

### RAG Retrieval Patterns

**Naive RAG**: query → top-k retrieval → stuff into context → generate. Breaks down at scale due to irrelevant chunks and context length limits.

**Advanced patterns**:
- **HyDE (Hypothetical Document Embeddings)**: generate a hypothetical answer to the query with the LLM, embed the answer, use that embedding for retrieval. Closes the query-document distribution gap.
- **Multi-query retrieval**: generate N rephrased versions of the query, retrieve for each, deduplicate. Improves recall for ambiguous queries.
- **Parent-document retrieval**: index child chunks (256 tokens) for precise matching; return parent chunk (1024 tokens) for richer context. Store `parent_id` in metadata.
- **Re-ranking**: retrieve top-50 by ANN, then re-rank with a cross-encoder (`cross-encoder/ms-marco-MiniLM-L-6-v2` or Cohere Rerank API) and take top-5. Cross-encoders consider query and document jointly — much more accurate than bi-encoders for scoring, but too slow for full-corpus search.
- **Contextual compression**: after retrieval, use an LLM to extract only the relevant sentences from each chunk before packing context. Reduces noise in long chunks.

**Evaluation**: use RAGAS framework — metrics: `context_precision`, `context_recall`, `faithfulness`, `answer_relevancy`. Run evals on a golden Q&A dataset (50-200 questions with reference answers and relevant chunk IDs).
