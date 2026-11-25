const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

function signToken(user) {
  return jwt.sign({ sub:user.id, role:user.role, email:user.email }, secret, { expiresIn:'12h', issuer:'xe-wedding-studio' });
}
function requireAuth(req,res,next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!raw) return res.status(401).json({error:'Sign in required'});
  try { req.user = jwt.verify(raw,secret,{issuer:'xe-wedding-studio'}); next(); }
  catch { return res.status(401).json({error:'Session expired. Please sign in again.'}); }
}
function requireOwner(req,res,next) {
  if (req.user?.role !== 'owner') return res.status(403).json({error:'Platform owner access required'});
  next();
}
async function galleryAccess(req,res,next) {
  try {
    const galleryId = req.params.id || req.params.galleryId;
    const q = await pool.query(
      `select g.* from galleries g
       left join gallery_admins ga on ga.gallery_id=g.id
       where g.id=$1 and ($2='owner' or ga.user_id=$3)`,
      [galleryId,req.user.role,req.user.sub]
    );
    if (!q.rowCount) return res.status(404).json({error:'Gallery not found or access denied'});
    req.gallery = q.rows[0]; next();
  } catch(e) { next(e); }
}
module.exports = { signToken, requireAuth, requireOwner, galleryAccess };
