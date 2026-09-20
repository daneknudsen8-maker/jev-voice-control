// Transcripts that arrive as TEXT rather than audio.
//
// Wispr Flow (and macOS dictation, and plain typing) put text into whatever
// field has focus. So the extension offers a field, watches it, and treats a
// finished burst of text as an utterance — no audio handling on our side at
// all, and the accuracy is whatever that tool achieves rather than whatever
// Chrome's Web Speech API manages.
//
// An utterance is finished when either:
//   • Enter is pressed, or
//   • the text stops changing for QUIET_MS — dictation tools type a whole
//     phrase in a burst and then stop.

const QUIET_MS = 900;
const MIN_CHARS = 2;

export class TextInputRecognizer {
  constructor(handlers, input) {
    this.handlers = handlers;
    this.input = input;
    this.timer = null;
    this.running = false;
    this.lastFired = "";

    this.onInput = () => {
      if (!this.running) return;
      const text = this.input.value.trim();
      this.handlers.onPartial?.(text);
      clearTimeout(this.timer);
      if (text.length < MIN_CHARS) return;
      this.timer = setTimeout(() => this.#fire(), QUIET_MS);
    };

    // Enter is handled by the panel, so the box works even when no recognizer
    // is running. This class only owns the "dictation went quiet" case.
  }

  available() {
    return true;   // text always works
  }

  start() {
    this.running = true;
    this.input.addEventListener("input", this.onInput);
    this.input.disabled = false;
    this.input.focus();
    this.handlers.onListening?.();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.input.removeEventListener("input", this.onInput);
  }

  #fire() {
    const text = this.input.value.trim();
    if (text.length < MIN_CHARS) return;
    // Dictation tools sometimes re-fire the same buffer; don't double-send.
    if (text === this.lastFired) return;
    this.lastFired = text;
    this.input.value = "";
    this.handlers.onFinal?.(text, null);
    // Keep focus so the next hotkey press lands here.
    this.input.focus();
  }
}
