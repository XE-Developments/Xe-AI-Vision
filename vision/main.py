import os, uuid
from typing import Optional
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
import psycopg2, psycopg2.extras
import hmac
from contextlib import contextmanager

TOKEN=os.environ.get("VISION_API_TOKEN","")
DATABASE_URL=os.environ.get("DATABASE_URL","")
FACE_ENABLED=os.environ.get("ENABLE_FACE_GROUPING","false").lower()=="true"
FACE_LICENSE_CONFIRMED=os.environ.get("FACE_MODEL_COMMERCIAL_LICENSE_CONFIRMED","false").lower()=="true"
app=FastAPI(title="XE Vision AI",version="2.0.0")

class PhotoIn(BaseModel):
    id: str
    object_key: str
class JobIn(BaseModel):
    gallery_id: str
    photos: list[PhotoIn]=Field(min_length=1,max_length=500)
    face_grouping: bool=False
    consent_confirmed: bool=False


@contextmanager
def db_session():
    if not DATABASE_URL: raise RuntimeError("DATABASE_URL is not configured")
    conn=psycopg2.connect(DATABASE_URL, sslmode=os.getenv("DB_SSLMODE","require"), cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        with conn: yield conn
    finally: conn.close()

def authorize(token):
    if not TOKEN or not token or not hmac.compare_digest(token, TOKEN): raise HTTPException(401,"Invalid vision service token")

def valid_gallery_key(gallery_id,key):
    return isinstance(key,str) and len(key)<=1024 and key.startswith(f"galleries/{gallery_id}/") and ".." not in key and not key.startswith("/")

@app.get("/health")
def health():
    try:
        with db_session() as conn:
            with conn.cursor() as cur: cur.execute("select 1")
        return {"ok":True,"service":"xe-vision-ai","database":"connected","face_grouping_enabled":FACE_ENABLED and FACE_LICENSE_CONFIRMED}
    except Exception as e:
        raise HTTPException(503,"Database unavailable")

@app.post("/jobs",status_code=202)
def create_job(body:JobIn,x_vision_token:Optional[str]=Header(default=None)):
    authorize(x_vision_token)
    if body.face_grouping and not body.consent_confirmed:
        raise HTTPException(400,"Explicit gallery-level consent confirmation is required")
    if body.face_grouping and not (FACE_ENABLED and FACE_LICENSE_CONFIRMED):
        raise HTTPException(403,"Face grouping is disabled until a commercially authorized model is configured")
    try: uuid.UUID(body.gallery_id)
    except Exception: raise HTTPException(400,"Invalid gallery id")
    seen=set(); items=[]
    for photo in body.photos:
        try: pid=str(uuid.UUID(photo.id))
        except Exception: raise HTTPException(400,"Invalid photo id")
        if pid in seen: continue
        seen.add(pid)
        if not valid_gallery_key(body.gallery_id,photo.object_key): raise HTTPException(400,"Photo object key is outside this gallery")
        items.append({"photo_id":pid,"object_key":photo.object_key})
    if not items: raise HTTPException(400,"No valid photos supplied")
    job_id=str(uuid.uuid4())
    with db_session() as conn:
        with conn.cursor() as cur:
            cur.execute("""insert into public.vision_jobs(id,gallery_id,status,face_grouping,consent_confirmed,total_photos,request_data)
              values(%s,%s,'queued',%s,%s,%s,%s)""",
              (job_id,body.gallery_id,body.face_grouping,body.consent_confirmed,len(items),psycopg2.extras.Json({"photos":items})))
    return {"job_id":job_id,"gallery_id":body.gallery_id,"status":"queued","total_photos":len(items)}

@app.get("/jobs/{job_id}")
def get_job(job_id:str,x_vision_token:Optional[str]=Header(default=None)):
    authorize(x_vision_token)
    with db_session() as conn:
        with conn.cursor() as cur:
            cur.execute("select id,gallery_id,status,total_photos,processed_photos,error,summary,created_at,started_at,completed_at from public.vision_jobs where id=%s",(job_id,))
            row=cur.fetchone()
    if not row: raise HTTPException(404,"Job not found")
    return dict(row)
