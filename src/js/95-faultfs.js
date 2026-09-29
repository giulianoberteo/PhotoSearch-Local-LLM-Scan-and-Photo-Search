
/* ================= fault injection =================
   Every storage test in this suite runs against OPFS, which is fast, local and
   never fails. The conditions that actually break this app are the opposite of
   that: a directory listing that takes 75 seconds, an operation that never
   returns at all, a write that fails once and succeeds on retry.

   None of those were reproducible, and three defects shipped that no number of
   green assertions could have caught -- a 75-second thumbs/ listing on every
   index open, an error that rendered as a blank line, and a config.json write
   on a path that only needed to read.

   faultFS wraps a directory handle so it can be told to be slow, to hang, or to
   fail. Everything it hands back is wrapped too, so one call at the entry point
   covers the whole tree beneath it. It is test-only: nothing in the app calls
   it, and the app never sees a wrapped handle unless a test puts one there.

     const stats = {};
     const slow = faultFS(dir, {
       latencyMs: 250,                  // every operation
       slowPaths: { "thumbs": 75000 },  // the measured listing
       hangPaths: [".photoindex"],      // never resolves
       failWrites: 0.1,                 // fraction of writes that throw
       stats
     });
*/

const FAULT_RAW = Symbol("faultfs.raw");

function faultSleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Operation kinds. Only "write" is eligible for injected failure; "flush"
   (close/abort) takes latency but never fails on its own, so a single logical
   write cannot roll the dice twice and make failWrites mean double what it
   says. */
function faultMatches(list, path){
  if (!list) return false;
  return list.some(p => path.includes(p));
}

async function faultGate(path, kind, cfg){
  const st = cfg.stats;
  st.ops++;
  (st.byKind[kind] = (st.byKind[kind] || 0) + 1);
  st.touched.push(kind + " " + path);

  if (faultMatches(cfg.hangPaths, path)){
    st.hangs++;
    /* The observed NAS behaviour: the call is accepted and simply never comes
       back. Anything that must survive this has to impose its own deadline --
       which is the whole point of asserting against it. */
    await new Promise(() => {});
  }

  let delay = cfg.latencyMs || 0;
  if (cfg.slowPaths)
    for (const key of Object.keys(cfg.slowPaths))
      if (path.includes(key)){ delay += cfg.slowPaths[key]; st.slow++; }
  if (delay > 0) await faultSleep(delay);

  const rate = kind === "write" ? (cfg.failWrites || 0) : (cfg.failReads || 0);
  if (rate > 0 && cfg.rng() < rate){
    st.failures++;
    st.failed.push(kind + " " + path);
    throw cfg.failWith(path, kind);
  }
}

/* A wrapped handle must never be passed back into a real DOM method: the
   browser rejects a Proxy where it expects a FileSystemHandle. */
function faultUnwrap(v){
  return (v && typeof v === "object" && v[FAULT_RAW]) ? v[FAULT_RAW] : v;
}

async function* faultIterate(inner, path, kind, cfg){
  /* Gate once, at the start: the cost of a directory listing is paid when the
     listing is taken, not per entry. This is what models thumbs/ at 75s. */
  await faultGate(path + "/", "list", cfg);
  for await (const item of inner){
    if (kind === "entries") yield [item[0], faultWrap(item[1], path + "/" + item[0], cfg)];
    else if (kind === "values") yield faultWrap(item, path + "/" + (item.name || ""), cfg);
    else yield item;                        // keys(): plain strings
  }
}

function faultWrap(target, path, cfg){
  if (!target || typeof target !== "object") return target;
  return new Proxy(target, {
    get(t, prop){
      if (prop === FAULT_RAW) return t;
      if (prop === "__faultPath") return path;
      const val = Reflect.get(t, prop);
      if (typeof val !== "function") return val;
      /* `for await (const [n, h] of dirHandle)` is the same listing as
         .entries(), and must be gated and wrapped the same way. */
      if (prop === Symbol.asyncIterator)
        return () => faultIterate(val.call(t), path, "entries", cfg);

      switch (prop){
        case "getDirectoryHandle":
        case "getFileHandle":
          return async (name, o) => {
            const child = path + "/" + name;
            await faultGate(child, o && o.create ? "write" : "open", cfg);
            return faultWrap(await val.call(t, name, o), child, cfg);
          };
        case "getFile":
          return async () => { await faultGate(path, "read", cfg); return val.call(t); };
        case "createWritable":
          return async o => {
            await faultGate(path, "write", cfg);
            return faultWrap(await val.call(t, o), path, cfg);
          };
        case "removeEntry":
          return async (name, o) => {
            await faultGate(path + "/" + name, "write", cfg);
            return val.call(t, name, o);
          };
        case "write":
        case "truncate":
        case "seek":
          return async (...a) => {
            await faultGate(path, prop === "seek" ? "flush" : "write", cfg);
            /* A write that reports success having stored only part of what it
               was given. This is the nastiest storage failure of the lot: no
               error is raised anywhere, so the caller carries on believing the
               data is safe. Only checking the resulting length catches it. */
            if (prop === "write" && cfg.shortWrites > 0 && a.length){
              const d = a[0];
              if (typeof d === "string")
                a = [d.slice(0, Math.floor(d.length * (1 - cfg.shortWrites)))];
              else if (d instanceof Blob)
                a = [d.slice(0, Math.floor(d.size * (1 - cfg.shortWrites)))];
            }
            return val.apply(t, a.map(faultUnwrap));
          };
        case "close":
        case "abort":
          return async (...a) => {
            await faultGate(path, "flush", cfg);
            return val.apply(t, a);
          };
        case "entries":
        case "values":
        case "keys":
          return () => faultIterate(val.call(t), path, prop, cfg);
        default:
          return (...a) => val.apply(t, a.map(faultUnwrap));
      }
    }
  });
}

function faultFS(handle, opts){
  const cfg = Object.assign({
    latencyMs: 0,
    slowPaths: null,
    hangPaths: null,
    failWrites: 0,
    failReads: 0,
    shortWrites: 0,   // fraction of each write silently dropped
    rng: Math.random,
    failWith: () => new DOMException("", "NoModificationAllowedError")
  }, opts || {});
  const st = cfg.stats || (cfg.stats = {});
  st.ops = 0; st.slow = 0; st.hangs = 0; st.failures = 0;
  st.byKind = {}; st.touched = []; st.failed = [];
  /* Report helpers, so a test asserts on intent rather than on array indices. */
  st.touchedPath = p => st.touched.some(x => x.includes(p));
  st.countPath = p => st.touched.filter(x => x.includes(p)).length;
  cfg.stats = st;
  return faultWrap(handle, handle.name || "", cfg);
}

/* An rng for cfg.rng that fails the first `n` rolls and then behaves, modelling
   a share that drops a connection and recovers -- the case retries exist for.
   Use with failWrites: 1, which makes every roll decisive:

     faultFS(dir, { failWrites: 1, rng: failFirstWrites(2) })

   Only writes consume rolls while failReads is 0, so `n` counts write attempts. */
function failFirstWrites(n){
  let seen = 0;
  return () => (++seen <= n ? 0 : 1);
}
