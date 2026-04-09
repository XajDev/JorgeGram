const express=require('express'),path=require('path'),fs=require('fs'),{v4:uuidv4}=require('uuid'),mime=require('mime-types'),bcrypt=require('bcryptjs'),multer=require('multer'),{query,queryOne,initDB}=require('./db');
const app=express();
const uploadDir=path.join(__dirname,'uploads');if(!fs.existsSync(uploadDir))fs.mkdirSync(uploadDir,{recursive:true});
const storage=multer.diskStorage({destination:(r,f,cb)=>cb(null,uploadDir),filename:(r,f,cb)=>cb(null,uuidv4()+'-'+f.originalname)});
const upload=multer({storage,limits:{fileSize:10*1024*1024},fileFilter:(r,f,cb)=>f.mimetype.startsWith('image/')?cb(null,true):cb(new Error('Images only'))});

async function findByToken(t){if(!t)return null;return queryOne('SELECT * FROM accounts WHERE token=$1',[t])}

app.use(express.json());
app.use((req,res,next)=>{if(req.headers['x-forwarded-proto']==='http')return res.redirect(301,'https://'+req.headers.host+req.url);next()});
app.use((req,res,next)=>{res.setHeader('Strict-Transport-Security','max-age=63072000; includeSubDomains; preload');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy','upgrade-insecure-requests');next()});
app.use(express.static(path.join(__dirname,'public')));
app.use('/uploads',express.static(uploadDir));

// Auth — shared with JorgeChat (same accounts table)
app.post('/api/register',async(req,res)=>{const{username,displayName,password}=req.body;if(!username||!password||!displayName)return res.status(400).json({error:'All fields required'});const c=username.trim().toLowerCase();if(c.length<3||c.length>24)return res.status(400).json({error:'Username: 3-24 chars'});if(!/^[a-z0-9_]+$/.test(c))return res.status(400).json({error:'Letters, numbers, _ only'});const cd=displayName.trim().substring(0,24);if(!cd)return res.status(400).json({error:'Display name required'});if(password.length<3)return res.status(400).json({error:'Password: 3+ chars'});if(await queryOne('SELECT username FROM accounts WHERE username=$1',[c]))return res.status(400).json({error:'Username taken'});const h=await bcrypt.hash(password,10),tk=uuidv4();const cnt=await query('SELECT COUNT(*) as n FROM accounts');const colors=['#CC0000','#0000CC','#009900','#CC6600','#9900CC','#006666','#CC0066','#336699','#669933','#993366'];const col=colors[parseInt(cnt[0].n)%colors.length];await query('INSERT INTO accounts (username,display_name,password_hash,color,token,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[c,cd,h,col,tk,Date.now()]);res.json({username:c,displayName:cd,color:col,token:tk})});
app.post('/api/login',async(req,res)=>{const{username,password}=req.body;if(!username||!password)return res.status(400).json({error:'Both fields required'});const acc=await queryOne('SELECT * FROM accounts WHERE username=$1',[username.trim().toLowerCase()]);if(!acc||!await bcrypt.compare(password,acc.password_hash))return res.status(401).json({error:'Invalid username or password'});const tk=uuidv4();await query('UPDATE accounts SET token=$1 WHERE username=$2',[tk,acc.username]);res.json({username:acc.username,displayName:acc.display_name,color:acc.color,token:tk,bio:acc.bio,pfp:acc.pfp,theme:acc.theme,isAdmin:acc.is_admin})});
app.post('/api/auth',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});res.json({username:acc.username,displayName:acc.display_name,color:acc.color,token:acc.token,bio:acc.bio,pfp:acc.pfp,theme:acc.theme,isAdmin:acc.is_admin})});

// Upload image for a post
app.post('/api/upload-image',upload.single('image'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'No file'});const acc=await findByToken(req.body.token);if(!acc){fs.unlinkSync(req.file.path);return res.status(401).json({error:'Invalid token'})}res.json({url:'/uploads/'+req.file.filename})});

// Create post
app.post('/api/post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const text=(req.body.text||'').trim().substring(0,280);const imageUrl=req.body.imageUrl||null;const gifUrl=req.body.gifUrl||null;const replyTo=req.body.replyTo||null;if(!text&&!imageUrl&&!gifUrl)return res.status(400).json({error:'Post cannot be empty'});const id=uuidv4();await query('INSERT INTO posts (id,username,text,image_url,gif_url,reply_to,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,acc.username,text,imageUrl,gifUrl,replyTo,Date.now()]);if(replyTo)await query('UPDATE posts SET reply_count=reply_count+1 WHERE id=$1',[replyTo]);res.json({id})});

// Delete post
app.post('/api/delete-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const post=await queryOne('SELECT * FROM posts WHERE id=$1',[req.body.postId]);if(!post)return res.status(404).json({error:'Not found'});if(post.username!==acc.username&&!acc.is_admin)return res.status(403).json({error:'Not yours'});await query('UPDATE posts SET deleted=true WHERE id=$1',[req.body.postId]);res.json({ok:true})});

// Like/unlike
app.post('/api/like',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId}=req.body;const existing=await queryOne('SELECT post_id FROM post_likes WHERE post_id=$1 AND username=$2',[postId,acc.username]);if(existing){await query('DELETE FROM post_likes WHERE post_id=$1 AND username=$2',[postId,acc.username]);await query('UPDATE posts SET like_count=GREATEST(like_count-1,0) WHERE id=$1',[postId]);res.json({liked:false})}else{await query('INSERT INTO post_likes (post_id,username,created_at) VALUES ($1,$2,$3)',[postId,acc.username,Date.now()]);await query('UPDATE posts SET like_count=like_count+1 WHERE id=$1',[postId]);res.json({liked:true})}});

// Repost
app.post('/api/repost',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId}=req.body;const existing=await queryOne('SELECT post_id FROM post_reposts WHERE post_id=$1 AND username=$2',[postId,acc.username]);if(existing){await query('DELETE FROM post_reposts WHERE post_id=$1 AND username=$2',[postId,acc.username]);await query('UPDATE posts SET repost_count=GREATEST(repost_count-1,0) WHERE id=$1',[postId]);res.json({reposted:false})}else{await query('INSERT INTO post_reposts (post_id,username,created_at) VALUES ($1,$2,$3)',[postId,acc.username,Date.now()]);await query('UPDATE posts SET repost_count=repost_count+1 WHERE id=$1',[postId]);// Create a repost entry in posts
const rid=uuidv4();await query('INSERT INTO posts (id,username,text,repost_of,created_at) VALUES ($1,$2,$3,$4,$5)',[rid,acc.username,'',postId,Date.now()]);res.json({reposted:true})}});

// Follow/unfollow
app.post('/api/follow',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const target=(req.body.username||'').toLowerCase();if(target===acc.username)return res.status(400).json({error:'Cannot follow yourself'});if(!await queryOne('SELECT username FROM accounts WHERE username=$1',[target]))return res.status(404).json({error:'User not found'});const existing=await queryOne('SELECT follower FROM follows WHERE follower=$1 AND following=$2',[acc.username,target]);if(existing){await query('DELETE FROM follows WHERE follower=$1 AND following=$2',[acc.username,target]);res.json({following:false})}else{await query('INSERT INTO follows (follower,following,created_at) VALUES ($1,$2,$3)',[acc.username,target,Date.now()]);res.json({following:true})}});

// Timeline — posts from people you follow + your own, sorted by time
app.post('/api/timeline',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const before=req.body.before||Date.now()+1;const rows=await query(`SELECT p.*,a.display_name,a.color,a.pfp,a.badges,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username=$1) as liked,
  EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username=$1) as reposted
  FROM posts p JOIN accounts a ON a.username=p.username
  WHERE p.deleted=false AND p.created_at<$2 AND (p.username=$1 OR p.username IN (SELECT following FROM follows WHERE follower=$1))
  ORDER BY p.created_at DESC LIMIT 30`,[acc.username,before]);
  // For reposts, fetch the original post
  for(let r of rows){if(r.repost_of){const orig=await queryOne('SELECT p.*,a.display_name,a.color,a.pfp,a.badges FROM posts p JOIN accounts a ON a.username=p.username WHERE p.id=$1 AND p.deleted=false',[r.repost_of]);r.original=orig||null}}
  res.json({posts:rows})});

// Explore — all recent posts
app.post('/api/explore',async(req,res)=>{const acc=await findByToken(req.body.token);const un=acc?acc.username:'__none__';const before=req.body.before||Date.now()+1;const rows=await query(`SELECT p.*,a.display_name,a.color,a.pfp,a.badges,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username=$1) as liked,
  EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username=$1) as reposted
  FROM posts p JOIN accounts a ON a.username=p.username
  WHERE p.deleted=false AND p.reply_to IS NULL AND p.created_at<$2
  ORDER BY p.created_at DESC LIMIT 30`,[un,before]);
  for(let r of rows){if(r.repost_of){const orig=await queryOne('SELECT p.*,a.display_name,a.color,a.pfp,a.badges FROM posts p JOIN accounts a ON a.username=p.username WHERE p.id=$1 AND p.deleted=false',[r.repost_of]);r.original=orig||null}}
  res.json({posts:rows})});

// User posts
app.get('/api/user/:username/posts',async(req,res)=>{const before=req.query.before||Date.now()+1;const viewer=req.query.viewer||'__none__';const rows=await query(`SELECT p.*,a.display_name,a.color,a.pfp,a.badges,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username=$1) as liked,
  EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username=$1) as reposted
  FROM posts p JOIN accounts a ON a.username=p.username
  WHERE p.username=$2 AND p.deleted=false AND p.created_at<$3
  ORDER BY p.created_at DESC LIMIT 30`,[viewer,req.params.username,before]);
  for(let r of rows){if(r.repost_of){const orig=await queryOne('SELECT p.*,a.display_name,a.color,a.pfp,a.badges FROM posts p JOIN accounts a ON a.username=p.username WHERE p.id=$1 AND p.deleted=false',[r.repost_of]);r.original=orig||null}}
  res.json({posts:rows})});

// Single post + replies
app.get('/api/post/:id',async(req,res)=>{const viewer=req.query.viewer||'__none__';const post=await queryOne(`SELECT p.*,a.display_name,a.color,a.pfp,a.badges,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username=$1) as liked,
  EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username=$1) as reposted
  FROM posts p JOIN accounts a ON a.username=p.username WHERE p.id=$2 AND p.deleted=false`,[viewer,req.params.id]);
  if(!post)return res.status(404).json({error:'Not found'});
  const replies=await query(`SELECT p.*,a.display_name,a.color,a.pfp,a.badges,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username=$1) as liked,
  EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username=$1) as reposted
  FROM posts p JOIN accounts a ON a.username=p.username WHERE p.reply_to=$2 AND p.deleted=false ORDER BY p.created_at ASC`,[viewer,req.params.id]);
  res.json({post,replies})});

// User profile
app.get('/api/profile/:username',async(req,res)=>{const acc=await queryOne('SELECT username,display_name,color,bio,pfp,badges,created_at FROM accounts WHERE username=$1',[req.params.username]);if(!acc)return res.status(404).json({error:'Not found'});const postCount=await queryOne('SELECT COUNT(*) as c FROM posts WHERE username=$1 AND deleted=false',[acc.username]);const followerCount=await queryOne('SELECT COUNT(*) as c FROM follows WHERE following=$1',[acc.username]);const followingCount=await queryOne('SELECT COUNT(*) as c FROM follows WHERE follower=$1',[acc.username]);const viewer=req.query.viewer||'__none__';const isFollowing=await queryOne('SELECT follower FROM follows WHERE follower=$1 AND following=$2',[viewer,acc.username]);res.json({username:acc.username,displayName:acc.display_name,color:acc.color,bio:acc.bio,pfp:acc.pfp,badges:acc.badges||[],createdAt:acc.created_at,postCount:parseInt(postCount.c),followerCount:parseInt(followerCount.c),followingCount:parseInt(followingCount.c),isFollowing:!!isFollowing})});

// Search posts
app.get('/api/search',async(req,res)=>{const q=(req.query.q||'').trim();if(q.length<2)return res.json({posts:[]});const viewer=req.query.viewer||'__none__';const rows=await query(`SELECT p.*,a.display_name,a.color,a.pfp,a.badges,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username=$1) as liked,
  EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username=$1) as reposted
  FROM posts p JOIN accounts a ON a.username=p.username WHERE p.deleted=false AND p.text ILIKE $2 ORDER BY p.created_at DESC LIMIT 30`,[viewer,'%'+q+'%']);res.json({posts:rows})});

const PORT=process.env.PORT||3001;
initDB().then(()=>{app.listen(PORT,()=>console.log('JorgeGram on port '+PORT))}).catch(e=>{console.error('DB fail:',e);process.exit(1)});
