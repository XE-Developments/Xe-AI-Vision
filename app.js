const API=(window.XE_CONFIG?.API_BASE||'').replace(/\/$/,'');
const $=s=>document.querySelector(s);
const state={token:sessionStorage.getItem('xe_token'),user:null,galleries:[],current:null,albums:[],photos:[],admins:[]};
const api=async(path,opts={})=>{
 const headers={...(opts.body?{'Content-Type':'application/json'}:{}),...(state.token?{Authorization:`Bearer ${state.token}`}:{}) ,...(opts.headers||{})};
 const r=await fetch(API+path,{...opts,headers});const data=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(data.error||`Request failed (${r.status})`);return data;
};
const msg=(el,text,kind='muted')=>{if(el){el.textContent=text;el.className=kind;}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formObj=f=>Object.fromEntries(new FormData(f).entries());
function toast(t){const el=$('#toast');if(el){el.textContent=t;el.classList.remove('hidden');setTimeout(()=>el.classList.add('hidden'),4500);}}
function galleryUrl(g){return `${location.origin}${location.pathname.replace(/[^/]*$/,'')}gallery.html?g=${encodeURIComponent(g.slug)}`;}
async function visitorOpen(ref,password){
 let slug=ref.trim();try{if(slug.includes('/')){const u=new URL(slug);slug=u.searchParams.get('g')||u.pathname.split('/').filter(Boolean).pop()||slug;}}catch{}
 let found=state.galleries.find(g=>g.gallery_code.toLowerCase()===slug.toLowerCase()||g.slug===slug);
 if(found)slug=found.slug;
 else if(/^XE-/i.test(slug)){const rr=await fetch(`${API}/api/visitor/resolve/${encodeURIComponent(slug)}`);const rd=await rr.json();if(!rr.ok)throw new Error(rd.error||'Gallery not found');slug=rd.slug;}
 const a=await fetch(`${API}/api/visitor/${encodeURIComponent(slug)}/access`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
 const d=await a.json();if(!a.ok)throw new Error(d.error||'Unable to open gallery');
 sessionStorage.setItem('xe_visitor_'+slug,d.visitor_token);location.href=`gallery.html?g=${encodeURIComponent(slug)}`;
}
if($('#year'))$('#year').textContent=new Date().getFullYear();
if($('#openForm'))$('#openForm').addEventListener('submit',async e=>{e.preventDefault();msg($('#openMsg'),'Opening gallery…');try{await visitorOpen($('#galleryRef').value,$('#visitorPassword').value); }catch(err){msg($('#openMsg'),err.message,'error');}});
if($('#loginForm'))$('#loginForm').addEventListener('submit',async e=>{
 e.preventDefault();msg($('#loginMsg'),'Signing in…');
 try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});state.token=d.token;state.user=d.user;sessionStorage.setItem('xe_token',d.token);await showApp();}
 catch(err){msg($('#loginMsg'),err.message,'error');}
});
async function initAdmin(){
 if(!$('#loginView'))return;
 if(state.token){try{const d=await api('/api/auth/me');state.user=d.user;await showApp();}catch{sessionStorage.removeItem('xe_token');state.token=null;}}
}
async function showApp(){
 $('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#logoutBtn').classList.remove('hidden');
 $('#welcome').textContent=`Signed in as ${state.user.email}`;$('#rolePill').textContent=state.user.role==='owner'?'PLATFORM OWNER':'CLIENT ADMIN';
 $('#ownerCreate').classList.toggle('hidden',state.user.role!=='owner');await loadGalleries();
}
$('#passwordForm')?.addEventListener('submit',async e=>{
 e.preventDefault();try{await api('/api/auth/change-password',{method:'POST',body:JSON.stringify(formObj(e.currentTarget))});e.currentTarget.reset();msg($('#passwordMsg'),'Password changed successfully.','success');}
 catch(err){msg($('#passwordMsg'),err.message,'error');}
});
$('#logoutBtn')?.addEventListener('click',()=>{sessionStorage.removeItem('xe_token');location.reload();});
$('#refreshBtn')?.addEventListener('click',loadGalleries);
async function loadGalleries(){
 try{const d=await api('/api/galleries');state.galleries=d.galleries;renderGalleries();}
 catch(e){toast(e.message);}
}
function renderGalleries(){
 $('#galleryList').innerHTML=state.galleries.map(g=>`<article class="card"><div class="row"><span class="pill">${esc(g.access_mode)}</span><span class="pill">${g.is_published?'Published':'Draft'}</span></div><h3 style="margin-top:18px">${esc(g.title)}</h3><p class="muted">${esc(g.website_name)} · ${esc(g.gallery_code)}</p><p class="muted">${esc(g.couple_names||'')}</p><div class="actions"><button data-manage="${g.id}">Manage gallery</button><button class="secondary" data-open="${g.slug}">Preview</button></div></article>`).join('')||'<div class="notice">No galleries yet. Create your first wedding gallery above.</div>';
 $('#galleryList').querySelectorAll('[data-manage]').forEach(b=>b.onclick=()=>openManage(b.dataset.manage));
 $('#galleryList').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>location.href=`gallery.html?g=${encodeURIComponent(b.dataset.open)}`);
}
$('#createForm')?.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.currentTarget,o=formObj(f);o.is_published=f.is_published.checked;
 if(!o.event_date)o.event_date=null;if(o.access_mode==='public')delete o.visitor_password;
 try{const d=await api('/api/galleries',{method:'POST',body:JSON.stringify(o)});msg($('#createMsg'),`Created ${d.gallery.gallery_code}`,'success');f.reset();await loadGalleries();openManage(d.gallery.id);}
 catch(err){msg($('#createMsg'),err.message,'error');}
});
async function openManage(id){
 try{const d=await api(`/api/galleries/${id}`);state.current=d.gallery;state.admins=d.admins;$('#manageView').classList.remove('hidden');$('#manageTitle').textContent=state.current.title;$('#manageCode').textContent=`${state.current.gallery_code} · ${state.current.slug}`;
 const f=$('#settingsForm');for(const [k,v] of Object.entries(state.current)){if(f.elements[k]){if(f.elements[k].type==='checkbox')f.elements[k].checked=!!v;else f.elements[k].value=v??'';}}
 f.elements.visitor_password.value='';$('#clientList').innerHTML=state.admins.map(a=>`<div class="notice">${esc(a.email)} ${esc(a.display_name||'')}</div>`).join('')||'<p class="muted">No client admins assigned yet.</p>';
 await loadAlbums();await loadPhotos();$('#manageView').scrollIntoView({behavior:'smooth'});
 }catch(e){toast(e.message);}
}
$('#backBtn')?.addEventListener('click',()=>{$('#manageView').classList.add('hidden');state.current=null;});
$('#settingsForm')?.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.currentTarget,o=formObj(f);o.is_published=f.is_published.checked;
 if(!o.event_date)o.event_date=null;if(!o.cover_url)o.cover_url=null;if(!o.visitor_password)delete o.visitor_password;
 try{const d=await api(`/api/galleries/${state.current.id}`,{method:'PATCH',body:JSON.stringify(o)});state.current=d.gallery;$('#manageTitle').textContent=d.gallery.title;msg($('#settingsMsg'),'Settings saved.','success');await loadGalleries();}
 catch(err){msg($('#settingsMsg'),err.message,'error');}
});
$('#clientForm')?.addEventListener('submit',async e=>{
 e.preventDefault();try{const d=await api(`/api/galleries/${state.current.id}/client-admin`,{method:'POST',body:JSON.stringify(formObj(e.currentTarget))});
 msg($('#clientMsg'),d.temporary_password?`Account assigned. Temporary password: ${d.temporary_password} — copy it now.`:d.message,'success');await openManage(state.current.id);
 }catch(err){msg($('#clientMsg'),err.message,'error');}
});
async function loadAlbums(){
 const d=await api(`/api/galleries/${state.current.id}/albums`);state.albums=d.albums;
 $('#albumList').innerHTML=d.albums.map(a=>`<div class="row notice"><span>${esc(a.title)}</span><button class="danger" data-del-album="${a.id}">Delete</button></div>`).join('')||'<p class="muted">No albums yet.</p>';
 $('#uploadAlbum').innerHTML='<option value="">Unassigned / all photos</option>'+d.albums.map(a=>`<option value="${a.id}">${esc(a.title)}</option>`).join('');
 $('#albumList').querySelectorAll('[data-del-album]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this album? Photos remain in the gallery.')){await api(`/api/albums/${b.dataset.delAlbum}`,{method:'DELETE'});await loadAlbums();}});
}
$('#albumForm')?.addEventListener('submit',async e=>{
 e.preventDefault();try{await api(`/api/galleries/${state.current.id}/albums`,{method:'POST',body:JSON.stringify(formObj(e.currentTarget))});e.currentTarget.reset();msg($('#albumMsg'),'Album created.','success');await loadAlbums();}
 catch(err){msg($('#albumMsg'),err.message,'error');}
});
async function loadPhotos(){
 const d=await api(`/api/galleries/${state.current.id}/photos`);
 state.photos=d.photos||[];
 renderPhotos();
}
function renderPhotos(){
 $('#photoList').innerHTML=state.photos.map(p=>`<div class="photo"><img src="${esc(p.public_url)}" loading="lazy" alt=""><button class="danger" data-delete-photo="${p.id}">×</button></div>`).join('')||'<div class="notice">Photo listing will populate after admin photo-list endpoint is enabled. Uploads are still saved to the gallery.</div>';
 $('#photoList').querySelectorAll('[data-delete-photo]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this photo?')){await api(`/api/photos/${b.dataset.deletePhoto}`,{method:'DELETE'});await loadPhotos();}});
}
$('#uploadBtn')?.addEventListener('click',async()=>{
 const files=[...$('#photoFiles').files];if(!files.length)return msg($('#uploadMsg'),'Choose images first.','error');if(files.length>20)return msg($('#uploadMsg'),'Upload up to 20 images per batch.','error');
 try{
  msg($('#uploadMsg'),'Preparing secure uploads…');
  const sign=await api(`/api/galleries/${state.current.id}/uploads/sign`,{method:'POST',body:JSON.stringify({files:files.map(f=>({name:f.name,type:f.type,size:f.size}))})});
  const completed=[];
  for(let i=0;i<files.length;i++){
   const f=files[i],u=sign.uploads[i];msg($('#uploadMsg'),`Uploading ${i+1}/${files.length}: ${f.name}`);
   const r=await fetch(u.upload_url,{method:'PUT',headers:{'Content-Type':f.type},body:f});if(!r.ok)throw new Error(`Upload failed for ${f.name}`);
   completed.push({...u,album_id:$('#uploadAlbum').value||null});
  }
  await api(`/api/galleries/${state.current.id}/photos`,{method:'POST',body:JSON.stringify({photos:completed})});
  msg($('#uploadMsg'),`${completed.length} photos uploaded successfully.`,'success');$('#photoFiles').value='';await loadPhotos();
 }catch(err){msg($('#uploadMsg'),err.message,'error');}
});

async function loadVisionResults(jobId){
 const box=$('#visionResults');if(!box||!state.current)return;
 try{
  const data=await api(`/api/galleries/${state.current.id}/vision/results${jobId?`?job_id=${encodeURIComponent(jobId)}`:''}`);
  const rows=data.photos||[];const groups=data.face_groups||[];const duplicates=data.duplicates||[];
  box.innerHTML=`<div class="notice"><strong>Saved analysis results</strong><p>${rows.length} photos · ${duplicates.length} duplicate candidates · ${groups.length} face groups</p></div>`+
   (rows.length?`<div class="card"><h3>Photo quality ranking</h3><div class="stack">${rows.map(r=>`<div class="row"><span>${esc(r.original_name||r.photo_id)}</span><span class="muted">Score ${Number(r.metrics?.quality_score||0).toFixed(1)} · Rank ${r.quality_rank||'—'} · ${esc((r.review_flags||[]).join(', ')||'No flags')}</span></div>`).join('')}</div></div>`:'')+
   (groups.length?`<div class="card"><h3>Face groups · manual review required</h3>${groups.map(g=>`<p>${esc(g.label)} · ${g.face_count} face appearances</p>`).join('')}</div>`:'')+
   (duplicates.length?`<div class="card"><h3>Duplicate candidates</h3>${duplicates.slice(0,30).map(d=>`<p>${esc(d.kind)} · ${esc(d.photo_a)} ↔ ${esc(d.photo_b)} · distance ${d.distance}</p>`).join('')}</div>`:'');
 }catch(e){box.textContent='Could not load saved results: '+e.message;}
}

$('#visionBtn')?.addEventListener('click',async()=>{
 const faceGrouping=$('#visionFaceConsent')?.checked===true;
 if(faceGrouping&&!confirm('Face grouping processes biometric data. Confirm documented consent from people in this gallery. Continue?'))return;
 try{
  $('#visionBtn').disabled=true;msg($('#visionMsg'),'Submitting analysis job…');
  const d=await api(`/api/galleries/${state.current.id}/vision/analyze`,{method:'POST',body:JSON.stringify({face_grouping:faceGrouping,consent_confirmed:faceGrouping})});
  if(!d.job_id)throw new Error(d.error||'Could not create vision job');
  msg($('#visionMsg'),`Job queued: ${d.job_id}. Processing ${d.total_photos} photos…`);
  let finished=false;
  while(!finished){await new Promise(resolve=>setTimeout(resolve,4000));const status=await api(`/api/galleries/${state.current.id}/vision/jobs/${d.job_id}`);
   if(status.status==='completed'){finished=true;msg($('#visionMsg'),`Analysis complete. ${status.summary?.processed||0} processed · ${status.summary?.duplicates||0} duplicate candidates · ${status.summary?.blurry||0} blurry · ${status.summary?.face_groups||0} face groups. Results are saved in Supabase.`,'success');await loadVisionResults(d.job_id);}
   else if(status.status==='failed'){finished=true;throw new Error(status.error||'Vision job failed');}
   else msg($('#visionMsg'),`XE Vision ${status.status} · ${status.processed_photos||0}/${status.total_photos||d.total_photos} photos`);
  }
 }catch(e){msg($('#visionMsg'),e.message,'error');}
 finally{$('#visionBtn').disabled=false;}
});
initAdmin();

async function initGallery(){
 if(!location.pathname.endsWith('gallery.html'))return;
 const slug=new URLSearchParams(location.search).get('g');if(!slug){document.body.innerHTML='Gallery not found';return;}
 const token=sessionStorage.getItem('xe_visitor_'+slug);
 const access=token?{visitor_token:token}:null;
 if(!access){document.body.innerHTML=`<main class="wrap"><header class="top"><a class="brand" href="./">XE <small>WEDDING STUDIO</small></a></header><section class="hero"><div class="eyebrow">Private collection</div><h1>Enter your<br>gallery.</h1><form id="gate" class="card stack" style="max-width:440px"><label>Gallery password</label><input id="gatePass" type="password" required><button>Continue</button><p id="gateMsg" class="muted"></p></form></section></main>`;$('#gate').onsubmit=async e=>{e.preventDefault();try{await visitorOpen(slug,$('#gatePass').value);}catch(err){msg($('#gateMsg'),err.message,'error');}};return;}
 try{
  const r=await fetch(`${API}/api/visitor/${encodeURIComponent(slug)}/gallery`,{headers:{Authorization:`Bearer ${token}`}});const d=await r.json();if(!r.ok)throw new Error(d.error);
  document.title=d.gallery.website_name+' — '+d.gallery.title;
  const albums=[{id:'all',title:'All moments'},...d.albums];let active='all';
  document.body.innerHTML=`<main class="wrap"><header class="top"><a class="brand" href="./">XE <small>WEDDING STUDIO</small></a><span class="eyebrow">${esc(d.gallery.website_name)}</span></header><section class="gallery-hero" style="${d.gallery.cover_url?`background-image:linear-gradient(0deg,rgba(0,0,0,.8),transparent 70%),url('${esc(d.gallery.cover_url)}')`:''}"><div><div class="eyebrow">The wedding collection</div><h1>${esc(d.gallery.title)}</h1><p>${esc(d.gallery.couple_names||'')} · ${esc(d.gallery.event_date||'')}</p><p class="muted">${esc(d.gallery.description||'')}</p></div></section><section class="section"><div class="album-tabs" id="tabs">${albums.map(a=>`<button class="${a.id==='all'?'active':'secondary'}" data-album="${a.id}">${esc(a.title)}</button>`).join('')}</div><div class="photos" id="photos"></div></section><footer class="footer">A collection by Xe Wedding Studio</footer></main>`;
  const render=()=>{$('#photos').innerHTML=d.photos.filter(p=>active==='all'||p.album_id===active).map(p=>`<a class="photo" href="${esc(p.public_url)}" target="_blank" rel="noopener"><img src="${esc(p.public_url)}" loading="lazy" alt="${esc(p.original_name||'Wedding photograph')}"></a>`).join('')||'<p class="muted">Photos will appear here soon.</p>';};
  $('#tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{active=b.dataset.album;$('#tabs').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));render();});render();
 }catch(e){document.body.innerHTML=`<main class="wrap"><h1>Unable to open gallery</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="./">Back</a></main>`;}
}
initGallery();
