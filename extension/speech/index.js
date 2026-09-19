// Swappable speech-to-text.
//
// A recognizer is anything with { start(), stop(), available() } that calls
// handlers.onFinal(text) for a settled utterance and handlers.onPartial(text)
// for in-progress speech. Swap the import below to change engines; nothing
// else in the extension knows which one is running.

import { WebSpeechRecognizer } from "./webspeech.js";

export function createRecognizer(handlers) {
  return new WebSpeechRecognizer(handlers);
}

// To use local Whisper instead, implement the same three methods over a
// WebSocket to a local whisper.cpp server and swap the line above:
//
//   import { WhisperRecognizer } from "./whisper.js";
//   export function createRecognizer(handlers) { return new WhisperRecognizer(handlers); }
