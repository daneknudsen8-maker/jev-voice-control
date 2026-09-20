// Orchestrator. Owns tab operations and all traffic to the proxy.
// The panel sends transcripts here; this decides what happens.

import { buildCommandQuestions, matchLocalCommand, matchTabNavigation, resolveCommand, splitSteps } from "./commands.js";
import { appendChunk, buildDictationQuestions, resolveDictation } from "./dictation.js";
import { buildComposeQuestions, REPLACES, resolveCompose, spokenEmail } from "./compose.js";
import { buildTaskQuestions, dateCandidates, MAX_STEPS, resolveDates, resolveTaskStep, valueCandidates } from "./task.js";
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

/** Move between tabs by position. All arithmetic, so none of it involves Jev. */
async function moveTab(spec) {
  const current = await activeTab();
  const tabs = (await chrome.tabs.query({ windowId: current.windowId })).filter((t) => !isOurs(t));
  if (tabs.length < 2 && spec.move !== "back") {
    return { kind: "error", message: "there's only one tab open", why: "single_tab" };
  }

  if (spec.move === "back") {
    const history = (await chrome.storage.session.get(TAB_HISTORY_KEY))[TAB_HISTORY_KEY] ?? [];
    const previous = history.find((id) => id !== current.id);
    if (previous === undefined) return { kind: "error", message: "no other tab to go back to", why: "no_tab_history" };
    try {
      const tab = await chrome.tabs.update(previous, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { kind: "done", message: `back to ${(tab.title ?? "that tab").slice(0, 50)}` };
    } catch {
      return { kind: "error", message: "that tab was closed", why: "tab_gone" };
    }
  }

  const index = tabs.findIndex((t) => t.id === current.id);
  const count = spec.count ?? 1;
  let target;
  if (spec.move === "first") target = 0;
  else if (spec.move === "last") target = tabs.length - 1;
  else {
    // Wrap around, the way ctrl-tab does.
    const delta = spec.move === "right" ? count : -count;
    target = ((index + delta) % tabs.length + tabs.length) % tabs.length;
  }

  const tab = tabs[target];
  await chrome.tabs.update(tab.id, { active: true });
  return { kind: "done", message: `${(tab.title ?? "tab").slice(0, 50)}` };
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

const LAST_TAB_KEY = "lastRealTab";
const TAB_HISTORY_KEY = "tabHistory";

function isOurs(tab) {
  return !tab?.url || tab.url.startsWith(chrome.runtime.getURL(""));
}

// Remember the page you were last on. Clicking a button in the panel makes the
// panel the last-focused window, so querying for it would aim every following
// command at ourselves instead of your page.
async function rememberTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isOurs(tab)) return;
    const history = (await chrome.storage.session.get(TAB_HISTORY_KEY))[TAB_HISTORY_KEY] ?? [];
    const next = [tab.id, ...history.filter((id) => id !== tab.id)].slice(0, 10);
    await chrome.storage.session.set({ [LAST_TAB_KEY]: tab.id, [TAB_HISTORY_KEY]: next });
  } catch { /* tab already gone */ }
}

chrome.tabs.onActivated.addListener(({ tabId }) => { rememberTab(tabId); });
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await rememberTab(tab.id);
});

async function activeTab() {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused[0] && !isOurs(focused[0])) return focused[0];

  // The panel had focus. Fall back to the page you were actually last on.
  const storedId = (await chrome.storage.session.get(LAST_TAB_KEY))[LAST_TAB_KEY];
  if (storedId !== undefined) {
    try {
      const tab = await chrome.tabs.get(storedId);
      if (!isOurs(tab)) return tab;
    } catch { /* closed since */ }
  }

  const anyActive = (await chrome.tabs.query({ active: true })).filter((t) => !isOurs(t));
  if (anyActive.length) return anyActive[0];
  throw new Error("no page open — open a website first");
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
    .filter((t) => t.id !== currentId && !isOurs(t))
    .slice(0, 20)
    .map((t) => ({
      id: `t${t.id}`,
      title: (t.title ?? "").slice(0, 80),
      host: (() => { try { return new URL(t.url).host; } catch { return ""; } })(),
    }));
}

/** Handle a finished utterance. Returns a report for the panel to render. */
async function handleUtterance(transcript, { skipMode = false } = {}) {
  // Assistant meta-commands never reach the model.
  const local = matchLocalCommand(transcript);
  if (local) return { kind: "stop", message: "listening paused", local: true };

  // While a message is open, almost everything said is words for that message.
  // skipMode is set when compose mode has already decided this utterance is a
  // browser command rather than part of the message.
  if (!skipMode) {
    const mode = await getMode();
    if (mode?.kind === "compose") return await handleCompose(transcript, mode);
    if (mode) return await handleDictation(transcript, mode);
  }

  // Tab movement by position: arithmetic, so code decides it.
  const tabMove = matchTabNavigation(transcript);
  if (tabMove) return { ...(await moveTab(tabMove)), why: "tab_navigation", local: true };

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
 * One utterance while a structured message (recipient, subject, body) is open.
 * The chosen field persists: people name a field and speak its value as two
 * separate utterances.
 */
async function handleCompose(transcript, mode) {
  const tab = await activeTab();
  if (tab.id !== mode.tabId) {
    await setMode(null);
    return { kind: "error", message: "you switched tabs, so I stopped writing", why: "compose_tab_changed" };
  }

  const available = Object.keys(mode.fields ?? {});
  const quick = resolveCompose(null, transcript, mode.currentField);
  let answers = null;
  let decision = quick;

  // An exact control or an explicitly named field needs no model call.
  if (!["control_phrase", "named_field", "named_field_only"].includes(quick.why)) {
    answers = await askJev(
      {
        utterance: transcript,
        current_field: mode.currentField ?? "body",
        message_so_far: mode.text ?? {},
      },
      buildComposeQuestions(available),
    );
    decision = resolveCompose(answers, transcript, mode.currentField);
  }

  const report = (extra) => ({
    ...extra, answers, usage: lastUsage, decision,
    compose: { active: true, fields: available, currentField: extra.currentField ?? mode.currentField, text: extra.text ?? mode.text },
  });

  switch (decision.do) {
    case "switch":
      await setMode({ ...mode, currentField: decision.role });
      return report({ kind: "field", message: `${decision.role}…`, currentField: decision.role, why: decision.why, detail: decision.detail });

    case "write": {
      const role = available.includes(decision.role) ? decision.role : (available.includes("body") ? "body" : available[0]);
      if (!role) return report({ kind: "error", message: "this message has no fields I can write to", why: "no_fields" });

      const previous = mode.text?.[role] ?? "";
      // Recipients replace and commit to a chip; subject and body accumulate.
      const value = REPLACES.has(role) ? spokenEmail(decision.text) : appendChunk(previous, decision.text);

      const result = await talkToPage(tab.id, {
        type: "execute",
        command: { do: "write_field", role, text: value, commit: REPLACES.has(role) },
      }).catch((error) => ({ ok: false, error: error.message }));

      if (!result.ok) return report({ kind: "error", message: result.error, why: "write_failed" });

      const text = { ...(mode.text ?? {}), [role]: value };
      await setMode({ ...mode, currentField: role, text });
      return report({ kind: "field_written", message: `${role}: ${value}`, currentField: role, text, why: decision.why, detail: decision.detail });
    }

    case "undo": {
      const result = await talkToPage(tab.id, { type: "execute", command: { do: "undo_composer" } })
        .catch((error) => ({ ok: false, error: error.message }));
      if (!result.ok) return report({ kind: "error", message: result.error, why: decision.why });
      const text = { ...(mode.text ?? {}), [result.role]: result.text ?? "" };
      await setMode({ ...mode, text });
      return report({ kind: "field_written", message: `undid ${result.role}`, text, why: decision.why });
    }

    // A browser command spoken while the message is open: run it, keep the
    // message open so writing can continue afterwards.
    case "other_command": {
      const result = await handleUtterance(transcript, { skipMode: true });
      return { ...result, answers, usage: lastUsage, decision,
               compose: { active: true, fields: available, currentField: mode.currentField, text: mode.text } };
    }

    case "read_back": {
      const t = mode.text ?? {};
      const lines = available.filter((r) => t[r]).map((r) => `${r}: ${t[r]}`);
      return report({ kind: "answer", message: lines.length ? lines.join("\n") : "nothing written yet", why: decision.why });
    }

    case "clear":
      await setPending({ command: { do: "clear_composer" }, tabId: tab.id, utterance: transcript, compose: true });
      return report({ kind: "confirm", message: "Erase this message and start over?", why: decision.why });

    case "send": {
      const t = mode.text ?? {};
      const preview = available.filter((r) => t[r]).map((r) => `${r}: ${t[r]}`).join("\n");
      await setPending({ command: { do: "send_composer" }, tabId: tab.id, utterance: transcript, compose: true });
      return report({ kind: "confirm", message: `Send this?\n\n${preview || "(empty)"}`, why: decision.why });
    }

    case "finish":
      await talkToPage(tab.id, { type: "execute", command: { do: "unbind_compose" } }).catch(() => {});
      await setMode(null);
      return { ...report({ kind: "done", message: "stopped composing", why: decision.why }), compose: { active: false } };

    default:
      return report({ kind: "error", message: `unhandled compose action ${decision.do}` });
  }
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

/**
 * Run a stated goal as a sequence of bounded steps, until it is met, the loop
 * gets stuck, a step needs a person, or the step limit is reached.
 *
 * Each step is a fresh judgment against the page as it stands, because that is
 * the only thing Jev can usefully answer. Nothing is planned ahead.
 */
async function runTask(goal, existing = null) {
  const task = existing ?? { goal, steps: [], startedAt: Date.now(), dates: resolveDates(goal) };
  const done = (kind, message, extra = {}) => {
    const result = { kind, message, task: { ...task, running: false }, ...extra };
    return result;
  };

  while (task.steps.length < MAX_STEPS) {
    const tab = await activeTab();
    const readable = Boolean(tab.url) && !/^(chrome|edge|about|chrome-extension|devtools|view-source|file):/.test(tab.url);
    if (!readable) {
      await setTask(null);
      return done("task_stopped", "I can't read this page, so I stopped.", { why: "no_page" });
    }

    let inv;
    try {
      inv = await talkToPage(tab.id, { type: "inventory", utterance: goal });
    } catch (error) {
      await setTask(null);
      return done("task_stopped", `Lost the page: ${error.message}`, { why: "page_unavailable" });
    }

    // Values are enumerated by code; Jev only selects among them. Relative
    // dates are worked out here too, since date arithmetic is not something
    // Jev does reliably — it gets real days to pick from instead.
    const pageValues = inv.typeables.map((t) => t.text).filter(Boolean);
    const dates = task.dates ?? resolveDates(goal);
    const values = valueCandidates(goal, [...pageValues, ...dateCandidates(dates)]);

    const state = {
      goal,
      step_number: task.steps.length + 1,
      page: inv.page,
      elements: inv.elements,
      typeables: inv.typeables,
      history: task.steps.map((s) => s.label),
      ...(dates.length ? { dates } : {}),
    };

    const answers = await askJev(state, buildTaskQuestions({
      elements: inv.elements, typeables: inv.typeables, values, dates,
    }));

    const step = resolveTaskStep(answers, {
      values, history: task.steps, elements: inv.elements, typeables: inv.typeables, goal,
    });

    if (step.do === "done") {
      await setTask(null);
      return done("task_done", `Done — ${goal}`, { why: step.why, detail: step.detail, answers, usage: lastUsage });
    }
    if (step.do === "stuck") {
      await setTask({ ...task, running: false });
      return done("task_stopped", `Stopped: ${step.detail}`, { why: step.why, answers, usage: lastUsage });
    }
    if (step.do === "ask") {
      // A consequential step. Hold the task and wait for a person.
      await setTask({ ...task, running: false, pendingStep: step });
      await setPending({ command: step.command, tabId: tab.id, utterance: goal, task: true });
      return {
        kind: "confirm",
        message: `${step.label}?

This can't easily be undone (risk ${step.risk.toFixed(1)}).`,
        task: { ...task, running: false },
        why: step.why, answers, usage: lastUsage,
      };
    }

    // Ordinary step: do it.
    const before = tab.url;
    const result = await runStepCommand(step.command, tab.id);
    task.steps.push({ label: step.label, command: step.command, ok: result.ok, at: Date.now() });
    await setTask({ ...task, running: true });

    if (!result.ok) {
      await setTask({ ...task, running: false });
      return done("task_stopped", `Step failed: ${result.error}`, { why: "step_failed", answers, usage: lastUsage });
    }

    await settle(tab.id, before);
  }

  await setTask({ ...task, running: false });
  return done("task_stopped", `Stopped after ${MAX_STEPS} steps without finishing.`, { why: "step_limit" });
}

/** Execute one task step, whether it belongs to the page or the browser. */
async function runStepCommand(command, tabId) {
  if (command.do === "navigate") {
    await chrome.tabs.update(tabId, { url: command.url });
    return { ok: true };
  }
  if (command.do === "history") {
    try {
      await chrome.tabs.goBack(tabId);
      return { ok: true };
    } catch { return { ok: false, error: "nothing to go back to" }; }
  }
  return await talkToPage(tabId, { type: "execute", command })
    .catch((error) => ({ ok: false, error: error.message }));
}

/** Give the page a chance to react, and wait properly if it navigated. */
async function settle(tabId, urlBefore) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url !== urlBefore || tab.status === "loading") await waitForTabLoad(tabId);
  } catch { /* tab closed */ }
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

/**
 * Bind whatever is open for writing. A form with a recipient/subject/body gets
 * structured compose mode; a lone comment box gets plain dictation.
 */
async function beginWriting(tabId, seedId) {
  const form = await talkToPage(tabId, { type: "execute", command: { do: "bind_compose", id: seedId } })
    .catch((error) => ({ ok: false, error: error.message }));

  const roles = form.ok ? Object.keys(form.fields ?? {}) : [];
  const structured = roles.some((r) => r !== "body");   // more than just a box

  if (form.ok && structured) {
    const first = form.fields.to ? "to" : (form.fields.subject ? "subject" : "body");
    await setMode({ kind: "compose", tabId, fields: form.fields, currentField: first, text: form.text ?? {} });
    return {
      kind: "composing",
      message: `Writing an email. Fields: ${roles.join(", ")}. Start with "to …", or say "the subject should be …".`,
      compose: { active: true, fields: roles, currentField: first, text: form.text ?? {} },
    };
  }

  // Just one box: plain dictation.
  const bindId = seedId ?? (form.ok ? Object.values(form.fields)[0] : undefined);
  const bound = await talkToPage(tabId, { type: "execute", command: { do: "bind_dictation", id: bindId } })
    .catch((error) => ({ ok: false, error: error.message }));
  if (!bound.ok) return { kind: "error", message: bound.error, why: "compose_bind_failed" };

  await setMode({ kind: "dictation", tabId, fieldId: bindId, label: bound.label, text: bound.text ?? "" });
  return {
    kind: "composing",
    message: `Writing into ${bound.label || "the field"}. Say "stop dictating" when done.`,
    dictation: { active: true, label: bound.label, text: bound.text ?? "" },
  };
}

    // Click the thing that opens a composer, wait for it, then bind to the box
    // it produced. Two page interactions, one spoken command.
    case "compose_via": {
      const clicked = await talkToPage(tab.id, { type: "execute", command: decision.command })
        .catch((error) => ({ ok: false, error: error.message }));
      if (!clicked.ok) return { kind: "error", message: clicked.error, why: "composer_open_failed" };

      await new Promise((r) => setTimeout(r, 700));   // let the composer appear

      return await beginWriting(tab.id, undefined);
    }

    case "task":
      return await runTask(decision.goal);

    case "compose":
      return await beginWriting(tab.id, decision.fieldId);

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
const TASK_KEY = "runningTask";

async function getTask() {
  return (await chrome.storage.session.get(TASK_KEY))[TASK_KEY] ?? null;
}
async function setTask(value) {
  if (value) await chrome.storage.session.set({ [TASK_KEY]: value });
  else await chrome.storage.session.remove(TASK_KEY);
}

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

// Every result kind that means the command did what was asked. Writing into a
// message and switching fields are successes; leaving them out made successful
// dictation show up as failures in the session report.
const SUCCESS_KINDS = new Set([
  "done", "answer", "stop", "wrote", "field", "field_written", "composing",
]);

function didSucceed(result) {
  if (result.kind === "sequence") {
    return result.steps.every((s) => !s.step || SUCCESS_KINDS.has(s.kind));
  }
  return SUCCESS_KINDS.has(result.kind);
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
              executed: SUCCESS_KINDS.has(step.kind),
              outcome: step.kind,
              why: step.decision?.why ?? step.why ?? null,
              detail: step.decision?.detail ?? step.message ?? null,
              answers: step.answers ?? null,
            });
          }
        }
        await record({
          utterance: msg.transcript,
          executed: didSucceed(result),
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
        } else if (pending.task) {
          const task = await getTask();
          if (!msg.yes) {
            await setTask(null);
            outcome = { kind: "task_stopped", message: "Task cancelled.", task: { ...(task ?? {}), running: false } };
          } else {
            const step = task?.pendingStep;
            const r = await runStepCommand(command, tabId);
            if (!r.ok) {
              await setTask(null);
              outcome = { kind: "task_stopped", message: `Step failed: ${r.error}` };
            } else {
              const steps = [...(task?.steps ?? []), { label: step?.label ?? "confirmed step", command, ok: true, at: Date.now() }];
              await settle(tabId, undefined);
              // Continue the loop from where it paused.
              outcome = await runTask(task?.goal ?? pending.utterance, { goal: task?.goal ?? pending.utterance, steps, startedAt: task?.startedAt ?? Date.now() });
            }
          }
        } else if (pending.compose) {
          const cmd = command.do === "clear_composer"
            ? { do: "write_field", role: (await getMode())?.currentField ?? "body", text: "" }
            : command;
          const r = await talkToPage(tabId, { type: "execute", command: cmd }).catch((e) => ({ ok: false, error: e.message }));
          outcome = r.ok ? { kind: "done", message: r.did ?? "done" } : { kind: "error", message: r.error };
          if (command.do === "send_composer" && r.ok) await setMode(null);
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
      } else if (msg.type === "task_state") {
        respond({ task: await getTask() });
      } else if (msg.type === "stop_task") {
        const task = await getTask();
        await setTask(null);
        respond({ kind: "task_stopped", message: "Stopped.", task: { ...(task ?? {}), running: false } });
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
