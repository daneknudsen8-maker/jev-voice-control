// Dictation mode: everything you say becomes text, until you say otherwise.
//
// The danger here is mode confusion. While writing an email, "send me the
// report tomorrow" is content and "send it" is a command, and they share words.
// Three defences, in order of how much they are trusted:
//
//   1. Exact control phrases matched in code. No model, no ambiguity.
//   2. Spoken punctuation converted in code. "period" -> "."
//   3. Jev judges the rest — but the default is ALWAYS to write the words down.
//      A control phrase mistaken for content costs you a line to delete. Content
//      mistaken for a control sends a half-written email.

// Said exactly, these are never content. Deterministic, instant, free.
const CONTROLS = [
  [/^(?:stop|end|finish|exit)\s+(?:dictating|dictation|typing|writing)$/i, "finish"],
  [/^(?:that's|thats)\s+it$/i, "finish"],
  [/^done\s+(?:dictating|writing|typing)$/i, "finish"],
  [/^(?:scratch|strike)\s+that$/i, "undo"],
  [/^(?:undo|delete)\s+that$/i, "undo"],
  [/^new\s+(?:line|paragraph)$/i, "new_paragraph"],
  [/^(?:clear|erase)\s+(?:it|all|everything|the\s+\w+)$/i, "clear"],
  [/^send\s+(?:it|this|the\s+(?:email|message|text))\s*(?:now)?$/i, "send"],
];

export function matchDictationControl(transcript) {
  const text = transcript.trim().replace(/[.!?]+$/, "");
  for (const [pattern, control] of CONTROLS) {
    if (pattern.test(text)) return control;
  }
  return null;
}

// Spoken punctuation. Pure text manipulation, so it stays in code.
const SPOKEN = [
  [/\s*\b(?:full\s+stop|period)\b\s*/gi, ". "],
  [/\s*\bcomma\b\s*/gi, ", "],
  [/\s*\bquestion\s+mark\b\s*/gi, "? "],
  [/\s*\bexclamation\s+(?:mark|point)\b\s*/gi, "! "],
  [/\s*\bcolon\b\s*/gi, ": "],
  [/\s*\bsemicolon\b\s*/gi, "; "],
  [/\s*\b(?:open\s+paren(?:thesis)?)\b\s*/gi, " ("],
  [/\s*\b(?:close\s+paren(?:thesis)?)\b\s*/gi, ") "],
  [/\s*\bdash\b\s*/gi, " — "],
  [/\s*\bapostrophe\b\s*/gi, "'"],
];

export function applySpokenPunctuation(text) {
  let out = text;
  for (const [pattern, replacement] of SPOKEN) out = out.replace(pattern, replacement);
  return out.replace(/\s+([.,!?;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** Join a new chunk onto existing text with sensible spacing and capitals. */
export function appendChunk(existing, chunk) {
  const addition = applySpokenPunctuation(chunk);
  if (!addition) return existing;
  if (!existing) return capitalize(addition);

  const endsSentence = /[.!?]\s*$/.test(existing);
  const endsNewline = /\n\s*$/.test(existing);
  const joiner = endsNewline ? "" : " ";
  const piece = endsSentence || endsNewline ? capitalize(addition) : addition;
  return existing.replace(/\s+$/, "") + joiner + piece;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Questions asked for each utterance while dictating. Deliberately small: this
 * runs on every sentence you speak, so it stays cheap and fast.
 */
export function buildDictationQuestions() {
  return {
    // The load-bearing judgment. High means write it down.
    is_content: {
      type: "noul",
      instructions: {
        question: "Is `utterance` words the user is dictating INTO the message described by `writing_into`, rather than an instruction to the assistant about the act of writing?",
        focus: "The test is WHO is being addressed. Content is addressed to the person who will read the message, and may freely discuss sending, deleting, finishing or clearing things in the world. An instruction is addressed to the assistant and refers only to the words just spoken into this message.",
      },
      criteria: {
        true: {
          what: "Words meant to appear in the finished message, including requests aimed at the RECIPIENT",
          note: "Anything referring to a document, draft, file, invoice, report or project OUTSIDE this message is content, even when it asks for something to be deleted, sent or stopped",
          examples: [
            "can you delete that last paragraph from the draft",
            "can you send me the report by Friday",
            "let me know if you want me to clear the invoice",
            "I am done with the review",
            "thanks for your help",
          ],
        },
        false: {
          what: "Spoken to the assistant about the words just dictated, not to the recipient",
          note: "Short and imperative, and refers to THIS dictation — the text just spoken, the message being composed",
          examples: ["stop dictating", "send it", "scratch that", "new paragraph", "erase everything"],
        },
      },
    },

    control: {
      type: "choice",
      instructions: {
        question: "If `utterance` is an instruction to the assistant rather than message content, which instruction is it?",
        focus: "Answer none when `utterance` reads as part of the message.",
      },
      criteria: {
        finish: "Stop dictating and leave the text as written. About this dictation, not about any project or task discussed in the message.",
        send: "Send or submit THIS message now",
        undo: "Remove the words just dictated into this message. Not a request that someone edit a document.",
        new_paragraph: "Begin a new line or paragraph in this message",
        clear: "Erase everything dictated into this message so far",
        none: "Not an instruction to the assistant — these are words for the message, including requests aimed at the recipient",
      },
    },
  };
}

// A control has to clear both bars to beat the default of writing it down.
const CONTENT_FLOOR = 0.35;
const CONTROL_FLOOR = 0.60;

// Real dictation controls are short imperatives: "send it", "scratch that",
// "new paragraph". A long sentence is presumptively part of the message, so it
// takes much stronger evidence to be read as an instruction. This is a property
// of how people speak, not a judgment, so it lives in code.
const LONG_UTTERANCE_WORDS = 7;
const LONG_CONTROL_FLOOR = 0.95;
const LONG_CONTENT_CEILING = 0.10;

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Decide what an utterance means while dictating.
 * Returns { do: "append"|"finish"|"send"|"undo"|"new_paragraph"|"clear", ... }
 */
export function resolveDictation(answers, transcript) {
  // 1. An exact control phrase needs no model.
  const exact = matchDictationControl(transcript);
  if (exact) return { do: exact, why: "control_phrase", confirm: exact === "send" || exact === "clear" };

  const isContent = answers?.is_content?.noul ?? 1;
  const control = answers?.control;

  // 2. Anything that reads as content gets written down. This is the default
  //    and it is deliberately hard to escape.
  const long = wordCount(transcript) >= LONG_UTTERANCE_WORDS;
  const controlBar = long ? LONG_CONTROL_FLOOR : CONTROL_FLOOR;
  const contentBar = long ? LONG_CONTENT_CEILING : CONTENT_FLOOR;

  if (isContent >= contentBar || !control || control.choice === "none" || control.confidence < controlBar) {
    return {
      do: "append",
      text: transcript,
      why: "content",
      detail: `is_content ${isContent.toFixed(2)}${control ? ` · control ${control.choice}@${control.confidence.toFixed(2)}` : ""}${long ? " · long utterance" : ""}`,
    };
  }

  // 3. Clearly an instruction. Destructive ones still confirm.
  return {
    do: control.choice,
    why: "control_judged",
    detail: `is_content ${isContent.toFixed(2)} · control ${control.choice}@${control.confidence.toFixed(2)}`,
    confirm: control.choice === "send" || control.choice === "clear",
  };
}
