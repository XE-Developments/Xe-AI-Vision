# Xe Wedding Studio

A multi-tenant wedding-gallery platform starter with:
- Platform owner dashboard and gallery-specific client admin accounts
- Public galleries and password-protected private galleries
- Per-gallery website title, couple names, slug, cover, event albums and theme settings
- Direct-to-Cloudflare-R2 uploads using short-lived presigned URLs
- Supabase PostgreSQL schema
- Render-ready Node.js API
- GitHub Pages-ready static frontend
- Optional XE Vision service for blur/duplicate analysis and consent-based face grouping

> Deployment status: this is a deployable project starter. It is not connected to your Supabase, Render, GitHub or Cloudflare accounts yet. Add your own credentials and deploy the services using the steps below. No secret keys are included.

## Project structure

- `public/` — gallery website, owner/client admin and browser-side upload UI
- `server/` — Express API, auth, tenant authorization, R2 upload signing
- `server/sql/schema.sql` — database schema and initial owner bootstrap instructions
- `vision/` — optional Python image-analysis service
- `render.yaml` — Render API blueprint
- `.env.example` — backend configuration template

## Architecture

GitHub Pages serves `public/`. Render runs `server/`. The API connects to Supabase PostgreSQL using a server-only database connection string. Cloudflare R2 stores original images. The browser never receives R2 credentials or the Supabase service-role key.

## 1. Supabase setup

1. Open your Supabase project → SQL Editor.
2. Run the complete `server/sql/schema.sql`.
3. Open Project Settings → Database and copy the PostgreSQL connection string (URI / pooled connection string).
4. Use the connection string only in Render environment variables. Never put it in `public/config.js`.
5. The API uses direct PostgreSQL access. Do not enable public write access to these tables through Supabase Data API. The included SQL revokes table access from `anon` and `authenticated`; the API connects with its database role.

## 2. Cloudflare R2 setup

1. Create an R2 bucket, for example `xe-wedding-studio`.
2. Create an R2 API token with Object Read & Write access limited to this bucket.
3. Copy the Account ID, Access Key ID and Secret Access Key.
4. In Render set:
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`
5. Keep the R2 bucket private (do not enable public bucket access or attach a public custom domain to this bucket). The API issues short-lived, 15-minute presigned GET URLs after checking visitor gallery access. Uploads use short-lived presigned PUT URLs. `R2_PUBLIC_BASE_URL` is not required by this version. Because presigned image URLs can be copied while valid, keep their expiry short and do not log them.

## 3. Configure and deploy the API on Render

Create a Render Web Service from this repository:
- Root Directory: `server`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

Set these environment variables in Render:
- `NODE_ENV=production`
- `PORT=10000` (Render normally supplies this)
- `DATABASE_URL` = Supabase PostgreSQL connection string
- `JWT_SECRET` = at least 32 random characters
- `FRONTEND_ORIGINS` = your GitHub Pages origin, e.g. `https://xedevelopments.github.io`
- `OWNER_EMAIL` = your owner login email
- `OWNER_PASSWORD` = a strong initial password (12+ chars); used only to create the owner if absent
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `R2_PUBLIC_BASE_URL` = your image CDN/custom-domain base URL
- `VISION_API_URL` = optional deployed XE Vision API URL
- `VISION_API_TOKEN` = optional shared token for the vision service

The API creates the initial platform owner at startup if that email does not already exist. Change the password after first login.

## 4. Configure GitHub Pages

Edit `public/config.js`:
```js
window.XE_CONFIG = {
  API_BASE: "https://YOUR-RENDER-SERVICE.onrender.com"
};
```
Commit the repository and enable GitHub Pages for the branch/folder containing `public/` (or copy `public/` to the publishing root). If publishing from a `/repository/` subpath, use the site URL that GitHub Pages gives you.

## 5. Local development

Requirements: Node.js 20+ and Python 3.10+ (optional vision service).

```bash
cd server
cp ../.env.example .env
npm install
npm run dev
```
Serve `public/` with any static server (for example `python -m http.server 5500 --directory public`). Set `FRONTEND_ORIGINS=http://localhost:5500`.

## 6. First login and gallery creation

1. Open `admin.html`.
2. Sign in with `OWNER_EMAIL` and `OWNER_PASSWORD`.
3. Create a gallery and choose Public or Private.
4. Add a client admin email. The API creates a temporary password if the user is new; copy it from the owner dashboard response and share it securely. Client admins can change their password after sign-in.
5. Open the gallery-specific admin panel using its Manage button.
6. Configure title, couple names, website name, slug, access mode, cover and event albums.
7. Upload photos. The browser asks the API for short-lived R2 upload URLs and uploads directly to R2.

## Security notes before production

- Use HTTPS everywhere and a strong unique `JWT_SECRET`.
- Change the initial owner password immediately.
- Client admins are scoped to assigned galleries; owner-only routes require the owner role.
- Gallery visitor passwords are stored as bcrypt hashes.
- Private gallery access tokens are separate from admin login tokens.
- Configure a private R2 delivery Worker with expiring signed URLs if the photos must not be retrievable by direct URL after a visitor shares it. Public CDN delivery is convenient but not revocable per visitor.
- Set strict CORS origins.
- Configure backups and retention policies.
- Obtain informed consent before biometric face grouping. Face embeddings are sensitive biometric data. Do not use face grouping to identify unknown people; this optional service only clusters faces within a gallery and should be enabled only with documented consent.
- AI blur/duplicate results are recommendations. Review before deletion.

## XE Vision service

See `vision/README.md`. The v2 service uses a Render web service plus a Render background worker. Run `vision/schema.sql` in Supabase after the main schema. The worker reads private R2 objects by gallery-scoped object key, then stores blur, exposure, resolution, quality rank, exact/near duplicate candidates, optional gallery-local face groups and job status in Supabase. The admin dashboard can submit jobs and read saved results.

Face grouping is disabled by default and requires both a documented consent confirmation and a commercially authorized face model. Do not enable InsightFace public pretrained weights for a commercial wedding studio unless you have obtained the relevant commercial authorization. No face embeddings are persisted and no cross-gallery matching is performed. Originals are never deleted automatically.

## API overview

- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-password`
- `GET /api/galleries` — galleries visible to the signed-in admin
- `POST /api/galleries` — owner creates gallery
- `GET /api/galleries/:id`, `PATCH /api/galleries/:id`
- `POST /api/galleries/:id/client-admin` — owner assigns client admin
- `GET /api/galleries/:id/albums`, `POST /api/galleries/:id/albums`, `PATCH /api/albums/:id`, `DELETE /api/albums/:id`
- `POST /api/galleries/:id/uploads/sign`
- `POST /api/galleries/:id/photos`, `DELETE /api/photos/:id`
- `POST /api/visitor/:slug/access`, `GET /api/visitor/:slug/gallery`
- `POST /api/galleries/:id/vision/analyze` — optional vision service

## Important scope

This package includes the complete starter implementation and deployment configuration. You still need to provide your real Supabase and Cloudflare credentials, deploy the Render API, run the SQL, and configure the GitHub Pages URL. The ZIP cannot deploy itself or connect to accounts without those credentials.
