# Deployment checklist

- [ ] Create Supabase project and run `server/sql/schema.sql`.
- [ ] Create a private R2 bucket and scoped token (do not enable public access).
- [ ] Configure R2 bucket CORS using `cloudflare-r2-cors.json` (replace origins with your exact frontend origin).
- [ ] Configure R2 custom domain / delivery Worker and set `R2_PUBLIC_BASE_URL`.
- [ ] Deploy `server/` as a Render Node web service.
- [ ] Add every required secret in Render Environment; never commit `.env`.
- [ ] Wait for `/health` to report `database: connected`.
- [ ] Set `public/config.js` API_BASE to the Render URL.
- [ ] Publish the contents of `public/` using GitHub Pages.
- [ ] Add the exact GitHub Pages origin to `FRONTEND_ORIGINS`.
- [ ] Sign in as owner and change the initial password.
- [ ] Create a private test gallery and a public test gallery.
- [ ] Assign a test client admin; verify that client cannot see other galleries.
- [ ] Test upload, album creation, visitor password, public link and image display.
- [ ] Configure a private image delivery Worker if per-visitor access revocation is required.
- [ ] Deploy optional `vision/` service separately; keep face grouping disabled until documented consent and model licensing are reviewed.


## XE Vision AI v2
- [ ] Run `vision/schema.sql` in Supabase SQL Editor after the main schema.
- [ ] Deploy `xe-vision-api` as a Render Python Web Service (root `vision`, build `pip install -r requirements.txt`, start `uvicorn main:app --host 0.0.0.0 --port $PORT`, health `/health`).
- [ ] Deploy `xe-vision-worker` as a Render Background Worker (root `vision`, build `pip install -r requirements.txt`, start `python worker.py`).
- [ ] Set `DATABASE_URL` on both services. Set `VISION_API_TOKEN` on the web service and the same token on the main Node API.
- [ ] Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` on the worker only. Grant the R2 token read-only access to the wedding bucket.
- [ ] Set `VISION_API_URL` and `VISION_API_TOKEN` on the main Node API.
- [ ] Keep `ENABLE_FACE_GROUPING=false` and `FACE_MODEL_COMMERCIAL_LICENSE_CONFIRMED=false` until commercial model authorization is documented.
- [ ] Test with a small gallery, verify job status and saved results, then load-test with realistic batches before opening it to client admins.
