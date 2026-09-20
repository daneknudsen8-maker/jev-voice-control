// Orchestrator. Owns tab operations and all traffic to the proxy.
// The panel sends transcripts here; this decides what happens.

import { buildCommandQuestions, matchLocalCommand, resolveCommand } from "./commands.js";
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

  const questions = buildCommandQuestions({ elements: inv.elements, tabs, typeables: inv.typeables });
  const answers = await askJev(state, questions);

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

async function carryOut(decision, tab, transcript) {
  switch (decision.kind) {
    case "ignore":
      return { kind: "ignored", message: decision.reason };

    case "clarify":
      return { kind: "clarify", message: decision.say, debug: decision.debug };

    case "choose":
      return { kind: "choose", message: decision.say, options: decision.options, debug: decision.debug };

    case "confirm":
      pending = { command: decision.command, tabId: tab.id, utterance: transcript };
      return { kind: "confirm", message: decision.say, risk: decision.risk };

    case "ask_page":
      return await answerAboutPage(tab, transcript);

    case "execute":
      return await run(decision.command, tab.id);

    default:
      return { kind: "error", message: `unknown decision ${decision.kind}` };
  }
}

let pending = null;

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
        await record({
          utterance: msg.transcript,
          executed: result.kind === "done" || result.kind === "answer" || result.kind === "stop",
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
        if (!pending) return respond({ kind: "error", message: "nothing to confirm" });
        const { command, tabId, utterance } = pending;
        pending = null;
        const outcome = msg.yes ? await run(command, tabId) : { kind: "ignored", message: "cancelled by user" };
        await record({
          utterance: `${utterance ?? "(confirm)"} → ${msg.yes ? "CONFIRMED" : "CANCELLED"}`,
          executed: msg.yes && outcome.kind === "done",
          outcome: outcome.kind,
          why: msg.yes ? "user_confirmed" : "user_cancelled",
          detail: outcome.message ?? null,
          command,
        });
        respond(outcome);
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
