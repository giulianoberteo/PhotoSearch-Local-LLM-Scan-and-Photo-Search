
function fnv(str){
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8,"0");
}
/* 32 bits collide around 77k items (birthday bound), which is well inside a real
   photo library, so ids are 64-bit: two independent FNV passes concatenated. */
function fnv64(str){
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < str.length; i++){
    const c = str.charCodeAt(i);
    a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + c) >>> 0; b ^= b << 13; b ^= b >>> 7; b = Math.imul(b, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8,"0") + b.toString(16).padStart(8,"0");
}
const SCHEMA_HASH = () => fnv(JSON.stringify(TPL.schema) + TPL.version);
const PROMPT_HASH = () => fnv(TPL.system + " " + TPL.user);
