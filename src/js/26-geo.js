
/* ================= offline place names (GeoNames-derived) =================
   Fetched once from a CDN, then cached inside .photoindex/geo/ as a compact
   binary so it travels with the photos and never needs the network again.
   No online geocoding API is ever contacted. */
const GEO_SRC = "https://cdn.jsdelivr.net/gh/lutangar/cities.json@master/cities.json";
const GEO = { lat:null, lon:null, names:null, cc:null, grid:null, count:0, state:"none" };

async function geoDir(){ return IDX.dir.getDirectoryHandle("geo", { create:true }); }

async function geoCached(){
  try {
    const g = await geoDir();
    const meta = JSON.parse(await (await (await g.getFileHandle("meta.json")).getFile()).text());
    const buf = await (await (await g.getFileHandle("cities.bin")).getFile()).arrayBuffer();
    const txt = await (await (await g.getFileHandle("names.txt")).getFile()).text();
    const coords = new Float32Array(buf);
    const lines = txt.split("\n");
    /* "<" let an interrupted refresh pair NEW coordinates with an OLD name
       file, shifting every place name by the row difference with no warning. */
    if (coords.length / 2 !== meta.count || lines.length < meta.count) return false;
    if (meta.stamp && meta.stamp !== (lines.length + ":" + coords.length)) return false;
    GEO.lat = new Float32Array(meta.count);
    GEO.lon = new Float32Array(meta.count);
    GEO.names = new Array(meta.count);
    GEO.cc = new Array(meta.count);
    for (let i = 0; i < meta.count; i++){
      GEO.lat[i] = coords[i*2]; GEO.lon[i] = coords[i*2+1];
      const t = lines[i].lastIndexOf("\t");
      GEO.names[i] = t < 0 ? lines[i] : lines[i].slice(0, t);
      GEO.cc[i] = t < 0 ? "" : lines[i].slice(t+1);
    }
    GEO.count = meta.count;
    buildGeoGrid();
    GEO.state = "ready";
    return true;
  } catch { return false; }
}

async function geoFetchAndCache(onProgress){
  /* Report distinct phases. The download is only a second or two; parsing 170k
     entries and writing the cache are what actually take time, and without
     naming them the button just says "working" for no visible reason. */
  const say = (phase, detail) => { if (onProgress) onProgress(phase, detail); };
  say("Contacting the CDN…");
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 120000);
  let r;
  try { r = await fetch(GEO_SRC, { signal: ac.signal }); }
  catch (e){
    clearTimeout(timeout);
    throw new Error(e.name === "AbortError"
      ? "the download timed out after 2 minutes" : String(e.message || e));
  }
  if (!r.ok){ clearTimeout(timeout); throw new Error("HTTP " + r.status); }
  /* Report megabytes, not a percentage: content-length is the COMPRESSED size
     while the stream we read is decompressed, so a percentage runs past 100. */
  const reader = r.body.getReader();
  const chunks = []; let got = 0, lastMB = 0;
  for(;;){
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    const mb = got / 1048576;
    if (mb >= lastMB + 2){                       // one update per 2 MB
      lastMB = mb;
      say("Downloading…", mb.toFixed(0) + " MB of about 17 MB");
    }
  }
  clearTimeout(timeout);
  say("Reading the file…", (got / 1048576).toFixed(1) + " MB downloaded");
  const blob = new Blob(chunks);
  const text = await blob.text();
  say("Parsing 170,000 places…", "this is the slow part");
  await new Promise(r2 => setTimeout(r2, 0));      // let the UI paint first
  const list = JSON.parse(text);
  const n = list.length;
  const coords = new Float32Array(n * 2);
  const names = new Array(n);
  for (let i = 0; i < n; i++){
    const c = list[i];
    coords[i*2] = parseFloat(c.lat); coords[i*2+1] = parseFloat(c.lng);
    names[i] = c.name + "\t" + (c.country || "");
  }
  say("Saving the cache…", n.toLocaleString() + " places");
  const g = await geoDir();
  await writeBinary(await g.getFileHandle("cities.bin", { create:true }), coords.buffer);
  await writeFile(await g.getFileHandle("names.txt", { create:true }), names.join("\n"));
  await writeFile(await g.getFileHandle("meta.json", { create:true }),
    JSON.stringify({ source:GEO_SRC, count:n, fetched_at:new Date().toISOString(),
      stamp: names.length + ":" + coords.length }, null, 2));
  say("Building the lookup index…");
  await new Promise(r2 => setTimeout(r2, 0));
  return geoCached();
}

/* One-degree cells; lookups scan an expanding ring so coastal/remote points still resolve. */
function buildGeoGrid(){
  const g = new Map();
  for (let i = 0; i < GEO.count; i++){
    let lo = Math.floor(GEO.lon[i]);
    if (lo >= 180) lo -= 360;                 // 180.0 collided with the -180 cell
    const k = (Math.floor(GEO.lat[i]) + 90) * 360 + (lo + 180);
    let a = g.get(k);
    if (!a){ a = []; g.set(k, a); }
    a.push(i);
  }
  GEO.grid = g;
}
function haversineKm(la1, lo1, la2, lo2){
  const R = 6371, t = Math.PI / 180;
  const dLa = (la2-la1)*t, dLo = (lo2-lo1)*t;
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*t)*Math.cos(la2*t)*Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function nearestPlace(lat, lon){
  if (GEO.state !== "ready" || !GEO.grid) return null;
  const bLa = Math.floor(lat), bLo = Math.floor(lon);
  let best = -1, bestKm = Infinity, foundAt = null;
  for (let ring = 0; ring <= 8; ring++){
    for (let dLa = -ring; dLa <= ring; dLa++){
      for (let dLo = -ring; dLo <= ring; dLo++){
        // only the ring's edge after the first pass
        if (ring && Math.abs(dLa) !== ring && Math.abs(dLo) !== ring) continue;
        const la = bLa + dLa;
        let lo = bLo + dLo;
        if (lo < -180) lo += 360; if (lo > 179) lo -= 360;
        const arr = GEO.grid.get((la + 90) * 360 + (lo + 180));
        if (!arr) continue;
        for (const i of arr){
          const km = haversineKm(lat, lon, GEO.lat[i], GEO.lon[i]);
          if (km < bestKm){ bestKm = km; best = i; }
        }
      }
    }
    /* Genuinely search ONE MORE ring after the first hit: a corner of ring N
       can be further away than the near edge of ring N+1, so stopping at the
       hit ring could return the second-nearest place. */
    if (best >= 0){
      if (foundAt == null) foundAt = ring;
      else if (ring > foundAt) break;
    }
  }
  if (best < 0) return null;
  return { name: GEO.names[best], country: GEO.cc[best], km: Math.round(bestKm * 10) / 10 };
}
