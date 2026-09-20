// Composing a structured message: recipient, cc, subject, body.
//
// Two facts from real sessions shape this:
//
//   1. People name a field and speak its value as SEPARATE utterances —
//      "to" … "Sarah Chen" … "subject line should be" … "new tool". So the
//      chosen field persists until another is named.
//   2. "subject line should be" scored 0.24 on is_content — the model could
//      already tell it was not prose. It just had nowhere to route it.
//
// Field prefixes are stripped in code (string work); which field an utterance
// belongs to when no prefix is spoken is a judgment, so Jev decides that.

export const FIELD_ROLES = ["to", "cc", "bcc", "subject", "body"];

// Longest / most specific first.
const FIELD_PREFIXES = [
  ["bcc",     /^(?:and\s+)?(?:bcc|blind\s+copy)\s*(?:to|:)?\s*(.*)$/i],
  ["cc",      /^(?:and\s+)?(?:cc|carbon\s+copy|copy)\s*(?:in|to|:)?\s*(.*)$/i],
  ["subject", /^(?:and\s+)?(?:the\s+)?subject(?:\s+line)?\s*(?:should\s+(?:be|say|read)|is|will\s+be|:)?\s*(.*)$/i],
  ["body",    /^(?:and\s+)?(?:the\s+)?(?:main\s+)?(?:body|message)(?:\s+of\s+the\s+(?:email|message))?\s*(?:should\s+(?:be|say|read)|is|:)?\s*(.*)$/i],
  ["body",    /^(?:and\s+)?(?:the\s+)?email\s+should\s+(?:say|read)\s*(.*)$/i],
  ["to",      /^(?:and\s+)?(?:send\s+(?:it|this)\s+)?to\s*(?::|)\s*(.*)$/i],
  ["to",      /^(?:it'?s?\s+)?(?:going|addressed)\s+to\s*(.*)$/i],
];

/**
 * Pull an explicit field name off the front of an utterance.
 * Returns { role, text } — text may be empty, meaning "switch to this field".
 */
export function matchFieldPrefix(transcript) {
  const said = transcript.trim().replace(/[.!?]+$/, "");
  for (const [role, pattern] of FIELD_PREFIXES) {
    const m = said.match(pattern);
    if (m) return { role, text: (m[1] ?? "").trim() };
  }
  return null;
}

/** Questions for one utterance while a structured message is open. */
export function buildComposeQuestions(available = FIELD_ROLES) {
  const fieldOptions = {
    to:      "The recipient — who the message is addressed to",
    cc:      "Someone to copy in",
    bcc:     "Someone to copy in privately",
    subject: "The subject line — a short title for the message",
    body:    "The message itself, the prose the recipient will read",
  };

  return {
    field: {
      type: "choice",
      instructions: {
        question: "Which part of the message being written do the words in `utterance` belong to?",
        focus: "The user is filling in an email. They may name a part ('the subject should be…') or simply continue speaking, in which case the words belong to the part they are already filling in — answer `same` for that.",
        currently_filling: "`current_field`",
      },
      criteria: {
        ...Object.fromEntries(Object.entries(fieldOptions).filter(([role]) => available.includes(role))),
        same: "No new part is named — these words continue whatever part is already being filled in, given in `current_field`",
      },
    },

    // Same load-bearing judgment as free dictation: is this the message, or an
    // instruction about the message?
    is_content: {
      type: "noul",
      instructions: {
        question: "Are the words in `utterance` part of the email being written — its recipient, subject or body — rather than an instruction to the assistant about the act of writing?",
        focus: "Naming a field, such as 'the subject should be', is still part of writing the email. Only speech about the DICTATION itself is an instruction.",
      },
      criteria: {
        true: "Anything that fills in the email: a name, an address, a subject, a sentence of the body, or a phrase naming which part comes next",
        false: "Spoken to the assistant about the dictation: 'stop dictating', 'send it', 'scratch that', 'start over'",
      },
    },

    control: {
      type: "choice",
      instructions: "If `utterance` is an instruction to the assistant rather than part of the email, which instruction is it?",
      criteria: {
        finish: "Stop dictating and leave the message as it is",
        send: "Send the message now",
        undo: "Remove the last thing written",
        clear: "Erase the message and start over",
        read_back: "Read back what has been written so far",
        none: "Not an instruction — these words belong in the email",
      },
    },
  };
}

const CONTENT_FLOOR = 0.35;
const CONTROL_FLOOR = 0.60;
const FIELD_FLOOR = 0.45;
const LONG_WORDS = 7;
const LONG_CONTROL_FLOOR = 0.95;
const LONG_CONTENT_CEILING = 0.10;

/**
 * An address said out loud: "marco at example dot com" -> marco@example.com.
 * Pure string work, so no model. Only applied to recipient fields, where "at"
 * and "dot" are almost never meant literally; a body saying "meet at dot com"
 * is left alone.
 */
export function spokenEmail(text) {
  const said = text.trim();
  if (/\S+@\S+\.\S+/.test(said)) return said.replace(/\s+/g, "");   // already an address
  if (!/\bat\b/i.test(said) || !/\bdot\b/i.test(said)) return said;

  const joined = said
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/\s+(?:underscore|under\s+score)\s+/gi, "_")
    .replace(/\s+(?:dash|hyphen)\s+/gi, "-")
    .replace(/\s+/g, "");

  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(joined) ? joined.toLowerCase() : said;
}

// Recipients replace (and commit to a chip); subject and body accumulate.
export const REPLACES = new Set(["to", "cc", "bcc"]);

/**
 * Decide what one utterance does to the message being composed.
 * Returns { do: "write"|"switch"|"finish"|"send"|"undo"|"clear"|"read_back", role?, text? }
 */
export function resolveCompose(answers, transcript, currentField = "body") {
  // 1. Exact control phrases: no model, no ambiguity.
  const exact = matchExactControl(transcript);
  if (exact) return { do: exact, why: "control_phrase", confirm: exact === "send" || exact === "clear" };

  // 2. An explicitly named field is string work, so code reads it.
  const prefix = matchFieldPrefix(transcript);

  const isContent = answers?.is_content?.noul ?? 1;
  const control = answers?.control;
  const long = transcript.trim().split(/\s+/).filter(Boolean).length >= LONG_WORDS;
  const controlBar = long ? LONG_CONTROL_FLOOR : CONTROL_FLOOR;
  const contentBar = long ? LONG_CONTENT_CEILING : CONTENT_FLOOR;

  const looksLikeControl = control && control.choice !== "none"
    && control.confidence >= controlBar && isContent < contentBar;

  // A named field means the user is filling the message in, whatever else the
  // words resemble. "cc Sarah" is not a control.
  if (looksLikeControl && !prefix) {
    return {
      do: control.choice, why: "control_judged",
      detail: `is_content ${isContent.toFixed(2)} · control ${control.choice}@${control.confidence.toFixed(2)}`,
      confirm: control.choice === "send" || control.choice === "clear",
    };
  }

  if (prefix) {
    return prefix.text
      ? { do: "write", role: prefix.role, text: prefix.text, why: "named_field",
          detail: `"${prefix.role}" named in the utterance` }
      : { do: "switch", role: prefix.role, why: "named_field_only",
          detail: `switched to ${prefix.role}; waiting for the value` };
  }

  // 3. No prefix: Jev says which part these words belong to.
  const field = answers?.field;
  const role = field && field.choice !== "same" && field.confidence >= FIELD_FLOOR
    ? field.choice
    : currentField;

  return {
    do: "write", role, text: transcript, why: field ? "field_judged" : "current_field",
    detail: `${role}${field ? ` (${field.choice}@${field.confidence.toFixed(2)})` : ""} · is_content ${isContent.toFixed(2)}`,
  };
}

const EXACT_CONTROLS = [
  [/^(?:stop|end|finish|exit)\s+(?:dictating|dictation|typing|writing|composing)$/i, "finish"],
  [/^done\s+(?:dictating|writing|composing)$/i, "finish"],
  [/^(?:scratch|strike)\s+that$/i, "undo"],
  [/^(?:undo|delete)\s+that$/i, "undo"],
  [/^send\s+(?:it|this|the\s+(?:email|message))\s*(?:now)?$/i, "send"],
  [/^(?:start\s+over|clear\s+(?:it|all|everything))$/i, "clear"],
  [/^(?:read|play)\s+(?:it\s+)?back$/i, "read_back"],
  [/^what\s+(?:have\s+i|did\s+i)\s+(?:got|written|say)(?:\s+so\s+far)?$/i, "read_back"],
];

export function matchExactControl(transcript) {
  const text = transcript.trim().replace(/[.!?]+$/, "");
  for (const [pattern, control] of EXACT_CONTROLS) if (pattern.test(text)) return control;
  return null;
}
