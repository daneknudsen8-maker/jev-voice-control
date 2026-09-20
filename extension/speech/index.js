// Swappable speech-to-text.
//
// A recognizer is anything with { start(), stop(), available() } that calls
// handlers.onFinal(text) for a settled utterance and handlers.onPartial(text)
// for in-progress speech. Swap the import below to change engines; nothing
// else in the extension knows which one is running.

import { WebSpeechRecognizer } from "./webspeech.js";
import { TextInputRecognizer } from "./textinput.js";

export const ENGINES = {
  // Chrome's own recognition. No setup, but the accuracy is what it is, and
  // the audio goes to Google.
  webspeech: { label: "Chrome mic", needsInput: false },
  // Text typed into the panel's box by any dictation tool — Wispr Flow, macOS
  // dictation — or by hand. Better accuracy, at the cost of keeping the box
  // focused.
  text: { label: "Wispr Flow / typing", needsInput: true },
};

export function createRecognizer(handlers, { engine = "webspeech", input } = {}) {
  if (engine === "text") {
    if (!input) throw new Error("the text engine needs an input element");
    return new TextInputRecognizer(handlers, input);
  }
  return new WebSpeechRecognizer(handlers);
}

// To use local Whisper instead, implement the same three methods over a
// WebSocket to a local whisper.cpp server and swap the line above:
//
//   import { WhisperRecognizer } from "./whisper.js";
//   export function createRecognizer(handlers) { return new WhisperRecognizer(handlers); }
