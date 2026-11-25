const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const port=Number(process.env.PORT||3000);
const accessPassword=process.env.APP_ACCESS_PASSWORD||'';
const adminPassword=process.env.APP_ADMIN_PASSWORD||'';
const cookieName='aistudio_access',adminCookieName='aistudio_admin',adminPath='/aistudio-yonetim-8b6f2d';
const token=(secret,label)=>crypto.createHmac('sha256',secret).update(label).digest('hex');
const accessToken=()=>token(accessPassword,'aistudio-auth-v1'),adminToken=()=>token(adminPassword,'aistudio-admin-v1');
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const validCookie=(req,name,value)=>{const got=cookies(req)[name]||'';return value&&got.length===64&&crypto.timingSafeEqual(Buffer.from(got),Buffer.from(value()));};
const isAuthed=req=>!!accessPassword&&validCookie(req,cookieName,accessToken);
const isAdmin=req=>!!adminPassword&&validCookie(req,adminCookieName,adminToken);
const json=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));};
async function readBody(req,maxBytes=1024*1024){let raw='',size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes){const e=new Error('İstek çok büyük.');e.status=413;throw e;}raw+=chunk;}try{return JSON.parse(raw||'{}')}catch{return {}}}
async function ai(body){
  const messages=Array.isArray(body.messages)?body.messages:[];
  const apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey)throw Object.assign(new Error('Gemini API anahtarı Render ortamında ayarlı değil (GEMINI_API_KEY).'),{status:503,code:'missing_api_key'});
  if(!messages.length)throw Object.assign(new Error('Mesaj boş olamaz.'),{status:400,code:'invalid_request'});
  const contents=messages.filter(m=>m&&['user','assistant','model'].includes(m.role)).map(m=>({role:m.role==='assistant'?'model':m.role,parts:[{text:String(m.content??'')}]}));
  if(!contents.length||contents.every(m=>m.role!=='user'))throw Object.assign(new Error('Kullanıcı mesajı bulunamadı.'),{status:400,code:'invalid_request'});
  const generationConfig=body.json?{responseMimeType:'application/json'}:undefined;
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify({contents,...(generationConfig?{generationConfig}:{})})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data.error){
    const status=r.status||502;
    let message='Gemini AI servisi yanıt vermedi.';
    let code='upstream_error';
    if(status===429){message='Gemini ücretsiz kullanım kotası doldu veya hız sınırına ulaşıldı. Bir süre sonra tekrar dene.';code='rate_limited';}
    else if(status===400){message='Gemini isteği kabul etmedi: '+String(data.error?.message||'istek biçimini kontrol et.').slice(0,350);code='invalid_request';}
    else if(status===401||status===403){message='Gemini API anahtarı geçersiz, kısıtlı veya bu proje için etkin değil. Google AI Studio anahtar/proje ayarlarını kontrol et.';code='invalid_api_key';}
    else if(status===404){message='Gemini ücretsiz modeline erişilemiyor. Model kullanılabilirliğini ve AI Studio projesini kontrol et.';code='model_unavailable';}
    throw Object.assign(new Error(message),{status,code});
  }
  const text=data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
  if(!text)throw Object.assign(new Error('Gemini bu istek için metin yanıtı döndürmedi.'),{status:502,code:'empty_response'});
  if(body.json){let value;try{value=JSON.parse(text.replace(/^```json\s*|\s*```$/g,''));}catch{throw new Error('AI geçerli JSON döndürmedi.')}return {text,value};}
  return {text};
}
const settingsPath=path.join(__dirname,'admin-settings.json');
let siteSettings={announcement:'',modules:{prompt:true,chat:true,sheet:true,lab:true,generator:true,video:true}};
try{const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));siteSettings={...siteSettings,...saved,modules:{...siteSettings.modules,...(saved.modules&&typeof saved.modules==='object'?saved.modules:{})}};}catch{}
delete siteSettings.modules.multi;
function publicSettings(){return {announcement:String(siteSettings.announcement||'').slice(0,500),modules:{...siteSettings.modules}}}
function adminCookie(value,maxAge=2592000){return `${adminCookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='GET'&&req.url==='/api/session')return json(res,200,{authenticated:isAuthed(req)});
  if(req.method==='POST'&&req.url==='/api/login'){
    const body=await readBody(req);
    if(!accessPassword||typeof body.password!=='string'||body.password.trim()!==accessPassword.trim())return json(res,401,{error:'Şifre yanlış.'});
    return json(res,200,{authenticated:true},{'Set-Cookie':`${cookieName}=${accessToken()}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`});
  }
  if(req.method==='POST'&&req.url==='/api/logout')return json(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`});
  if(req.method==='GET'&&req.url==='/api/site-settings')return json(res,200,publicSettings());
  if(req.method==='GET'&&req.url==='/api/admin/session')return json(res,200,{authenticated:isAdmin(req)});
  if(req.method==='POST'&&req.url==='/api/admin/login'){
    const body=await readBody(req);
    if(!adminPassword||typeof body.password!=='string'||body.password.trim()!==adminPassword.trim())return json(res,401,{error:'Yönetici parolası yanlış.'});
    return json(res,200,{authenticated:true},{'Set-Cookie':adminCookie(adminToken())});
  }
  if(req.method==='POST'&&req.url==='/api/admin/logout')return json(res,200,{ok:true},{'Set-Cookie':adminCookie('',0)});
  if(req.method==='GET'&&req.url==='/api/admin/settings')return isAdmin(req)?json(res,200,siteSettings):json(res,401,{error:'Yönetici girişi gerekli.'});
  if(req.method==='POST'&&req.url==='/api/admin/settings'){
    if(!isAdmin(req))return json(res,401,{error:'Yönetici girişi gerekli.'});
    const body=await readBody(req),mods=body.modules&&typeof body.modules==='object'?body.modules:{};
    siteSettings={announcement:typeof body.announcement==='string'?body.announcement.slice(0,500):siteSettings.announcement,modules:{...siteSettings.modules,...Object.fromEntries(Object.keys(siteSettings.modules).map(k=>[k,mods[k]!==false]))}};
    try{fs.writeFileSync(settingsPath,JSON.stringify(siteSettings,null,2));}catch{}
    return json(res,200,{ok:true,settings:publicSettings()});
  }
  if(req.method==='POST'&&req.url==='/api/ai'){
    if(!isAuthed(req))return json(res,401,{error:'Önce uygulama şifresiyle giriş yapın.'});
    try{return json(res,200,await ai(await readBody(req)))}catch(e){return json(res,e.status||500,{error:e.message,code:e.code||'ai_error'});}
  }
  const requested=req.url.split('?')[0];let file=requested===adminPath?'/admin.html':(requested==='/'?'/index.html':requested);file=path.join(__dirname,'public',path.normalize(file));
  if(!file.startsWith(path.join(__dirname,'public'))){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(file,(e,d)=>{if(e&&!path.extname(requested)){file=path.join(__dirname,'public','index.html');fs.readFile(file,(fallbackErr,fallbackData)=>{if(fallbackErr){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fallbackData)});return}if(e){res.writeHead(404);return res.end('Not found');}const ext=path.extname(file);const type={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css','.js':'text/javascript'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(d);});
});
server.listen(port,'0.0.0.0',()=>console.log(`AI Studio Atölyesi listening on ${port}`));
