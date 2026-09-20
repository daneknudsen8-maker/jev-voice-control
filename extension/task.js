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
export function buildTaskQuestions({ elements, typeables, values }) {
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
        focus: "Prefer the element that advances the goal, not merely one that matches its words. Entries are listed in page order and carry a `position` label. `today` gives the current date, for any day the goal refers to — 'next week', 'friday', 'the 25th'.",
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
/**
 * A signature of what the page currently shows. Used to tell a legitimate
 * repeat from a stuck one: pressing "+" on a guest counter six times is the
 * same click six times, and each press changes the number on screen.
 */
export function pageSignature(elements, typeables) {
  return [...elements, ...typeables].map((e) => `${e.id}:${e.text}`).join("|");
}

export function resolveTaskStep(answers, { values, history, elements, typeables, goal = "", signature = "" }) {
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
      // Clicking the same thing again is only a problem when the page did not
      // react last time. A counter, a "load more", a carousel arrow are all
      // meant to be pressed repeatedly.
      const lastIdentical = [...history].reverse().find(
        (h) => h.command?.do === "click" && h.command?.id === target.choice,
      );
      if (lastIdentical && lastIdentical.signature === signature) {
        return { do: "stuck", why: "repeat", detail: `clicked "${el?.text}" and the page did not change` };
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
      const retyped = [...history].reverse().find(
        (h) => h.command?.do === "type" && h.command?.id === field.choice && h.command?.text === text,
      );
      if (retyped && retyped.signature === signature) {
        return { do: "stuck", why: "repeat", detail: `typed "${text}" there and nothing changed` };
      }
      return needsPerson
        ? { do: "ask", command: { do: "type", id: field.choice, text }, label, risk, why: "risk_gate" }
        : { do: "act", command: { do: "type", id: field.choice, text }, label, risk, why: "ok" };
    }

    default:
      return { do: "stuck", why: "unhandled", detail: `no handler for ${action.choice}` };
  }
}
