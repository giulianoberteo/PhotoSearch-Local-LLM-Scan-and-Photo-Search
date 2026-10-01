
/* ================= timeline =================
   Every record already carries a date, its source, a confidence and a place,
   and until now none of it was browsable: the library could only be queried,
   never looked through. This is the browsing half.

   Grouped by day, newest first, the way a photo library is actually read.
   Nothing here calls a model or re-reads a photo; it is a view over what is
   already in memory. */

const TL = { days: [], years: [], undated: 0, total: 0, built: 0, io: null };

/* The app's own `when` block is authoritative where it exists, because it is
   what every other surface (when_phrase, occasions, events) was derived from.
   Parsing date_taken again here would drift from it by a timezone. */
function tlDayKey(r){
  const w = r.when;
  if (w && w.year && w.month && w.day)
    return [w.year, String(w.month).padStart(2,"0"), String(w.day).padStart(2,"0")].join("-");
  const d = r.date_taken ? new Date(r.date_taken) : null;
  if (!d || isNaN(d)) return null;
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"),
          String(d.getDate()).padStart(2,"0")].join("-");
}

const TL_MONTHS = ["January","February","March","April","May","June","July",
                   "August","September","October","November","December"];
const TL_DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function tlDayLabel(key){
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return TL_DAYS[dt.getDay()] + " " + d + " " + TL_MONTHS[m - 1] + " " + y;
}

/* Builds the whole grouping in one pass. At 6,635 records this is a few
   milliseconds; the expensive part of a timeline is images, not arithmetic. */
function buildTimeline(){
  const byDay = new Map();
  let undated = 0, total = 0;
  for (const r of IDX.records.values()){
    if (r.deleted || r.hidden || r.status === "error") continue;
    total++;
    const key = tlDayKey(r);
    if (!key){ undated++; continue; }
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }
  const days = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))          // newest day first
    .map(([key, recs]) => {
      /* Within a day, order by clock time where it is known. */
      recs.sort((a, b) => (Date.parse(b.date_taken) || 0) - (Date.parse(a.date_taken) || 0));
      const places = [...new Set(recs.map(r => r.place).filter(Boolean))];
      const occasions = [...new Set(recs.flatMap(r =>
        (r.when && r.when.occasions) || []))];
      return { key, recs, places, occasions,
               suspect: recs.filter(r => r.date_suspect).length };
    });

  /* Year and month counts for the scrubber, in the same newest-first order. */
  const years = [];
  for (const d of days){
    const y = +d.key.slice(0, 4), m = +d.key.slice(5, 7);
    let ye = years.find(x => x.year === y);
    if (!ye){ ye = { year:y, count:0, months:[], firstKey:d.key }; years.push(ye); }
    ye.count += d.recs.length;
    let me = ye.months.find(x => x.month === m);
    if (!me){ me = { month:m, count:0, firstKey:d.key }; ye.months.push(me); }
    me.count += d.recs.length;
  }
  TL.days = days; TL.years = years; TL.undated = undated; TL.total = total;
  return TL;
}

/* ---- lazy filling ----
   6,635 thumbnails is 6,635 reads from the share. Only days on screen are
   filled, and a day that scrolls away is emptied again so the thumbnail cache
   stays bounded and its eviction can never revoke a visible image. */
function tlFill(section){
  if (section.dataset.filled === "1") return;
  section.dataset.filled = "1";
  const day = TL.days[+section.dataset.idx];
  if (!day) return;
  const rows = section.querySelector(".tlrows");
  rows.textContent = "";
  const g = el("div", "grid");
  for (const r of day.recs){
    thumbPin(r.id);
    const fig = el("figure");
    const im = el("img");
    im.alt = r.caption || r.name || "";
    im.loading = "lazy";
    applyRotation(im, r);
    thumbUrl(r.id).then(u => { if (u) im.src = u; });
    fig.append(im);
    const bits = [];
    if (r.date_taken) bits.push(r.date_taken.slice(11, 16));
    if (r.place) bits.push(r.place);
    const cap = el("figcaption");
    cap.textContent = bits.join(" · ") || r.name || "";
    if (r.date_suspect){
      const q = el("span", "tlmark", " ?");
      q.title = "This date came from " + (r.date_source || "an uncertain source")
        + " and may be when the file was exported rather than when it was taken.";
      cap.append(q);
    }
    fig.append(cap);
    fig.title = r.caption || r.name || "";
    fig.onclick = () => openLightbox(r);
    g.append(fig);
  }
  rows.append(g);
}

function tlEmpty(section){
  if (section.dataset.filled !== "1") return;
  const day = TL.days[+section.dataset.idx];
  const rows = section.querySelector(".tlrows");
  /* Keep the height so releasing a day does not make the page jump -- and never
     SHRINK it: offsetHeight reads 0 whenever the tab is hidden or layout has
     not run yet, which would throw away the reservation and collapse the page
     under the reader the moment they came back to it. */
  const measured = rows.offsetHeight;
  const reserved = parseInt(rows.style.minHeight, 10) || 0;
  rows.style.minHeight = Math.max(measured, reserved, 64) + "px";
  if (day) for (const r of day.recs) thumbUnpin(r.id);
  rows.textContent = "";
  section.dataset.filled = "0";
}

function tlObserver(){
  if (TL.io) TL.io.disconnect();
  TL.io = new IntersectionObserver(entries => {
    for (const e of entries){
      if (e.isIntersecting) tlFill(e.target); else tlEmpty(e.target);
    }
  }, { root: null, rootMargin: "600px 0px" });   // fill just before it is needed
  return TL.io;
}

function renderTimelineBar(){
  const bar = $("#tlBar");
  bar.textContent = "";
  bar.append(Object.assign(el("span", "hint"),
    { textContent: TL.total.toLocaleString() + " photos" + (TL.days.length
      ? " · " + TL.days.length.toLocaleString() + " days" : "")
      + (TL.undated ? " · " + TL.undated + " undated" : "") }));
  for (const y of TL.years){
    const b = el("button", null, String(y.year));
    b.title = y.count.toLocaleString() + " photos";
    b.onclick = () => tlJump(y.firstKey);
    bar.append(b);
  }
  const jump = el("input");
  jump.type = "date";
  jump.title = "Jump to a date";
  jump.onchange = () => { if (jump.value) tlJump(jump.value, true); };
  bar.append(jump);
}

/* Jumps to a day, or to the nearest day at or before it, so picking a date
   with no photos lands somewhere sensible rather than doing nothing. */
function tlJump(key, nearest){
  let idx = TL.days.findIndex(d => d.key === key);
  if (idx < 0 && nearest) idx = TL.days.findIndex(d => d.key <= key);
  if (idx < 0) idx = TL.days.length - 1;
  const node = $("#tlBody").children[idx];
  if (node) node.scrollIntoView({ block:"start", behavior:"smooth" });
  return idx;
}

function renderTimeline(){
  const body = $("#tlBody");
  body.textContent = "";
  if (!TL.days.length){
    body.append(Object.assign(el("span", "dim"), { textContent: TL.total
      ? "No photos carry a date yet."
      : "Nothing indexed yet — run a scan first." }));
    renderTimelineBar();
    return;
  }
  const io = tlObserver();
  TL.days.forEach((day, i) => {
    const sec = el("section", "tlday");
    sec.dataset.idx = String(i);
    sec.dataset.filled = "0";
    const h = el("h3");
    h.append(document.createTextNode(tlDayLabel(day.key)));
    const bits = [day.recs.length + (day.recs.length === 1 ? " photo" : " photos")];
    if (day.places.length) bits.push(day.places.slice(0, 2).join(", ")
      + (day.places.length > 2 ? " +" + (day.places.length - 2) : ""));
    if (day.occasions.length) bits.push(day.occasions.join(", "));
    if (day.suspect) bits.push(day.suspect + " with an uncertain date");
    h.append(el("span", null, bits.join("  ·  ")));
    sec.append(h);
    const rows = el("div", "tlrows");
    /* Approximate the filled height up front so the scrollbar is honest before
       anything has been filled in. */
    rows.style.minHeight = (Math.ceil(day.recs.length / 8) * 140) + "px";
    sec.append(rows);
    body.append(sec);
    io.observe(sec);
  });
  renderTimelineBar();
}

/* Called from the tab switcher on first view, and again whenever the index has
   changed underneath it. */
let tlLoading = false;
async function onTimelineShown(force){
  if (tlLoading) return;
  if (!force && TL.built && TL.built === IDX.records.size) return;
  tlLoading = true;
  const body = $("#tlBody");
  try {
    if (!IDX.dir || !IDX.loaded){
      body.textContent = "";
      body.append(Object.assign(el("span", "dim"), { textContent: "Opening the index…" }));
      if (!S.dirHandle && !S.indexDirHandle){
        body.textContent = "";
        body.append(Object.assign(el("span", "dim"),
          { textContent: "Connect a folder in Settings first." }));
        return;
      }
      await ensureIndex(null, { write:false });
      await loadRecords();
    }
    buildTimeline();
    TL.built = IDX.records.size;
    renderTimeline();
  } catch (e){
    body.textContent = "";
    body.append(Object.assign(el("div", "note"), { textContent: humanError(e) }));
  } finally { tlLoading = false; }
}
