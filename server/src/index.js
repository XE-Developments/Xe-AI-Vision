require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pool } = require('./db');
const { signToken, requireAuth, requireOwner, galleryAccess } = require('./auth');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const origins = (process.env.FRONTEND_ORIGINS || 'http://localhost:5500').split(',').map(x=>x.trim());
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(cors({origin:(origin,cb)=>!origin||origins.includes(origin)?cb(null,true):cb(new Error('Origin not allowed'))}));
app.use(express.json({limit:'2mb'}));
app.use('/api/auth', rateLimit({windowMs:15*60*1000,max:30,standardHeaders:true,legacyHeaders:false}));
const s3 = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
 ? new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}})
 : null;
const bucket = process.env.R2_BUCKET;
const publicBase = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/,'');
const slugify = s => String(s||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'wedding';
const safeUser = u => ({id:u.id,email:u.email,role:u.role,display_name:u.display_name});
const asyncRoute = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const getUser = async id => (await pool.query('select * from studio_users where id=$1 and is_active=true',[id])).rows[0];
async function ensureOwner(){
  const email=(process.env.OWNER_EMAIL||'').trim().toLowerCase(), password=process.env.OWNER_PASSWORD||'';
  if(!email||!password) { console.warn('OWNER_EMAIL/OWNER_PASSWORD not set; owner bootstrap skipped'); return; }
  if(password.length<12) throw new Error('OWNER_PASSWORD must be at least 12 characters');
  const exists=await pool.query('select id from studio_users where email=$1',[email]);
  if(!exists.rowCount) {
    const hash=await bcrypt.hash(password,12);
    await pool.query(`insert into studio_users(email,password_hash,role,display_name) values($1,$2,'owner','Platform Owner')`,[email,hash]);
    console.log('Initial platform owner created:',email);
  }
}
async function canManage(galleryId,user) {
  if(user.role==='owner') return true;
  return (await pool.query('select 1 from gallery_admins where gallery_id=$1 and user_id=$2',[galleryId,user.sub])).rowCount>0;
}
function galleryDto(g){return {id:g.id,slug:g.slug,gallery_code:g.gallery_code,website_name:g.website_name,title:g.title,couple_names:g.couple_names,description:g.description,event_date:g.event_date,access_mode:g.access_mode,is_published:g.is_published,cover_url:g.cover_url,theme:g.theme,settings:g.settings,created_at:g.created_at};}

app.get('/health',asyncRoute(async(req,res)=>{
  await pool.query('select 1'); res.json({ok:true,service:'xe-wedding-studio-api',database:'connected'});
}));

app.post('/api/auth/login',asyncRoute(async(req,res)=>{
  const body=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);
  const q=await pool.query('select * from studio_users where email=$1 and is_active=true',[body.email.toLowerCase()]);
  const u=q.rows[0];
  if(!u||!(await bcrypt.compare(body.password,u.password_hash))) return res.status(401).json({error:'Invalid email or password'});
  res.json({token:signToken(u),user:safeUser(u)});
}));
app.get('/api/auth/me',requireAuth,asyncRoute(async(req,res)=>{
  const u=await getUser(req.user.sub); if(!u) return res.status(401).json({error:'Account unavailable'});
  res.json({user:safeUser(u)});
}));
app.post('/api/auth/change-password',requireAuth,asyncRoute(async(req,res)=>{
  const body=z.object({currentPassword:z.string(),newPassword:z.string().min(12)}).parse(req.body);
  const u=await getUser(req.user.sub);
  if(!u||!(await bcrypt.compare(body.currentPassword,u.password_hash))) return res.status(400).json({error:'Current password is incorrect'});
  await pool.query('update studio_users set password_hash=$1,updated_at=now() where id=$2',[await bcrypt.hash(body.newPassword,12),u.id]);
  res.json({ok:true});
}));

app.get('/api/galleries',requireAuth,asyncRoute(async(req,res)=>{
  const q=req.user.role==='owner'
    ? await pool.query('select * from galleries order by created_at desc')
    : await pool.query('select g.* from galleries g join gallery_admins ga on ga.gallery_id=g.id where ga.user_id=$1 order by g.created_at desc',[req.user.sub]);
  res.json({galleries:q.rows.map(galleryDto)});
}));
app.post('/api/galleries',requireAuth,requireOwner,asyncRoute(async(req,res)=>{
  const b=z.object({title:z.string().min(2).max(120),website_name:z.string().min(2).max(100).optional(),couple_names:z.string().max(160).optional(),description:z.string().max(2000).optional(),event_date:z.string().optional().nullable(),access_mode:z.enum(['public','private']).default('private'),visitor_password:z.string().min(6).optional(),is_published:z.boolean().default(false)}).parse(req.body);
  if(b.access_mode==='private'&&!b.visitor_password) return res.status(400).json({error:'A visitor password is required for private galleries'});
  let slug=slugify(b.title), suffix=crypto.randomBytes(3).toString('hex'); slug=`${slug}-${suffix}`;
  const code=('XE-'+crypto.randomBytes(4).toString('hex')).toUpperCase();
  const hash=b.visitor_password?await bcrypt.hash(b.visitor_password,12):null;
  const q=await pool.query(`insert into galleries(slug,gallery_code,website_name,title,couple_names,description,event_date,access_mode,visitor_password_hash,is_published,created_by)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
   [slug,code,b.website_name||'Xe Wedding Studio',b.title,b.couple_names||null,b.description||null,b.event_date||null,b.access_mode,hash,b.is_published,req.user.sub]);
  res.status(201).json({gallery:galleryDto(q.rows[0])});
}));
app.get('/api/galleries/:id',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const admins=await pool.query(`select u.id,u.email,u.display_name from studio_users u join gallery_admins ga on ga.user_id=u.id where ga.gallery_id=$1`,[req.gallery.id]);
  res.json({gallery:galleryDto(req.gallery),admins:admins.rows});
}));
app.patch('/api/galleries/:id',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const b=z.object({title:z.string().min(2).max(120).optional(),website_name:z.string().min(2).max(100).optional(),couple_names:z.string().max(160).nullable().optional(),description:z.string().max(2000).nullable().optional(),event_date:z.string().nullable().optional(),access_mode:z.enum(['public','private']).optional(),visitor_password:z.string().min(6).optional(),is_published:z.boolean().optional(),cover_url:z.string().url().nullable().optional(),theme:z.string().optional(),settings:z.record(z.any()).optional()}).parse(req.body);
  if(b.access_mode==='private' && req.gallery.access_mode!=='private' && !b.visitor_password) return res.status(400).json({error:'Set a visitor password when switching to private'});
  const vals=[],sets=[]; let i=1;
  for(const [k,v] of Object.entries(b)){
    if(k==='visitor_password'){sets.push(`visitor_password_hash=$${i++}`);vals.push(await bcrypt.hash(v,12));}
    else {sets.push(`${k}=$${i++}`);vals.push(v);}
  }
  if(!sets.length) return res.json({gallery:galleryDto(req.gallery)});
  sets.push('updated_at=now()'); vals.push(req.gallery.id);
  const q=await pool.query(`update galleries set ${sets.join(',')} where id=$${i} returning *`,vals);
  res.json({gallery:galleryDto(q.rows[0])});
}));
app.post('/api/galleries/:id/client-admin',requireAuth,requireOwner,galleryAccess,asyncRoute(async(req,res)=>{
  const b=z.object({email:z.string().email(),display_name:z.string().max(100).optional()}).parse(req.body);
  const email=b.email.toLowerCase(); let u=(await pool.query('select * from studio_users where email=$1',[email])).rows[0];
  let temporaryPassword=null;
  if(!u){temporaryPassword=crypto.randomBytes(9).toString('base64url')+'A9!';u=(await pool.query(`insert into studio_users(email,password_hash,role,display_name) values($1,$2,'client_admin',$3) returning *`,[email,await bcrypt.hash(temporaryPassword,12),b.display_name||null])).rows[0];}
  if(u.role==='owner') return res.status(400).json({error:'Owner account cannot be assigned as a client admin'});
  await pool.query('insert into gallery_admins(gallery_id,user_id) values($1,$2) on conflict do nothing',[req.gallery.id,u.id]);
  res.status(201).json({admin:safeUser(u),temporary_password:temporaryPassword,message:temporaryPassword?'Share this temporary password securely. Ask the client to change it after login.':'Existing client admin assigned to this gallery.'});
}));
app.delete('/api/galleries/:id',requireAuth,requireOwner,asyncRoute(async(req,res)=>{
  const photos=await pool.query('select object_key from photos where gallery_id=$1',[req.params.id]);
  if(s3) for(const p of photos.rows) await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:p.object_key}));
  await pool.query('delete from galleries where id=$1',[req.params.id]); res.json({ok:true});
}));

app.get('/api/galleries/:id/photos',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const q=await pool.query('select id,album_id,object_key,public_url,original_name,mime_type,byte_size,sort_order,vision_status,vision_data,created_at from photos where gallery_id=$1 order by sort_order,created_at desc',[req.gallery.id]);
  const photos=await Promise.all(q.rows.map(async p=>({...p,public_url:s3?await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:p.object_key}),{expiresIn:900}):p.public_url})));
  res.json({photos});
}));
app.get('/api/visitor/resolve/:code',asyncRoute(async(req,res)=>{
  const code=req.params.code.toUpperCase();
  const q=await pool.query('select slug,access_mode,is_published from galleries where upper(gallery_code)=$1',[code]);
  if(!q.rowCount||!q.rows[0].is_published)return res.status(404).json({error:'Published gallery not found'});
  res.json({slug:q.rows[0].slug,access_mode:q.rows[0].access_mode});
}));
app.get('/api/galleries/:id/albums',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const q=await pool.query('select * from albums where gallery_id=$1 order by sort_order,title',[req.gallery.id]);res.json({albums:q.rows});
}));
app.post('/api/galleries/:id/albums',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const b=z.object({title:z.string().min(1).max(100),description:z.string().max(500).optional(),sort_order:z.number().int().optional()}).parse(req.body);
  const q=await pool.query('insert into albums(gallery_id,title,description,sort_order) values($1,$2,$3,$4) returning *',[req.gallery.id,b.title,b.description||null,b.sort_order||0]);res.status(201).json({album:q.rows[0]});
}));
app.patch('/api/albums/:id',requireAuth,asyncRoute(async(req,res)=>{
  const b=z.object({title:z.string().min(1).max(100).optional(),description:z.string().max(500).nullable().optional(),sort_order:z.number().int().optional(),is_published:z.boolean().optional()}).parse(req.body);
  const q=await pool.query('select * from albums where id=$1',[req.params.id]);if(!q.rowCount||!(await canManage(q.rows[0].gallery_id,req.user)))return res.status(404).json({error:'Album not found'});
  const keys=Object.keys(b);if(!keys.length)return res.json({album:q.rows[0]});
  const values=keys.map(k=>b[k]);values.push(req.params.id);
  const u=await pool.query(`update albums set ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} where id=$${keys.length+1} returning *`,values);res.json({album:u.rows[0]});
}));
app.delete('/api/albums/:id',requireAuth,asyncRoute(async(req,res)=>{
  const q=await pool.query('select * from albums where id=$1',[req.params.id]);if(!q.rowCount||!(await canManage(q.rows[0].gallery_id,req.user)))return res.status(404).json({error:'Album not found'});
  await pool.query('delete from albums where id=$1',[req.params.id]);res.json({ok:true});
}));

app.post('/api/galleries/:id/uploads/sign',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  if(!s3||!bucket)return res.status(503).json({error:'R2 is not configured yet'});
  const b=z.object({files:z.array(z.object({name:z.string().max(240),type:z.enum(['image/jpeg','image/png','image/webp','image/avif']),size:z.number().int().positive().max(30*1024*1024)})).min(1).max(20)}).parse(req.body);
  const uploads=[];
  for(const f of b.files){
    const ext=({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif'})[f.type];
    const key=`galleries/${req.gallery.id}/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.${ext}`;
    const { PutObjectCommand }=require('@aws-sdk/client-s3');
    const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:f.type});
    uploads.push({key,upload_url:await getSignedUrl(s3,command,{expiresIn:600}),public_url:`https://storage.invalid/${key}`,original_name:f.name,mime_type:f.type,byte_size:f.size});
  }
  res.json({uploads});
}));
app.post('/api/galleries/:id/photos',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const b=z.object({photos:z.array(z.object({key:z.string(),public_url:z.string().url(),original_name:z.string().optional(),mime_type:z.string().optional(),byte_size:z.number().int().optional(),album_id:z.string().uuid().nullable().optional()})).min(1).max(20)}).parse(req.body);
  const out=[];
  for(const p of b.photos){
    if(!p.key.startsWith(`galleries/${req.gallery.id}/`))return res.status(400).json({error:'Invalid upload key'});
    if(p.album_id){const a=await pool.query('select id from albums where id=$1 and gallery_id=$2',[p.album_id,req.gallery.id]);if(!a.rowCount)return res.status(400).json({error:'Album does not belong to this gallery'});}
    const q=await pool.query(`insert into photos(gallery_id,album_id,object_key,public_url,original_name,mime_type,byte_size)
      values($1,$2,$3,$4,$5,$6,$7) returning *`,[req.gallery.id,p.album_id||null,p.key,p.public_url,p.original_name||null,p.mime_type||null,p.byte_size||null]);out.push(q.rows[0]);
  }
  res.status(201).json({photos:out});
}));
app.delete('/api/photos/:id',requireAuth,asyncRoute(async(req,res)=>{
  const q=await pool.query('select * from photos where id=$1',[req.params.id]);if(!q.rowCount||!(await canManage(q.rows[0].gallery_id,req.user)))return res.status(404).json({error:'Photo not found'});
  if(s3)await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:q.rows[0].object_key}));
  await pool.query('delete from photos where id=$1',[req.params.id]);res.json({ok:true});
}));

app.post('/api/visitor/:slug/access',rateLimit({windowMs:15*60*1000,max:20}),asyncRoute(async(req,res)=>{
  const b=z.object({password:z.string().optional()}).parse(req.body||{});
  const q=await pool.query('select * from galleries where slug=$1 and is_published=true',[req.params.slug]);const g=q.rows[0];
  if(!g)return res.status(404).json({error:'Gallery not found'});
  if(g.access_mode==='private'&&(!g.visitor_password_hash||!b.password||!(await bcrypt.compare(b.password,g.visitor_password_hash))))return res.status(401).json({error:'Incorrect gallery password'});
  const token=require('jsonwebtoken').sign({gallery_id:g.id,scope:'visitor'},process.env.JWT_SECRET,{expiresIn:'8h',issuer:'xe-wedding-studio'});
  res.json({visitor_token:token});
}));
app.get('/api/visitor/:slug/gallery',asyncRoute(async(req,res)=>{
  const q=await pool.query('select * from galleries where slug=$1 and is_published=true',[req.params.slug]);const g=q.rows[0];if(!g)return res.status(404).json({error:'Gallery not found'});
  try{const t=require('jsonwebtoken').verify((req.headers.authorization||'').replace(/^Bearer\s+/i,''),process.env.JWT_SECRET,{issuer:'xe-wedding-studio'});if(t.scope!=='visitor'||t.gallery_id!==g.id)throw new Error();}
  catch{return res.status(401).json({error:'Gallery access required'});}
  const [albums,photos]=await Promise.all([
    pool.query('select id,title,description,sort_order from albums where gallery_id=$1 and is_published=true order by sort_order,title',[g.id]),
    pool.query('select id,album_id,object_key,public_url,original_name,sort_order from photos where gallery_id=$1 order by sort_order,created_at',[g.id])
  ]);
  const photoItems=await Promise.all(photos.rows.map(async p=>({id:p.id,album_id:p.album_id,public_url:s3?await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:p.object_key}),{expiresIn:900}):p.public_url,original_name:p.original_name,sort_order:p.sort_order})));
  res.json({gallery:{slug:g.slug,website_name:g.website_name,title:g.title,couple_names:g.couple_names,description:g.description,event_date:g.event_date,cover_url:g.cover_url,theme:g.theme,settings:g.settings},albums:albums.rows,photos:photoItems});
}));

app.post('/api/galleries/:id/vision/analyze',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  if(!process.env.VISION_API_URL)return res.status(503).json({error:'XE Vision service is not configured'});
  const body=z.object({photo_ids:z.array(z.string().uuid()).max(500).optional(),face_grouping:z.boolean().default(false),consent_confirmed:z.boolean().default(false)}).parse(req.body||{});
  if(body.face_grouping&&!body.consent_confirmed)return res.status(400).json({error:'Documented consent confirmation is required for face grouping'});
  const photos=body.photo_ids?.length
    ? await pool.query('select id,object_key from photos where gallery_id=$1 and id=any($2::uuid[])',[req.gallery.id,body.photo_ids])
    : await pool.query('select id,object_key from photos where gallery_id=$1 order by created_at desc limit 500',[req.gallery.id]);
  if(!photos.rowCount)return res.status(400).json({error:'No photos found for this gallery'});
  const response=await fetch(`${process.env.VISION_API_URL.replace(/\/$/,'')}/jobs`,{method:'POST',headers:{'content-type':'application/json','x-vision-token':process.env.VISION_API_TOKEN||''},body:JSON.stringify({gallery_id:req.gallery.id,photos:photos.rows.map(p=>({id:p.id,object_key:p.object_key})),face_grouping:body.face_grouping,consent_confirmed:body.consent_confirmed})});
  const data=await response.json();res.status(response.status).json(data);
}));
app.get('/api/galleries/:id/vision/jobs/:jobId',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  if(!process.env.VISION_API_URL)return res.status(503).json({error:'XE Vision service is not configured'});
  const response=await fetch(`${process.env.VISION_API_URL.replace(/\/$/,'')}/jobs/${encodeURIComponent(req.params.jobId)}`,{headers:{'x-vision-token':process.env.VISION_API_TOKEN||''}});
  const data=await response.json();
  if(data.gallery_id&&data.gallery_id!==req.gallery.id)return res.status(404).json({error:'Job not found'});
  res.status(response.status).json(data);
}));
app.get('/api/galleries/:id/vision/results',requireAuth,galleryAccess,asyncRoute(async(req,res)=>{
  const jobs=await pool.query('select id,status,summary,created_at,completed_at from vision_jobs where gallery_id=$1 order by created_at desc limit 10',[req.gallery.id]);
  if(!jobs.rowCount)return res.json({jobs:[],photos:[],duplicates:[],face_groups:[]});
  const jobId=req.query.job_id||jobs.rows[0].id;
  const [photos,duplicates,groups]=await Promise.all([
    pool.query(`select r.photo_id,p.original_name,r.metrics,r.quality_rank,r.review_flags from vision_photo_results r join photos p on p.id=r.photo_id where r.gallery_id=$1 and r.job_id=$2 order by r.quality_rank nulls last`,[req.gallery.id,jobId]),
    pool.query('select photo_a,photo_b,kind,distance from vision_duplicate_pairs where gallery_id=$1 and job_id=$2 order by kind,distance',[req.gallery.id,jobId]),
    pool.query(`select g.id,g.label,g.face_count,g.review_status,coalesce(json_agg(json_build_object('photo_id',m.photo_id,'face_index',m.face_index,'bounding_box',m.bounding_box,'detector_score',m.detector_score)) filter(where m.id is not null),'[]') as members from vision_face_groups g left join vision_face_members m on m.group_id=g.id where g.gallery_id=$1 and g.job_id=$2 group by g.id order by g.label`,[req.gallery.id,jobId])
  ]);
  res.json({jobs:jobs.rows,job_id:jobId,photos:photos.rows,duplicates:duplicates.rows,face_groups:groups.rows});
}));

app.use((err,req,res,next)=>{
  if(err instanceof z.ZodError)return res.status(400).json({error:'Invalid request',details:err.issues.map(x=>({path:x.path,message:x.message}))});
  console.error(err);res.status(500).json({error:process.env.NODE_ENV==='production'?'Server error':err.message});
});
const port=process.env.PORT||8080;
ensureOwner().then(()=>app.listen(port,()=>console.log(`Xe Wedding Studio API listening on ${port}`))).catch(err=>{console.error('Startup failed:',err);process.exit(1);});
