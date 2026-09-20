// Runs in the page. Two jobs:
//   1. Inventory the interactive elements, so Jev has something to SELECT from.
//   2. Execute the resolved command.
//
// The inventory is filtered and ranked in code before it goes anywhere near the
// model — docs/typesafe/01-limits.md #5, irrelevant state costs accuracy.

const MAX_CLICKABLE = 70;
const MAX_TYPEABLE = 12;
const MAX_SECTIONS = 60;
const MAX_TEXT = 90;

let registry = new Map();  // id -> Element, rebuilt each inventory
let counter = 0;

// Dictation binds to one element and survives inventory rebuilds, which would
// otherwise drop the id out from under an in-progress message.
let dictation = null;  // { el, chunks: [] }

const CLICKABLE = [
  "a[href]", "button", "[role=button]", "[role=link]", "[role=tab]",
  "[role=menuitem]", "[role=option]", "[role=checkbox]", "[role=radio]",
  "input[type=submit]", "input[type=button]", "input[type=checkbox]",
  "input[type=radio]", "summary", "[onclick]", "[tabindex]:not([tabindex='-1'])",
].join(",");

const TYPEABLE = [
  "input:not([type])", "input[type=text]", "input[type=search]", "input[type=email]",
  "input[type=url]", "input[type=tel]", "input[type=password]", "input[type=number]",
  "textarea", "[contenteditable=true]", "[role=textbox]", "[role=searchbox]",
].join(",");

function visible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return null;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) return null;
  if (el.closest("[aria-hidden=true]")) return null;
  if (el.disabled) return null;
  return rect;
}

function labelFor(el) {
  const pick = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  return (
    pick(el.getAttribute("aria-label")) ||
    pick(el.labels?.[0]?.textContent) ||
    pick(el.innerText || el.textContent) ||
    pick(el.getAttribute("placeholder")) ||
    pick(el.getAttribute("title")) ||
    pick(el.getAttribute("alt")) ||
    pick(el.querySelector("img[alt]")?.getAttribute("alt")) ||
    pick(el.value) ||
    pick(el.getAttribute("name")) ||
    ""
  ).slice(0, MAX_TEXT);
}

function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "text area";
  if (tag === "input") return `${el.type || "text"} input`;
  return tag;
}

function regionOf(el, rect) {
  if (el.closest("nav, header, [role=navigation], [role=banner]")) return "navigation";
  if (el.closest("footer, [role=contentinfo]")) return "footer";
  if (el.closest("aside, [role=complementary]")) return "sidebar";
  if (el.closest("form")) return "form";
  if (rect.top < 0 || rect.bottom > innerHeight) return "off screen";
  return "main content";
}

// Cheap lexical overlap with the utterance — mirrors the rerank cookbook's
// "shortlist in code, judge with Jev" shape.
function affinity(text, words) {
  if (!words.length) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const w of words) if (lower.includes(w)) hits += w.length > 4 ? 2 : 1;
  return hits;
}

function collect(selector, limit, words) {
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const rect = visible(el);
    if (!rect) continue;
    const text = labelFor(el);
    if (!text) continue;
    if (out.some((c) => c.el === el)) continue;

    const onScreen = rect.top >= 0 && rect.top < innerHeight;
    out.push({
      el,
      rect,
      text,
      kind: roleOf(el),
      where: regionOf(el, rect),
      hint: el.getAttribute("title") || undefined,
      score: affinity(text, words) * 10 + (onScreen ? 5 : 0) - Math.abs(rect.top) / 4000,
    });
  }

  out.sort((a, b) => b.score - a.score);
  const kept = out.slice(0, limit);

  return kept.map((c) => {
    const id = `e${counter++}`;
    registry.set(id, c.el);
    return { id, text: c.text, kind: c.kind, where: c.where, hint: c.hint };
  });
}

function inventory(utterance = "") {
  registry = new Map();
  counter = 0;
  const words = utterance.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return {
    page: {
      title: document.title.slice(0, 120),
      url: location.href.slice(0, 200),
      host: location.host,
    },
    elements: collect(CLICKABLE, MAX_CLICKABLE, words),
    typeables: collect(TYPEABLE, MAX_TYPEABLE, words),
  };
}

// Page prose for ask_page. Different state, different request — see
// docs/typesafe/03-design-patterns.md, semantic_find.
function sections() {
  registry = registry.size ? registry : new Map();
  const blocks = [];
  const seen = new Set();
  const nodes = document.querySelectorAll("h1,h2,h3,h4,p,li,dd,blockquote,td,figcaption");

  for (const node of nodes) {
    if (!visible(node)) continue;
    const text = (node.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length < 25 || seen.has(text)) continue;
    seen.add(text);
    const id = `s${blocks.length}`;
    registry.set(id, node);
    blocks.push({ id, heading: /^H[1-4]$/.test(node.tagName), text: text.slice(0, 260) });
    if (blocks.length >= MAX_SECTIONS) break;
  }
  return blocks;
}

function flash(el, color = "#22c55e") {
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = `3px solid ${color}`;
  el.style.outlineOffset = "2px";
  setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = prevOffset; }, 1100);
}

function setValue(el, text) {
  if (el.isContentEditable) {
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    return;
  }
  // React and friends track the native setter; bypass their shadowing.
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  setter ? setter.call(el, text) : (el.value = text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Read whatever is currently in a field. */
function readField(el) {
  return el.isContentEditable ? el.innerText : (el.value ?? "");
}

function execute(command) {
  switch (command.do) {
    case "bind_dictation": {
      const el = registry.get(command.id) ?? document.activeElement;
      if (!el || !(el.isContentEditable || "value" in el)) {
        return { ok: false, error: "that isn't a text field" };
      }
      dictation = { el, chunks: [] };
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      flash(el, "#3b82f6");
      return { ok: true, did: `writing into ${labelFor(el) || "the field"}`, text: readField(el), label: labelFor(el) };
    }

    // The background computes the assembled text (spacing, capitals, spoken
    // punctuation all live in dictation.js) and sends the full new value.
    case "set_dictation_text": {
      if (!dictation?.el?.isConnected) return { ok: false, error: "the field went away" };
      dictation.chunks.push({ before: readField(dictation.el) });   // for undo
      setValue(dictation.el, command.text);
      dictation.el.scrollIntoView({ block: "center" });
      return { ok: true, did: command.note ?? "wrote that", text: command.text };
    }

    case "undo_dictation": {
      if (!dictation?.el?.isConnected) return { ok: false, error: "the field went away" };
      const last = dictation.chunks.pop();
      if (!last) return { ok: false, error: "nothing to undo" };
      setValue(dictation.el, last.before);
      return { ok: true, did: "removed that", text: last.before };
    }

    case "clear_dictation": {
      if (!dictation?.el?.isConnected) return { ok: false, error: "the field went away" };
      dictation.chunks.push({ before: readField(dictation.el) });
      setValue(dictation.el, "");
      return { ok: true, did: "cleared", text: "" };
    }

    case "read_dictation": {
      if (!dictation?.el?.isConnected) return { ok: false, error: "the field went away" };
      return { ok: true, text: readField(dictation.el), label: labelFor(dictation.el) };
    }

    case "unbind_dictation":
      dictation = null;
      return { ok: true, did: "stopped writing" };

    case "submit_dictation": {
      if (!dictation?.el?.isConnected) return { ok: false, error: "the field went away" };
      const el = dictation.el;
      // Prefer the form's own submit button; fall back to Enter.
      const form = el.closest("form");
      const button = form?.querySelector("button[type=submit], input[type=submit]")
        ?? form?.querySelector("button:not([type=button])");
      if (button) { button.click(); return { ok: true, did: `submitted via "${labelFor(button)}"` }; }
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      return { ok: true, did: "pressed Enter" };
    }

    case "scroll": {
      const amount = Math.round(innerHeight * 0.8);
      const map = {
        down:   () => scrollBy({ top: amount, behavior: "smooth" }),
        up:     () => scrollBy({ top: -amount, behavior: "smooth" }),
        top:    () => scrollTo({ top: 0, behavior: "smooth" }),
        bottom: () => scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
      };
      (map[command.direction] ?? map.down)();
      return { ok: true, did: `scroll ${command.direction}` };
    }

    case "click": {
      const el = registry.get(command.id);
      if (!el) return { ok: false, error: "element is gone — the page may have changed" };
      flash(el);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.click();
      return { ok: true, did: `clicked "${labelFor(el)}"` };
    }

    case "type": {
      const el = registry.get(command.id);
      if (!el) return { ok: false, error: "field is gone — the page may have changed" };
      flash(el, "#3b82f6");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setValue(el, command.text);
      return { ok: true, did: `typed "${command.text}"` };
    }

    case "highlight": {
      const el = registry.get(command.id);
      if (!el) return { ok: false, error: "section is gone" };
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      flash(el, "#f59e0b");
      return { ok: true, did: "highlighted" };
    }

    // reload / back / forward deliberately live in background.js: doing them
    // here destroys this script before it can reply.

    default:
      return { ok: false, error: `content script cannot do "${command.do}"` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  try {
    if (msg.type === "inventory")  return respond(inventory(msg.utterance)), true;
    if (msg.type === "sections")   return respond({ sections: sections(), page: { title: document.title, url: location.href } }), true;
    if (msg.type === "execute")    return respond(execute(msg.command)), true;
  } catch (error) {
    respond({ ok: false, error: error.message });
  }
  return true;
});
