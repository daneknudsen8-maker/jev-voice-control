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
  compose: "Begin dictating a longer piece of writing into a field on the page — an email, a message, a comment, a post. Use when the user wants to START writing and will speak the words after, e.g. 'write an email', 'compose a message', 'start dictating in the comment box', 'let me write a reply'. NOT for a short phrase the user already said in the same breath.",
  type: "Enter text into a field or text box ON THE CURRENT PAGE. Use for 'type ...', 'enter ...', 'write ...', 'put ... in the ... box', and for searching the current site when the user says so explicitly: 'search this site for ...', 'search the page for ...', 'search Amazon for ...'.",
  scroll: "Move the page up or down without activating anything.",
  navigate: "Leave the current page for a different website or a WEB search. Use for 'go to ...', 'open ...', 'google ...', and for a plain 'search for ...' with no site named — a bare search means the whole web. Use only when the destination is NOT already open in `open_tabs`.",
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
/**
 * Candidate split of a chained command. Code does the splitting because it is
 * string work; a Noul decides whether the split is real, since "click the login
 * and password fields" is one action and "go to espn and click scores" is two.
 */
export function splitSteps(transcript) {
  const parts = transcript
    .split(/\s*,?\s+(?:and\s+then|then|and)\s+/gi)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [transcript.trim()];
}

export function buildCommandQuestions({ elements, tabs, typeables, steps }) {
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

    names_a_site: {
      type: "noul",
      instructions: "In `utterance`, is the user naming a specific website they want to visit, rather than describing something they want to search the web for?",
      criteria: {
        true: "Names a site or brand you would expect to have its own address, such as 'go to espn', 'open notion', 'take me to costco'",
        false: "Describes a topic, question, or thing to look up, such as 'find flights to denver' or 'search for rust async'",
      },
    },

    ...(steps && steps.length > 1 ? {
      multi_step: {
        type: "noul",
        instructions: {
          question: "Does `utterance` ask for two or more separate browser actions to be carried out one after another?",
          focus: `Compare against this proposed split: ${JSON.stringify(steps)}. Answer yes only if each part is an action in its own right.`,
        },
        criteria: {
          true: "Two or more distinct actions in sequence, e.g. 'go to espn and click scores', 'open gmail then search for invoices'",
          false: "One single action, even when it names several things joined by 'and', e.g. 'click the login and password fields', 'search for cats and dogs'",
        },
      },
    } : {}),

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
        focus: "Match what the user said against each element's text and role. Prefer an exact wording match, then closest meaning. When the user says a position such as 'the second email' or 'the last link', use each entry's `position` label — the entries are listed in page order.",
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
  if (el.where) d.region = el.where;
  // Position is given as a label so "the second email" is a selection rather
  // than a count — see docs/typesafe/01-limits.md #2.
  if (el.position) d.position = `${el.position} in ${el.where}`;
  if (el.last) d.note = "the last one";
  return d;
}

/**
 * Naming a thing with no verb — "Loom", "starred", "inbox" — is a real way
 * people talk to a voice interface, but it reads as conversation, so the
 * is_command Noul rightly scores it low. Rather than lower that bar for
 * everything (microphone noise scored 0.23 in practice), allow it only when the
 * words uniquely match something actually on screen.
 */
function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function strongNameMatch(transcript, elements = [], tabs = []) {
  const said = normalize(transcript);
  if (said.length < 3 || said.split(" ").length > 4) return null;

  const hit = (text) => {
    const candidate = normalize(text);
    if (!candidate) return false;
    if (candidate === said) return true;
    // Whole-word containment, so "C" never matches "CMC" and "compost" never
    // matches "compose".
    return new RegExp(`(^|\\s)${said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`).test(candidate);
  };

  const tabHits = tabs.filter((t) => hit(t.title) || hit(t.host));
  const elementHits = elements.filter((e) => hit(e.text));

  // Ambiguous means it is not a name, it is a word. Only a unique hit counts.
  if (tabHits.length === 1 && elementHits.length === 0) return { kind: "tab", id: tabHits[0].id, label: tabHits[0].title };
  if (elementHits.length === 1 && tabHits.length === 0) return { kind: "element", id: elementHits[0].id, label: elementHits[0].text };
  if (tabHits.length === 1 && elementHits.length === 1) return { kind: "tab", id: tabHits[0].id, label: tabHits[0].title };
  return null;
}

// Below this there is not even enough signal to trust a name match.
const NAME_MATCH_FLOOR = 0.15;

// A bare site name — "canvas", "notion" — reads as conversation and scores low
// on is_command, but the names_a_site Noul separates it sharply from noise: in
// a real session, site names scored 0.80-0.92 while every misheard fragment sat
// at 0.03-0.22. Allowed only with that corroboration and a real destination.
const SITE_NAME_COMMAND_FLOOR = 0.30;
const SITE_NAME_CONFIRMATION = 0.75;

/**
 * A verb said outright. "Click on CMC email" is an instruction about THIS page;
 * it must never turn into switching to some tab that happens to have CMC email
 * open. The action Choice sees a matching tab and reasonably wants to switch,
 * so the explicit verb has to win before that judgment is consulted.
 *
 * Only unambiguous verbs. "open" is deliberately absent: "open gmail" really
 * can mean the tab.
 */
const EXPLICIT_VERBS = [
  [/^(?:please\s+)?(?:click|press|tap|hit|push|select)\b/i, "click"],
  [/^(?:please\s+)?(?:scroll)\b/i, "scroll"],
  [/^(?:please\s+)?(?:reload|refresh)\b/i, "reload"],
];

export function matchExplicitVerb(transcript) {
  const said = transcript.trim();
  for (const [pattern, action] of EXPLICIT_VERBS) if (pattern.test(said)) return action;
  return null;
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
export function resolveCommand(answers, ctx) {
  const { transcript, elements, typeables, tabs } = ctx;
  const byId = new Map([...elements, ...typeables].map((el) => [el.id, el]));

  /**
   * The thing they named may be on the page rather than in a tab or a URL —
   * a bookmark tile, a shortcut, a link. "go to CMC email" on a new-tab page
   * means the tile called CMC email. Falls back to the target answer, which is
   * already asked in every request.
   */
  const onPage = (floor = FLOORS.target) => {
    const t = answers.target;
    if (!t || t.choice === "no_match" || t.confidence < floor) return null;
    const el = byId.get(t.choice);
    return el ? { id: t.choice, el, confidence: t.confidence } : null;
  };

  const action = answers.action;
  const isCommand = answers.is_command?.noul ?? 1;
  const risk = answers.risk?.score ?? 0;

  if (!ctx.readable && ["click", "type", "scroll", "ask_page"].includes(action.choice)) {
    return { kind: "clarify", why: "no_page", say: "There's no page open yet — try 'go to' a website first.",
             detail: `action=${action.choice} needs page content; current tab is not readable` };
  }
  // An explicit verb outranks the action judgment. Said before anything is
  // resolved, so a matching tab cannot hijack "click".
  const spokenVerb = matchExplicitVerb(transcript);
  if (spokenVerb === "click" && ["switch_tab", "navigate", "new_tab"].includes(action.choice)) {
    const here = onPage(0.5);
    if (here) {
      return { kind: "execute", command: { do: "click", id: here.id }, why: "explicit_click",
               detail: `"click" was spoken, so the page wins over ${action.choice}` };
    }
    return {
      kind: "clarify", why: "explicit_click_no_target",
      say: ctx.readable
        ? "I don't see that on this page."
        : "I can't read this page, so there's nothing to click — try \"go to\" instead.",
      detail: `"click" was spoken but no element matched (action was ${action.choice}@${action.confidence.toFixed(2)})`,
    };
  }

  if (action.choice === "stop" && action.confidence > 0.8) {
    return { kind: "execute", command: { do: "stop_listening" }, why: "ok" };
  }
  if (isCommand < IS_COMMAND_FLOOR) {
    // A bare name that matches exactly one thing on screen is a command.
    const named = isCommand >= NAME_MATCH_FLOOR ? strongNameMatch(transcript, elements, tabs) : null;
    if (named) {
      return named.kind === "tab"
        ? { kind: "execute", command: { do: "switch_tab", id: named.id }, why: "named_tab",
            detail: `bare name matched tab "${named.label}" (is_command ${isCommand.toFixed(2)})` }
        : { kind: "execute", command: { do: "click", id: named.id }, why: "named_element",
            detail: `bare name matched "${named.label}" (is_command ${isCommand.toFixed(2)})` };
    }
    // Nothing on screen matched. A bare site name, corroborated by
    // names_a_site and resolvable to an address, is still a command.
    const namesSite = answers.names_a_site?.noul ?? 0;
    if (isCommand >= SITE_NAME_COMMAND_FLOOR && namesSite >= SITE_NAME_CONFIRMATION
        && ["navigate", "switch_tab"].includes(action.choice)) {
      const query = extractSearchQuery(transcript);
      const url = spokenDomain(transcript) ?? KNOWN_SITES[query?.toLowerCase()] ?? guessDomain(query ?? "");
      if (url) {
        return { kind: "execute", command: { do: "navigate", url }, why: "bare_site_name",
                 detail: `names_a_site ${namesSite.toFixed(2)} with is_command ${isCommand.toFixed(2)}` };
      }
    }

    return { kind: "ignore", why: "not_a_command", detail: `is_command ${isCommand.toFixed(2)} < ${IS_COMMAND_FLOOR}`, isCommand };
  }
  if (action.choice === "none") {
    return { kind: "ignore", why: "action_none", detail: `Jev read this as not a browser action (conf ${action.confidence.toFixed(2)})` };
  }
  if (action.confidence < FLOORS.action) {
    // click, switch_tab and navigate all mean "open this thing", so probability
    // spread across them is not real uncertainty about intent. "go to CMC
    // email" on a page of tiles splits 0.37 three ways while the tile itself
    // scores 1.00. An unambiguous target settles it.
    const openish = ["click", "switch_tab", "navigate"];
    const openShare = openish.reduce((sum, k) => sum + (action.probabilities?.[k] ?? 0), 0);
    const here = onPage(0.85);
    if (here && openShare >= 0.7) {
      return { kind: "execute", command: { do: "click", id: here.id }, why: "named_on_page",
               detail: `action split ${action.confidence.toFixed(2)} across open-ish actions (${openShare.toFixed(2)}); target "${here.el.text}" ${here.confidence.toFixed(2)}` };
    }
    return { kind: "clarify", why: "action_unclear", say: "I didn't catch that — could you say it again?", detail: `action=${action.choice} conf ${action.confidence.toFixed(2)} < ${FLOORS.action}` };
  }

  const confirmFor = (cmd, label) => {
    const byRisk = risk >= CONFIRM_RISK;
    const byWord = DANGER.test(label ?? "");
    return byRisk || byWord
      ? { kind: "confirm", command: cmd, why: byRisk ? "risk_gate" : "danger_word",
          say: `Confirm: ${label}?`, risk,
          detail: byRisk ? `risk ${risk.toFixed(2)} >= ${CONFIRM_RISK}` : `target text matched danger pattern` }
      : { kind: "execute", command: cmd, why: "ok", risk };
  };

  switch (action.choice) {
    case "scroll": {
      const dir = answers.scroll_direction;
      return { kind: "execute", command: { do: "scroll", direction: dir?.choice ?? "down" }, why: "ok" };
    }

    case "back":     return { kind: "execute", command: { do: "history", delta: -1 }, why: "ok" };
    case "forward":  return { kind: "execute", command: { do: "history", delta: 1 }, why: "ok" };
    case "reload":   return { kind: "execute", command: { do: "reload" }, why: "ok" };
    case "new_tab":  return { kind: "execute", command: { do: "new_tab" }, why: "ok" };
    case "stop":     return { kind: "execute", command: { do: "stop_listening" }, why: "ok" };

    case "click": {
      const target = answers.target;
      if (!target || target.choice === "no_match") {
        return { kind: "clarify", why: "target_no_match", say: "I couldn't find that on the page.", detail: "Jev saw no matching element in the candidate list" };
      }
      if (target.confidence < FLOORS.target) {
        const ranked = Object.entries(target.probabilities)
          .filter(([id]) => id !== "no_match")
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => byId.get(id))
          .filter(Boolean);
        return { kind: "choose", why: "target_ambiguous", options: ranked, say: "Which one did you mean?", detail: `target conf ${target.confidence.toFixed(2)} < ${FLOORS.target}` };
      }
      const el = byId.get(target.choice);
      return confirmFor({ do: "click", id: target.choice }, el?.text ?? "that");
    }

    case "compose": {
      const field = answers.field;
      if (!field || field.choice === "no_match") {
        // No writable box yet. If something on the page looks like it opens one
        // — Gmail's Compose, a "Reply" or "New message" button — click that
        // first and bind to whatever box it produces.
        const opener = answers.target;
        if (opener && opener.choice !== "no_match" && opener.confidence >= FLOORS.target) {
          return { kind: "compose_via", why: "open_composer_first",
                   command: { do: "click", id: opener.choice },
                   detail: `no field yet; opening via "${elements.find((e) => e.id === opener.choice)?.text ?? opener.choice}"` };
        }
        return { kind: "clarify", why: "no_field_to_compose",
                 say: "I don't see a text box to write in — open one first, or say 'click compose'.",
                 detail: "no typeable field and nothing that looks like it opens one" };
      }
      if (field.confidence < FLOORS.field) {
        return { kind: "clarify", why: "field_unresolved", say: "Which box should I write in?",
                 detail: `field conf ${field.confidence.toFixed(2)} < ${FLOORS.field}` };
      }
      return { kind: "compose", why: "ok", command: { do: "bind_dictation", id: field.choice }, fieldId: field.choice };
    }

    case "type": {
      const field = answers.field;
      const text = extractDictation(transcript);
      if (!text) {
        return { kind: "clarify", why: "no_dictation_text", say: "What should I type?", detail: "regex found no text after the type/search verb" };
      }
      if (!field || field.choice === "no_match" || field.confidence < FLOORS.field) {
        return { kind: "clarify", why: "field_unresolved", say: "I couldn't tell which field to type into.", detail: `field=${field?.choice} conf ${field?.confidence?.toFixed(2) ?? "n/a"}` };
      }
      // The TEXT is verbatim from ASR. Jev only chose the field.
      return confirmFor({ do: "type", id: field.choice, text }, `type "${text}"`);
    }

    case "navigate": {
      // 1. An address spoken outright needs no model at all.
      const spoken = spokenDomain(transcript);
      if (spoken) {
        return { kind: "execute", command: { do: "navigate", url: spoken }, risk, why: "ok_spoken_domain" };
      }

      // 2. A bookmark or tile on the page that clearly matches. Someone's own
      //    shortcut is more specific than a generic domain — a tile called
      //    "Gcal" may point at a particular calendar, not calendar.google.com.
      const strongHere = onPage(0.85);
      if (strongHere) {
        return { kind: "execute", command: { do: "click", id: strongHere.id }, why: "named_on_page",
                 detail: `clicked "${strongHere.el.text}" on the page (${strongHere.confidence.toFixed(2)}) rather than guessing a URL` };
      }

      // 3. A site we know by name.
      const dest = answers.destination;
      if (dest && dest.choice !== "web_search" && dest.confidence >= FLOORS.destination) {
        return { kind: "execute", command: { do: "navigate", url: KNOWN_SITES[dest.choice] }, risk, why: "ok" };
      }

      // Before falling back to a web search, a weaker page match will still do.
      const here = onPage(0.6);
      if (here) {
        return { kind: "execute", command: { do: "click", id: here.id }, why: "named_on_page",
                 detail: `not a known site; clicked "${here.el.text}" on the page (${here.confidence.toFixed(2)})` };
      }

      const query = extractSearchQuery(transcript);
      if (!query) {
        return { kind: "clarify", why: "no_destination", say: "Where would you like to go?", detail: "no site named and no search query extractable" };
      }

      // 3. Jev says this names a site, and it is a single word we can turn into
      //    a domain. Code builds the URL — the model only made the judgment.
      const namesSite = answers.names_a_site?.noul ?? 0;
      const guess = guessDomain(query);
      if (namesSite >= 0.6 && guess) {
        return { kind: "execute", command: { do: "navigate", url: guess }, risk, why: "ok_guessed_domain" };
      }

      // 4. Otherwise search for what was actually said.
      return {
        kind: "execute",
        command: { do: "navigate", url: `https://www.google.com/search?q=${encodeURIComponent(query)}` },
        risk, why: "ok_web_search",
      };
    }

    case "switch_tab":
    case "close_tab": {
      const closing = action.choice === "close_tab";
      const t = answers.tab_target;

      // With no other tabs open the tab_target question is never asked, so
      // "close this tab" must still resolve. Treat an absent or no-match
      // answer on a close as meaning the tab in front of you.
      const target = (!t || t.choice === "no_match") ? "current" : t.choice;

      // "go to CMC email" on a page of bookmark tiles splits the action almost
      // evenly between click and switch_tab, and which one wins varies run to
      // run. The targets do not: the tile scores 1.00 while the nearest tab
      // scores 0.27. When the page match is overwhelmingly stronger, trust it
      // rather than the coin flip above it.
      if (!closing) {
        const here = onPage(0.8);
        const tabConfidence = t && t.choice !== "no_match" ? t.confidence : 0;
        if (here && here.confidence > tabConfidence + 0.3) {
          return { kind: "execute", command: { do: "click", id: here.id }, why: "named_on_page",
                   detail: `page "${here.el.text}" ${here.confidence.toFixed(2)} beat tab ${tabConfidence.toFixed(2)}` };
        }
      }

      const tabUnresolved = (!closing && target === "current")
        || (target !== "current" && t && t.confidence < FLOORS.tab);

      if (tabUnresolved && !closing) {
        // No tab matched, but they may have named something on the page.
        const here = onPage();
        if (here) {
          return { kind: "execute", command: { do: "click", id: here.id }, why: "named_on_page",
                   detail: `no matching tab; clicked "${here.el.text}" on the page (${here.confidence.toFixed(2)})` };
        }
        return t && t.confidence < FLOORS.tab && target !== "current"
          ? { kind: "clarify", why: "tab_ambiguous", say: "Which tab did you mean?", detail: `tab conf ${t.confidence.toFixed(2)} < ${FLOORS.tab}` }
          : { kind: "clarify", why: "tab_no_match", say: "Which tab?", detail: "no matching tab and nothing on the page matched" };
      }
      if (tabUnresolved && closing) {
        return { kind: "clarify", why: "tab_ambiguous", say: "Which tab did you mean?", detail: `tab conf ${t?.confidence?.toFixed(2)} < ${FLOORS.tab}` };
      }

      if (!closing) {
        return { kind: "execute", command: { do: "switch_tab", id: target }, why: "ok" };
      }

      // Closing the tab you are looking at is explicit and reversible
      // (cmd-shift-T), so it runs. Closing one you named but cannot see is
      // where a misheard word does damage, so that confirms.
      if (target === "current") {
        return { kind: "execute", command: { do: "close_tab", id: "current" }, why: "ok", risk };
      }
      const tab = tabs.find((x) => x.id === target);
      return {
        kind: "confirm",
        command: { do: "close_tab", id: target },
        why: "close_other_tab",
        say: `Close "${tab?.title ?? "that tab"}"?`,
        detail: "closing a tab you are not looking at always confirms",
        risk,
      };
    }

    case "ask_page":
      // Needs different state (page prose, not controls), and only matters on this
      // branch — a genuine second request. See docs/typesafe/00-core.md.
      return { kind: "ask_page", why: "ok", query: transcript };

    default:
      return { kind: "ignore", why: "unhandled_action", detail: `no handler for action "${action.choice}"` };
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

/**
 * Tab movement by position rather than by name. Position is arithmetic, and Jev
 * is documented as unreliable at it — "go left one tab" scored 0.17 in practice.
 * Code owns it: deterministic, instant, free.
 *
 * Returns { move: "left"|"right"|"first"|"last"|"back", count } or null.
 */
const TAB_MOVES = [
  // "switch back" is the last tab you used. Plain "go back" is NOT here: that is
  // browser history, and stealing it would break a much commoner command.
  [/^(?:go\s+|move\s+|switch\s+)?back\s+to(?:\s+the)?\s+(?:other|previous|last)\s+tab$/i, { move: "back" }],
  [/^switch\s+back$/i, { move: "back" }],
  [/^(?:the\s+)?other\s+tab$/i, { move: "back" }],
  [/^(?:go\s+|move\s+|switch\s+(?:to\s+)?)?(?:the\s+)?(?:next|right)\s+tab$/i, { move: "right" }],
  [/^(?:go\s+|move\s+|switch\s+(?:to\s+)?)?(?:the\s+)?(?:previous|prior|left)\s+tab$/i, { move: "left" }],
  [/^(?:go|move)\s+(left|right)(?:\s+(one|two|three|\d+))?(?:\s+tabs?)?$/i, "directional"],
  [/^(?:switch\s+to\s+)?(?:the\s+)?tab\s+to\s+the\s+(left|right)(?:\s+of.*)?$/i, "directional"],
  [/^(?:go\s+|switch\s+to\s+)?(?:the\s+)?(first|last)\s+tab$/i, "position"],
];

const WORD_COUNTS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

export function matchTabNavigation(transcript) {
  const text = transcript.trim().replace(/[.!?]+$/, "");
  for (const [pattern, spec] of TAB_MOVES) {
    const m = text.match(pattern);
    if (!m) continue;
    if (spec === "directional") {
      const count = m[2] ? (WORD_COUNTS[m[2].toLowerCase()] ?? Number(m[2]) ?? 1) : 1;
      return { move: m[1].toLowerCase(), count: Number.isFinite(count) ? count : 1 };
    }
    if (spec === "position") return { move: m[1].toLowerCase() === "first" ? "first" : "last" };
    return { ...spec, count: 1 };
  }
  return null;
}

export function matchLocalCommand(transcript) {
  const text = transcript.trim().replace(/[.!?]+$/, "");
  for (const [pattern, command] of LOCAL_COMMANDS) {
    if (pattern.test(text)) return command;
  }
  return null;
}

// Dictation text must come from the transcript verbatim — Jev cannot generate it.
// Longest alternatives first, so "search this site for X" is not mis-split by
// the bare "search" branch.
const DICTATION_LEAD = new RegExp(
  "^(?:please\\s+)?(?:" +
    "search\\s+(?:this\\s+site|this\\s+page|the\\s+page|the\\s+site|here|[a-z][\\w-]{1,20})\\s+for" +
    "|search\\s+for|search" +
    "|look\\s+up|fill\\s+in(?:\\s+with)?" +
    "|type|enter|write|input|dictate|put" +
  ")\\s+(.*)$",
  "i",
);
const DICTATION_TAIL = /\s+(?:in(?:to)?|on)\s+(?:the\s+)?[\w\s]{0,30}(?:box|field|bar|input|search|form)$/i;

export function extractDictation(transcript) {
  const m = transcript.trim().match(DICTATION_LEAD);
  if (!m) return null;
  let text = m[1].trim().replace(DICTATION_TAIL, "").trim();
  text = text.replace(/^["'](.*)["']$/, "$1");
  return text || null;
}

// An address said out loud: "go to espn dot com", "open github.com".
const TLDS = "com|org|net|io|ai|dev|co|edu|gov|tv|me|app|xyz|uk|ca";
const SPOKEN_DOMAIN = new RegExp(`\\b([a-z0-9][a-z0-9-]{1,30})\\s*(?:\\.|\\s+dot\\s+)\\s*(${TLDS})\\b`, "i");

export function spokenDomain(transcript) {
  const m = transcript.match(SPOKEN_DOMAIN);
  return m ? `https://${m[1].toLowerCase()}.${m[2].toLowerCase()}` : null;
}

/**
 * Turn a spoken site name into an address. Only for a single word: "espn" is
 * safely espn.com, but "the new york times" is not thenewyorktimes.com, so
 * multi-word names fall through to a search instead of guessing wrong.
 */
export function guessDomain(query) {
  const name = query.trim().toLowerCase()
    .replace(/^(?:the|a)\s+/, "")
    .replace(/\s+(?:website|site|homepage|dot com)$/, "")
    .trim();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(name)) return null;
  return `https://${name}.com`;
}

const NAV_LEAD = /^(?:please\s+)?(?:go\s+to|open|visit|navigate\s+to|take\s+me\s+to|show\s+me|find|search\s+(?:for|))\s+(.*)$/i;

export function extractSearchQuery(transcript) {
  const m = transcript.trim().match(NAV_LEAD);
  const q = (m ? m[1] : transcript).trim().replace(/^(?:the\s+)?(?:website\s+)?/i, "");
  return q || null;
}
