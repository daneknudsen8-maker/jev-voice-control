// Running a stated goal as a sequence of bounded steps.
//
// Jev is not an agent model: it does not plan, does not generate, and does not
// choose its own next action in any open-ended sense. What it does is judge one
// bounded question about the state in front of it. So CODE owns the loop --
// counting steps, detecting repeats, executing, waiting -- and Jev answers, at
// each turn, "given the goal and this page, which single thing happens next".
//
// This is the docs' own shape: "Code can retain goals and observations while
// fresh judgments guide the next bounded step."
//
// The consequence is a greedy loop. It cannot plan several moves ahead or
// recover creatively when a site surprises it. It can follow an obvious path.

export const MAX_STEPS = 25;

// A step whose consequence scores at or above this needs a person.
export const CONFIRM_RISK = 1.5;

export const TASK_ACTIONS = {
  click: "Activate one thing on the page that moves toward the goal — a link, a button, a menu item, a date, a result.",
  type: "Put text into one field on the page.",
  scroll: "Move further down the page to bring more of it into view. Use when what the goal needs is probably below the fold.",
  back: "Return to the previous page, because this one turned out to be a dead end.",
  search_web: "Run a web search for the goal, because this page has nothing to do with it and a search is the way to reach a site that does. Use this on a blank tab, a home page, or an unrelated site.",
  done: "The goal has been achieved. Nothing further is needed.",
  stuck: "There is no sensible next step on this page toward the goal — the site is asking for something unavailable, or nothing here relates to the goal.",
};

/**
 * Candidate values for a typing step. Jev cannot generate text, so code
 * enumerates every phrase that could plausibly be typed and Jev selects one.
 * Sources are the goal itself and, for "fill this in from that email", text
 * already on the page.
 */
export function valueCandidates(goal, pageValues = []) {
  const words = goal.trim().split(/\s+/).filter(Boolean);
  const spans = new Set();

  // Every 1-to-5 word run of the goal. The right value is nearly always one.
  for (let n = 1; n <= 5; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const span = words.slice(i, i + n).join(" ").replace(/^[^\w$]+|[^\w%)]+$/g, "").trim();
      if (span.length >= 2) spans.add(span);
    }
  }
  for (const value of pageValues) {
    const trimmed = String(value ?? "").trim();
    if (trimmed.length >= 2 && trimmed.length <= 80) spans.add(trimmed);
  }

  // Drop pure filler, which is never the value being asked for.
  const FILLER = /^(?:a|an|the|and|or|for|to|in|on|at|of|my|me|i|is|it|this|that|with|from|find|get|fill|out|please|some)$/i;
  return [...spans].filter((s) => !FILLER.test(s)).slice(0, 120);
}

/**
 * One request per step. Every question is about the same page, so they run in
 * parallel; code reads only the ones the chosen action needs.
 */
export function buildTaskQuestions({ elements, typeables, values, dates = [] }) {
  const questions = {
    next_action: {
      type: "choice",
      instructions: {
        question: "Working towards `goal`, and looking at the page described by `page`, `elements` and `typeables`, what is the single next thing to do?",
        focus: "One step only, the obvious next one. `history` lists what has already been done, so do not repeat it. Answer `done` only if the goal is already achieved on this page.",
      },
      criteria: TASK_ACTIONS,
    },

    // Asked separately from next_action because the two answers are useful
    // apart: a step can be worth taking even when the goal is nearly met.
    goal_met: {
      type: "noul",
      instructions: {
        question: "Has `goal` already been achieved, judging by the page in front of you?",
        focus: "Judge what is on screen now, not what might come next. A goal that asks to FIND, SEARCH FOR or SHOW something is achieved as soon as the matching results are on screen — the user can choose among them. Opening one of the results is a further step they did not ask for.",
      },
      criteria: {
        true: {
          what: "The page already shows what the goal asked for",
          examples: [
            "the goal was to find places to stay, and a list of places with prices is showing",
            "the goal was to search for something, and the results are on screen",
            "the goal was to fill in a form, and the fields hold the right values",
          ],
        },
        false: {
          what: "There is still work to do, or this is the wrong page entirely",
          examples: [
            "a search form is filled in but not yet submitted",
            "the page is a home page, a login screen, or an unrelated site",
          ],
        },
      },
    },

    risk: {
      type: "score",
      instructions: {
        question: "If the next step on this page is carried out and it turns out to be wrong, how hard is that to undo?",
        focus: "Judge the consequence on this page — what the visible buttons would do — not the goal as a whole.",
      },
      criteria: [
        "Trivially reversible: scrolling, opening a listing, going back, running a search",
        "Mildly annoying: navigating away, losing a filled-in form, closing something",
        "Sends or commits something: submitting a form, posting, applying, booking a hold",
        "Spends money or cannot be taken back: paying, confirming a purchase, deleting, sending a message to a person",
      ],
    },
  };

  if (elements.length) {
    questions.target = {
      type: "choice",
      instructions: {
        question: "If the next step is to click something, which entry in `elements` moves closest towards `goal`?",
        focus: "Prefer the element that advances the goal, not merely one that matches its words. Entries are listed in page order and carry a `position` label."
          + (dates.length
            ? " When choosing a day in a calendar, use `dates`: the words in the goal have already been worked out into real dates there, so match those rather than interpreting the words again."
            : ""),
      },
      criteria: {
        ...Object.fromEntries(elements.map((el) => [el.id, describe(el)])),
        no_match: "Nothing here is worth clicking for this goal",
      },
    };
  }

  if (typeables.length) {
    questions.field = {
      type: "choice",
      instructions: "If the next step is to type, which entry in `typeables` should receive the text?",
      criteria: {
        ...Object.fromEntries(typeables.map((el) => [el.id, describe(el)])),
        no_match: "No field here needs filling in for this goal",
      },
    };

    if (values.length) {
      questions.value = {
        type: "choice",
        instructions: {
          question: "If the next step is to type, which of these candidate texts should be entered?",
          focus: "These are phrases taken from `goal` and from the page. Choose the one that belongs in the field being filled. Do not choose a phrase that merely describes the task.",
        },
        criteria: {
          ...Object.fromEntries(values.map((v, i) => [`v${i}`, v])),
          no_match: "None of these is the right text",
        },
      };
    }
  }

  return questions;
}

function describe(el) {
  const d = { role: el.kind, text: el.text };
  if (el.where) d.region = el.where;
  if (el.position) d.position = el.position;
  return d;
}

const ACTION_FLOOR = 0.35;
const TARGET_FLOOR = 0.40;
const FIELD_FLOOR = 0.40;
const VALUE_FLOOR = 0.35;
const GOAL_MET_FLOOR = 0.55;

/**
 * Turn one step's answers into something to do.
 * Returns { do, ... } where `do` is act | done | stuck | ask.
 */
export function resolveTaskStep(answers, { values, history, elements, typeables, goal = "" }) {
  const action = answers.next_action;
  const goalMet = answers.goal_met?.noul ?? 0;
  const risk = answers.risk?.score ?? 0;

  if (goalMet >= GOAL_MET_FLOOR || action.choice === "done") {
    return { do: "done", why: "goal_met", detail: `goal_met ${goalMet.toFixed(2)} · action ${action.choice}@${action.confidence.toFixed(2)}` };
  }
  if (action.choice === "stuck") {
    return { do: "stuck", why: "no_next_step", detail: `nothing on this page advances the goal (${action.confidence.toFixed(2)})` };
  }
  if (action.confidence < ACTION_FLOOR) {
    return { do: "stuck", why: "action_unclear", detail: `next action unclear (${action.choice}@${action.confidence.toFixed(2)})` };
  }

  const byId = new Map([...elements, ...typeables].map((el) => [el.id, el]));
  const needsPerson = risk >= CONFIRM_RISK;

  switch (action.choice) {
    case "scroll":
      return { do: "act", command: { do: "scroll", direction: "down" }, label: "scroll down", risk, why: "ok" };

    case "back":
      return { do: "act", command: { do: "history", delta: -1 }, label: "go back", risk, why: "ok" };

    case "search_web": {
      if (history.some((h) => h.command?.do === "navigate")) {
        return { do: "stuck", why: "repeat", detail: "already searched the web for this and it did not help" };
      }
      return { do: "act", label: `search the web for "${goal}"`, risk, why: "ok",
               command: { do: "navigate", url: `https://www.google.com/search?q=${encodeURIComponent(goal)}` } };
    }

    case "click": {
      const target = answers.target;
      if (!target || target.choice === "no_match") {
        return { do: "stuck", why: "nothing_to_click", detail: "no element here advances the goal" };
      }
      if (target.confidence < TARGET_FLOOR) {
        return { do: "stuck", why: "target_unclear", detail: `target ${target.confidence.toFixed(2)} < ${TARGET_FLOOR}` };
      }
      const el = byId.get(target.choice);
      const label = `click "${el?.text ?? target.choice}"`;
      // Repeating an identical click means the last one did nothing.
      if (history.some((h) => h.command?.id === target.choice && h.command?.do === "click")) {
        return { do: "stuck", why: "repeat", detail: `already clicked "${el?.text}" and the page did not move on` };
      }
      return needsPerson
        ? { do: "ask", command: { do: "click", id: target.choice }, label, risk, why: "risk_gate" }
        : { do: "act", command: { do: "click", id: target.choice }, label, risk, why: "ok" };
    }

    case "type": {
      const field = answers.field;
      const value = answers.value;
      if (!field || field.choice === "no_match" || field.confidence < FIELD_FLOOR) {
        return { do: "stuck", why: "no_field", detail: `field ${field?.choice ?? "none"}@${field?.confidence?.toFixed(2) ?? "-"}` };
      }
      if (!value || value.choice === "no_match" || value.confidence < VALUE_FLOOR) {
        return { do: "stuck", why: "no_value",
                 detail: "none of the phrases from the goal fits this field — say the value out loud and try again" };
      }
      const text = values[Number(value.choice.slice(1))];
      if (text === undefined) return { do: "stuck", why: "bad_value", detail: `unknown value id ${value.choice}` };

      const el = byId.get(field.choice);
      const label = `type "${text}" into ${el?.text ?? "the field"}`;
      if (history.some((h) => h.command?.do === "type" && h.command?.id === field.choice && h.command?.text === text)) {
        return { do: "stuck", why: "repeat", detail: `already typed "${text}" there` };
      }
      return needsPerson
        ? { do: "ask", command: { do: "type", id: field.choice, text }, label, risk, why: "risk_gate" }
        : { do: "act", command: { do: "type", id: field.choice, text }, label, risk, why: "ok" };
    }

    default:
      return { do: "stuck", why: "unhandled", detail: `no handler for ${action.choice}` };
  }
}

// --------------------------------------------------------------------------
// Dates
//
// "Next week" has to become actual days before a date picker can be clicked,
// and Jev reads dates as text rather than ordered quantities — arithmetic on
// them is documented as unreliable (docs/typesafe/01-limits.md #3). So code
// works out what the words mean and hands Jev concrete days to select from.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * Concrete dates implied by a goal, as {label, start, end}. Returns [] when no
 * date is named — most goals do not involve one.
 */
export function resolveDates(goal, today = new Date()) {
  const said = goal.toLowerCase();
  const found = [];
  const base = new Date(today);
  base.setHours(12, 0, 0, 0);   // midday, so DST cannot shift the day

  if (/\btoday\b/.test(said))     found.push({ label: "today", start: base, end: base });
  if (/\btomorrow\b/.test(said))  found.push({ label: "tomorrow", start: addDays(base, 1), end: addDays(base, 1) });

  // "next week" = the coming Monday through the Sunday after it.
  if (/\bnext week\b/.test(said)) {
    const daysToMonday = (8 - base.getDay()) % 7 || 7;
    const start = addDays(base, daysToMonday);
    found.push({ label: "next week", start, end: addDays(start, 6) });
  }
  if (/\bthis week\b/.test(said)) {
    const start = addDays(base, -((base.getDay() + 6) % 7));
    found.push({ label: "this week", start, end: addDays(start, 6) });
  }
  // A weekend is the Friday to the Sunday.
  if (/\b(?:this |next )?weekend\b/.test(said)) {
    const nextWeekend = /\bnext weekend\b/.test(said);
    const daysToFriday = ((5 - base.getDay()) + 7) % 7 || 7;
    const friday = addDays(base, daysToFriday + (nextWeekend ? 7 : 0));
    found.push({ label: nextWeekend ? "next weekend" : "this weekend", start: friday, end: addDays(friday, 2) });
  }

  // "next friday", "this tuesday"
  for (const [index, name] of WEEKDAYS.entries()) {
    const m = said.match(new RegExp(`\\b(next|this|on)\\s+${name}\\b`));
    if (!m) continue;
    let delta = (index - base.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (m[1] === "next" && delta < 7) delta += 7;
    const day = addDays(base, delta);
    found.push({ label: `${m[1]} ${name}`, start: day, end: day });
  }

  // "march 3rd", "march 3 to 7"
  for (const [index, month] of MONTHS.entries()) {
    const m = said.match(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:\\s*(?:st|nd|rd|th))?(?:\\s*(?:to|through|-|–|until)\\s*(?:${month}\\s+)?(\\d{1,2})(?:\\s*(?:st|nd|rd|th))?)?`));
    if (!m) continue;
    const year = index < base.getMonth() ? base.getFullYear() + 1 : base.getFullYear();
    const start = new Date(year, index, Number(m[1]), 12);
    const end = m[2] ? new Date(year, index, Number(m[2]), 12) : start;
    found.push({ label: m[0], start, end });
  }

  return found.map((f) => ({
    label: f.label,
    start: iso(f.start),
    end: iso(f.end),
    // The formats a date picker actually shows, so Jev has something to match.
    startText: formats(f.start),
    endText: formats(f.end),
  }));
}

function formats(d) {
  const month = MONTHS[d.getMonth()];
  const name = month.charAt(0).toUpperCase() + month.slice(1);
  return [
    String(d.getDate()),
    `${name} ${d.getDate()}`,
    `${name.slice(0, 3)} ${d.getDate()}`,
    `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
    iso(d),
  ];
}

/** Every concrete date string worth offering as a typeable value. */
export function dateCandidates(dates) {
  const out = [];
  for (const d of dates) {
    out.push(...d.startText, ...d.endText);
    if (d.start !== d.end) out.push(`${d.start} to ${d.end}`);
  }
  return [...new Set(out)];
}
