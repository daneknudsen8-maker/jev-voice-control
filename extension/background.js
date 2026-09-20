// Orchestrator. Owns tab operations and all traffic to the proxy.
// The panel sends transcripts here; this decides what happens.

import { buildCommandQuestions, matchLocalCommand, resolveCommand, splitSteps } from "./commands.js";
import { appendChunk, buildDictationQuestions, resolveDictation } from "./dictation.js";
import "./open-panel.js";

const PROXY = "http://127.0.0.1:8787/systemone";
const TRACE = "http://127.0.0.1:8787/trace";
const MODEL = "jev-latest";

let lastUsage = null;

async function askJev(state, questions) {
  const started = performance.now();
  const res = await fetch(PROXY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("TypeSafe rejected the API key (401). Check .env.");
    if (res.status === 429) throw new Error("Rate limited (429). Slow down.");
    if (res.status === 403) throw new Error("Proxy refused this extension. Check JEV_ALLOWED_EXTENSION_ID.");
    throw new Error(`Proxy ${res.status}: ${detail.slice(0, 160)}`);
  }

  const json = await res.json();
  lastUsage = { ...json.usage, ms: Math.round(performance.now() - started), model: json.model };
  return json.answers;
}

/** Resolve once the tab has finished loading, or after a ceiling. */
function waitForTabLoad(tabId, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      clearTimeout(timer);
      // A moment more for scripts to paint the interactive elements.
      setTimeout(resolve, 350);
    };
    const onUpdate = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

/**
 * Talk to the content script, injecting it first if the tab predates the
 * extension. Throws PageUnavailable rather than a raw Chrome error, so callers
 * can tell "this page is off limits" from a genuine bug.
 */
class PageUnavailable extends Error {
  constructor(reason) { super(reason); this.name = "PageUnavailable"; }
}

async function talkToPage(tabId, message) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, message);
    if (reply !== undefined) return reply;
  } catch { /* no content script yet — inject below */ }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    throw new PageUnavailable(
      /permission/i.test(error.message)
        ? "this extension isn't allowed on this page (reload the extension after a manifest change)"
        : `can't reach this page: ${error.message}`,
    );
  }

  try {
    const reply = await chrome.tabs.sendMessage(tabId, message);
    if (reply === undefined) throw new Error("no reply");
    return reply;
  } catch (error) {
    throw new PageUnavailable(`page did not respond: ${error.message}`);
  }
}

async function openTabs(currentId) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter((t) => t.id !== currentId)
    .slice(0, 20)
    .map((t) => ({
      id: `t${t.id}`,
      title: (t.title ?? "").slice(0, 80),
      host: (() => { try { return new URL(t.url).host; } catch { return ""; } })(),
    }));
}

/** Handle a finished utterance. Returns a report for the panel to render. */
async function handleUtterance(transcript) {
  // Assistant meta-commands never reach the model.
  const local = matchLocalCommand(transcript);
  if (local) return { kind: "stop", message: "listening paused", local: true };

  // While a message is open, almost everything said is words for that message.
  const mode = await getMode();
  if (mode) return await handleDictation(transcript, mode);

  const tab = await activeTab();

  // A new tab, the settings page, a PDF — nothing to inventory. That is NOT a
  // reason to refuse the command: "go to hacker news", "new tab" and "switch to
  // gmail" all work fine with no page at all, and a new tab is exactly where you
  // are most likely to say one of them.
  const readable = Boolean(tab.url) && !/^(chrome|edge|about|chrome-extension|devtools|view-source|file):/.test(tab.url);

  let inv = {
    page: { title: tab.title ?? "New tab", url: tab.url ?? "", host: "" },
    elements: [],
    typeables: [],
  };
  const tabs = await openTabs(tab.id);

  let pageProblem = null;
  if (readable) {
    try {
      inv = await talkToPage(tab.id, { type: "inventory", utterance: transcript });
    } catch (error) {
      // Page off limits, still loading, or CSP-blocked. Commands that need no
      // page content must still work, so carry on with an empty inventory.
      pageProblem = error.message;
      console.warn("inventory unavailable, continuing without page:", error.message);
    }
  }
  // No usable page, whatever the reason.
  const havePage = readable && !pageProblem;

  const state = {
    utterance: transcript,
    page: inv.page,
    elements: inv.elements,
    typeables: inv.typeables,
    open_tabs: tabs,
  };

  // A chained command is split in code; the multi_step Noul decides whether the
  // split is real. Asked in the same request, so a single command costs nothing.
  const steps = splitSteps(transcript);
  const questions = buildCommandQuestions({ elements: inv.elements, tabs, typeables: inv.typeables, steps });
  const answers = await askJev(state, questions);

  if (steps.length > 1 && (answers.multi_step?.noul ?? 0) >= 0.6) {
    return await runSequence(steps, transcript);
  }

  const decision = resolveCommand(answers, {
    transcript,
    elements: inv.elements,
    typeables: inv.typeables,
    tabs,
    readable: havePage,
  });

  return {
    ...(await carryOut(decision, tab, transcript)),
    answers,
    usage: lastUsage,
    decision,
    page: inv.page,
    pageProblem,
    // What Jev actually had to choose from — the first thing to check on a miss.
    candidates: {
      elements: inv.elements.map((e) => ({ id: e.id, text: e.text, kind: e.kind, where: e.where })),
      typeables: inv.typeables.map((e) => ({ id: e.id, text: e.text, kind: e.kind })),
      tabs,
    },
  };
}

/**
 * One utterance while a message is open. The default is to write it down; see
 * dictation.js for why that default is deliberately hard to escape.
 */
async function handleDictation(transcript, mode) {
  const tab = await activeTab();
  if (tab.id !== mode.tabId) {
    await setMode(null);
    return { kind: "error", message: "you switched tabs, so I stopped writing", why: "dictation_tab_changed" };
  }

  // An exact control phrase skips the model entirely.
  const quick = resolveDictation(null, transcript);
  let answers = null;
  let decision = quick;

  if (quick.why !== "control_phrase") {
    answers = await askJev(
      {
        utterance: transcript,
        writing_into: mode.label ?? "a text box",
        text_so_far: (mode.text ?? "").slice(-300),
      },
      buildDictationQuestions(),
    );
    decision = resolveDictation(answers, transcript);
  }

  const report = (extra) => ({
    ...extra, answers, usage: lastUsage, decision,
    dictation: { active: true, label: mode.label, text: mode.text },
  });

  switch (decision.do) {
    case "append": {
      const text = appendChunk(mode.text ?? "", decision.text);
      const result = await talkToPage(tab.id, {
        type: "execute",
        command: { do: "set_dictation_text", text, note: "wrote that" },
      }).catch((error) => ({ ok: false, error: error.message }));

      if (!result.ok) {
        await setMode(null);
        return report({ kind: "error", message: result.error, why: "dictation_field_lost" });
      }
      await setMode({ ...mode, text });
      return report({ kind: "wrote", message: text, why: decision.why, detail: decision.detail });
    }

    case "new_paragraph": {
      const text = `${(mode.text ?? "").replace(/\s+$/, "")}\n\n`;
      await talkToPage(tab.id, { type: "execute", command: { do: "set_dictation_text", text, note: "new paragraph" } });
      await setMode({ ...mode, text });
      return report({ kind: "wrote", message: text, why: decision.why });
    }

    case "undo": {
      const result = await talkToPage(tab.id, { type: "execute", command: { do: "undo_dictation" } });
      if (result.ok) await setMode({ ...mode, text: result.text ?? "" });
      return report({ kind: result.ok ? "wrote" : "error", message: result.ok ? (result.text ?? "") : result.error, why: decision.why });
    }

    case "clear":
      await setPending({ command: { do: "clear_dictation" }, tabId: tab.id, utterance: transcript, dictation: true });
      return report({ kind: "confirm", message: "Erase everything written so far?", why: decision.why });

    case "send":
      await setPending({ command: { do: "submit_dictation" }, tabId: tab.id, utterance: transcript, dictation: true });
      return report({ kind: "confirm", message: `Send this?\n\n${mode.text ?? ""}`, why: decision.why });

    case "finish":
      await talkToPage(tab.id, { type: "execute", command: { do: "unbind_dictation" } }).catch(() => {});
      await setMode(null);
      return { ...report({ kind: "done", message: "stopped writing", why: decision.why }), dictation: { active: false } };

    default:
      return report({ kind: "error", message: `unhandled dictation action ${decision.do}` });
  }
}

/**
 * Carry out a chained command one step at a time. Each step is resolved fresh
 * against the page as it stands after the previous one, because "go to espn and
 * click scores" cannot resolve "scores" until espn has loaded.
 */
async function runSequence(steps, original) {
  const results = [];

  for (const [index, step] of steps.entries()) {
    const before = await activeTab();
    const beforeUrl = before.url;

    let result;
    try {
      result = await handleUtterance(step);
    } catch (error) {
      results.push({ step, kind: "error", message: error.message });
      break;
    }
    results.push({ step, ...result });

    // Anything needing an answer from you ends the chain: the remaining steps
    // were written for a page that may now never appear.
    if (["confirm", "choose", "clarify", "error"].includes(result.kind)) {
      results.push({ step: null, kind: "ignored", message: `stopped after step ${index + 1} of ${steps.length}` });
      break;
    }

    if (index < steps.length - 1) {
      const after = await activeTab();
      if (after.url !== beforeUrl || result.message?.startsWith?.("going to")) {
        await waitForTabLoad(after.id);
      } else {
        await new Promise((r) => setTimeout(r, 250));  // let the page react
      }
    }
  }

  const ran = results.filter((r) => r.kind === "done" || r.kind === "answer" || r.kind === "wrote").length;
  return {
    kind: "sequence",
    steps: results,
    message: `${ran} of ${steps.length} steps`,
    utterance: original,
  };
}

async function carryOut(decision, tab, transcript) {
  switch (decision.kind) {
    case "ignore":
      return { kind: "ignored", message: decision.reason };

    case "clarify":
      return { kind: "clarify", message: decision.say, debug: decision.debug };

    case "choose":
      return { kind: "choose", message: decision.say, options: decision.options, debug: decision.debug };

    case "confirm":
      await setPending({ command: decision.command, tabId: tab.id, utterance: transcript });
      return { kind: "confirm", message: decision.say, risk: decision.risk };

    case "ask_page":
      return await answerAboutPage(tab, transcript);

    case "compose": {
      const result = await talkToPage(tab.id, { type: "execute", command: decision.command })
        .catch((error) => ({ ok: false, error: error.message }));
      if (!result.ok) return { kind: "error", message: result.error, why: "compose_bind_failed" };
      await setMode({ tabId: tab.id, fieldId: decision.fieldId, label: result.label, text: result.text ?? "" });
      return {
        kind: "composing",
        message: `Writing into ${result.label || "the field"}. Say "stop dictating" when done.`,
        dictation: { active: true, label: result.label, text: result.text ?? "" },
      };
    }

    case "execute":
      return await run(decision.command, tab.id);

    default:
      return { kind: "error", message: `unknown decision ${decision.kind}` };
  }
}

// A pending confirmation must outlive the service worker, which Chrome stops
// after ~30s idle. A module variable would be gone by the time you answered.
const PENDING_KEY = "pendingConfirmation";
const MODE_KEY = "dictationMode";

async function getMode() {
  return (await chrome.storage.session.get(MODE_KEY))[MODE_KEY] ?? null;
}
async function setMode(value) {
  if (value) await chrome.storage.session.set({ [MODE_KEY]: value });
  else await chrome.storage.session.remove(MODE_KEY);
}

async function setPending(value) {
  await chrome.storage.session.set({ [PENDING_KEY]: value });
}
async function takePending() {
  const stored = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] ?? null;
  await chrome.storage.session.remove(PENDING_KEY);
  return stored;
}

/** Report the full outcome of an utterance. Never allowed to break a command. */
async function record(entry) {
  try {
    await fetch(TRACE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: new Date().toISOString(), ...entry }),
    });
  } catch { /* proxy down: the command itself still worked */ }
}

async function run(command, tabId) {
  switch (command.do) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: command.url });
      return { kind: "done", message: `going to ${new URL(command.url).host}` };

    case "new_tab":
      await chrome.tabs.create({});
      return { kind: "done", message: "new tab" };

    case "close_tab": {
      const id = command.id === "current" ? tabId : Number(command.id.slice(1));
      await chrome.tabs.remove(id);
      return { kind: "done", message: "closed tab" };
    }

    case "switch_tab": {
      const id = Number(command.id.slice(1));
      await chrome.tabs.update(id, { active: true });
      return { kind: "done", message: "switched tab" };
    }

    case "stop_listening":
      return { kind: "stop", message: "listening paused" };

    // These tear down the content script as they run, so asking the page to do
    // them means the reply never arrives and a working command looks broken.
    // Chrome's own tab APIs do not have that problem, and they also work on
    // pages where no content script can run.
    case "reload":
      await chrome.tabs.reload(tabId);
      return { kind: "done", message: "reloading" };

    case "history": {
      try {
        if (command.delta < 0) await chrome.tabs.goBack(tabId);
        else await chrome.tabs.goForward(tabId);
      } catch {
        return { kind: "error", message: command.delta < 0 ? "nothing to go back to" : "nothing to go forward to" };
      }
      return { kind: "done", message: command.delta < 0 ? "went back" : "went forward" };
    }

    default: {
      try {
        const result = await talkToPage(tabId, { type: "execute", command });
        return result.ok
          ? { kind: "done", message: result.did }
          : { kind: "error", message: result.error };
      } catch (error) {
        return { kind: "error", message: error.message, why: "page_unavailable" };
      }
    }
  }
}

// ask_page: a second request, justified because its state is page prose rather
// than page controls, and it only exists on this branch.
async function answerAboutPage(tab, question) {
  let sections, page;
  try {
    ({ sections, page } = await talkToPage(tab.id, { type: "sections" }));
  } catch (error) {
    return { kind: "error", message: `I can't read this page — ${error.message}`, why: "page_unavailable" };
  }
  if (!sections.length) return { kind: "error", message: "nothing readable on this page" };

  const answers = await askJev(
    { question, page, sections },
    {
      answered: {
        type: "noul",
        instructions: "Do the entries in `sections` contain enough to answer `question`?",
        criteria: {
          true: "At least one section directly addresses the question",
          false: "The page is about something else, or only mentions it in passing without answering",
        },
      },
      best_section: {
        type: "choice",
        instructions: {
          question: "Which entry in `sections` best answers `question`?",
          focus: "Pick the section a person would be shown. Prefer the one that answers over one that merely mentions the topic.",
        },
        criteria: {
          ...Object.fromEntries(sections.map((s) => [s.id, s.text.slice(0, 200)])),
          none: "No section answers the question",
        },
      },
    },
  );

  const answered = answers.answered.noul;
  const best = answers.best_section;

  if (answered < 0.45 || best.choice === "none") {
    return { kind: "answer", message: "I don't think this page answers that.", usage: lastUsage, answers };
  }

  // Scrolling to the section is a nicety; never lose the answer over it.
  try {
    await talkToPage(tab.id, { type: "execute", command: { do: "highlight", id: best.choice } });
  } catch { /* the answer below is still useful */ }
  const section = sections.find((s) => s.id === best.choice);
  return {
    kind: "answer",
    message: section?.text ?? "found it",
    certainty: answered,
    confidence: best.confidence,
    usage: lastUsage,
    answers,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    try {
      if (msg.type === "utterance") {
        const started = Date.now();
        let result;
        try {
          result = await handleUtterance(msg.transcript);
        } catch (error) {
          await record({
            utterance: msg.transcript,
            executed: false,
            outcome: "error",
            why: "exception",
            detail: error.message,
            ms: Date.now() - started,
          });
          throw error;
        }
        if (result.kind === "sequence") {
          for (const step of result.steps) {
            if (!step.step) continue;
            await record({
              utterance: `${msg.transcript}  ‹step: ${step.step}›`,
              executed: ["done", "answer", "wrote"].includes(step.kind),
              outcome: step.kind,
              why: step.decision?.why ?? step.why ?? null,
              detail: step.decision?.detail ?? step.message ?? null,
              answers: step.answers ?? null,
            });
          }
        }
        await record({
          utterance: msg.transcript,
          executed: result.kind === "done" || result.kind === "answer" || result.kind === "stop"
                 || (result.kind === "sequence" && result.steps.every((x) => !x.step || ["done","answer","wrote"].includes(x.kind))),
          outcome: result.kind,
          why: result.decision?.why ?? (result.local ? "local_command" : result.why ?? null),
          detail: result.decision?.detail ?? result.message ?? null,
          command: result.decision?.command ?? null,
          message: result.message ?? null,
          page: result.page ?? null,
          candidates: result.candidates ?? null,
          answers: result.answers ?? null,
          usage: result.usage ?? null,
          ms: Date.now() - started,
        });
        respond(result);
      } else if (msg.type === "confirm") {
        const pending = await takePending();
        if (!pending) return respond({ kind: "error", message: "nothing to confirm" });
        const { command, tabId, utterance } = pending;
        let outcome;
        if (!msg.yes) {
          outcome = { kind: "ignored", message: "cancelled by user" };
        } else if (pending.dictation) {
          const r = await talkToPage(tabId, { type: "execute", command }).catch((e) => ({ ok: false, error: e.message }));
          outcome = r.ok ? { kind: "done", message: r.did ?? "done" } : { kind: "error", message: r.error };
          if (command.do === "submit_dictation" && r.ok) await setMode(null);
          if (command.do === "clear_dictation" && r.ok) {
            const mode = await getMode();
            if (mode) await setMode({ ...mode, text: "" });
          }
        } else {
          outcome = await run(command, tabId);
        }
        await record({
          utterance: `${utterance ?? "(confirm)"} → ${msg.yes ? "CONFIRMED" : "CANCELLED"}`,
          executed: msg.yes && outcome.kind === "done",
          outcome: outcome.kind,
          why: msg.yes ? "user_confirmed" : "user_cancelled",
          detail: outcome.message ?? null,
          command,
        });
        respond(outcome);
      } else if (msg.type === "dictation_state") {
        respond({ mode: await getMode() });
      } else if (msg.type === "end_dictation") {
        const mode = await getMode();
        if (mode) await talkToPage(mode.tabId, { type: "execute", command: { do: "unbind_dictation" } }).catch(() => {});
        await setMode(null);
        respond({ kind: "done", message: "stopped writing", dictation: { active: false } });
      } else if (msg.type === "pick") {
        const tab = await activeTab();
        respond(await run({ do: "click", id: msg.id }, tab.id));
      }
    } catch (error) {
      respond({ kind: "error", message: error.message });
    }
  })();
  return true; // async response
});
