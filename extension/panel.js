// The panel owns the microphone and renders what happened. All decisions live
// in background.js; this file is presentation plus the mic lifecycle.

import { createRecognizer, ENGINES } from "./speech/index.js";

const $ = (id) => document.getElementById(id);
const toggle = $("toggle"), label = $("toggle-label"), status = $("status");
const heard = $("heard"), log = $("log"), usage = $("usage");
const prompt = $("prompt"), promptText = $("prompt-text"), promptActions = $("prompt-actions");
const composer = $("composer"), composerText = $("composer-text"), composerTarget = $("composer-target");
const mail = $("mail"), mailFields = $("mail-fields");
const engineSelect = $("engine"), entry = $("entry"), commandInput = $("command");

let listening = false;
let busy = false;
let lastSaid = "";

const HANDLERS = {
  onListening: () => setStatus(engine === "text" ? "ready — type or dictate" : "listening"),
  onPartial: (text) => { heard.textContent = text; heard.classList.remove("final"); },
  onFinal: (text) => {
    heard.textContent = text;
    heard.classList.add("final");
    submit(text);
  },
  onError: (message) => { add("error", message); setListening(false); },
};

// Remembered per browser; the panel is reopened often.
let engine = (() => {
  try { return localStorage.getItem("jev.engine") ?? "webspeech"; } catch { return "webspeech"; }
})();
let recognizer = createRecognizer(HANDLERS, { engine, input: commandInput });

function applyEngine(next) {
  const wasListening = listening;
  if (wasListening) setListening(false);

  engine = next;
  try { localStorage.setItem("jev.engine", next); } catch { /* private window */ }

  engineSelect.value = next;
  entry.hidden = !ENGINES[next].needsInput;
  document.body.classList.toggle("text-engine", next === "text");
  label.textContent = next === "text" ? "Start" : "Start listening";

  recognizer = createRecognizer(HANDLERS, { engine: next, input: commandInput });
  if (wasListening) setListening(true);
}

engineSelect.addEventListener("change", (event) => applyEngine(event.target.value));

// Wispr Flow types into whatever field has focus. If focus leaves this box
// while the text engine is on, the next thing dictated lands in the web page
// instead — so say so loudly rather than letting it happen quietly.
commandInput.addEventListener("blur", () => {
  if (engine === "text" && listening) setStatus("⚠ box not focused — click it before dictating");
});
commandInput.addEventListener("focus", () => {
  if (engine === "text" && listening) setStatus("ready — type or dictate");
});
// Clicking anywhere in the panel puts focus back where dictation should land.
addEventListener("click", (event) => {
  if (engine !== "text" || !listening) return;
  if (event.target.closest("button, select, input, a")) return;
  commandInput.focus();
});

function setStatus(text) { status.textContent = text; }

/** Show or hide the composer. While it is visible, speech becomes text. */
function showComposer(state) {
  if (state?.active) {
    composer.hidden = false;
    document.body.classList.add("dictating");
    composerTarget.textContent = state.label ? `into ${state.label}` : "into the page";
    if (state.text !== undefined) composerText.textContent = state.text;
    composerText.scrollTop = composerText.scrollHeight;
    setStatus("writing");
  } else {
    composer.hidden = true;
    document.body.classList.remove("dictating");
    composerText.textContent = "";
    setStatus(listening ? "listening" : "idle");
  }
}

/** Render the email as it is being filled in, marking the active field. */
function showMail(state) {
  if (!state?.active) {
    mail.hidden = true;
    document.body.classList.remove("dictating");
    mailFields.replaceChildren();
    setStatus(listening ? "listening" : "idle");
    return;
  }
  mail.hidden = false;
  document.body.classList.add("dictating");
  mailFields.replaceChildren();

  for (const role of state.fields ?? []) {
    const dt = document.createElement("dt");
    dt.textContent = role;
    const dd = document.createElement("dd");
    dd.textContent = state.text?.[role] ?? "";
    dd.className = role === "body" ? "body" : "";
    if (role === state.currentField) { dt.classList.add("active"); dd.classList.add("active"); }
    mailFields.append(dt, dd);
  }
  setStatus(`writing · ${state.currentField ?? ""}`);
}

$("mail-stop").addEventListener("click", async () => {
  render(await chrome.runtime.sendMessage({ type: "end_dictation" }), "");
});

$("composer-stop").addEventListener("click", async () => {
  render(await chrome.runtime.sendMessage({ type: "end_dictation" }), "");
});

/**
 * One line per query. What you said comes first, because that is what you check
 * when something goes wrong — the transcript is often the culprit, not the model.
 */
function add(kind, message, meta, said) {
  const li = document.createElement("li");
  li.className = kind;

  if (said) {
    const q = document.createElement("span");
    q.className = "said";
    q.textContent = said;
    li.append(q);
  }

  const body = document.createElement("span");
  body.className = "result";
  body.textContent = message;
  li.append(body);

  if (meta) {
    const span = document.createElement("span");
    span.className = "meta";
    span.textContent = meta;
    li.append(span);
  }

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.append(time);

  log.prepend(li);
  while (log.children.length > 60) log.lastElementChild.remove();
  return li;
}

function clearPrompt() {
  prompt.hidden = true;
  promptActions.replaceChildren();
}

function askUser(text, buttons) {
  promptText.textContent = text;
  promptActions.replaceChildren();
  for (const [caption, handler, primary] of buttons) {
    const b = document.createElement("button");
    b.textContent = caption;
    if (primary) b.className = "primary";
    b.addEventListener("click", () => { clearPrompt(); handler(); });
    promptActions.append(b);
  }
  prompt.hidden = false;
}

async function submit(transcript) {
  if (busy) return;                     // one utterance at a time
  busy = true;
  setStatus("thinking");
  clearPrompt();
  try {
    lastSaid = transcript;
    render(await chrome.runtime.sendMessage({ type: "utterance", transcript }), transcript);
  } catch (error) {
    add("error", error.message);
  } finally {
    busy = false;
    setStatus(listening ? "listening" : "idle");
  }
}

function render(result, transcript) {
  const said = transcript || lastSaid;
  if (!result) return add("error", "no response from the extension", undefined, said);

  if (result.usage) {
    const { input_tokens, ms, model } = result.usage;
    usage.textContent = `${ms}ms · ${input_tokens} tok · ${model}`;
  }

  if (result.dictation) showComposer(result.dictation);
  if (result.compose) showMail(result.compose);

  const meta = debugLine(result);

  switch (result.kind) {
    case "sequence": {
      // One line per step, oldest first, so the chain reads top to bottom.
      add("done", result.message, meta, said);
      for (const step of result.steps) {
        if (!step.step) { add("ignored", step.message); continue; }
        const kind = step.kind === "done" || step.kind === "answer" || step.kind === "wrote" ? "done"
                   : step.kind === "error" ? "error" : "clarify";
        add(kind, step.message ?? step.kind, debugLine(step), `↳ ${step.step}`);
      }
      break;
    }

    case "composing":
      add("done", result.message, meta, said);
      break;

    case "field":
      add("clarify", result.message, meta, said);
      break;

    case "field_written":
      add("done", result.message, meta, said);
      break;

    case "wrote":
      composerText.textContent = result.message;
      composerText.scrollTop = composerText.scrollHeight;
      add("done", `wrote: ${String(result.message).split("\n").pop().slice(-60)}`, meta, said);
      break;

    case "done":
      add("done", result.message, meta, said);
      break;

    case "answer":
      add("done", result.message,
        result.certainty != null
          ? `answered ${result.certainty.toFixed(2)} · match ${result.confidence?.toFixed(2)} · ${meta ?? ""}`
          : meta, said);
      break;

    case "confirm":
      add("confirm", result.message, meta, said);
      askUser(result.message, [
        ["Yes, do it", () => send({ type: "confirm", yes: true }), true],
        ["Cancel", () => send({ type: "confirm", yes: false })],
      ]);
      break;

    case "choose":
      add("choose", result.message, meta, said);
      askUser(result.message, [
        ...result.options.map((o) => [`${o.text}`.slice(0, 40), () => send({ type: "pick", id: o.id })]),
        ["None of these", () => {}],
      ]);
      break;

    case "clarify":
      add("clarify", result.message, meta, said);
      break;

    case "ignored":
      add("ignored", result.message ?? "not a command", meta, said);
      break;

    case "stop":
      add("done", result.message);
      setListening(false);
      break;

    default:
      add("error", result.message ?? `unexpected: ${result.kind}`, meta, said);
  }
}

function debugLine(result) {
  const a = result.answers;
  if (!a) return result.detail ?? result.debug ?? undefined;
  const bits = [];
  if (a.is_content) bits.push(`content ${a.is_content.noul.toFixed(2)}`);
  if (a.field) bits.push(`field ${a.field.choice} ${a.field.confidence.toFixed(2)}`);
  if (a.control) bits.push(`${a.control.choice} ${a.control.confidence.toFixed(2)}`);
  if (a.action) bits.push(`${a.action.choice} ${a.action.confidence.toFixed(2)}`);
  if (a.is_command) bits.push(`cmd ${a.is_command.noul.toFixed(2)}`);
  if (a.risk) bits.push(`risk ${a.risk.score.toFixed(2)}`);
  if (a.target && a.target.choice !== "no_match") bits.push(`target ${a.target.confidence.toFixed(2)}`);
  if (result.debug) bits.push(result.debug);
  return bits.join(" · ") || undefined;
}

async function send(message) {
  try {
    render(await chrome.runtime.sendMessage(message), "");
  } catch (error) {
    add("error", error.message);
  }
}

function setListening(on) {
  listening = on;
  toggle.setAttribute("aria-pressed", String(on));
  label.textContent = on
    ? (engine === "text" ? "Stop" : "Stop listening")
    : (engine === "text" ? "Start" : "Start listening");
  setStatus(on ? "listening" : "idle");
  if (on) recognizer.start(); else { recognizer.stop(); heard.textContent = ""; }
}

toggle.addEventListener("click", () => setListening(!listening));

// Space toggles, Escape stops — as long as focus isn't on a button.
addEventListener("keydown", (event) => {
  if (event.target === commandInput && event.code !== "Escape") return;
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    setListening(!listening);
  }
  if (event.code === "Escape" && listening) setListening(false);
});

chrome.runtime.sendMessage({ type: "dictation_state" }).then((r) => {
  if (!r?.mode) return;
  if (r.mode.kind === "compose") {
    showMail({ active: true, fields: Object.keys(r.mode.fields ?? {}), currentField: r.mode.currentField, text: r.mode.text });
  } else {
    showComposer({ active: true, label: r.mode.label, text: r.mode.text });
  }
}).catch(() => {});

applyEngine(engine);

if (!recognizer.available()) {
  add("error", "No Web Speech API in this browser — switch the source to \"Wispr Flow / typing\".");
}
