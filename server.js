const express=require('express'),path=require('path'),fs=require('fs'),{v4:uuidv4}=require('uuid'),bcrypt=require('bcryptjs'),multer=require('multer'),{query,queryOne,initDB}=require('./db');
const app=express();
const uploadDir=path.join(__dirname,'uploads');if(!fs.existsSync(uploadDir))fs.mkdirSync(uploadDir,{recursive:true});
const storage=multer.diskStorage({destination:(r,f,cb)=>cb(null,uploadDir),filename:(r,f,cb)=>cb(null,uuidv4()+'-'+f.originalname)});
const upload=multer({storage,limits:{fileSize:10*1024*1024},fileFilter:(r,f,cb)=>f.mimetype.startsWith('image/')?cb(null,true):cb(new Error('Images only'))});
async function findByToken(t){if(!t)return null;return queryOne('SELECT * FROM accounts WHERE token=$1',[t])}
async function notify(username,type,fromUser,postId){await query('INSERT INTO notifications (id,username,type,from_user,post_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[uuidv4(),username,type,fromUser,postId,Date.now()])}
const COLORS=['#CC0000','#0000CC','#009900','#CC6600','#9900CC','#006666','#CC0066','#336699','#669933','#993366'];

app.use(express.json());
app.use((req,res,next)=>{if(req.headers['x-forwarded-proto']==='http')return res.redirect(301,'https://'+req.headers.host+req.url);next()});
app.use((req,res,next)=>{res.setHeader('Strict-Transport-Security','max-age=63072000; includeSubDomains; preload');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy','upgrade-insecure-requests');next()});
app.use(express.static(path.join(__dirname,'public')));
app.use('/uploads',express.static(uploadDir));

// Auth
app.post('/api/register',async(req,res)=>{const{username,displayName,password}=req.body;if(!username||!password||!displayName)return res.status(400).json({error:'All fields required'});const c=username.trim().toLowerCase();if(c.length<3||c.length>24)return res.status(400).json({error:'Username: 3-24 chars'});if(!/^[a-z0-9_]+$/.test(c))return res.status(400).json({error:'Letters, numbers, _ only'});const cd=displayName.trim().substring(0,24);if(!cd)return res.status(400).json({error:'Display name required'});if(password.length<3)return res.status(400).json({error:'Password: 3+ chars'});if(await queryOne('SELECT username FROM accounts WHERE username=$1',[c]))return res.status(400).json({error:'Username taken'});const h=await bcrypt.hash(password,10),tk=uuidv4();const cnt=await query('SELECT COUNT(*) as n FROM accounts');const col=COLORS[parseInt(cnt[0].n)%COLORS.length];await query('INSERT INTO accounts (username,display_name,password_hash,color,token,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[c,cd,h,col,tk,Date.now()]);res.json({username:c,displayName:cd,color:col,token:tk})});
app.post('/api/login',async(req,res)=>{const{username,password}=req.body;if(!username||!password)return res.status(400).json({error:'Both fields required'});const acc=await queryOne('SELECT * FROM accounts WHERE username=$1',[username.trim().toLowerCase()]);if(!acc||!await bcrypt.compare(password,acc.password_hash))return res.status(401).json({error:'Invalid username or password'});let tk=acc.token;if(!tk){tk=uuidv4();await query('UPDATE accounts SET token=$1 WHERE username=$2',[tk,acc.username])}res.json({username:acc.username,displayName:acc.display_name,color:acc.color,token:tk,bio:acc.bio,pfp:acc.pfp,theme:acc.theme,isAdmin:acc.is_admin})});
app.post('/api/auth',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});res.json({username:acc.username,displayName:acc.display_name,color:acc.color,token:acc.token,bio:acc.bio,pfp:acc.pfp,theme:acc.theme,isAdmin:acc.is_admin})});

// Upload
app.post('/api/upload-image',upload.single('image'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'No file'});const acc=await findByToken(req.body.token);if(!acc){fs.unlinkSync(req.file.path);return res.status(401).json({error:'Invalid token'})}res.json({url:'/uploads/'+req.file.filename})});

// Post helpers
const POST_SELECT=`SELECT p.*,a.display_name,a.color,a.pfp,a.badges`;
const POST_JOIN=`FROM posts p JOIN accounts a ON a.username=p.username`;
function postExtras(viewer){return `,EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.username='${viewer}') as liked,EXISTS(SELECT 1 FROM post_reposts pr WHERE pr.post_id=p.id AND pr.username='${viewer}') as reposted,EXISTS(SELECT 1 FROM bookmarks bk WHERE bk.post_id=p.id AND bk.username='${viewer}') as bookmarked`}
async function enrichPosts(rows,viewer){for(let r of rows){if(r.repost_of){r.original=await queryOne(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.id=$1 AND p.deleted=false`,[r.repost_of])}if(r.quote_of){r.quoted=await queryOne(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.id=$1 AND p.deleted=false`,[r.quote_of])}}return rows}

// Create post
app.post('/api/post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const text=(req.body.text||'').trim().substring(0,280);const imageUrl=req.body.imageUrl||null;const gifUrl=req.body.gifUrl||null;const replyTo=req.body.replyTo||null;const quoteOf=req.body.quoteOf||null;if(!text&&!imageUrl&&!gifUrl)return res.status(400).json({error:'Post cannot be empty'});const id=uuidv4();await query('INSERT INTO posts (id,username,text,image_url,gif_url,reply_to,quote_of,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,acc.username,text,imageUrl,gifUrl,replyTo,quoteOf,Date.now()]);if(replyTo){await query('UPDATE posts SET reply_count=reply_count+1 WHERE id=$1',[replyTo]);const op=await queryOne('SELECT username FROM posts WHERE id=$1',[replyTo]);if(op&&op.username!==acc.username)await notify(op.username,'reply',acc.username,id)}// Notify mentioned users
const mentions=text.match(/@([a-z0-9_]+)/gi);if(mentions)for(const m of mentions){const un=m.substring(1).toLowerCase();if(un!==acc.username)await notify(un,'mention',acc.username,id)}res.json({id})});

// Delete post
app.post('/api/delete-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const post=await queryOne('SELECT * FROM posts WHERE id=$1',[req.body.postId]);if(!post)return res.status(404).json({error:'Not found'});if(post.username!==acc.username&&!acc.is_admin)return res.status(403).json({error:'Not yours'});await query('UPDATE posts SET deleted=true WHERE id=$1',[req.body.postId]);res.json({ok:true})});

// Like
app.post('/api/like',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId}=req.body;const existing=await queryOne('SELECT post_id FROM post_likes WHERE post_id=$1 AND username=$2',[postId,acc.username]);if(existing){await query('DELETE FROM post_likes WHERE post_id=$1 AND username=$2',[postId,acc.username]);await query('UPDATE posts SET like_count=GREATEST(like_count-1,0) WHERE id=$1',[postId]);res.json({liked:false})}else{await query('INSERT INTO post_likes (post_id,username,created_at) VALUES ($1,$2,$3)',[postId,acc.username,Date.now()]);await query('UPDATE posts SET like_count=like_count+1 WHERE id=$1',[postId]);const op=await queryOne('SELECT username FROM posts WHERE id=$1',[postId]);if(op&&op.username!==acc.username)await notify(op.username,'like',acc.username,postId);res.json({liked:true})}});

// Liked by list
app.get('/api/post/:id/likes',async(req,res)=>{const rows=await query('SELECT a.username,a.display_name,a.color,a.pfp FROM post_likes pl JOIN accounts a ON a.username=pl.username WHERE pl.post_id=$1 ORDER BY pl.created_at DESC',[req.params.id]);res.json({users:rows})});

// Repost
app.post('/api/repost',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId}=req.body;const existing=await queryOne('SELECT post_id FROM post_reposts WHERE post_id=$1 AND username=$2',[postId,acc.username]);if(existing){await query('DELETE FROM post_reposts WHERE post_id=$1 AND username=$2',[postId,acc.username]);await query('UPDATE posts SET repost_count=GREATEST(repost_count-1,0) WHERE id=$1',[postId]);res.json({reposted:false})}else{await query('INSERT INTO post_reposts (post_id,username,created_at) VALUES ($1,$2,$3)',[postId,acc.username,Date.now()]);await query('UPDATE posts SET repost_count=repost_count+1 WHERE id=$1',[postId]);const rid=uuidv4();await query('INSERT INTO posts (id,username,text,repost_of,created_at) VALUES ($1,$2,$3,$4,$5)',[rid,acc.username,'',postId,Date.now()]);const op=await queryOne('SELECT username FROM posts WHERE id=$1',[postId]);if(op&&op.username!==acc.username)await notify(op.username,'repost',acc.username,postId);res.json({reposted:true})}});

// Quote post
app.post('/api/quote',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const text=(req.body.text||'').trim().substring(0,280);const quoteOf=req.body.postId;if(!text)return res.status(400).json({error:'Add a comment'});const id=uuidv4();await query('INSERT INTO posts (id,username,text,quote_of,created_at) VALUES ($1,$2,$3,$4,$5)',[id,acc.username,text,quoteOf,Date.now()]);const op=await queryOne('SELECT username FROM posts WHERE id=$1',[quoteOf]);if(op&&op.username!==acc.username)await notify(op.username,'quote',acc.username,id);res.json({id})});

// Follow
app.post('/api/follow',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const target=(req.body.username||'').toLowerCase();if(target===acc.username)return res.status(400).json({error:'Cannot follow yourself'});if(!await queryOne('SELECT username FROM accounts WHERE username=$1',[target]))return res.status(404).json({error:'User not found'});const existing=await queryOne('SELECT follower FROM follows WHERE follower=$1 AND following=$2',[acc.username,target]);if(existing){await query('DELETE FROM follows WHERE follower=$1 AND following=$2',[acc.username,target]);res.json({following:false})}else{await query('INSERT INTO follows (follower,following,created_at) VALUES ($1,$2,$3)',[acc.username,target,Date.now()]);await notify(target,'follow',acc.username,null);res.json({following:true})}});

// Follower/following lists
app.get('/api/user/:username/followers',async(req,res)=>{const rows=await query('SELECT a.username,a.display_name,a.color,a.pfp FROM follows f JOIN accounts a ON a.username=f.follower WHERE f.following=$1 ORDER BY f.created_at DESC',[req.params.username]);res.json({users:rows})});
app.get('/api/user/:username/following',async(req,res)=>{const rows=await query('SELECT a.username,a.display_name,a.color,a.pfp FROM follows f JOIN accounts a ON a.username=f.following WHERE f.follower=$1 ORDER BY f.created_at DESC',[req.params.username]);res.json({users:rows})});

// Bookmark
app.post('/api/bookmark',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId}=req.body;const existing=await queryOne('SELECT post_id FROM bookmarks WHERE post_id=$1 AND username=$2',[postId,acc.username]);if(existing){await query('DELETE FROM bookmarks WHERE post_id=$1 AND username=$2',[postId,acc.username]);res.json({bookmarked:false})}else{await query('INSERT INTO bookmarks (post_id,username,created_at) VALUES ($1,$2,$3)',[postId,acc.username,Date.now()]);res.json({bookmarked:true})}});
app.post('/api/bookmarks',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query(`${POST_SELECT}${postExtras(acc.username)} ${POST_JOIN} WHERE p.id IN (SELECT post_id FROM bookmarks WHERE username=$1) AND p.deleted=false ORDER BY p.created_at DESC LIMIT 50`,[acc.username]);res.json({posts:await enrichPosts(rows,acc.username)})});

// Record view
app.post('/api/view',async(req,res)=>{const acc=await findByToken(req.body.token);const un=acc?acc.username:'anon_'+req.ip;const{postId}=req.body;await query('INSERT INTO post_views (post_id,username,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[postId,un,Date.now()]);await query('UPDATE posts SET view_count=view_count+1 WHERE id=$1',[postId]);res.json({ok:true})});

// Notifications
app.post('/api/notifications',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query('SELECT n.*,a.display_name,a.color,a.pfp FROM notifications n LEFT JOIN accounts a ON a.username=n.from_user WHERE n.username=$1 ORDER BY n.created_at DESC LIMIT 50',[acc.username]);const unread=await queryOne('SELECT COUNT(*) as c FROM notifications WHERE username=$1 AND read=false',[acc.username]);res.json({notifications:rows,unreadCount:parseInt(unread.c)})});
app.post('/api/notifications/read',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});await query('UPDATE notifications SET read=true WHERE username=$1',[acc.username]);res.json({ok:true})});
app.post('/api/notification-count',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const r=await queryOne('SELECT COUNT(*) as c FROM notifications WHERE username=$1 AND read=false',[acc.username]);res.json({count:parseInt(r.c)})});

// Timeline
app.post('/api/timeline',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const before=req.body.before||Date.now()+1;const rows=await query(`${POST_SELECT}${postExtras(acc.username)} ${POST_JOIN} WHERE p.deleted=false AND p.created_at<$2 AND (p.username=$1 OR p.username IN (SELECT following FROM follows WHERE follower=$1)) AND p.username NOT IN (SELECT blocked FROM blocks WHERE blocker=$1) AND p.username NOT IN (SELECT muted FROM mutes WHERE muter=$1) ORDER BY p.created_at DESC LIMIT 30`,[acc.username,before]);res.json({posts:await enrichPosts(rows,acc.username)})});

// Explore
app.post('/api/explore',async(req,res)=>{const acc=await findByToken(req.body.token);const un=acc?acc.username:'__none__';const before=req.body.before||Date.now()+1;const rows=await query(`${POST_SELECT}${postExtras(un)} ${POST_JOIN} WHERE p.deleted=false AND p.reply_to IS NULL AND p.created_at<$1 ORDER BY p.created_at DESC LIMIT 30`,[before]);res.json({posts:await enrichPosts(rows,un)})});

// Trending — most liked in last 24h
app.get('/api/trending',async(req,res)=>{const viewer=req.query.viewer||'__none__';const since=Date.now()-86400000;const rows=await query(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.deleted=false AND p.reply_to IS NULL AND p.created_at>$1 ORDER BY p.like_count DESC,p.repost_count DESC LIMIT 20`,[since]);res.json({posts:await enrichPosts(rows,viewer)})});

// User posts
app.get('/api/user/:username/posts',async(req,res)=>{const before=req.query.before||Date.now()+1;const viewer=req.query.viewer||'__none__';const rows=await query(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.username=$1 AND p.deleted=false AND p.created_at<$2 ORDER BY p.created_at DESC LIMIT 30`,[req.params.username,before]);res.json({posts:await enrichPosts(rows,viewer)})});

// Single post + replies
app.get('/api/post/:id',async(req,res)=>{const viewer=req.query.viewer||'__none__';const post=await queryOne(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.id=$1 AND p.deleted=false`,[req.params.id]);if(!post)return res.status(404).json({error:'Not found'});if(post.quote_of){post.quoted=await queryOne(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.id=$1 AND p.deleted=false`,[post.quote_of])}const replies=await query(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.reply_to=$1 AND p.deleted=false ORDER BY p.created_at ASC`,[req.params.id]);res.json({post,replies})});

// Profile
app.get('/api/profile/:username',async(req,res)=>{try{const acc=await queryOne('SELECT username,display_name,color,bio,pfp,badges,banner_color,created_at FROM accounts WHERE username=$1',[req.params.username]);if(!acc)return res.status(404).json({error:'Not found'});const pc=await queryOne('SELECT COUNT(*) as c FROM posts WHERE username=$1 AND deleted=false',[acc.username]);const flrc=await queryOne('SELECT COUNT(*) as c FROM follows WHERE following=$1',[acc.username]);const flgc=await queryOne('SELECT COUNT(*) as c FROM follows WHERE follower=$1',[acc.username]);const viewer=req.query.viewer||'__none__';const isF=await queryOne('SELECT follower FROM follows WHERE follower=$1 AND following=$2',[viewer,acc.username]);res.json({username:acc.username,displayName:acc.display_name,color:acc.color,bio:acc.bio,pfp:acc.pfp,badges:acc.badges||[],bannerColor:acc.banner_color||'#0a246a',createdAt:acc.created_at,postCount:parseInt(pc.c),followerCount:parseInt(flrc.c),followingCount:parseInt(flgc.c),isFollowing:!!isF})}catch(e){// Fallback without banner_color
const acc=await queryOne('SELECT username,display_name,color,bio,pfp,badges,created_at FROM accounts WHERE username=$1',[req.params.username]);if(!acc)return res.status(404).json({error:'Not found'});const pc=await queryOne('SELECT COUNT(*) as c FROM posts WHERE username=$1 AND deleted=false',[acc.username]);const flrc=await queryOne('SELECT COUNT(*) as c FROM follows WHERE following=$1',[acc.username]);const flgc=await queryOne('SELECT COUNT(*) as c FROM follows WHERE follower=$1',[acc.username]);const viewer=req.query.viewer||'__none__';const isF=await queryOne('SELECT follower FROM follows WHERE follower=$1 AND following=$2',[viewer,acc.username]);res.json({username:acc.username,displayName:acc.display_name,color:acc.color,bio:acc.bio,pfp:acc.pfp,badges:acc.badges||[],bannerColor:'#0a246a',createdAt:acc.created_at,postCount:parseInt(pc.c),followerCount:parseInt(flrc.c),followingCount:parseInt(flgc.c),isFollowing:!!isF})}});

// Search posts + hashtag search
app.get('/api/search',async(req,res)=>{const q=(req.query.q||'').trim();if(q.length<2)return res.json({posts:[]});const viewer=req.query.viewer||'__none__';const rows=await query(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.deleted=false AND p.text ILIKE $1 ORDER BY p.created_at DESC LIMIT 30`,['%'+q+'%']);res.json({posts:await enrichPosts(rows,viewer)})});

// Trending hashtags
app.get('/api/trending-tags',async(req,res)=>{const since=Date.now()-86400000;const rows=await query("SELECT unnest(regexp_matches(text,'#([a-zA-Z0-9_]+)','g')) as tag FROM posts WHERE deleted=false AND created_at>$1",[since]);const counts={};for(const r of rows){const t=r.tag.toLowerCase();counts[t]=(counts[t]||0)+1}const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10);res.json({tags:sorted.map(s=>({tag:s[0],count:s[1]}))})});

// Copy/share link
app.get('/api/post/:id/link',async(req,res)=>{res.json({url:'https://jorgepompacarrera.info/post/'+req.params.id})});

// Admin
app.post('/api/admin/stats',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});const uc=await queryOne('SELECT COUNT(*) as c FROM accounts');const pc=await queryOne('SELECT COUNT(*) as c FROM posts WHERE deleted=false');const fc=await queryOne('SELECT COUNT(*) as c FROM follows');res.json({users:parseInt(uc.c),posts:parseInt(pc.c),follows:parseInt(fc.c)})});
app.post('/api/admin/users',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});const users=await query('SELECT username,display_name,color,badges,created_at,is_admin FROM accounts ORDER BY created_at DESC');res.json({users:users.map(u=>({username:u.username,displayName:u.display_name,color:u.color,badges:u.badges||[],createdAt:u.created_at,isAdmin:u.is_admin}))})});
app.post('/api/admin/set-badge',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});const target=(req.body.username||'').toLowerCase();const badge=(req.body.badge||'').trim().substring(0,20);const action=req.body.action||'add';const t=await queryOne('SELECT badges FROM accounts WHERE username=$1',[target]);if(!t)return res.status(404).json({error:'User not found'});let badges=t.badges||[];if(action==='add'&&!badges.includes(badge))badges.push(badge);if(action==='remove')badges=badges.filter(b=>b!==badge);await query('UPDATE accounts SET badges=$1 WHERE username=$2',[badges,target]);res.json({badges})});
app.post('/api/admin/delete-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});await query('UPDATE posts SET deleted=true WHERE id=$1',[req.body.postId]);res.json({ok:true})});
app.post('/api/admin/delete-user',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});const target=(req.body.username||'').toLowerCase();if(target===acc.username)return res.status(400).json({error:'Cannot delete yourself'});try{await query('DELETE FROM post_likes WHERE username=$1',[target]);await query('DELETE FROM post_reposts WHERE username=$1',[target]);await query('DELETE FROM bookmarks WHERE username=$1',[target]);await query('DELETE FROM notifications WHERE username=$1 OR from_user=$1',[target]);await query('DELETE FROM post_views WHERE username=$1',[target]);await query('DELETE FROM follows WHERE follower=$1 OR following=$1',[target]);await query('UPDATE posts SET deleted=true WHERE username=$1',[target]);await query('DELETE FROM accounts WHERE username=$1',[target]);res.json({ok:true})}catch(e){res.json({error:e.message})}});

// === JORGEGRAM BATCH A ===

// Pin/unpin post on profile
app.post('/api/pin-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const post=await queryOne('SELECT * FROM posts WHERE id=$1',[req.body.postId]);if(!post||post.username!==acc.username)return res.status(403).json({error:'Not yours'});const pinned=!post.pinned;if(pinned){await query('UPDATE posts SET pinned=false WHERE username=$1 AND pinned=true',[acc.username])}await query('UPDATE posts SET pinned=$1 WHERE id=$2',[pinned,req.body.postId]);res.json({pinned})});

// Get pinned post for a user
app.get('/api/user/:username/pinned',async(req,res)=>{const viewer=req.query.viewer||'__none__';const post=await queryOne(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.username=$1 AND p.pinned=true AND p.deleted=false`,[req.params.username]);res.json({post:post||null})});

// Trending users — most followed in last 7 days
app.get('/api/trending-users',async(req,res)=>{const since=Date.now()-604800000;const rows=await query(`SELECT a.username,a.display_name,a.color,a.pfp,a.badges,COUNT(f.follower) as new_followers
  FROM follows f JOIN accounts a ON a.username=f.following WHERE f.created_at>$1
  GROUP BY a.username,a.display_name,a.color,a.pfp,a.badges ORDER BY new_followers DESC LIMIT 10`,[since]);res.json({users:rows.map(u=>({username:u.username,displayName:u.display_name,color:u.color,pfp:u.pfp,badges:u.badges||[],newFollowers:parseInt(u.new_followers)}))})});

// Report post
app.post('/api/report',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId,reason}=req.body;if(!postId)return res.status(400).json({error:'Post ID required'});const existing=await queryOne('SELECT id FROM reports WHERE reporter=$1 AND post_id=$2',[acc.username,postId]);if(existing)return res.status(400).json({error:'Already reported'});await query('INSERT INTO reports (id,reporter,post_id,reason,created_at) VALUES ($1,$2,$3,$4,$5)',[uuidv4(),acc.username,postId,(reason||'').substring(0,200),Date.now()]);res.json({ok:true})});

// Admin: view reports
app.post('/api/admin/reports',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});const rows=await query("SELECT r.*,a.display_name as reporter_name FROM reports r JOIN accounts a ON a.username=r.reporter WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 50");res.json({reports:rows})});
app.post('/api/admin/resolve-report',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});await query('UPDATE reports SET status=$1 WHERE id=$2',[req.body.action||'resolved',req.body.reportId]);if(req.body.action==='delete'&&req.body.postId)await query('UPDATE posts SET deleted=true WHERE id=$1',[req.body.postId]);res.json({ok:true})});

// Post analytics — view count breakdown
app.get('/api/post/:id/analytics',async(req,res)=>{const viewer=req.query.viewer||'__none__';const post=await queryOne('SELECT username,view_count,like_count,repost_count,reply_count,created_at FROM posts WHERE id=$1',[req.params.id]);if(!post)return res.status(404).json({error:'Not found'});if(post.username!==viewer)return res.status(403).json({error:'Not yours'});const likers=await query('SELECT a.display_name FROM post_likes pl JOIN accounts a ON a.username=pl.username WHERE pl.post_id=$1 ORDER BY pl.created_at DESC LIMIT 20',[req.params.id]);res.json({views:post.view_count,likes:post.like_count,reposts:post.repost_count,replies:post.reply_count,age:Date.now()-parseInt(post.created_at),recentLikers:likers.map(l=>l.display_name)})});

// Upload multiple images for carousel
app.post('/api/upload-images',upload.array('images',4),async(req,res)=>{if(!req.files||!req.files.length)return res.status(400).json({error:'No files'});const acc=await findByToken(req.body.token);if(!acc){req.files.forEach(f=>fs.unlinkSync(f.path));return res.status(401).json({error:'Invalid token'})}const urls=req.files.map(f=>'/uploads/'+f.filename);res.json({urls})});

// Create post with multiple images
app.post('/api/post-carousel',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const text=(req.body.text||'').trim().substring(0,280);const imageUrls=req.body.imageUrls||[];if(!text&&!imageUrls.length)return res.status(400).json({error:'Post cannot be empty'});const id=uuidv4();await query('INSERT INTO posts (id,username,text,image_url,created_at) VALUES ($1,$2,$3,$4,$5)',[id,acc.username,text,imageUrls[0]||null,Date.now()]);for(let i=0;i<imageUrls.length;i++){await query('INSERT INTO post_images (id,post_id,url,position) VALUES ($1,$2,$3,$4)',[uuidv4(),id,imageUrls[i],i])}res.json({id})});

// Get carousel images for a post
app.get('/api/post/:id/images',async(req,res)=>{const rows=await query('SELECT url,position FROM post_images WHERE post_id=$1 ORDER BY position',[req.params.id]);res.json({images:rows})});

// Schedule a post
app.post('/api/schedule-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{text,imageUrl,gifUrl,sendAt}=req.body;if(!text&&!imageUrl&&!gifUrl)return res.status(400).json({error:'Post cannot be empty'});if(!sendAt||sendAt<=Date.now())return res.status(400).json({error:'Must be in the future'});const id=uuidv4();await query('INSERT INTO scheduled_posts (id,username,text,image_url,gif_url,send_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,acc.username,(text||'').substring(0,280),imageUrl||null,gifUrl||null,sendAt,Date.now()]);res.json({id})});
app.post('/api/scheduled-posts',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query('SELECT * FROM scheduled_posts WHERE username=$1 AND sent=false ORDER BY send_at ASC',[acc.username]);res.json({posts:rows})});
app.post('/api/cancel-scheduled-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});await query('DELETE FROM scheduled_posts WHERE id=$1 AND username=$2',[req.body.id,acc.username]);res.json({ok:true})});

// === JORGEGRAM BATCH B ===

// User Lists
app.post('/api/create-list',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const name=(req.body.name||'').trim().substring(0,50);if(!name)return res.status(400).json({error:'Name required'});const id=uuidv4();await query('INSERT INTO user_lists (id,owner,name,description,private,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[id,acc.username,name,(req.body.description||'').substring(0,200),req.body.private||false,Date.now()]);res.json({id})});
app.post('/api/my-lists',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query('SELECT l.*,(SELECT COUNT(*) FROM list_members WHERE list_id=l.id) as member_count FROM user_lists l WHERE l.owner=$1 ORDER BY l.created_at DESC',[acc.username]);res.json({lists:rows.map(l=>({id:l.id,name:l.name,description:l.description,private:l.private,memberCount:parseInt(l.member_count)}))})});
app.post('/api/list-add',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const list=await queryOne('SELECT owner FROM user_lists WHERE id=$1',[req.body.listId]);if(!list||list.owner!==acc.username)return res.status(403).json({error:'Not your list'});await query('INSERT INTO list_members (list_id,username,added_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[req.body.listId,req.body.username,Date.now()]);res.json({ok:true})});
app.post('/api/list-remove',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});await query('DELETE FROM list_members WHERE list_id=$1 AND username=$2',[req.body.listId,req.body.username]);res.json({ok:true})});
app.post('/api/list-delete',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});await query('DELETE FROM list_members WHERE list_id=$1',[req.body.listId]);await query('DELETE FROM user_lists WHERE id=$1 AND owner=$2',[req.body.listId,acc.username]);res.json({ok:true})});
app.get('/api/list/:id',async(req,res)=>{const list=await queryOne('SELECT * FROM user_lists WHERE id=$1',[req.params.id]);if(!list)return res.status(404).json({error:'Not found'});const members=await query('SELECT a.username,a.display_name,a.color,a.pfp FROM list_members lm JOIN accounts a ON a.username=lm.username WHERE lm.list_id=$1',[req.params.id]);res.json({list:{id:list.id,name:list.name,description:list.description,owner:list.owner},members})});
app.post('/api/list-timeline',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const before=req.body.before||Date.now()+1;const rows=await query(`${POST_SELECT}${postExtras(acc.username)} ${POST_JOIN} WHERE p.deleted=false AND p.username IN (SELECT username FROM list_members WHERE list_id=$1) AND p.created_at<$2 ORDER BY p.created_at DESC LIMIT 30`,[req.body.listId,before]);res.json({posts:await enrichPosts(rows,acc.username)})});

// Post Templates
app.post('/api/save-template',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const name=(req.body.name||'').trim().substring(0,30);const text=(req.body.text||'').substring(0,280);if(!name||!text)return res.status(400).json({error:'Name and text required'});const id=uuidv4();await query('INSERT INTO post_templates (id,username,name,text,created_at) VALUES ($1,$2,$3,$4,$5)',[id,acc.username,name,text,Date.now()]);res.json({id})});
app.post('/api/my-templates',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query('SELECT * FROM post_templates WHERE username=$1 ORDER BY created_at DESC',[acc.username]);res.json({templates:rows})});
app.post('/api/delete-template',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});await query('DELETE FROM post_templates WHERE id=$1 AND username=$2',[req.body.id,acc.username]);res.json({ok:true})});

// Comments
app.post('/api/comment',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId,text,parentId}=req.body;if(!text||!text.trim())return res.status(400).json({error:'Comment cannot be empty'});const id=uuidv4();await query('INSERT INTO comments (id,post_id,parent_id,username,text,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[id,postId,parentId||null,acc.username,text.trim().substring(0,500),Date.now()]);const op=await queryOne('SELECT username FROM posts WHERE id=$1',[postId]);if(op&&op.username!==acc.username)await notify(op.username,'comment',acc.username,postId);res.json({id})});
app.get('/api/post/:id/comments',async(req,res)=>{const rows=await query('SELECT c.*,a.display_name,a.color,a.pfp,a.badges FROM comments c JOIN accounts a ON a.username=c.username WHERE c.post_id=$1 AND c.deleted=false ORDER BY c.created_at ASC',[req.params.id]);res.json({comments:rows})});
app.post('/api/like-comment',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const existing=await queryOne('SELECT comment_id FROM comment_likes WHERE comment_id=$1 AND username=$2',[req.body.commentId,acc.username]);if(existing){await query('DELETE FROM comment_likes WHERE comment_id=$1 AND username=$2',[req.body.commentId,acc.username]);await query('UPDATE comments SET like_count=GREATEST(like_count-1,0) WHERE id=$1',[req.body.commentId]);res.json({liked:false})}else{await query('INSERT INTO comment_likes (comment_id,username) VALUES ($1,$2)',[req.body.commentId,acc.username]);await query('UPDATE comments SET like_count=like_count+1 WHERE id=$1',[req.body.commentId]);res.json({liked:true})}});
app.post('/api/delete-comment',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const c=await queryOne('SELECT username FROM comments WHERE id=$1',[req.body.commentId]);if(!c||c.username!==acc.username)return res.status(403).json({error:'Not yours'});await query('UPDATE comments SET deleted=true WHERE id=$1',[req.body.commentId]);res.json({ok:true})});

// Embed post — generate embed HTML
app.get('/api/post/:id/embed',async(req,res)=>{const post=await queryOne('SELECT p.*,a.display_name,a.color FROM posts p JOIN accounts a ON a.username=p.username WHERE p.id=$1 AND p.deleted=false',[req.params.id]);if(!post)return res.status(404).json({error:'Not found'});const embedHtml='<blockquote style="border:1px solid #ccc;padding:12px;max-width:400px;font-family:sans-serif;font-size:13px"><b style="color:'+post.color+'">'+post.display_name+'</b> <span style="color:gray">@'+post.username+'</span><p>'+post.text+'</p><a href="https://jorgepompacarrera.info/post/'+post.id+'" style="font-size:11px;color:gray">View on JorgeGram</a></blockquote>';res.json({html:embedHtml,url:'https://jorgepompacarrera.info/post/'+post.id})});

// Quote of the day
app.get('/api/quote-of-the-day',async(req,res)=>{const count=await queryOne('SELECT COUNT(*) as c FROM daily_quotes');if(!count||parseInt(count.c)===0)return res.json({quote:null});const day=Math.floor(Date.now()/86400000);const offset=day%parseInt(count.c);const quote=await queryOne('SELECT * FROM daily_quotes ORDER BY created_at LIMIT 1 OFFSET $1',[offset]);res.json({quote})});
app.post('/api/admin/add-quote',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc||!acc.is_admin)return res.status(403).json({error:'Not admin'});const text=(req.body.text||'').trim();const author=(req.body.author||'').trim();if(!text)return res.status(400).json({error:'Text required'});await query('INSERT INTO daily_quotes (id,text,author,added_by,created_at) VALUES ($1,$2,$3,$4,$5)',[uuidv4(),text.substring(0,300),author.substring(0,50),acc.username,Date.now()]);res.json({ok:true})});

// SPA catch-all
app.get('/post/:id',(req,res)=>{res.sendFile(path.join(__dirname,'public','index.html'))});
app.get('/user/:username',(req,res)=>{res.sendFile(path.join(__dirname,'public','index.html'))});

// === BATCH 2 ===

// Create poll post
app.post('/api/post-poll',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const text=(req.body.text||'').trim().substring(0,280);const options=(req.body.options||[]).map(o=>o.trim().substring(0,60)).filter(o=>o);if(options.length<2||options.length>4)return res.status(400).json({error:'2-4 options required'});const duration=Math.min(req.body.duration||24,168);const id=uuidv4();const endsAt=Date.now()+duration*3600000;await query('INSERT INTO posts (id,username,text,created_at) VALUES ($1,$2,$3,$4)',[id,acc.username,text,Date.now()]);await query('INSERT INTO polls (post_id,options,votes,ends_at) VALUES ($1,$2,$3,$4)',[id,options,'{}',endsAt]);res.json({id})});

// Vote on poll
app.post('/api/poll-vote',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const{postId,optionIdx}=req.body;const poll=await queryOne('SELECT * FROM polls WHERE post_id=$1',[postId]);if(!poll)return res.status(404).json({error:'Poll not found'});if(Date.now()>parseInt(poll.ends_at))return res.status(400).json({error:'Poll ended'});if(await queryOne('SELECT post_id FROM poll_votes WHERE post_id=$1 AND username=$2',[postId,acc.username]))return res.status(400).json({error:'Already voted'});await query('INSERT INTO poll_votes (post_id,username,option_idx,created_at) VALUES ($1,$2,$3,$4)',[postId,acc.username,optionIdx,Date.now()]);const votes=poll.votes||{};votes[optionIdx]=(votes[optionIdx]||0)+1;await query('UPDATE polls SET votes=$1 WHERE post_id=$2',[JSON.stringify(votes),postId]);res.json({ok:true})});

// Get poll data
app.get('/api/poll/:postId',async(req,res)=>{const poll=await queryOne('SELECT * FROM polls WHERE post_id=$1',[req.params.postId]);if(!poll)return res.status(404).json({error:'Not found'});const totalVotes=await queryOne('SELECT COUNT(*) as c FROM poll_votes WHERE post_id=$1',[req.params.postId]);const viewer=req.query.viewer||'__none__';const myVote=await queryOne('SELECT option_idx FROM poll_votes WHERE post_id=$1 AND username=$2',[req.params.postId,viewer]);res.json({options:poll.options,votes:poll.votes||{},totalVotes:parseInt(totalVotes.c),endsAt:parseInt(poll.ends_at),ended:Date.now()>parseInt(poll.ends_at),myVote:myVote?myVote.option_idx:null})});

// Block user
app.post('/api/block',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const target=(req.body.username||'').toLowerCase();if(target===acc.username)return res.status(400).json({error:'Cannot block yourself'});const existing=await queryOne('SELECT blocker FROM blocks WHERE blocker=$1 AND blocked=$2',[acc.username,target]);if(existing){await query('DELETE FROM blocks WHERE blocker=$1 AND blocked=$2',[acc.username,target]);res.json({blocked:false})}else{await query('INSERT INTO blocks (blocker,blocked,created_at) VALUES ($1,$2,$3)',[acc.username,target,Date.now()]);await query('DELETE FROM follows WHERE (follower=$1 AND following=$2) OR (follower=$2 AND following=$1)',[acc.username,target]);res.json({blocked:true})}});

// Mute user
app.post('/api/mute',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const target=(req.body.username||'').toLowerCase();const existing=await queryOne('SELECT muter FROM mutes WHERE muter=$1 AND muted=$2',[acc.username,target]);if(existing){await query('DELETE FROM mutes WHERE muter=$1 AND muted=$2',[acc.username,target]);res.json({muted:false})}else{await query('INSERT INTO mutes (muter,muted,created_at) VALUES ($1,$2,$3)',[acc.username,target,Date.now()]);res.json({muted:true})}});

// Get block/mute status
app.get('/api/user-status/:target',async(req,res)=>{const viewer=req.query.viewer||'__none__';const blocked=await queryOne('SELECT blocker FROM blocks WHERE blocker=$1 AND blocked=$2',[viewer,req.params.target]);const muted=await queryOne('SELECT muter FROM mutes WHERE muter=$1 AND muted=$2',[viewer,req.params.target]);res.json({blocked:!!blocked,muted:!!muted})});

// Edit post
app.post('/api/edit-post',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const post=await queryOne('SELECT * FROM posts WHERE id=$1',[req.body.postId]);if(!post||post.username!==acc.username)return res.status(403).json({error:'Not yours'});const newText=(req.body.text||'').trim().substring(0,280);await query('INSERT INTO post_edits (id,post_id,old_text,new_text,edited_at) VALUES ($1,$2,$3,$4,$5)',[uuidv4(),post.id,post.text,newText,Date.now()]);await query('UPDATE posts SET text=$1,edited=true WHERE id=$2',[newText,post.id]);res.json({ok:true})});

// Get edit history
app.get('/api/post/:id/edits',async(req,res)=>{const rows=await query('SELECT * FROM post_edits WHERE post_id=$1 ORDER BY edited_at DESC',[req.params.id]);res.json({edits:rows})});

// Drafts
app.post('/api/save-draft',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const id=req.body.id||uuidv4();const text=(req.body.text||'').substring(0,280);const now=Date.now();const existing=await queryOne('SELECT id FROM drafts WHERE id=$1 AND username=$2',[id,acc.username]);if(existing){await query('UPDATE drafts SET text=$1,image_url=$2,gif_url=$3,updated_at=$4 WHERE id=$5',[text,req.body.imageUrl||null,req.body.gifUrl||null,now,id])}else{await query('INSERT INTO drafts (id,username,text,image_url,gif_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,acc.username,text,req.body.imageUrl||null,req.body.gifUrl||null,now,now])}res.json({id})});
app.post('/api/drafts',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query('SELECT * FROM drafts WHERE username=$1 ORDER BY updated_at DESC',[acc.username]);res.json({drafts:rows})});
app.post('/api/delete-draft',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});await query('DELETE FROM drafts WHERE id=$1 AND username=$2',[req.body.id,acc.username]);res.json({ok:true})});

// Update banner color
app.post('/api/update-banner',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const color=(req.body.color||'').trim();if(!/^#[0-9a-fA-F]{6}$/.test(color))return res.status(400).json({error:'Invalid color'});await query('UPDATE accounts SET banner_color=$1 WHERE username=$2',[color,acc.username]);res.json({color})});

// Media gallery — user's image/gif posts only
app.get('/api/user/:username/media',async(req,res)=>{const viewer=req.query.viewer||'__none__';const rows=await query(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.username=$1 AND p.deleted=false AND (p.image_url IS NOT NULL OR p.gif_url IS NOT NULL) ORDER BY p.created_at DESC LIMIT 50`,[req.params.username]);res.json({posts:rows})});

// Suggested users — people followed by people you follow, that you don't follow yet
app.post('/api/suggested',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const rows=await query(`SELECT a.username,a.display_name,a.color,a.pfp,a.badges,COUNT(*) as mutual
    FROM follows f1 JOIN follows f2 ON f2.follower=f1.following JOIN accounts a ON a.username=f2.following
    WHERE f1.follower=$1 AND f2.following!=$1 AND f2.following NOT IN (SELECT following FROM follows WHERE follower=$1)
    AND f2.following NOT IN (SELECT blocked FROM blocks WHERE blocker=$1)
    GROUP BY a.username,a.display_name,a.color,a.pfp,a.badges ORDER BY mutual DESC LIMIT 10`,[acc.username]);res.json({users:rows.map(u=>({username:u.username,displayName:u.display_name,color:u.color,pfp:u.pfp,badges:u.badges||[],mutualCount:parseInt(u.mutual)}))})});

// === BATCH 3 ===

// Post of the day — most liked post in last 24h
app.get('/api/post-of-the-day',async(req,res)=>{const viewer=req.query.viewer||'__none__';const since=Date.now()-86400000;const post=await queryOne(`${POST_SELECT}${postExtras(viewer)} ${POST_JOIN} WHERE p.deleted=false AND p.reply_to IS NULL AND p.repost_of IS NULL AND p.created_at>$1 ORDER BY p.like_count DESC LIMIT 1`,[since]);res.json({post:post||null})});

// Post streak — consecutive days the user has posted
app.get('/api/streak/:username',async(req,res)=>{const rows=await query("SELECT DISTINCT DATE(to_timestamp(created_at/1000)) as d FROM posts WHERE username=$1 AND deleted=false ORDER BY d DESC",[req.params.username]);if(!rows.length)return res.json({streak:0,maxStreak:0});let streak=0,maxStreak=0,curStreak=1;const today=new Date();today.setHours(0,0,0,0);const firstDay=new Date(rows[0].d);firstDay.setHours(0,0,0,0);if(today.getTime()-firstDay.getTime()<=86400000)streak=1;else{res.json({streak:0,maxStreak:calcMax(rows)});return}for(let i=1;i<rows.length;i++){const cur=new Date(rows[i-1].d);const prev=new Date(rows[i].d);const diff=(cur.getTime()-prev.getTime())/86400000;if(Math.round(diff)===1){curStreak++;streak=curStreak}else break}maxStreak=calcMax(rows);res.json({streak,maxStreak})});
function calcMax(rows){let max=1,cur=1;for(let i=1;i<rows.length;i++){const a=new Date(rows[i-1].d);const b=new Date(rows[i].d);if(Math.round((a.getTime()-b.getTime())/86400000)===1){cur++;if(cur>max)max=cur}else cur=1}return max}

// "For You" feed — posts liked by people you follow
app.post('/api/foryou',async(req,res)=>{const acc=await findByToken(req.body.token);if(!acc)return res.status(401).json({error:'Invalid token'});const before=req.body.before||Date.now()+1;const rows=await query(`${POST_SELECT}${postExtras(acc.username)} ${POST_JOIN}
  WHERE p.deleted=false AND p.reply_to IS NULL AND p.repost_of IS NULL
  AND p.id IN (SELECT pl.post_id FROM post_likes pl WHERE pl.username IN (SELECT following FROM follows WHERE follower=$1))
  AND p.username!=$1 AND p.username NOT IN (SELECT blocked FROM blocks WHERE blocker=$1)
  AND p.username NOT IN (SELECT muted FROM mutes WHERE muter=$1)
  AND p.created_at<$2
  ORDER BY p.like_count DESC, p.created_at DESC LIMIT 30`,[acc.username,before]);res.json({posts:await enrichPosts(rows,acc.username)})});

const PORT=process.env.PORT||3001;
initDB().then(()=>{app.listen(PORT,()=>{console.log('JorgeGram on port '+PORT);
  // Scheduled post processor — checks every 15 seconds
  setInterval(async()=>{try{const posts=await query('SELECT sp.*,a.display_name,a.color FROM scheduled_posts sp JOIN accounts a ON a.username=sp.username WHERE sp.sent=false AND sp.send_at<=$1',[Date.now()]);for(const sp of posts){const id=uuidv4();await query('INSERT INTO posts (id,username,text,image_url,gif_url,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[id,sp.username,sp.text,sp.image_url,sp.gif_url,Date.now()]);await query('UPDATE scheduled_posts SET sent=true WHERE id=$1',[sp.id])}}catch(e){console.error('Scheduler error:',e.message)}},15000);
})}).catch(e=>{console.error('DB fail:',e);process.exit(1)});
