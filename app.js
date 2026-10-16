"use strict";

// ---------- Konfiguration ----------

// Sprachaufnahmen der Meditation. Weitere Stimmen einfach hier ergänzen,
// dann erscheint in den Einstellungen eine Auswahl.
const VOICES = [
  { id: "standard", name: "Standard", file: "audio/meditation.mp3" },
];
const MUSIC_FILE = "audio/musik.mp3";

// gemini-3.8-flash ist im Gratis-Tarif oft überlastet (HTTP 503), 3.6 antwortet zuverlässig.
const DEFAULT_MODEL = "gemini-3.6-flash";
const OVERLOADED_MODELS = ["gemini-3.8-flash"];
const GEMINI_TIMEOUT_MS = 20000;
const VOICE_DELAY_MS = 8000;      // Erst Musik, dann setzt die Stimme ein
const SILENT_MED_SECONDS = 300;   // Meditation, falls die Sprachdatei fehlt
const MUSIC_TAIL_SECONDS = 75;    // Musik wird nach „Gute Nacht“ über so viele Sekunden ausgeblendet
const INHALE = 4000;
const EXHALE = 6000;

const SORT_PROMPT = `Du hilfst einem Menschen abends beim Kopf-Leeren vor dem Schlafen.
Du bekommst einen ungefilterten Gedankenstrom. Zerlege ihn in einzelne Gedanken und lege jeden in genau einen Stapel:

- morgen: konkrete Dinge, die die Person morgen oder bald tun kann. Als kurze, machbare Aufgabe formulieren, z. B. "Mama zurückrufen" oder "Folien für Präsentation fertig machen".
- nicht_heute: Sorgen und Themen, auf die die Person heute Abend keinen Einfluss hat. Kurz und neutral benennen, ohne zu dramatisieren.
- nur_gedanke: Grübeleien, Bewertungen, Erinnerungen und Fragmente, die einfach gehen dürfen.

Regeln:
- Aufzählungen, die mit Kommas, Punkten oder "und" verbunden sind, enthalten fast immer mehrere Gedanken. Trenne sie in einzelne Einträge.
- Jeder Eintrag höchstens etwa 10 Wörter, in der Sprache der Person, aus ihrer Sicht formuliert (nicht "du").
- Nichts erfinden und nichts weglassen, was inhaltlich gemeint war. Doppeltes zusammenfassen.
- Ein leerer Stapel ist in Ordnung.
- zuspruch: genau ein warmer, ruhiger Satz an die Person (Du-Form, höchstens 20 Wörter), der anerkennt, was heute im Kopf war. Keine Ratschläge, keine Floskeln.
- Wenn der Text auf eine akute Krise, Suizidgedanken oder Selbstverletzung hindeutet: Der zuspruch sagt sanft, dass die Person nicht allein ist, und nennt die TelefonSeelsorge (0800 111 0 111, kostenlos, rund um die Uhr).`;

const PILES = {
  morgen: "Morgen erledigen",
  nicht: "Nicht heute Abend",
  gedanke: "Darf gehen",
};

// ---------- Speicher (nur dieser Browser) ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem("abendritual." + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("abendritual." + key, JSON.stringify(value));
    } catch {
      /* Speicher nicht verfügbar – App läuft trotzdem */
    }
  },
  remove(key) {
    try { localStorage.removeItem("abendritual." + key); } catch { /* egal */ }
  },
};

// Optional: Schlüssel aus config.local.js (wird nie hochgeladen, siehe .gitignore)
const LOCAL_KEY = window.LOCAL_CONFIG?.geminiKey?.trim() ?? "";

function settings() {
  const s = {
    sortmode: "ki",
    key: "",
    model: DEFAULT_MODEL,
    voice: VOICES[0].id,
    music: 35,
    ...store.get("settings", {}),
  };
  if (!s.key) s.key = LOCAL_KEY;
  if (!s.model || OVERLOADED_MODELS.includes(s.model)) s.model = DEFAULT_MODEL;
  return s;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- Helfer ----------

const $ = (sel) => document.querySelector(sel);
const timers = new Set();

function later(fn, ms) {
  const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
  return id;
}
function clearTimers() {
  timers.forEach(clearTimeout);
  timers.clear();
}

const STEP = { start: 0, settings: 0, momente: 0, ablegen: 1, sortieren: 2, moment: 3, meditation: 4, ende: 5 };

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  document.body.dataset.step = STEP[id] ?? 0;
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

const uuid = () =>
  crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );

// ---------- Daten: im Konto (Supabase) oder nur in diesem Browser ----------
//
// Ohne Anmeldung liegt alles im localStorage ("aufgaben", "momente").
// Mit Anmeldung liegt alles in Supabase; lokal bleibt nur eine Kopie ("cache.*"),
// damit die App auch ohne Netz etwas zeigen kann. Schreibvorgänge, die offline
// nicht durchgehen, landen in der "warteschlange" und werden später nachgereicht.

const APP = window.APP_CONFIG ?? {};
const sbConfigured = Boolean(APP.supabaseUrl && APP.supabaseAnonKey);
const sb = sbConfigured && window.supabase
  ? window.supabase.createClient(APP.supabaseUrl, APP.supabaseAnonKey)
  : null;
let user = null;

// Angemeldet – oder angemeldet gewesen, aber Supabase gerade nicht ladbar (offline).
const remote = () => Boolean(user) || Boolean(sbConfigured && !sb && store.get("konto", null));
const online = () => Boolean(sb && user);
const localKey = (name) => (remote() ? "cache." : "") + name;

const DAY_MS = 24 * 60 * 60 * 1000;

// Unerledigtes plus alles, was in den letzten 24 Stunden abgehakt wurde.
function visibleAufgaben(rows) {
  const since = Date.now() - DAY_MS;
  return rows
    .filter((r) => !r.erledigt || (r.erledigt_am && Date.parse(r.erledigt_am) > since))
    .sort((a, b) => a.erstellt_am.localeCompare(b.erstellt_am));
}

function upsertLocal(name, rows) {
  const list = store.get(localKey(name), []);
  for (const row of rows) {
    const i = list.findIndex((x) => x.id === row.id);
    if (i >= 0) list[i] = row;
    else list.push(row);
  }
  store.set(localKey(name), list);
}

function queuedRows(table) {
  return store.get("warteschlange", []).filter((j) => j.table === table).flatMap((j) => j.rows);
}

// Server-Daten plus noch nicht übertragene Zeilen (die gewinnen).
function withQueued(table, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of queuedRows(table)) byId.set(r.id, r);
  return [...byId.values()];
}

async function pushRows(table, rows) {
  if (!remote()) return;
  if (online()) {
    try {
      const { error } = await sb.from(table).upsert(rows);
      if (!error) return;
    } catch {
      /* unten in die Warteschlange */
    }
  }
  store.set("warteschlange", [...store.get("warteschlange", []), { table, rows }]);
  toast("Gerade keine Verbindung. Wird beim nächsten Mal gespeichert.");
}

async function flushQueue() {
  if (!online()) return;
  const rest = [];
  for (const job of store.get("warteschlange", [])) {
    try {
      const { error } = await sb.from(job.table).upsert(job.rows);
      if (error) rest.push(job);
    } catch {
      rest.push(job);
    }
  }
  store.set("warteschlange", rest);
}

const data = {
  async aufgaben() {
    if (online()) {
      try {
        const since = new Date(Date.now() - DAY_MS).toISOString();
        const { data: rows, error } = await sb
          .from("aufgaben")
          .select("id,text,erledigt,erledigt_am,erstellt_am")
          .or(`erledigt.eq.false,erledigt_am.gt.${since}`)
          .order("erstellt_am");
        if (error) throw error;
        const all = withQueued("aufgaben", rows);
        store.set(localKey("aufgaben"), all);
        return visibleAufgaben(all);
      } catch {
        /* offline: lokale Kopie zeigen */
      }
    }
    return visibleAufgaben(store.get(localKey("aufgaben"), []));
  },

  async addAufgaben(texte) {
    const now = new Date().toISOString();
    const rows = texte.map((text) => ({ id: uuid(), text, erledigt: false, erledigt_am: null, erstellt_am: now }));
    upsertLocal("aufgaben", rows);
    await pushRows("aufgaben", rows);
  },

  async setErledigt(row, erledigt) {
    const next = { ...row, erledigt, erledigt_am: erledigt ? new Date().toISOString() : null };
    upsertLocal("aufgaben", [next]);
    await pushRows("aufgaben", [next]);
    return next;
  },

  async clearAufgaben() {
    if (online()) {
      const { error } = await sb.from("aufgaben").delete().eq("user_id", user.id);
      if (error) throw error;
      store.set("warteschlange", store.get("warteschlange", []).filter((j) => j.table !== "aufgaben"));
    } else if (remote()) {
      throw new Error("offline");
    }
    store.set(localKey("aufgaben"), []);
  },

  async addMoment(text) {
    const row = { id: uuid(), datum: today(), text, erstellt_am: new Date().toISOString() };
    upsertLocal("momente", [row]);
    await pushRows("momente", [row]);
  },

  async momente() {
    const sorted = (rows) =>
      [...rows].sort((a, b) => b.datum.localeCompare(a.datum) || b.erstellt_am.localeCompare(a.erstellt_am));
    if (online()) {
      try {
        const { data: rows, error } = await sb.from("momente").select("id,datum,text,erstellt_am");
        if (error) throw error;
        const all = withQueued("momente", rows);
        store.set(localKey("momente"), all);
        return sorted(all);
      } catch {
        /* offline: lokale Kopie zeigen */
      }
    }
    return sorted(store.get(localKey("momente"), []));
  },

  async deleteMoment(id) {
    if (online()) {
      const { error } = await sb.from("momente").delete().eq("id", id);
      if (error) throw error;
    } else if (remote()) {
      throw new Error("offline");
    }
    store.set(localKey("momente"), store.get(localKey("momente"), []).filter((m) => m.id !== id));
  },

  async wipe() {
    if (online()) {
      for (const table of ["aufgaben", "momente"]) {
        const { error } = await sb.from(table).delete().eq("user_id", user.id);
        if (error) throw error;
      }
      store.remove("warteschlange");
    } else if (remote()) {
      throw new Error("offline");
    }
    store.remove(localKey("aufgaben"));
    store.remove(localKey("momente"));
  },
};

// Ältere Version speicherte { datum, items } bzw. Momente ohne id – einmalig umwandeln.
(function migrateOldFormat() {
  const old = store.get("liste", null);
  if (old?.items) {
    const at = new Date(old.datum + "T20:00").toISOString();
    const rows = old.items.map((i) => ({
      id: uuid(),
      text: i.text,
      erledigt: Boolean(i.done),
      erledigt_am: i.done ? new Date().toISOString() : null,
      erstellt_am: at,
    }));
    store.set("aufgaben", [...store.get("aufgaben", []), ...rows]);
    store.remove("liste");
  }
  const momente = store.get("momente", []);
  if (momente.some((m) => !m.id)) {
    store.set(
      "momente",
      momente.map((m) => (m.id ? m : { id: uuid(), erstellt_am: new Date(m.datum + "T21:00").toISOString(), ...m })),
    );
  }
})();

// ---------- Konto ----------

// Nach der Anmeldung: was bisher nur im Browser lag, ins Konto übertragen.
async function uploadLocal() {
  for (const table of ["aufgaben", "momente"]) {
    const rows = store.get(table, []);
    if (!rows.length) continue;
    try {
      const { error } = await sb.from(table).upsert(rows);
      if (!error) store.remove(table);
    } catch {
      /* beim nächsten Anmelden erneut */
    }
  }
}

function renderAccount() {
  $("#acc-off").hidden = sbConfigured;
  $("#acc-login").hidden = !sb || Boolean(user);
  $("#acc-in").hidden = !user;
  if (user) $("#acc-who").textContent = user.email;
  if (sbConfigured && !sb) $("#acc-msg").textContent = "Das Konto ist gerade nicht erreichbar. Prüf deine Internetverbindung.";
  $("#storage-note").textContent = remote()
    ? "Liste und gute Momente liegen in deinem Konto. Einstellungen und Gemini-Schlüssel bleiben in diesem Browser."
    : "Alles wird nur in diesem Browser gespeichert.";
  $("#wipe").textContent = remote()
    ? "Liste und gute Momente im Konto löschen"
    : "Liste und gute Momente löschen";
}

if (sb) {
  sb.auth.onAuthStateChange((_event, session) => {
    const before = user?.id;
    user = session?.user ?? null;
    // Keine Supabase-Aufrufe direkt im Callback (kann sonst hängen) – kurz danach.
    setTimeout(async () => {
      if (user && user.id !== before) {
        store.set("konto", user.email);
        await uploadLocal();
        await flushQueue();
      }
      renderAccount();
      renderHome();
    }, 0);
  });
}

// Anmelden mit E-Mail und Passwort (kein Mail-Versand nötig).
function credentials() {
  const email = $("#acc-email").value.trim();
  const password = $("#acc-password").value;
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    $("#acc-msg").textContent = "Bitte gib eine gültige E-Mail-Adresse ein.";
    return null;
  }
  if (password.length < 6) {
    $("#acc-msg").textContent = "Das Passwort braucht mindestens 6 Zeichen.";
    return null;
  }
  return { email, password };
}

function authErrorText(err) {
  const code = err?.code ?? "";
  if (err?.status === 429 || code === "over_request_rate_limit") {
    return "Zu viele Versuche. Warte ein paar Minuten und probier es dann noch einmal.";
  }
  switch (code) {
    case "invalid_credentials":
      return "E-Mail oder Passwort stimmt nicht.";
    case "email_not_confirmed":
      return "Dieses Konto ist noch nicht bestätigt. Öffne den Link in der Mail von Supabase und melde dich dann an.";
    case "user_already_exists":
    case "email_exists":
      return "Für diese E-Mail gibt es schon ein Konto. Tipp auf „Anmelden“.";
    case "weak_password":
      return "Das Passwort ist zu schwach. Nimm ein längeres.";
    case "signup_disabled":
      return "Neue Konten sind gerade nicht erlaubt.";
  }
  return err instanceof TypeError || err?.name === "AuthRetryableFetchError"
    ? "Keine Verbindung zum Konto. Prüf dein Internet."
    : "Das hat nicht geklappt" + (err?.message ? `: ${err.message}` : ".");
}

async function withAuthButtons(action) {
  const buttons = [$("#acc-signin"), $("#acc-signup")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await action();
  } catch (err) {
    $("#acc-msg").textContent = authErrorText(err);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$("#acc-signin").addEventListener("click", () =>
  withAuthButtons(async () => {
    const c = credentials();
    if (!c) return;
    $("#acc-msg").textContent = "Einen Moment …";
    const { error } = await sb.auth.signInWithPassword(c);
    if (error) throw error;
    $("#acc-password").value = "";
    $("#acc-msg").textContent = "Angemeldet. Deine Liste und deine guten Momente werden jetzt im Konto gespeichert.";
  }),
);

$("#acc-signup").addEventListener("click", () =>
  withAuthButtons(async () => {
    const c = credentials();
    if (!c) return;
    $("#acc-msg").textContent = "Konto wird erstellt …";
    const { data: res, error } = await sb.auth.signUp(c);
    if (error) throw error;
    // Supabase meldet eine schon vergebene Adresse teils ohne Fehler, aber ohne Identitäten.
    if (res.user && res.user.identities?.length === 0) throw { code: "user_already_exists" };
    $("#acc-password").value = "";
    $("#acc-msg").textContent = res.session
      ? "Konto erstellt und angemeldet. Deine Liste und deine guten Momente werden jetzt im Konto gespeichert."
      : "Konto erstellt. Bestätige es über den Link in der Mail von Supabase und melde dich dann hier an.";
  }),
);

$("#acc-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#acc-signin").click();
});

$("#acc-logout").addEventListener("click", async () => {
  await flushQueue();
  if (store.get("warteschlange", []).length &&
      !confirm("Ein paar Einträge sind noch nicht im Konto gespeichert, weil keine Verbindung besteht. Trotzdem abmelden? Sie gehen dann verloren.")) {
    return;
  }
  await sb.auth.signOut().catch(() => {});
  user = null;
  ["konto", "warteschlange", "cache.aufgaben", "cache.momente"].forEach((k) => store.remove(k));
  $("#acc-msg").textContent = "Abgemeldet.";
  renderAccount();
  renderHome();
});

// ---------- Start ----------

let homeRun = 0;

async function renderHome() {
  const h = new Date().getHours();
  $("#start-title").textContent =
    h < 5 ? "Noch wach?" : h < 11 ? "Guten Morgen" : h < 17 ? "Hallo" : "Guten Abend";

  const run = ++homeRun;
  const rows = await data.aufgaben();
  if (run !== homeRun) return; // inzwischen neu gerendert

  const box = $("#today-list");
  const ul = $("#today-items");
  ul.replaceChildren();

  if (!rows.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const fromEarlier = rows.some((r) => new Date(r.erstellt_am).toDateString() !== new Date().toDateString());
  $("#today-title").textContent = fromEarlier ? "Für heute" : "Liegt für morgen bereit";

  for (let row of rows) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    const span = document.createElement("span");
    cb.type = "checkbox";
    cb.checked = row.erledigt;
    span.textContent = row.text;
    label.classList.toggle("done", row.erledigt);
    cb.addEventListener("change", async () => {
      label.classList.toggle("done", cb.checked);
      row = await data.setErledigt(row, cb.checked);
    });
    label.append(cb, span);
    li.append(label);
    ul.append(li);
  }
}

$("#today-clear").addEventListener("click", async () => {
  try {
    await data.clearAufgaben();
  } catch {
    toast("Die Liste konnte gerade nicht geleert werden. Prüf deine Verbindung.");
  }
  renderHome();
});

// ---------- Gute Momente ----------

$("#open-momente").addEventListener("click", async () => {
  show("momente");
  $("#momente-list").replaceChildren();
  $("#momente-empty").hidden = true;
  $("#momente-loading").hidden = false;
  const rows = await data.momente();
  $("#momente-loading").hidden = true;
  renderMomente(rows);
});

function renderMomente(rows) {
  const box = $("#momente-list");
  box.replaceChildren();
  $("#momente-empty").hidden = rows.length > 0;

  let month = null;
  let ul = null;
  for (const m of rows) {
    const day = new Date(m.datum + "T12:00");
    const label = day.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
    if (label !== month) {
      month = label;
      const h = document.createElement("h3");
      h.className = "month";
      h.textContent = label;
      ul = document.createElement("ul");
      ul.className = "moments";
      box.append(h, ul);
    }

    const li = document.createElement("li");
    li.className = "moment-item";

    const text = document.createElement("button");
    text.type = "button";
    text.className = "moment-text";
    text.textContent = m.text;
    text.setAttribute("aria-expanded", "false");
    text.addEventListener("click", () => {
      text.setAttribute("aria-expanded", String(li.classList.toggle("open")));
    });

    const date = document.createElement("p");
    date.className = "moment-date";
    date.textContent = day.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "link danger moment-delete";
    del.textContent = "Löschen";
    del.addEventListener("click", async () => {
      if (!confirm("Diesen Moment löschen?")) return;
      try {
        await data.deleteMoment(m.id);
        renderMomente(rows.filter((r) => r.id !== m.id));
      } catch {
        toast("Der Moment konnte gerade nicht gelöscht werden. Prüf deine Verbindung.");
      }
    });

    li.append(text, date, del);
    ul.append(li);
  }
}

$("#begin").addEventListener("click", startWriting);

document.querySelectorAll("[data-back]").forEach((b) =>
  b.addEventListener("click", () => {
    clearTimers();
    renderHome();
    show(b.dataset.back);
  }),
);

// ---------- 1 Ablegen ----------

function startWriting() {
  const brain = $("#brain");
  brain.value = "";
  $("#brain-done").disabled = true;
  show("ablegen");
  brain.focus();
}

$("#brain").addEventListener("input", (e) => {
  $("#brain-done").disabled = !e.target.value.trim();
});

$("#brain-done").addEventListener("click", () => {
  startSorting($("#brain").value.trim());
});

// ---------- 2 Sortieren ----------

let thoughts = [];
let rawText = "";

// Trennt an Zeilenumbrüchen, Kommas, Punkten, Semikolons, ! und ?.
// Kommas und Punkte zwischen Ziffern (3,5 oder 14.30) bleiben stehen.
function splitThoughts(text) {
  return text
    .split(/\n+|[;!?…]+|(?<!\d)[.,](?!\d)/)
    .map((s) => s.replace(/^[-*•\s]+/, "").trim())
    .filter((s) => s.length > 1)
    .slice(0, 40);
}

function resetSortScreen() {
  const screen = $("#sortieren");
  screen.classList.remove("releasing", "released");
  screen.querySelectorAll(".pile").forEach((p) => p.classList.remove("empty"));
  $("#sort-kind").hidden = true;
  $("#release").hidden = false;
  $("#release").disabled = true;
  $("#sort-next").hidden = true;
  $("#sort-manual").hidden = true;
}

let sortRun = 0; // verhindert, dass eine späte Gemini-Antwort einen neuen Durchgang überschreibt

// Zeigt die Gedanken sofort als sanft pulsierende Liste, solange Gemini sortiert.
function setLoading(on) {
  $("#sortieren").classList.toggle("is-loading", on);
  const box = $("#pile-loading");
  const ul = box.querySelector(".thoughts");
  ul.replaceChildren();
  box.hidden = !on;
  if (!on) return;
  splitThoughts(rawText).forEach((text, i) => {
    const li = document.createElement("li");
    li.className = "thought";
    li.style.animationDelay = i * 0.3 + "s";
    const span = document.createElement("span");
    span.className = "thought-text";
    span.textContent = text;
    li.append(span);
    ul.append(li);
  });
}

async function startSorting(text) {
  const run = ++sortRun;
  rawText = text;
  thoughts = [];
  resetSortScreen();
  $("#sort-tech").hidden = true;
  renderPiles();
  show("sortieren");

  const s = settings();
  if (s.sortmode !== "ki" || !s.key) {
    sortManually(s.sortmode === "ki" ? "Kein Gemini-Schlüssel eingetragen, also sortierst du selbst. Tipp bei jedem Gedanken an, wo er hingehört." : null);
    return;
  }

  $("#sort-status").textContent = "Einen Moment. Deine Gedanken werden sortiert.";
  setLoading(true);
  try {
    const result = await sortWithFallback(text, s);
    if (run !== sortRun) return;
    thoughts = resultToThoughts(result);
    $("#sort-status").textContent = "Stimmt etwas nicht? Tipp den Gedanken an und leg ihn woanders hin.";
    if (result.zuspruch) {
      $("#sort-kind").textContent = result.zuspruch;
      $("#sort-kind").hidden = false;
    }
    $("#sort-manual").hidden = false;
    renderPiles();
  } catch (err) {
    if (run !== sortRun) return;
    sortManually(
      geminiErrorText(err) + " Du sortierst selbst: Tipp bei jedem Gedanken an, wo er hingehört.",
      "Technischer Grund: " + technicalReason(err),
    );
  } finally {
    if (run === sortRun) setLoading(false);
  }
}

function resultToThoughts(result) {
  const take = (arr, pile) =>
    (Array.isArray(arr) ? arr : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .map((t) => ({ text: t, pile }));
  return [
    ...take(result.morgen, "morgen"),
    ...take(result.nicht_heute, "nicht"),
    ...take(result.nur_gedanke, "gedanke"),
  ].map((t, i) => ({ ...t, id: i }));
}

function sortManually(message, tech) {
  thoughts = splitThoughts(rawText).map((text, id) => ({ id, text, pile: null }));
  $("#sort-status").textContent = message || "Tipp bei jedem Gedanken an, wo er hingehört.";
  $("#sort-tech").textContent = tech || "";
  $("#sort-tech").hidden = !tech;
  $("#sort-kind").hidden = true;
  $("#sort-manual").hidden = true;
  renderPiles();
}

$("#sort-manual").addEventListener("click", () => sortManually(null));

function renderPiles() {
  const lists = {
    null: $("#pile-unsorted .thoughts"),
    morgen: $("#pile-morgen .thoughts"),
    nicht: $("#pile-nicht .thoughts"),
    gedanke: $("#pile-gedanke .thoughts"),
  };
  Object.values(lists).forEach((ul) => ul.replaceChildren());

  for (const t of thoughts) {
    const li = document.createElement("li");
    li.className = "thought";

    const text = document.createElement("button");
    text.type = "button";
    text.className = "thought-text";
    text.textContent = t.text;
    text.setAttribute("aria-expanded", "false");
    text.addEventListener("click", () => {
      const open = li.classList.toggle("open");
      text.setAttribute("aria-expanded", String(open));
    });

    const moves = document.createElement("div");
    moves.className = "moves";
    for (const [pile, label] of Object.entries(PILES)) {
      if (pile === t.pile) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        t.pile = pile;
        renderPiles();
      });
      moves.append(b);
    }

    li.append(text, moves);
    lists[t.pile].append(li);
  }

  const unsorted = thoughts.filter((t) => t.pile === null).length;
  $("#pile-unsorted").hidden = unsorted === 0;
  $("#release").disabled = thoughts.length === 0 || unsorted > 0;
}

$("#release").addEventListener("click", () => {
  saveTomorrow(thoughts.filter((t) => t.pile === "morgen").map((t) => t.text));

  const screen = $("#sortieren");
  for (const pile of Object.keys(PILES)) {
    const empty = !thoughts.some((t) => t.pile === pile);
    screen.querySelector(`.pile[data-pile="${pile}"]`).classList.toggle("empty", empty);
  }
  $("#release").hidden = true;
  $("#sort-manual").hidden = true;
  $("#sort-status").textContent = "";
  screen.classList.add("releasing");

  later(() => {
    screen.classList.remove("releasing");
    screen.classList.add("released");
    $("#sort-next").hidden = false;
    $("#sort-next").focus();
  }, 2700);
});

$("#sort-next").addEventListener("click", () => {
  $("#moment-input").value = "";
  show("moment");
  $("#moment-input").focus();
});

// Unerledigtes von früheren Abenden bleibt automatisch auf der Liste (siehe visibleAufgaben).
function saveTomorrow(items) {
  if (items.length) data.addAufgaben(items);
}

// ---------- Gemini ----------

function geminiError(message, extra) {
  return Object.assign(new Error(message), extra);
}

const isRetryable = (err) =>
  err.status >= 500 ||
  err.status === 404 ||
  ["empty", "parse", "timeout"].includes(err.kind);

// Überlastung, Zeitüberschreitung, leere oder unlesbare Antwort: bis zu zwei andere Modelle probieren.
// Alle Fehler landen in err.history, damit der technische Grund jeden Versuch zeigt.
async function sortWithFallback(text, s) {
  const history = [];
  const attempt = async (m) => {
    try {
      return await sortWithGemini(text, s.key, m);
    } catch (err) {
      history.push(err);
      if (!isRetryable(err)) throw Object.assign(err, { history });
      return null;
    }
  };

  const first = await attempt(s.model);
  if (first) return first;

  for (const m of await findFallbackModels(s.key, s.model, 2)) {
    const result = await attempt(m);
    if (result) return result;
  }
  throw Object.assign(history.at(-1), { history });
}

// Fragt Google, welche Modelle dieser Schlüssel nutzen darf; neueste Flash-Modelle zuerst.
async function findFallbackModels(key, exclude, count) {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key },
    });
    if (!res.ok) return null;
    const { models = [] } = await res.json();
    const version = (n) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
    const score = (n) => version(n) * 100 - (/lite/.test(n) ? 10 : 0) - (/preview/.test(n) ? 5 : 0);
    return (
      models
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => /flash/.test(n) && !/tts|live|image|audio|transcribe|embedding|robotics|exp/.test(n))
        .filter((n) => n !== exclude && !/latest/.test(n) && !OVERLOADED_MODELS.includes(n))
        .sort((a, b) => score(b) - score(a))
        .slice(0, count)
    );
  } catch {
    return [];
  }
}

// Liest JSON auch dann, wenn das Modell ```json-Zäune oder Text drumherum schreibt.
function parseJsonLoose(s) {
  const tries = [s, s.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")];
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      /* nächster Versuch */
    }
  }
  return null;
}

async function sortWithGemini(text, key, model, withThinking = true) {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  const list = { type: "ARRAY", items: { type: "STRING" } };
  const body = {
    systemInstruction: { parts: [{ text: SORT_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          morgen: list,
          nicht_heute: list,
          nur_gedanke: list,
          zuspruch: { type: "STRING" },
        },
        required: ["morgen", "nicht_heute", "nur_gedanke", "zuspruch"],
      },
      ...(withThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error?.message ?? "";
      } catch {
        /* kein JSON im Fehler */
      }
      // Manche Modelle kennen thinkingLevel nicht – dann ohne noch einmal.
      if (res.status === 400 && withThinking && !/API.?KEY/i.test(detail)) {
        clearTimeout(abort);
        return sortWithGemini(text, key, model, false);
      }
      throw geminiError("HTTP " + res.status, { status: res.status, detail, model });
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const out = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    if (!out.trim()) {
      throw geminiError("Antwort leer", {
        kind: "empty",
        detail: candidate?.finishReason || data.promptFeedback?.blockReason || "",
        model,
      });
    }

    let result = parseJsonLoose(out);
    if (Array.isArray(result)) result = result[0];
    if (!result || typeof result !== "object") {
      throw geminiError("JSON nicht lesbar", { kind: "parse", detail: out.slice(0, 120), model });
    }
    if (!resultToThoughts(result).length) {
      throw geminiError("Keine Einträge", { kind: "empty", detail: out.slice(0, 120), model });
    }
    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      throw geminiError(`Zeitüberschreitung (${GEMINI_TIMEOUT_MS / 1000} s)`, { kind: "timeout", model });
    }
    if (err instanceof TypeError) throw geminiError("Keine Verbindung", { kind: "network", detail: err.message, model });
    throw err;
  } finally {
    clearTimeout(abort);
  }
}

function geminiErrorText(err) {
  if (err.status === 400 && /API.?KEY/i.test(err.detail ?? "")) {
    return "Gemini hat den Schlüssel nicht angenommen. Prüf ihn in den Einstellungen.";
  }
  switch (err.status) {
    case 400:
      return "Gemini hat die Anfrage abgelehnt.";
    case 401:
    case 403:
      return "Gemini hat den Schlüssel nicht angenommen. Prüf ihn in den Einstellungen.";
    case 404:
      return "Gemini kennt das eingestellte Modell nicht. Prüf den Modellnamen in den Einstellungen.";
    case 429:
      return "Das Gratis-Kontingent von Gemini ist gerade aufgebraucht.";
  }
  if (err.status >= 500) return "Gemini ist gerade überlastet.";
  if (err.kind === "timeout") return "Gemini hat zu lange gebraucht.";
  if (err.kind === "network") return "Gemini ist gerade nicht erreichbar.";
  return "Gemini konnte gerade nicht sortieren.";
}

function technicalReason(err) {
  const one = (e) => {
    const parts = [];
    if (e.model) parts.push(e.model);
    parts.push(e.message);
    if (e.detail) parts.push(String(e.detail).replace(/\s+/g, " ").slice(0, 120));
    return parts.join(" · ");
  };
  return (err.history?.length ? err.history : [err]).map(one).join(" | ");
}

// ---------- 3 Guter Moment ----------

$("#moment-next").addEventListener("click", () => {
  const text = $("#moment-input").value.trim();
  if (text) data.addMoment(text);
  prepareMeditation();
});
$("#moment-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#moment-next").click();
});
$("#moment-skip").addEventListener("click", prepareMeditation);

// ---------- 4 Meditation ----------

const voiceAudio = $("#voice-audio");
const musicAudio = $("#music-audio");
const moon = $("#moon");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let med = null; // laufende Meditation
let wakeLock = null;

async function fileExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

function currentVoice() {
  const id = settings().voice;
  return VOICES.find((v) => v.id === id) ?? VOICES[0];
}

async function prepareMeditation() {
  show("meditation");
  $("#med-start").hidden = false;
  $("#med-start").disabled = true;
  $("#med-controls").hidden = true;
  $("#breath-word").textContent = "Mach es dir bequem";
  $("#med-bar").style.width = "0";
  setMoon(0.62, 0);

  const [hasVoice, hasMusic] = await Promise.all([
    fileExists(currentVoice().file),
    fileExists(MUSIC_FILE),
  ]);
  med = { hasVoice, hasMusic, paused: false, breathTimer: null, tick: null };

  $("#med-note").textContent = hasVoice
    ? "Leg dich hin, wenn du magst. Das Handy darf umgedreht liegen."
    : "Die Sprachaufnahme fehlt noch. Du kannst trotzdem fünf Minuten mit dem Mond atmen.";
  $("#med-start").disabled = false;
}

$("#med-start").addEventListener("click", startMeditation);

async function startMeditation() {
  $("#med-start").hidden = true;
  $("#med-controls").hidden = false;
  $("#med-pause").textContent = "Pause";
  $("#med-note").textContent = "";
  requestWakeLock();

  music.start(med.hasMusic);

  if (med.hasVoice) {
    $("#breath-word").textContent = "";
    voiceAudio.src = currentVoice().file;
    voiceAudio.onended = finishMeditation;
    voiceAudio.ontimeupdate = () => {
      if (voiceAudio.duration) {
        $("#med-bar").style.width = (voiceAudio.currentTime / voiceAudio.duration) * 100 + "%";
      }
    };
    // iOS erlaubt späteres Abspielen nur, wenn das Element einmal im Tipp gestartet wurde:
    // stumm anspielen, anhalten, dann nach der Musik-Einleitung richtig starten.
    const current = med;
    try {
      voiceAudio.muted = true;
      await voiceAudio.play();
      voiceAudio.pause();
      voiceAudio.currentTime = 0;
      voiceAudio.muted = false;
      if (med !== current) return; // inzwischen beendet
      scheduleVoice(VOICE_DELAY_MS);
    } catch {
      voiceAudio.muted = false;
      if (med !== current) return;
      med.hasVoice = false;
      $("#med-note").textContent = "Die Sprachaufnahme ließ sich nicht abspielen.";
    }
  }

  if (!med.hasVoice) {
    med.elapsed = 0;
    med.tick = setInterval(() => {
      if (med.paused) return;
      med.elapsed += 1;
      $("#med-bar").style.width = (med.elapsed / SILENT_MED_SECONDS) * 100 + "%";
      if (med.elapsed >= SILENT_MED_SECONDS) finishMeditation();
    }, 1000);
  }

  breathe(true);
}

function scheduleVoice(ms) {
  med.voiceDue = Date.now() + ms;
  med.voiceTimer = setTimeout(() => {
    if (!med) return;
    med.voiceStarted = true;
    voiceAudio.play().catch(() => {});
  }, ms);
}

function setMoon(scale, ms) {
  moon.style.transitionDuration = ms + "ms";
  if (reducedMotion) {
    moon.style.opacity = scale > 0.8 ? "1" : "0.6";
  } else {
    moon.style.transform = `scale(${scale})`;
  }
}

// Hält den Mond genau dort an, wo er gerade ist.
function freezeMoon() {
  const cs = getComputedStyle(moon);
  moon.style.transitionDuration = "0ms";
  if (cs.transform && cs.transform !== "none") moon.style.transform = cs.transform;
  moon.style.opacity = cs.opacity;
}

function breathe(inhale) {
  if (!med || med.paused) return;
  // Mit Stimme führt die Stimme, der Mond atmet still mit.
  const showWords = !med.hasVoice;
  if (inhale) {
    setMoon(1, INHALE);
    if (showWords) $("#breath-word").textContent = "Ein";
    med.breathTimer = setTimeout(() => breathe(false), INHALE);
  } else {
    setMoon(0.62, EXHALE);
    if (showWords) $("#breath-word").textContent = "Aus";
    med.breathTimer = setTimeout(() => breathe(true), EXHALE);
  }
}

$("#med-pause").addEventListener("click", () => {
  if (!med) return;
  med.paused = !med.paused;
  if (med.paused) {
    clearTimeout(med.breathTimer);
    freezeMoon();
    if (med.hasVoice && !med.voiceStarted) {
      // Pause noch in der Musik-Einleitung: Restzeit merken
      clearTimeout(med.voiceTimer);
      med.voiceRemaining = Math.max(0, med.voiceDue - Date.now());
    }
    if (med.hasVoice) voiceAudio.pause();
    music.pause();
    $("#med-pause").textContent = "Weiter";
    $("#breath-word").textContent = "Pause";
  } else {
    if (med.hasVoice && !med.voiceStarted) scheduleVoice(med.voiceRemaining);
    else if (med.hasVoice) voiceAudio.play().catch(() => {});
    music.resume();
    $("#med-pause").textContent = "Pause";
    if (med.hasVoice) $("#breath-word").textContent = "";
    breathe(true);
  }
});

$("#med-stop").addEventListener("click", finishMeditation);

function finishMeditation() {
  if (!med) return;
  clearTimeout(med.breathTimer);
  clearTimeout(med.voiceTimer);
  clearInterval(med.tick);
  voiceAudio.pause();
  voiceAudio.onended = null;
  voiceAudio.ontimeupdate = null;
  med = null;

  show("ende");
  music.fadeOut(MUSIC_TAIL_SECONDS, releaseWakeLock);
}

$("#end-home").addEventListener("click", () => {
  music.stop();
  releaseWakeLock();
  renderHome();
  show("start");
});

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- Musik: Datei, sonst ein leiser erzeugter Klangteppich ----------
// Lautstärke und Ausblenden laufen über Web Audio, weil Safari auf dem iPhone
// audio.volume ignoriert.

const music = (() => {
  let ctx = null;
  let fileGain = null;   // Musikdatei -> fileGain -> Ausgang (einmal angelegt)
  let synth = null;      // { gain, sources } für den Klangteppich
  let mode = null;       // "file" | "synth" | null
  let fadeTimer = null;

  const level = () => (settings().music / 100) * 0.6;

  function audioContext() {
    if (!ctx) {
      // Musik soll auch bei eingeschaltetem Stummschalter laufen (Safari 16.4+).
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* egal */ }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function ramp(gain, target, seconds) {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(target, now + seconds);
  }

  function startFile() {
    const c = audioContext();
    if (!fileGain) {
      fileGain = c.createGain();
      c.createMediaElementSource(musicAudio).connect(fileGain).connect(c.destination);
    }
    fileGain.gain.value = 0;
    musicAudio.volume = 1;
    musicAudio.src = MUSIC_FILE;
    musicAudio.play().then(() => ramp(fileGain, level(), 6)).catch(() => {});
  }

  function startSynth() {
    const c = audioContext();
    const gain = c.createGain();
    gain.gain.value = 0;
    gain.connect(c.destination);
    const sources = [];

    // Weiches, tiefes Rauschen
    const len = c.sampleRate * 4;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.2;
    }
    const noise = c.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const noiseGain = c.createGain();
    noiseGain.gain.value = 0.35;
    noise.connect(lp).connect(noiseGain).connect(gain);
    sources.push(noise);

    // Ruhiger Akkord, der langsam atmet
    [110, 164.81, 220.4].forEach((freq, i) => {
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = c.createGain();
      g.gain.value = 0.03;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.023;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 0.015;
      lfo.connect(lfoGain).connect(g.gain);
      osc.connect(g).connect(gain);
      sources.push(osc, lfo);
    });

    sources.forEach((s) => s.start());
    synth = { gain, sources };
    ramp(gain, level(), 6);
  }

  function activeGain() {
    return mode === "file" ? fileGain : synth?.gain;
  }

  return {
    // Muss direkt aus einem Tipp heraus aufgerufen werden (iOS).
    start(hasFile) {
      this.stop();
      if (level() === 0) return;
      try {
        if (hasFile) startFile();
        else startSynth();
        mode = hasFile ? "file" : "synth";
      } catch {
        mode = null;
      }
    },
    pause() {
      if (mode === "file") musicAudio.pause();
      if (mode) ctx.suspend().catch(() => {});
    },
    resume() {
      if (!mode) return;
      ctx.resume().catch(() => {});
      if (mode === "file") musicAudio.play().catch(() => {});
    },
    fadeOut(seconds, done) {
      const gain = activeGain();
      if (!gain) {
        done?.();
        return;
      }
      ramp(gain, 0, seconds);
      fadeTimer = setTimeout(() => {
        this.stop();
        done?.();
      }, seconds * 1000 + 200);
    },
    stop() {
      clearTimeout(fadeTimer);
      musicAudio.pause();
      musicAudio.removeAttribute("src");
      if (fileGain) fileGain.gain.value = 0;
      if (synth) {
        synth.sources.forEach((s) => { try { s.stop(); } catch { /* schon gestoppt */ } });
        synth.gain.disconnect();
        synth = null;
      }
      mode = null;
    },
  };
})();

// ---------- Einstellungen ----------

$("#open-settings").addEventListener("click", () => {
  const s = settings();
  document.querySelectorAll('input[name="sortmode"]').forEach((r) => (r.checked = r.value === s.sortmode));
  $("#set-key").value = store.get("settings", {}).key ?? "";
  $("#set-key").placeholder = LOCAL_KEY
    ? "Wird aus config.local.js genommen"
    : "Kostenlos bei aistudio.google.com";
  $("#set-model").value = s.model;
  $("#set-music").value = s.music;

  const select = $("#set-voice");
  select.replaceChildren(
    ...VOICES.map((v) => {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.name;
      o.selected = v.id === s.voice;
      return o;
    }),
  );
  $("#voice-field").hidden = VOICES.length < 2;
  renderAccount();
  show("settings");
});

$("#settings-save").addEventListener("click", () => {
  store.set("settings", {
    sortmode: document.querySelector('input[name="sortmode"]:checked')?.value ?? "ki",
    key: $("#set-key").value.trim(),
    model: $("#set-model").value.trim() || DEFAULT_MODEL,
    voice: $("#set-voice").value || VOICES[0].id,
    music: Number($("#set-music").value),
  });
  renderHome();
  show("start");
});

$("#wipe").addEventListener("click", async () => {
  const question = remote()
    ? "Liste und gute Momente in deinem Konto löschen? Sie verschwinden dann auf allen Geräten."
    : "Liste und gute Momente wirklich löschen?";
  if (!confirm(question)) return;
  try {
    await data.wipe();
    toast("Gelöscht.");
  } catch {
    toast("Das hat gerade nicht geklappt. Prüf deine Verbindung.");
  }
  renderHome();
});

// ---------- Los geht's ----------

// Mit Supabase rendert onAuthStateChange die Startseite, sobald die Sitzung bekannt ist.
if (!sb) renderHome();
show("start");
