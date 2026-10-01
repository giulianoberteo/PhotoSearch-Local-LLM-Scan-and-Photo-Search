/* Direct retrieval never needs the chat model. Filters are visible and results
   are paginated, so a family album does not quietly stop at twelve photos. */
const SEARCH_UI = { request:0, abort:null, offset:0, pinned:[], filters:null };

function renderSearchPeople(){
  const host = $("#photoPeople");
  const selected = new Set([...host.querySelectorAll("input:checked")].map(x => x.value));
  host.textContent = "";
  for (const p of FACES.people.filter(p => p.name).sort((a,b) => a.name.localeCompare(b.name))){
    const label = el("label", "switch");
    const input = el("input"); input.type = "checkbox"; input.value = p.id;
    input.checked = selected.has(p.id);
    label.append(input, document.createTextNode(p.name)); host.append(label);
  }
  if (!host.children.length) host.append(el("span", "hint", "Name a group in People to search for someone."));
}

async function openSearchIndex(){
  if (!IDX.loaded){
    if (!(await ensureIndexConnected()) || !(await ensureConnected("photo search")))
      throw new Error("Connect your photo index in Settings to search it.");
    await indexOp("opening photo search", async () => {
      await ensureIndex(null, { write:false });
      await loadRecords(); await loadVectors(); await ensureFaceNames();
      rebuildDerived();
    }, { cost:8 });
  } else await ensureFaceNames();
}
async function onSearchShown(){
  renderSearchPeople();
  $("#photoQuery").focus();
}
function clearSearchResults(){
  for (const id of SEARCH_UI.pinned) thumbUnpin(id);
  SEARCH_UI.pinned = [];
  $("#photoSearchResults").textContent = "";
  $("#photoSearchPages").textContent = "";
}
async function submitPhotoSearch(offset = 0){
  const request = ++SEARCH_UI.request;
  if (SEARCH_UI.abort) SEARCH_UI.abort.abort();
  const abort = new AbortController(); SEARCH_UI.abort = abort;
  const status = $("#photoSearchStatus");
  status.textContent = "Opening your index…";
  clearSearchResults();
  $("#photoSearchApplied").textContent = "";
  $("#photoSearchDetails").hidden = true;
  try {
    await openSearchIndex();
    if (request !== SEARCH_UI.request) return;
    renderSearchPeople();
    const filters = offset && SEARCH_UI.filters ? SEARCH_UI.filters : {
      query:$("#photoQuery").value.trim(), place:$("#photoPlace").value.trim(),
      date_from:$("#photoFrom").value, date_to:$("#photoTo").value,
      person_ids:[...$("#photoPeople").querySelectorAll("input:checked")].map(x => x.value),
      semantic:$("#photoSemantic").checked, interpret_people:$("#photoInterpret").checked
    };
    if (filters.date_from && filters.date_to && filters.date_from > filters.date_to)
      throw new Error("The From date must be on or before the To date.");
    SEARCH_UI.filters = filters;
    status.textContent = "Searching…";
    const result = await searchPhotos({ ...filters, offset, limit:60, signal:abort.signal });
    if (request !== SEARCH_UI.request) return;
    const applied = [...result.applied];
    if (filters.place) applied.push("Place: " + filters.place);
    if (filters.date_from) applied.push("From " + filters.date_from);
    if (filters.date_to) applied.push("To " + filters.date_to);
    for (const label of applied) $("#photoSearchApplied").append(el("span", "pill", label));
    status.textContent = result.total ? result.total.toLocaleString() + " matching photos"
      : "No photos match. Try fewer filters, another word, or review the person's group in People.";
    if (result.results.length){
      const records = result.results.map(x => x.rec);
      SEARCH_UI.pinned = records.map(r => r.id);
      renderGrid($("#photoSearchResults"), records);
    }
    const pages = $("#photoSearchPages");
    if (result.total){
      const prev = el("button", "btn sec", "Previous"); prev.disabled = !offset;
      prev.onclick = () => submitPhotoSearch(Math.max(0, offset - 60));
      const next = el("button", "btn sec", "Next"); next.disabled = offset + 60 >= result.total;
      next.onclick = () => submitPhotoSearch(offset + 60);
      pages.append(prev, el("span", "hint", (offset + 1) + "–"
        + (offset + result.results.length) + " of " + result.total), next);
    }
    $("#photoSearchHow").textContent = result.used.join(". ");
    $("#photoSearchDetails").hidden = false;
  } catch (e){
    if (request === SEARCH_UI.request) status.textContent = "Could not search: " + errText(e);
  }
}
$("#photoSearchForm").onsubmit = e => { e.preventDefault(); submitPhotoSearch(); };
$("#photoSearchClear").onclick = () => {
  ++SEARCH_UI.request; if (SEARCH_UI.abort) SEARCH_UI.abort.abort();
  $("#photoSearchForm").reset();
  for (const input of $("#photoPeople").querySelectorAll("input")) input.checked = false;
  SEARCH_UI.filters = null; clearSearchResults();
  $("#photoSearchApplied").textContent = "";
  $("#photoSearchStatus").textContent = "Filters cleared. Search again to browse your photos.";
  $("#photoSearchDetails").hidden = true;
  $("#photoQuery").focus();
};
