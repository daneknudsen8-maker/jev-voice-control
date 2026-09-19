// Jev question design for voice browser control.
//
// Everything here follows one rule from the TypeSafe docs: Jev SELECTS, it never
// GENERATES. Element targets, tab targets and destinations are all Choice options
// that code enumerated first. Any literal text (dictation, search terms) comes
// verbatim from the ASR transcript, never from the model.
//
// See docs/typesafe/03-design-patterns.md (speculative fan-out) and
// docs/typesafe/01-limits.md #9 (generation).

// Sites reachable by name. Edit freely — these become Choice options.
export const KNOWN_SITES = {
  "google": "https://www.google.com",
  "gmail": "https://mail.google.com",
  "youtube": "https://www.youtube.com",
  "github": "https://github.com",
  "hacker news": "https://news.ycombinator.com",
  "reddit": "https://www.reddit.com",
  "wikipedia": "https://en.wikipedia.org",
  "amazon": "https://www.amazon.com",
  "maps": "https://maps.google.com",
  "calendar": "https://calendar.google.com",
  "chatgpt": "https://chat.openai.com",
  "claude": "https://claude.ai",
  "typesafe docs": "https://docs.typesafe.ai",
};

export const ACTIONS = {
  click: "Activate something on the page: a link, button, checkbox, menu item, or tab. Use for 'click', 'press', 'open', 'select', 'choose', 'tap', 'hit'.",
  type: "Enter text into a field, search box, or text area. Use for 'type', 'enter', 'search for', 'write', 'put ... in'.",
  scroll: "Move the page up or down without activating anything.",
  navigate: "Leave the current page for a different website or a web search. Use this only when the destination is NOT already open in `open_tabs`.",
  back: "Return to the previous page in history.",
  forward: "Go forward again in history.",
  reload: "Reload or refresh the current page.",
  new_tab: "Open a new empty browser tab.",
  close_tab: "Close a browser tab.",
  switch_tab: "Move to a tab that is already open — including when the user names a site that appears in `open_tabs`, since switching to it beats loading it again.",
  ask_page: "Answer a question about what is on the current page, or locate a section of it. The user wants information, not an action. Use for 'is there', 'does this page', 'find the', 'what does it say about'.",
  stop: "Stop listening for voice commands. Use for 'stop listening', 'pause', 'go to sleep'.",
  none: "The speech is not a browser command at all: background conversation, an unfinished thought, or nonsense from the microphone.",
};

/**
 * One request carrying every question the command might need (speculative fan-out).
 * Irrelevant answers are simply not read — see resolveCommand.
 */
export function buildCommandQuestions({ elements, tabs, typeables }) {
  const questions = {
    action: {
      type: "choice",
      instructions: {
        question: "What does the user want the browser to do, in `utterance`?",
        focus: "Judge the user's intent. `page` and `elements` are context for what is currently on screen.",
      },
      criteria: ACTIONS,
    },

    // Absolute, not relative: the action Choice always picks *something*, so this
    // Noul is what tells us the utterance was a command at all.
    // docs/typesafe/01-limits.md #8 — Choice is relative, Noul is absolute.
    is_command: {
      type: "noul",
      instructions: "Is `utterance` addressed to the browser — either an instruction to do something, or a question the user wants answered about the page on screen — rather than conversation, thinking aloud, or microphone noise?",
      criteria: {
        true: "An instruction to the browser, OR a question about the current page such as 'is there a refund policy here' or 'find the pricing section'",
        false: "Talk between people, an unfinished phrase, a filler sound, or speech aimed at someone other than the browser",
      },
    },

    // Asked about the utterance, not the resolved element: questions in one request
    // cannot see each other's answers. Code adds an element-level danger check after
    // the target is known.
    risk: {
      type: "score",
      instructions: {
        question: "If the browser carries out `utterance` and the user did not mean it, how hard is that to undo?",
        focus: "Judge the consequence of the action itself, not how confident the phrasing sounds.",
      },
      criteria: [
        "Trivially reversible: scrolling, going back, switching tabs, reading the page",
        "Mildly annoying to undo: navigating away, reloading, closing one tab, typing in a field",
        "Sends or changes something: submitting a form, posting, purchasing, sending a message",
        "Destroys or discloses something: deleting, permanently removing, confirming a payment, revealing private data",
      ],
    },

    scroll_direction: {
      type: "choice",
      instructions: "If `utterance` asks to scroll, in which direction?",
      criteria: {
        down: "Further down the page",
        up: "Back up the page",
        top: "All the way to the very top",
        bottom: "All the way to the very bottom",
      },
    },

    destination: {
      type: "choice",
      instructions: {
        question: "If `utterance` asks to visit a different website, which one?",
        focus: "Pick `web_search` when the user names something not in this list, or is describing what they want to find rather than naming a site.",
      },
      criteria: {
        ...Object.fromEntries(Object.keys(KNOWN_SITES).map((name) => [name, null])),
        web_search: "A site not listed here, or a description of something to search for",
      },
    },
  };

  // Element targeting: options are ids code assigned. Jev picks one; it never
  // invents a selector. Capped well under the 255-option limit by rankElements().
  if (elements.length > 0) {
    questions.target = {
      type: "choice",
      instructions: {
        question: "If `utterance` asks to click or activate something, which entry in `elements` does it mean?",
        focus: "Match on what the user said against each element's text and role. Prefer an exact wording match; otherwise the closest meaning.",
      },
      criteria: {
        ...Object.fromEntries(elements.map((el) => [el.id, describeElement(el)])),
        no_match: "Nothing in `elements` matches what the user described, or the user is not asking to click anything",
      },
    };
  }

  if (typeables.length > 0) {
    questions.field = {
      type: "choice",
      instructions: {
        question: "If `utterance` asks to type, search, or enter text, which entry in `typeables` should receive it?",
        focus: "Choose by what the field is for. Ignore the text the user wants to enter.",
      },
      criteria: {
        ...Object.fromEntries(typeables.map((el) => [el.id, describeElement(el)])),
        no_match: "No suitable field, or the user is not asking to enter text",
      },
    };
  }

  if (tabs.length > 0) {
    questions.tab_target = {
      type: "choice",
      instructions: "If `utterance` asks to switch to or close another tab, which entry in `open_tabs` does it mean?",
      criteria: {
        ...Object.fromEntries(tabs.map((t) => [t.id, `${t.title} — ${t.host}`])),
        current: "The tab the user is looking at right now",
        no_match: "No particular tab, or not a tab command",
      },
    };
  }

  return questions;
}

function describeElement(el) {
  const d = { role: el.kind, text: el.text };
  if (el.hint) d.description = el.hint;
  if (el.where) d.position = el.where;
  return d;
}

// Confidence floors, scaled to consequence — docs/typesafe/00-core.md.
// Below the floor we ask rather than act.
const FLOORS = {
  action: 0.45,
  target: 0.40,
  field: 0.40,
  destination: 0.35,
  tab: 0.35,
};
const IS_COMMAND_FLOOR = 0.5;
const CONFIRM_RISK = 1.6;   // on the 0–3 risk scale
const DANGER = /\b(delete|remove|deactivate|close account|cancel (subscription|plan)|buy|purchase|place order|pay|checkout|confirm|submit|send|post|publish|transfer|withdraw|unsubscribe|sign out|log out)\b/i;

/**
 * Turn Jev's answers into a command for content.js, reading only the answers
 * that the chosen action actually needs.
 *
 * Returns { kind: "execute" | "confirm" | "clarify" | "ignore", ... }
 */
export function resolveCommand(answers, { transcript, elements, typeables, tabs }) {
  const action = answers.action;
  const isCommand = answers.is_command?.noul ?? 1;
  const risk = answers.risk?.score ?? 0;

  if (action.choice === "stop" && action.confidence > 0.8) {
    return { kind: "execute", command: { do: "stop_listening" } };
  }
  if (isCommand < IS_COMMAND_FLOOR) {
    return { kind: "ignore", reason: `not a command (${isCommand.toFixed(2)})` };
  }
  if (action.choice === "none") {
    return { kind: "ignore", reason: "no browser action" };
  }
  if (action.confidence < FLOORS.action) {
    return { kind: "clarify", say: "I didn't catch that — could you say it again?", debug: `action confidence ${action.confidence.toFixed(2)}` };
  }

  const byId = new Map([...elements, ...typeables].map((el) => [el.id, el]));
  const confirmFor = (cmd, label) =>
    risk >= CONFIRM_RISK || DANGER.test(label ?? "")
      ? { kind: "confirm", command: cmd, say: `Confirm: ${label}?`, risk }
      : { kind: "execute", command: cmd, risk };

  switch (action.choice) {
    case "scroll": {
      const dir = answers.scroll_direction;
      return { kind: "execute", command: { do: "scroll", direction: dir?.choice ?? "down" } };
    }

    case "back":     return { kind: "execute", command: { do: "history", delta: -1 } };
    case "forward":  return { kind: "execute", command: { do: "history", delta: 1 } };
    case "reload":   return { kind: "execute", command: { do: "reload" } };
    case "new_tab":  return { kind: "execute", command: { do: "new_tab" } };
    case "stop":     return { kind: "execute", command: { do: "stop_listening" } };

    case "click": {
      const target = answers.target;
      if (!target || target.choice === "no_match") {
        return { kind: "clarify", say: "I couldn't find that on the page.", debug: "target no_match" };
      }
      if (target.confidence < FLOORS.target) {
        const ranked = Object.entries(target.probabilities)
          .filter(([id]) => id !== "no_match")
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => byId.get(id))
          .filter(Boolean);
        return { kind: "choose", options: ranked, say: "Which one did you mean?", debug: `target confidence ${target.confidence.toFixed(2)}` };
      }
      const el = byId.get(target.choice);
      return confirmFor({ do: "click", id: target.choice }, el?.text ?? "that");
    }

    case "type": {
      const field = answers.field;
      const text = extractDictation(transcript);
      if (!text) {
        return { kind: "clarify", say: "What should I type?", debug: "no dictation text in transcript" };
      }
      if (!field || field.choice === "no_match" || field.confidence < FLOORS.field) {
        return { kind: "clarify", say: "I couldn't tell which field to type into.", debug: `field ${field?.choice} @ ${field?.confidence?.toFixed(2)}` };
      }
      // The TEXT is verbatim from ASR. Jev only chose the field.
      return confirmFor({ do: "type", id: field.choice, text }, `type "${text}"`);
    }

    case "navigate": {
      const dest = answers.destination;
      if (dest && dest.choice !== "web_search" && dest.confidence >= FLOORS.destination) {
        return { kind: "execute", command: { do: "navigate", url: KNOWN_SITES[dest.choice] }, risk };
      }
      const query = extractSearchQuery(transcript);
      if (!query) {
        return { kind: "clarify", say: "Where would you like to go?", debug: "no destination and no query" };
      }
      return {
        kind: "execute",
        command: { do: "navigate", url: `https://www.google.com/search?q=${encodeURIComponent(query)}` },
        risk,
      };
    }

    case "switch_tab":
    case "close_tab": {
      const t = answers.tab_target;
      const closing = action.choice === "close_tab";
      if (!t || t.choice === "no_match") {
        if (closing) return confirmFor({ do: "close_tab", id: "current" }, "close this tab");
        return { kind: "clarify", say: "Which tab?", debug: "tab no_match" };
      }
      if (t.choice !== "current" && t.confidence < FLOORS.tab) {
        return { kind: "clarify", say: "Which tab did you mean?", debug: `tab confidence ${t.confidence.toFixed(2)}` };
      }
      const tab = tabs.find((x) => x.id === t.choice);
      const label = t.choice === "current" ? "this tab" : (tab?.title ?? "that tab");
      // Always confirm a close: a tab may hold unsaved work, and Jev reasonably
      // rates it low-risk since Chrome can reopen it. Policy belongs in code.
      return closing
        ? { kind: "confirm", command: { do: "close_tab", id: t.choice }, say: `Close ${label}?`, risk }
        : { kind: "execute", command: { do: "switch_tab", id: t.choice } };
    }

    case "ask_page":
      // Needs different state (page prose, not controls), and only matters on this
      // branch — a genuine second request. See docs/typesafe/00-core.md.
      return { kind: "ask_page", query: transcript };

    default:
      return { kind: "ignore", reason: `unhandled action ${action.choice}` };
  }
}

/**
 * Commands aimed at the voice assistant rather than the browser. Matched in code
 * before any API call: deterministic, instant, free, and still working when the
 * proxy is down. Returns a command or null.
 */
const LOCAL_COMMANDS = [
  [/^(?:jev[,\s]+)?(?:stop|pause|quit|cancel)\s+(?:listening|for now)$/i, { do: "stop_listening" }],
  [/^(?:jev[,\s]+)?(?:go\s+to\s+sleep|sleep|shut\s+up|never\s+mind)$/i, { do: "stop_listening" }],
  [/^(?:jev[,\s]+)?stop$/i, { do: "stop_listening" }],
];

export function matchLocalCommand(transcript) {
  const text = transcript.trim().replace(/[.!?]+$/, "");
  for (const [pattern, command] of LOCAL_COMMANDS) {
    if (pattern.test(text)) return command;
  }
  return null;
}

// Dictation text must come from the transcript verbatim — Jev cannot generate it.
const DICTATION_LEAD = /^(?:please\s+)?(?:type|enter|write|input|search\s+(?:for|)|look\s+up|put|fill\s+in(?:\s+with)?)\s+(.*)$/i;
const DICTATION_TAIL = /\s+(?:in(?:to)?|on)\s+(?:the\s+)?[\w\s]{0,30}(?:box|field|bar|input|search|form)$/i;

export function extractDictation(transcript) {
  const m = transcript.trim().match(DICTATION_LEAD);
  if (!m) return null;
  let text = m[1].trim().replace(DICTATION_TAIL, "").trim();
  text = text.replace(/^["'](.*)["']$/, "$1");
  return text || null;
}

const NAV_LEAD = /^(?:please\s+)?(?:go\s+to|open|visit|navigate\s+to|take\s+me\s+to|show\s+me|find|search\s+(?:for|))\s+(.*)$/i;

export function extractSearchQuery(transcript) {
  const m = transcript.trim().match(NAV_LEAD);
  const q = (m ? m[1] : transcript).trim().replace(/^(?:the\s+)?(?:website\s+)?/i, "");
  return q || null;
}
