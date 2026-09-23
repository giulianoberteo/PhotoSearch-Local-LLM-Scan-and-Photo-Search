
/* ================= dating a photo =================
   EXIF is not ground truth. Exported, edited or generated files often carry the
   processing time in every date field, with no camera tags at all. So we record
   WHERE the date came from and how much to trust it, try the filename too, and
   let an explicit override win over everything. */
let exifr = null, exifrTried = false;
async function loadExifr(){
  if (exifrTried) return exifr;
  exifrTried = true;
  try {
    const m = await import("https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs");
    exifr = m.default || m;
  } catch { exifr = null; }
  return exifr;
}

/* Conservative: only year-first patterns, so 04-07-2012 (ambiguous) is ignored. */
const FN_DATE = [
  /(?:^|[^0-9])(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _tT-]+(\d{2})[-_.:]?(\d{2})(?:[-_.:]?(\d{2}))?)?/,
];
function dateFromName(name){
  for (const rx of FN_DATE){
    const m = name.match(rx);
    if (!m) continue;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2035 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const dt = new Date(y, mo - 1, d, +(m[4] || 12), +(m[5] || 0), +(m[6] || 0));
    if (isNaN(dt)) continue;
    return dt;
  }
  return null;
}

/* Higher is better. Used for date_confidence and for choosing between sources. */
function dateConfidence(source, hasCamera){
  if (source === "override") return "certain";
  if (source === "exif-original" && hasCamera) return "high";
  if (source === "exif-original" || source === "exif-create") return "medium";
  if (source === "filename") return "medium";
  return "low";
}

async function readExif(file, name, override){
  const out = { date_taken:null, date_source:"mtime", date_confidence:"low",
                gps:null, camera:null, lens:null, software:null,
                date_alternatives:{} };
  const lib = await loadExifr();
  let d = null;
  if (lib){
    try { d = await lib.parse(file, { tiff:true, exif:true, gps:true, ifd0:true, xmp:true, iptc:true }); }
    catch {}
  }
  if (d){
    const cam = [d.Make, d.Model].filter(Boolean).join(" ").trim();
    if (cam) out.camera = cam;
    if (d.LensModel) out.lens = d.LensModel;
    if (d.Software) out.software = String(d.Software);
    if (typeof d.latitude === "number" && typeof d.longitude === "number"
        && isFinite(d.latitude) && isFinite(d.longitude))
      out.gps = { lat:d.latitude, lon:d.longitude };
    const pick = [["exif-original", d.DateTimeOriginal], ["exif-create", d.CreateDate],
                  ["exif-modify", d.ModifyDate]];
    for (const [src, v] of pick){
      if (!v) continue;
      const dt = new Date(v);
      if (isNaN(dt)) continue;
      out.date_alternatives[src] = dt.toISOString();
      if (!out.date_taken){ out.date_taken = dt.toISOString(); out.date_source = src; }
    }
  }
  const fn = dateFromName(name || file.name || "");
  if (fn) out.date_alternatives.filename = fn.toISOString();
  // A filename date beats a bare mtime, but never beats real EXIF.
  if (!out.date_taken && fn){ out.date_taken = fn.toISOString(); out.date_source = "filename"; }
  if (!out.date_taken){
    out.date_taken = new Date(file.lastModified).toISOString();
    out.date_source = "mtime";
  }
  out.date_alternatives.mtime = new Date(file.lastModified).toISOString();
  out.date_confidence = dateConfidence(out.date_source, !!out.camera);

  /* An edited/exported/generated file typically has dates but no camera tags.
     Flag it so the date is never presented as if it were a capture time. */
  out.date_suspect = !out.camera && out.date_source.startsWith("exif");

  if (override && override.date){
    out.date_alternatives[out.date_source] = out.date_taken;
    out.date_taken = new Date(override.date).toISOString();
    out.date_source = "override";
    out.date_confidence = "certain";
    out.date_suspect = false;
  }
  return out;
}

/* Overrides live in config.json so they travel with the index.
   A path prefix lets one entry re-date a whole folder. */
function overrideFor(path){
  const list = S.date.overrides || [];
  let best = null;
  for (const o of list){
    if (!o.prefix || !path.startsWith(o.prefix)) continue;
    if (!best || o.prefix.length > best.prefix.length) best = o;
  }
  return best;
}
