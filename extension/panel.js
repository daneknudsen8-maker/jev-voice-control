// The panel owns the microphone and renders what happened. All decisions live
// in background.js; this file is presentation plus the mic lifecycle.

import { createRecognizer } from "./speech/index.js";

const $ = (id) => document.getElementById(id);
const toggle = $("toggle"), label = $("toggle-label"), status = $("status");
const heard = $("heard"), log = $("log"), usage = $("usage");
const prompt = $("prompt"), promptText = $("prompt-text"), promptActions = $("prompt-actions");
const composer = $("composer"), composerText = $("composer-text"), composerTarget = $("composer-target");

let listening = false;
let busy = false;

const recognizer = createRecognizer({
  onListening: () => setStatus("listening"),
  onPartial: (text) => { heard.textContent = text; heard.classList.remove("final"); },
  onFinal: (text) => {
    heard.textContent = text;
    heard.classList.add("final");
    submit(text);
  },
  onError: (message) => { add("error", message); setListening(false); },
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

$("composer-stop").addEventListener("click", async () => {
  render(await chrome.runtime.sendMessage({ type: "end_dictation" }), "");
});

function add(kind, message, meta) {
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = message;
  if (meta) {
    const span = document.createElement("span");
    span.className = "meta";
    span.textContent = meta;
    li.append(span);
  }
  log.prepend(li);
  while (log.children.length > 40) log.lastElementChild.remove();
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
    render(await chrome.runtime.sendMessage({ type: "utterance", transcript }), transcript);
  } catch (error) {
    add("error", error.message);
  } finally {
    busy = false;
    setStatus(listening ? "listening" : "idle");
  }
}

function render(result, transcript) {
  if (!result) return add("error", "no response from the extension");

  if (result.usage) {
    const { input_tokens, ms, model } = result.usage;
    usage.textContent = `${ms}ms · ${input_tokens} tok · ${model}`;
  }

  if (result.dictation) showComposer(result.dictation);

  const meta = debugLine(result);

  switch (result.kind) {
    case "composing":
      add("done", result.message, meta);
      break;

    case "wrote":
      composerText.textContent = result.message;
      composerText.scrollTop = composerText.scrollHeight;
      add("done", `wrote: ${String(result.message).split("\n").pop().slice(-60)}`, meta);
      break;

    case "done":
      add("done", result.message, meta);
      break;

    case "answer":
      add("done", result.message,
        result.certainty != null
          ? `answered ${result.certainty.toFixed(2)} · match ${result.confidence?.toFixed(2)} · ${meta ?? ""}`
          : meta);
      break;

    case "confirm":
      add("confirm", result.message, meta);
      askUser(result.message, [
        ["Yes, do it", () => send({ type: "confirm", yes: true }), true],
        ["Cancel", () => send({ type: "confirm", yes: false })],
      ]);
      break;

    case "choose":
      add("choose", result.message, meta);
      askUser(result.message, [
        ...result.options.map((o) => [`${o.text}`.slice(0, 40), () => send({ type: "pick", id: o.id })]),
        ["None of these", () => {}],
      ]);
      break;

    case "clarify":
      add("clarify", result.message, meta);
      break;

    case "ignored":
      add("ignored", `— ${transcript}`, result.message);
      break;

    case "stop":
      add("done", result.message);
      setListening(false);
      break;

    default:
      add("error", result.message ?? `unexpected: ${result.kind}`);
  }
}

function debugLine(result) {
  const a = result.answers;
  if (!a) return result.detail ?? result.debug ?? undefined;
  const bits = [];
  if (a.is_content) bits.push(`content ${a.is_content.noul.toFixed(2)}`);
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
  label.textContent = on ? "Stop listening" : "Start listening";
  setStatus(on ? "listening" : "idle");
  if (on) recognizer.start(); else { recognizer.stop(); heard.textContent = ""; }
}

toggle.addEventListener("click", () => setListening(!listening));

// Space toggles, Escape stops — as long as focus isn't on a button.
addEventListener("keydown", (event) => {
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    setListening(!listening);
  }
  if (event.code === "Escape" && listening) setListening(false);
});

chrome.runtime.sendMessage({ type: "dictation_state" }).then((r) => {
  if (r?.mode) showComposer({ active: true, label: r.mode.label, text: r.mode.text });
}).catch(() => {});

if (!recognizer.available()) {
  add("error", "No Web Speech API in this browser. Chrome is required.");
  toggle.disabled = true;
}
