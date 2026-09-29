
/* ================= validation + normalisation ================= */
const CAPS = { observations:8, objects:12, activities:5, search_keywords:10, dominant_colors:3 };
/* Text is the most searchable thing in an image, so the cap depends on what the
   image IS. A flat 300 threw away 1,127 characters of a single slide. */
const TEXT_CAP = { screenshot:6000, document:6000, receipt:4000, meme:1500,
                   artwork:800, photo:800, other:1500, unknown:1500 };
const TEXT_HEAVY = new Set(["screenshot","document","receipt"]);
const textCapFor = t => TEXT_CAP[t] || TEXT_CAP.other;
/* Applied after image_type is corrected, since the corrected type is the one
   that should decide how much text is worth keeping. */
function capText(rec){
  const cap = textCapFor(rec.image_type);
  const vt = rec.visible_text || { has_text:false, text:"" };
  if ((vt.text || "").length > cap)
    rec.visible_text = { has_text:vt.has_text, text:vt.text.slice(0, cap) };
  if (rec.text_lines && rec.text_lines.length){
    const out = []; let n = 0;
    for (const ln of rec.text_lines){
      if (n + ln.length > cap) break;
      out.push(ln); n += ln.length + 1;
    }
    rec.text_lines = out;
  }
  rec.text_chars = (rec.visible_text.text || "").length;
  return rec;
}
const KEEP_PLURAL = new Set(["glasses","sunglasses","jeans","shorts","scissors","headphones",
  "stairs","trousers","binoculars","pyjamas","clothes","fireworks",
  /* singular nouns that merely end in s -- "lens" became "len", "gas" became
     "ga", and the stored term then differed from the search term */
  "lens","gas","canvas","bus","iris","atlas","compass","glass","grass","dress",
  "cactus","virus","campus","chess","cross","press","class","brass","moss"]);
const SYNONYMS = { auto:"car", automobile:"car", "cell phone":"phone", "mobile phone":"phone",
  sofa:"couch", "bicycle":"bike", "photograph":"photo", "canine":"dog", "feline":"cat" };

function singular(w){
  w = w.trim().toLowerCase();
  if (KEEP_PLURAL.has(w)) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0,-3) + "y";
  if (/(ch|sh|x|s|z)es$/.test(w)) return w.slice(0,-2);
  if (/s$/.test(w)) return w.slice(0,-1);
  return w;
}
function normList(v, cap, sing){
  const out = [];
  for (const x of (v || [])){
    if (typeof x !== "string") continue;
    let t = x.trim().toLowerCase().replace(/\s+/g," ");
    if (sing) t = singular(t);
    t = SYNONYMS[t] || t;
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, cap);
}
const clampWords = (s, n) => (s || "").trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const stripThink = s => (s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

/* Fields the record owns. The model must never be able to set them: validate
   spreads the parsed object, and scanOne spreads the result LAST, so a stray
   "id" or "path" key would overwrite the record's identity. */
const RESERVED = new Set(["id","path","name","kind","library_root","content_tag",
  "fingerprint","size","mtime","width","height","decoder","scanned_at","status",
  "issues","secs","out_tokens","deleted","vision_model","embed_model",
  "schema_hash","prompt_hash","date_taken","gps","camera","when","place"]);

function validate(r){
  const issues = [], n = { ...r };
  for (const k of RESERVED){
    if (k in n){ delete n[k]; issues.push("model returned a reserved field: " + k); }
  }
  n.template_version = TPL.version;
  for (const [f, cap] of Object.entries(CAPS))
    if ((r[f] || []).length > cap) issues.push(f + " over cap (" + r[f].length + ">" + cap + ")");
  n.observations = (r.observations || []).map(o => clampWords(o, 15)).slice(0, 8);
  if (n.observations.length < 3) issues.push("observations fewer than 3");
  n.objects = normList(r.objects, 12, true);
  n.activities = normList(r.activities, 5, false);
  n.search_keywords = normList(r.search_keywords, 10, false);
  n.dominant_colors = normList(r.dominant_colors, 3, false);
  n.setting = clampWords(r.setting, 3).toLowerCase();
  const capW = (r.caption || "").trim().split(/\s+/).filter(Boolean).length;
  if (capW > 25) issues.push("caption " + capW + " words >25");
  n.caption = clampWords(r.caption, 25);
  const dW = (r.description || "").trim().split(/\s+/).filter(Boolean).length;
  if (dW > 80) issues.push("description " + dW + " words >80");
  n.description = clampWords(r.description, 80);
  const vt = r.visible_text || {};
  const CEILING = 20000;                     // runaway guard only, not the real cap
  if ((vt.text || "").length > CEILING) issues.push("visible_text over " + CEILING + " chars");
  n.visible_text = { has_text: !!vt.has_text, text: (vt.text || "").slice(0, CEILING) };
  const p = r.people || {};
  const pw = (p.description || "").trim().split(/\s+/).filter(Boolean).length;
  if (pw > 25) issues.push("people.description >25 words");
  /* "count: 5" with a missing bucket used to become bucket "0" -- "no people" --
     which is what search and filters actually use. */
  const bucketFor = c => c == null ? "0"
    : c <= 0 ? "0" : c === 1 ? "1" : c === 2 ? "2"
    : c <= 5 ? "3-5" : c <= 10 ? "6-10" : "10+";
  n.people = { count: p.count == null ? null : p.count,
               count_bucket: p.count_bucket || bucketFor(p.count),
               age_groups: normList(p.age_groups, 4, false), description: clampWords(p.description, 25) };
  n.animals = (r.animals || []).slice(0,5).map(a => ({
    type: singular(String(a && a.type || "").toLowerCase()),
    count: Number.isFinite(Number(a && a.count)) ? Number(a.count) : 1 }));
  for (const f of ["image_type","scene_type","time_of_day","season","weather","mood"]){
    const allowed = TPL.enums[f];
    if (allowed && !allowed.includes(r[f])) issues.push(f + "='" + r[f] + "' not in enum");
  }
  return { norm:n, issues };
}

/* ---- image_type correction ----
   The model defaults almost everything to "photo": it typed a Google Maps
   screenshot and a film poster as photos while its own caption said otherwise.
   Filename, pixel dimensions and camera EXIF are local, free and far more
   reliable for this one field, so they win where they are confident. */
const SCREENSHOT_NAME =
  /(^|[^a-z])(screen[ _-]?shot|screen[ _-]?capture|screencap|snip|capture|bildschirmfoto|schermata|captura)([^a-z]|$)/i;
const SCREEN_SIZES = new Set([
  "1280x720","1366x768","1440x900","1536x864","1600x900","1680x1050","1920x1080","1920x1200",
  "2048x1152","2560x1440","2560x1600","2880x1800","3072x1920","3360x2100","3456x2234",
  "3840x2160","5120x2880","1080x1920","1170x2532","1179x2556","1284x2778","1290x2796",
  "1125x2436","750x1334","828x1792","1242x2688","1668x2388","2048x2732","1620x2160",
  "2732x2048","2388x1668","2160x1620"
]);
/* The model's own words are a better signal than its image_type field: it will
   write "a presentation slide" and still tick "photo". Only consulted for files
   with no camera tags, so a real photograph OF a poster stays a photograph. */
const CAPTION_TYPE = [
  [/\b(presentation slide|power\s?point|slide deck|a slide\b)/i, "screenshot"],
  [/\b(screenshot|screen capture|user interface|dialog box|web ?page|browser window|app window|menu bar)\b/i, "screenshot"],
  [/\b(map view|satellite view|street map|google maps|road map)\b/i, "screenshot"],
  [/\b(spreadsheet|chat log|messaging app|email client|terminal window)\b/i, "screenshot"],
  [/\b(movie poster|film poster|album cover|book cover|concert poster|vintage poster)\b/i, "artwork"],
  [/\b(illustration|digital art|cartoon drawing|painting of|drawing of|comic panel)\b/i, "artwork"],
  [/\b(receipt|invoice|till slip|boarding pass|ticket stub)\b/i, "receipt"],
  [/\b(floor plan|blueprint|schematic|technical drawing|scanned document|certificate|application form|order form)\b/i, "document"],
  [/\b(meme|image macro)\b/i, "meme"],
];
function typeFromWords(rec){
  const text = [rec && rec.caption, rec && rec.description,
    ...((rec && rec.observations) || [])].filter(Boolean).join(" ");
  if (!text) return null;
  for (const [rx, type] of CAPTION_TYPE) if (rx.test(text)) return type;
  return null;
}
function correctImageType(modelType, meta, rec){
  const name = meta.name || "";
  const dims = meta.width + "x" + meta.height;
  /* Camera tags come FIRST: the filename pattern matches bare "capture" and
     "snip", so "Video Capture 2019.jpg" from a real camera was being retyped as
     a screenshot -- contradicting the very rule below it. */
  if (meta.camera){
    if (modelType === "screenshot" || modelType === "document")
      return { type:"photo", source:"exif-camera", changed:true };
    return { type:modelType, source:"model", changed:false };
  }
  if (SCREENSHOT_NAME.test(name))
    return { type:"screenshot", source:"filename", changed: modelType !== "screenshot" };
  // 3. Exact screen dimensions on a lossless format.
  if (SCREEN_SIZES.has(dims) && /\.(png|bmp|webp)$/i.test(name))
    return { type:"screenshot", source:"dimensions", changed: modelType !== "screenshot" };
  // 4. What the model actually described.
  const byWords = typeFromWords(rec);
  if (byWords && byWords !== modelType)
    return { type:byWords, source:"caption", changed:true };
  return { type:modelType, source:"model", changed:false };
}
