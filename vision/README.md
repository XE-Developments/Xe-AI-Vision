# XE Vision AI v2

A separate Render web service + Render background worker. The web service accepts authenticated job requests; the worker reads private Cloudflare R2 objects, analyzes them, and writes results to Supabase Postgres. It never accepts arbitrary remote image URLs.

## Features
- Blur/sharpness, exposure, contrast and resolution metrics
- SHA-256 exact duplicate detection and perceptual-hash near-duplicate candidates
- Quality ranking and shortlist recommendations; originals are never deleted
- Optional within-gallery face clustering, with no cross-gallery matching and no identity naming
- Job status and persistent result tables in Supabase

## Deploy prerequisites
1. Run `schema.sql` in the same Supabase database after the main Xe Wedding Studio schema.
2. Configure both Render services with the same `DATABASE_URL` and R2 credentials.
3. Create a Render **Web Service** with root directory `vision`, build `pip install -r requirements.txt`, start `uvicorn main:app --host 0.0.0.0 --port $PORT`, health path `/health`.
4. Create a Render **Background Worker** from the same repo and root directory `vision`, build `pip install -r requirements.txt`, start `python worker.py`.
5. Set `VISION_API_TOKEN` on the web service. The Node API uses the same token to create jobs. Set R2 credentials and database variables on both services; only the worker needs R2 access.

## Environment variables
- `DATABASE_URL` — Supabase Postgres connection string (server-side only)
- `VISION_API_TOKEN` — random 48+ byte secret (web service)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (worker)
- `ENABLE_FACE_GROUPING=false` (default)
- `FACE_MODEL_COMMERCIAL_LICENSE_CONFIRMED=false` (default)
- `INSIGHTFACE_MODEL_NAME=buffalo_l` (only after obtaining rights to the model)
- `MAX_IMAGE_BYTES=36700160`, `MAX_IMAGE_PIXELS=80000000`, `WORKER_POLL_SECONDS=3`

## Face grouping and licensing
Face grouping is disabled unless both `ENABLE_FACE_GROUPING=true` and `FACE_MODEL_COMMERCIAL_LICENSE_CONFIRMED=true`. Do not set the latter merely to bypass the check: obtain and retain the relevant commercial model authorization first. InsightFace code and pretrained weights have different licensing terms. The project does not bundle model weights. If you use a different commercially licensed model, adapt `get_face_model()` and `group_faces()` to that provider.

Face clusters are probabilistic, gallery-local suggestions, not verified identities. They require explicit documented consent and human review. The service does not persist face embeddings, only face bounding boxes, group membership and detector confidence. Delete face-group rows when consent is withdrawn or gallery data is erased.

## API
- `POST /jobs` — creates a queued job (service token required)
- `GET /jobs/{job_id}` — job state (service token required)
- `GET /health` — health + database readiness

Request body example (server-to-server only):
```json
{"gallery_id":"uuid","photos":[{"id":"photo-uuid","object_key":"galleries/gallery-uuid/2026-01-01/photo.jpg"}],"face_grouping":false,"consent_confirmed":false}
```
The object key must be under `galleries/{gallery_id}/`. The Node API must derive photo IDs and keys from its own database, not accept client-supplied keys.

## Operational notes
- The worker uses `FOR UPDATE SKIP LOCKED` so multiple worker instances can safely claim separate jobs.
- One job handles at most 500 photos. For very large galleries, submit batches and use a parent orchestration job.
- Use a paid Render instance with sufficient memory/CPU for large wedding galleries. CPU face inference can be slow.
- Tune blur and face similarity thresholds against a labeled test set before using results operationally.
- Near-duplicate candidates are not proof of duplicates. Keep manual review and do not auto-delete.
- Add backups, retention, job cancellation, metrics/alerts and load tests before high-volume commercial launch.
