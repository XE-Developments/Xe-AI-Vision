import os, io, time, json, hashlib, traceback
from collections import defaultdict
import boto3, cv2, imagehash, numpy as np
from PIL import Image, ImageStat, ImageOps
import psycopg2, psycopg2.extras
from contextlib import contextmanager

DATABASE_URL=os.environ["DATABASE_URL"]
R2_ACCOUNT_ID=os.environ["R2_ACCOUNT_ID"]
R2_ACCESS_KEY_ID=os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET_ACCESS_KEY=os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET=os.environ["R2_BUCKET"]
FACE_ENABLED=os.getenv("ENABLE_FACE_GROUPING","false").lower()=="true"
FACE_LICENSE_CONFIRMED=os.getenv("FACE_MODEL_COMMERCIAL_LICENSE_CONFIRMED","false").lower()=="true"
MAX_IMAGE_BYTES=int(os.getenv("MAX_IMAGE_BYTES",str(35*1024*1024)))
MAX_PIXELS=int(os.getenv("MAX_IMAGE_PIXELS","80000000"))
POLL_SECONDS=float(os.getenv("WORKER_POLL_SECONDS","3"))

s3=boto3.client('s3',endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',aws_access_key_id=R2_ACCESS_KEY_ID,aws_secret_access_key=R2_SECRET_ACCESS_KEY,region_name='auto')

@contextmanager
def db_session():
    conn=psycopg2.connect(DATABASE_URL,sslmode=os.getenv('DB_SSLMODE','require'),cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        with conn: yield conn
    finally: conn.close()

def claim_job():
    with db_session() as conn:
        with conn.cursor() as cur:
            cur.execute("update public.vision_jobs set status='failed',error='Worker lease expired after maximum retries',completed_at=now(),updated_at=now() where status='processing' and updated_at < now()-interval '25 minutes' and retry_count>=3")
            cur.execute("""with picked as (select id from public.vision_jobs where (status='queued' or (status='processing' and updated_at < now()-interval '25 minutes')) and retry_count<3 order by created_at for update skip locked limit 1)
              update public.vision_jobs j set status='processing',started_at=coalesce(j.started_at,now()),updated_at=now(),retry_count=j.retry_count+1 from picked where j.id=picked.id
              returning j.*""")
            return cur.fetchone()

def fetch_image(key):
    obj=s3.get_object(Bucket=R2_BUCKET,Key=key)
    body=obj['Body']
    data=body.read(MAX_IMAGE_BYTES+1)
    if len(data)>MAX_IMAGE_BYTES: raise ValueError('Image exceeds configured byte limit')
    if not data: raise ValueError('Empty image object')
    im=Image.open(io.BytesIO(data))
    im=ImageOps.exif_transpose(im).convert('RGB')
    if im.width*im.height>MAX_PIXELS: raise ValueError('Image dimensions exceed pixel limit')
    return im,data

def analyze_image(im,data):
    rgb=np.asarray(im)
    # Downsample for stable, bounded CPU cost while preserving the full-res metadata.
    scale=min(1.0,1600/max(im.size))
    if scale<1: work=cv2.resize(rgb,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA)
    else: work=rgb
    gray=cv2.cvtColor(work,cv2.COLOR_RGB2GRAY)
    sharp=float(cv2.Laplacian(gray,cv2.CV_64F).var())
    gray_stats=ImageStat.Stat(Image.fromarray(gray))
    brightness=float(gray_stats.mean[0])
    contrast=float(gray_stats.stddev[0])
    pixels=im.width*im.height
    # Scores are ranking signals, not an aesthetic judgement.
    blur_score=max(0,min(100,100*(sharp/(sharp+90))))
    exposure_score=max(0,100-abs(brightness-128)*1.45)
    contrast_score=max(0,min(100,contrast*2.2))
    resolution_score=min(100,100*pixels/(3000*2000))
    quality=0.45*blur_score+0.20*exposure_score+0.15*contrast_score+0.20*resolution_score
    ph=str(imagehash.phash(Image.fromarray(work)))
    return {"sha256":hashlib.sha256(data).hexdigest(),"phash":ph,"width":im.width,"height":im.height,
      "blur_metric":round(sharp,3),"blur_score":round(blur_score,2),"blur_label":"clear" if sharp>=100 else "review" if sharp>=45 else "blurry",
      "brightness":round(brightness,2),"contrast":round(contrast,2),"exposure_score":round(exposure_score,2),
      "resolution_score":round(resolution_score,2),"quality_score":round(quality,2)}

_face_model=None
def get_face_model():
    global _face_model
    if not (FACE_ENABLED and FACE_LICENSE_CONFIRMED): raise RuntimeError('Face grouping is disabled or model licensing is not confirmed')
    if _face_model is None:
        from insightface.app import FaceAnalysis
        _face_model=FaceAnalysis(name=os.getenv('INSIGHTFACE_MODEL_NAME','buffalo_l'),providers=['CPUExecutionProvider'])
        _face_model.prepare(ctx_id=-1,det_size=(640,640))
    return _face_model

def extract_face_vectors(photo_id,im):
    model=get_face_model()
    rgb=np.asarray(im)
    scale=min(1.0,2000/max(im.size))
    if scale<1: rgb=cv2.resize(rgb,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA)
    bgr=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR)
    vectors=[]
    for idx,face in enumerate(model.get(bgr)):
        vectors.append({'photo_id':photo_id,'face_index':idx,'embedding':np.asarray(face.normed_embedding,dtype=np.float32),
                        'bbox':[int(x/scale) for x in face.bbox.tolist()],'det_score':float(face.det_score)})
    return vectors

def group_face_vectors(vectors):
    # Greedy, gallery-local clustering; retain no embeddings after this job.
    clusters=[]
    threshold=float(os.getenv('FACE_MATCH_THRESHOLD','0.48'))
    for face in vectors:
        best=None; best_sim=-1
        for cluster in clusters:
            sim=float(np.dot(face['embedding'],cluster['centroid']))
            if sim>best_sim: best,best_sim=cluster,sim
        if best is not None and best_sim>=threshold:
            best['members'].append(face); centroid=np.mean([m['embedding'] for m in best['members']],axis=0); best['centroid']=centroid/(np.linalg.norm(centroid)+1e-12)
        else: clusters.append({'centroid':face['embedding'].copy(),'members':[face]})
    return [c['members'] for c in clusters if len(c['members'])>=2]

def persist(job,results,duplicates,groups,errors):
    # Group labels are provisional gallery-local clusters. No identity names are inferred.
    with db_session() as conn:
      with conn.cursor() as cur:
        # Make stale-job retries idempotent for this job.
        cur.execute('delete from public.vision_face_groups where job_id=%s',(job['id'],))
        cur.execute('delete from public.vision_duplicate_pairs where job_id=%s',(job['id'],))
        cur.execute('delete from public.vision_photo_results where job_id=%s',(job['id'],))
        for r in results:
          cur.execute("""insert into public.vision_photo_results(job_id,gallery_id,photo_id,metrics,quality_rank,review_flags)
            values(%s,%s,%s,%s,%s,%s) on conflict(job_id,photo_id) do update set metrics=excluded.metrics,quality_rank=excluded.quality_rank,review_flags=excluded.review_flags""",
            (job['id'],job['gallery_id'],r['photo_id'],psycopg2.extras.Json({k:v for k,v in r.items() if k not in ('photo_id','image')}),r.get('quality_rank'),r.get('review_flags',[])))
          cur.execute("update public.photos set vision_status='complete',vision_data=coalesce(vision_data,'{}'::jsonb)||%s::jsonb,width=%s,height=%s where id=%s and gallery_id=%s",
            (json.dumps({'job_id':job['id'],'quality_score':r['quality_score'],'blur_label':r['blur_label'],'duplicate':r.get('duplicate',False),'quality_rank':r.get('quality_rank')}),r['width'],r['height'],r['photo_id'],job['gallery_id']))
        for d in duplicates:
          cur.execute("insert into public.vision_duplicate_pairs(job_id,gallery_id,photo_a,photo_b,kind,distance) values(%s,%s,%s,%s,%s,%s) on conflict do nothing",
            (job['id'],job['gallery_id'],d['photo_a'],d['photo_b'],d['kind'],d['distance']))
        for n,members in enumerate(groups,1):
          cur.execute("insert into public.vision_face_groups(job_id,gallery_id,label,face_count) values(%s,%s,%s,%s) returning id",
            (job['id'],job['gallery_id'],f'Person group {n:03d}',len(members)))
          gid=cur.fetchone()['id']
          for f in members:
            cur.execute("insert into public.vision_face_members(group_id,photo_id,face_index,bounding_box,detector_score) values(%s,%s,%s,%s,%s)",
              (gid,f['photo_id'],f['face_index'],f['bbox'],f['det_score']))
        summary={'processed':len(results),'errors':len(errors),'duplicates':len(duplicates),'face_groups':len(groups),
          'blurry':sum(1 for r in results if r['blur_label']=='blurry'),'recommended_selection':sum(1 for r in results if r.get('recommended_selection'))}
        cur.execute("update public.vision_jobs set status='completed',processed_photos=%s,summary=%s,error=%s,completed_at=now(),updated_at=now() where id=%s",
          (len(results)+len(errors),psycopg2.extras.Json(summary),('; '.join(errors[:5]) if errors else None),job['id']))

def heartbeat(job_id):
    with db_session() as conn:
        with conn.cursor() as cur: cur.execute('update public.vision_jobs set updated_at=now() where id=%s and status=\'processing\'',(job_id,))

def process(job):
    photos=(job.get('request_data') or {}).get('photos',[])
    results=[]; errors=[]; dup=[]; face_vectors=[]
    for index,entry in enumerate(photos,1):
      if index % 10 == 0: heartbeat(job['id'])
      pid=entry['photo_id']; key=entry['object_key']
      try:
        if not key.startswith(f"galleries/{job['gallery_id']}/") or '..' in key: raise ValueError('Object key is outside the requested gallery')
        im,data=fetch_image(key); metrics=analyze_image(im,data); metrics['photo_id']=pid
        results.append(metrics)
        if job['face_grouping']: face_vectors.extend(extract_face_vectors(pid,im))
      except Exception as e: errors.append(f'{pid}: {str(e)[:240]}')
    # Exact duplicate groups by SHA-256.
    exact=defaultdict(list)
    for r in results: exact[r['sha256']].append(r['photo_id'])
    for ids in exact.values():
      if len(ids)>1:
        for a in ids[1:]: dup.append({'photo_a':ids[0],'photo_b':a,'kind':'exact','distance':0})
    # Near-duplicate pairs. Limit pairwise work to at most 500 photos per job.
    hashes=[(r['photo_id'],imagehash.hex_to_hash(r['phash'])) for r in results]
    for i,(ida,ha) in enumerate(hashes):
      for idb,hb in hashes[i+1:]:
        dist=ha-hb
        if 0<dist<=5: dup.append({'photo_a':ida,'photo_b':idb,'kind':'near','distance':int(dist)})
    duplicate_ids={x for d in dup for x in (d['photo_a'],d['photo_b'])}
    # Ranking excludes blurry and duplicate copies from recommended selection; originals remain untouched.
    eligible=[r for r in results if r['blur_label']!='blurry' and r['photo_id'] not in duplicate_ids]
    eligible.sort(key=lambda r:r['quality_score'],reverse=True)
    ranks={r['photo_id']:i+1 for i,r in enumerate(eligible)}
    for r in results:
      r['duplicate']=r['photo_id'] in duplicate_ids
      r['quality_rank']=r['photo_id'] and ranks.get(r['photo_id'])
      r['recommended_selection']=r['photo_id'] in ranks and ranks[r['photo_id']]<=max(1,int(len(eligible)*0.25))
      flags=[]
      if r['blur_label']=='blurry': flags.append('blurry')
      if r['duplicate']: flags.append('duplicate_review')
      if r['exposure_score']<45: flags.append('exposure_review')
      if r['resolution_score']<35: flags.append('low_resolution')
      r['review_flags']=flags
    groups=[]
    if job['face_grouping']:
      groups=group_face_vectors(face_vectors)
    persist(job,results,dup,groups,errors)

def main():
  print('XE Vision worker started')
  while True:
    try:
      job=claim_job()
      if not job: time.sleep(POLL_SECONDS); continue
      try: process(job)
      except Exception as exc:
        print('Job failed',job['id'],str(exc),traceback.format_exc()[-3000:])
        with db_session() as conn:
          with conn.cursor() as cur:
            cur.execute("update public.vision_jobs set status='failed',error=%s,completed_at=now(),updated_at=now() where id=%s",(str(exc)[:2000],job['id']))
    except Exception as exc:
      print('Worker loop error',str(exc)); time.sleep(max(POLL_SECONDS,5))
if __name__=='__main__': main()
