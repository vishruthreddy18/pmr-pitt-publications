// Static front end: downloads the synced JSON once, then does all
// filtering, searching, sorting and pagination in the browser.
// No Scopus calls happen here.

const ALL = "ALL";
const SORTS = ["newest", "oldest", "cited"];
const SIZES = [5, 10, 20];

let publications = [];
let facultyNames = [];
const state = { author: ALL, q: "", sort: "newest", size: 10, page: 1 };

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

// ---------------------------------------------------------------- theme
// The <head> script sets data-theme before first paint; this wires the toggle.

function wireThemeToggle() {
  const btn = $("theme-toggle");
  const current = () =>
    document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const label = () => {
    const next = current() === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  };
  btn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) { /* storage blocked: still works for this visit */ }
    label();
  });
  label();
}

// ---------------------------------------------------------------- startup

async function init() {
  wireThemeToggle();
  readUrl();
  try {
    // Relative URLs so the same files work on GitHub Pages and Render.
    const [pubs, meta] = await Promise.all([
      fetch("data/publications.json").then(checkOk),
      fetch("data/meta.json").then(checkOk),
    ]);
    publications = pubs;
    // Lowercased text used by the search box, built once.
    publications.forEach((p) => {
      p._search = [p.title, p.journal, p.first_author, p.faculty.join(" "), p.doi].join(" ").toLowerCase();
    });
    facultyNames = [...meta.authors].sort((a, b) => a.localeCompare(b));
    buildDropdown();
    showUpdated(meta.last_updated);
  } catch (err) {
    $("summary").textContent = "Sorry, the publication list could not be loaded. Please try again later.";
    console.error(err);
    return;
  }
  wireControls();
  render();
}

function checkOk(res) {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`);
  return res.json();
}

function buildDropdown() {
  const select = $("author");
  select.innerHTML = "";
  select.append(new Option("All Authors", ALL));
  facultyNames.forEach((name) => select.append(new Option(name, name)));

  if (!facultyNames.includes(state.author)) state.author = ALL;
  select.value = state.author;
  select.disabled = false;
}

function showUpdated(iso) {
  if (!iso) return;
  $("stat-updated").textContent = new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

// ---------------------------------------------------------------- URL params
// e.g. ?author=Dicianno, Brad&sort=cited&size=10&page=2&q=spina

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.author = p.get("author") || ALL;
  state.q = p.get("q") || "";
  state.sort = SORTS.includes(p.get("sort")) ? p.get("sort") : "newest";
  state.size = SIZES.includes(Number(p.get("size"))) ? Number(p.get("size")) : 10;
  state.page = Math.max(1, parseInt(p.get("page"), 10) || 1);
  $("search").value = state.q;
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.author !== ALL) p.set("author", state.author);
  if (state.q) p.set("q", state.q);
  if (state.sort !== "newest") p.set("sort", state.sort);
  if (state.size !== 10) p.set("size", state.size);
  if (state.page > 1) p.set("page", state.page);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------- controls

function wireControls() {
  $("author").addEventListener("change", (e) => {
    state.author = e.target.value;
    state.page = 1;
    render();
  });

  let timer;
  $("search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.page = 1;
      render();
    }, 150);
  });

  document.querySelectorAll("[data-sort]").forEach((b) =>
    b.addEventListener("click", () => { state.sort = b.dataset.sort; state.page = 1; render(); }));
  document.querySelectorAll("[data-size]").forEach((b) =>
    b.addEventListener("click", () => { state.size = Number(b.dataset.size); state.page = 1; render(); }));

  // Pager buttons are rebuilt on every render, so use one delegated listener.
  $("pager").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-goto]");
    if (!b || b.disabled) return;
    state.page = Number(b.dataset.goto);
    render();
    $("summary").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---------------------------------------------------------------- data

function currentList() {
  let list = state.author === ALL
    ? publications.slice()
    : publications.filter((p) => p.faculty.includes(state.author));

  if (state.q) {
    const words = state.q.toLowerCase().split(/\s+/);
    list = list.filter((p) => words.every((w) => p._search.includes(w)));
  }

  const byDate = (a, b) => a.date.localeCompare(b.date);
  if (state.sort === "newest") list.sort((a, b) => byDate(b, a));
  else if (state.sort === "oldest") list.sort(byDate);
  else list.sort((a, b) => b.citations - a.citations || byDate(b, a));
  return list;
}

// ---------------------------------------------------------------- render

function render() {
  const list = currentList();
  const pages = Math.max(1, Math.ceil(list.length / state.size));
  state.page = Math.min(Math.max(1, state.page), pages);
  writeUrl();

  const start = (state.page - 1) * state.size;
  const pageItems = list.slice(start, start + state.size);

  renderStats(list);

  document.querySelectorAll("[data-sort]").forEach((b) => setActive(b, b.dataset.sort === state.sort));
  document.querySelectorAll("[data-size]").forEach((b) => setActive(b, Number(b.dataset.size) === state.size));

  $("summary").textContent = list.length
    ? `Showing ${fmt(start + 1)}–${fmt(start + pageItems.length)} of ${fmt(list.length)} publications`
    : "";

  const results = $("results");
  results.innerHTML = "";
  if (!list.length) {
    const li = el("li", "empty", state.q ? `No publications match “${state.q}”.` : "No publications found.");
    results.append(li);
  }
  pageItems.forEach((p) => results.append(renderItem(p)));

  renderPager(pages);
}

function setActive(button, on) {
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", on);
}

function renderStats(list) {
  $("stat-pubs").textContent = fmt(list.length);
  $("stat-cites").textContent = fmt(list.reduce((sum, p) => sum + p.citations, 0));
  if (state.author === ALL) {
    $("stat-faculty").textContent = facultyNames.length;
    $("stat-faculty-label").textContent = "Faculty";
  } else {
    // For one person, show how many other PM&R faculty they've published with.
    const coauthors = new Set();
    list.forEach((p) => p.faculty.forEach((f) => f !== state.author && coauthors.add(f)));
    $("stat-faculty").textContent = coauthors.size;
    $("stat-faculty-label").textContent = "PM&R Collaborators";
  }
}

// Built with textContent (never innerHTML) so titles can't inject markup.
function renderItem(p) {
  const li = el("li", "pub");

  const head = el("div", "pub-head");
  const a = el("a", "pub-title", p.title);
  a.href = p.link;
  a.target = "_blank";
  a.rel = "noopener";
  const cites = el("div", "cites");
  cites.append(el("b", null, fmt(p.citations)), el("span", null, p.citations === 1 ? "citation" : "citations"));
  head.append(a, cites);

  const source = el("div", "pub-source");
  if (p.journal) source.append(el("i", null, p.journal), " · ");
  source.append(String(p.year ?? ""));
  if (p.type) source.append(el("span", "chip", p.type));

  li.append(head, source, metaLine("Primary Author: ", el("b", null, p.first_author)));
  li.append(metaLine("PM&R Faculty: ", el("b", null, p.faculty.join(" · "))));
  if (p.doi) {
    const doi = el("a", null, p.doi);
    doi.href = `https://doi.org/${p.doi}`;
    doi.target = "_blank";
    doi.rel = "noopener";
    li.append(metaLine("DOI: ", doi));
  }
  return li;
}

function renderPager(pages) {
  const pager = $("pager");
  pager.innerHTML = "";
  pager.hidden = pages <= 1;
  if (pages <= 1) return;

  const btn = (label, page, { disabled = false, active = false, aria, cls } = {}) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.dataset.goto = page;
    b.disabled = disabled;
    if (active) { b.classList.add("active"); b.setAttribute("aria-current", "page"); }
    if (aria) b.setAttribute("aria-label", aria);
    return b;
  };

  const cur = state.page;
  // Arrows only appear when there's somewhere to go in that direction.
  if (cur > 1) {
    pager.append(
      btn("«", 1, { aria: "First page" }),
      btn("‹", cur - 1, { aria: "Previous page" }),
    );
  }
  pageNumbers(cur, pages).forEach((n) =>
    pager.append(n === "…" ? el("span", null, "…") : btn(String(n), n, { active: n === cur, cls: "num", aria: `Page ${n}` })));
  if (cur < pages) {
    pager.append(
      btn("›", cur + 1, { aria: "Next page" }),
      btn("»", pages, { aria: "Last page" }),
    );
  }
}

// 1 … 4 5 6 … 18
function pageNumbers(cur, total) {
  const keep = new Set([1, total, cur - 1, cur, cur + 1].filter((n) => n >= 1 && n <= total));
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((n, i) => {
    if (i && n - sorted[i - 1] > 1) out.push("…");
    out.push(n);
  });
  return out;
}

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function metaLine(label, valueEl) {
  const div = el("div", "meta");
  div.append(label, valueEl);
  return div;
}

init();
