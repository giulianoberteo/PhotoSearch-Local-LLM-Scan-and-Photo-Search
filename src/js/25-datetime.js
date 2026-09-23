
/* ================= date context: when was this taken ================= */
/* Gregorian Easter (Meeus/Jones/Butcher). Returns a Date at UTC midnight. */
function easterSunday(y){
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
const DAY = 86400000;
const shift = (d, n) => new Date(d.getTime() + n * DAY);
const ymd = d => d.getUTCFullYear() + "-" + String(d.getUTCMonth()+1).padStart(2,"0")
  + "-" + String(d.getUTCDate()).padStart(2,"0");

/* Nth weekday of a month, e.g. nth(2024,10,4,4) = 4th Thursday of November. */
function nthWeekday(y, monthIdx, weekday, n){
  const first = new Date(Date.UTC(y, monthIdx, 1));
  let offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, monthIdx, 1 + offset + (n - 1) * 7));
}
function lastWeekday(y, monthIdx, weekday){
  const last = new Date(Date.UTC(y, monthIdx + 1, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return shift(last, -back);
}

/* Occasions are date ranges. Edit OCCASIONS in Settings to suit your calendar. */
function occasionsFor(year, enabled){
  const E = easterSunday(year);
  const all = [
    { key:"new year",      from: ymd(new Date(Date.UTC(year,0,1))),  to: ymd(new Date(Date.UTC(year,0,2))) },
    { key:"valentines",    from: ymd(new Date(Date.UTC(year,1,14))), to: ymd(new Date(Date.UTC(year,1,14))) },
    { key:"easter",        from: ymd(shift(E,-2)),  to: ymd(shift(E, 1)) },   // Good Friday..Easter Monday
    { key:"holy week",     from: ymd(shift(E,-7)),  to: ymd(shift(E,-3)) },
    { key:"halloween",     from: ymd(new Date(Date.UTC(year,9,31))), to: ymd(new Date(Date.UTC(year,9,31))) },
    { key:"bonfire night", from: ymd(new Date(Date.UTC(year,10,5))), to: ymd(new Date(Date.UTC(year,10,5))) },
    { key:"ferragosto",    from: ymd(new Date(Date.UTC(year,7,15))), to: ymd(new Date(Date.UTC(year,7,15))) },
    { key:"christmas",     from: ymd(new Date(Date.UTC(year,11,24))), to: ymd(new Date(Date.UTC(year,11,26))) },
    { key:"new year's eve",from: ymd(new Date(Date.UTC(year,11,31))), to: ymd(new Date(Date.UTC(year,11,31))) },
    { key:"thanksgiving",  from: ymd(nthWeekday(year,10,4,4)), to: ymd(nthWeekday(year,10,4,4)) },
    { key:"uk spring bank holiday", from: ymd(lastWeekday(year,4,1)), to: ymd(lastWeekday(year,4,1)) },
  ];
  return all.filter(o => !enabled || enabled.includes(o.key));
}

const SEASONS_N = [["winter",12],["spring",3],["summer",6],["autumn",9]];
function seasonOf(month, hemisphere){
  const n = month >= 3 && month <= 5 ? "spring"
          : month >= 6 && month <= 8 ? "summer"
          : month >= 9 && month <= 11 ? "autumn" : "winter";
  if (hemisphere !== "south") return n;
  return { spring:"autumn", summer:"winter", autumn:"spring", winter:"summer" }[n];
}
function partOfDay(h){
  if (h < 5) return "night";
  if (h < 8) return "dawn";
  if (h < 12) return "morning";
  if (h < 14) return "midday";
  if (h < 17) return "afternoon";
  if (h < 20) return "evening";
  return "night";
}
const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MONTHS = ["january","february","march","april","may","june",
                "july","august","september","october","november","december"];

/* Derives the searchable time context for one photo. Local time, not UTC:
   a photo taken at 23:00 belongs to that evening, not the next UTC day. */
function dateContext(iso, opts){
  opts = opts || {};
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  const key = y + "-" + String(m).padStart(2,"0") + "-" + String(day).padStart(2,"0");
  const occ = [];
  for (const o of occasionsFor(y, opts.occasions))
    if (key >= o.from && key <= o.to) occ.push(o.key);
  // A late-December photo can also belong to the next year's new-year window.
  if (m === 1 && day <= 2) occ.push("new year");
  const dow = d.getDay();
  return {
    year:y, month:m, month_name:MONTHS[m-1], day,
    weekday:WEEKDAYS[dow], is_weekend: dow === 0 || dow === 6,
    hour:d.getHours(), part_of_day: partOfDay(d.getHours()),
    season: seasonOf(m, opts.hemisphere),
    decade: Math.floor(y / 10) * 10 + "s",
    occasions: [...new Set(occ)],
    date_key: key
  };
}
/* Short human phrase used in the embedding document and chat answers. */
function datePhrase(ctx){
  if (!ctx) return "";
  const bits = [ctx.part_of_day, ctx.weekday, ctx.month_name + " " + ctx.year, ctx.season];
  if (ctx.occasions.length) bits.push(ctx.occasions.join(" "));
  return bits.join(", ");
}
