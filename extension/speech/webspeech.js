// Web Speech API recognizer.
//
// Chrome streams microphone audio to Google's servers for recognition. That is
// how this API works in Chrome; it is not something the extension controls.
// For fully local recognition, implement this same interface over whisper.cpp.

const WAKE_SUFFIX = /\b(please|thanks|thank you)\.?$/i;

export class WebSpeechRecognizer {
  constructor(handlers) {
    this.handlers = handlers;
    this.recognition = null;
    this.wantRunning = false;
    this.restartDelay = 200;
  }

  available() {
    return typeof webkitSpeechRecognition !== "undefined" || typeof SpeechRecognition !== "undefined";
  }

  start() {
    if (!this.available()) {
      this.handlers.onError?.("This browser has no Web Speech API. Use Chrome.");
      return;
    }
    this.wantRunning = true;
    this.#spin();
  }

  stop() {
    this.wantRunning = false;
    this.recognition?.stop();
    this.recognition = null;
  }

  #spin() {
    const Impl = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    const r = new Impl();
    this.recognition = r;

    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;

        if (result.isFinal) {
          const cleaned = text.replace(WAKE_SUFFIX, "").trim();
          if (cleaned) this.handlers.onFinal?.(cleaned, result[0].confidence ?? null);
        } else {
          this.handlers.onPartial?.(text);
        }
      }
    };

    r.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return; // routine
      if (event.error === "not-allowed") {
        this.wantRunning = false;
        this.handlers.onError?.("Microphone permission denied. Allow it for this page and reload.");
        return;
      }
      this.handlers.onError?.(`speech error: ${event.error}`);
    };

    // Chrome ends the session periodically; restart while we still want it.
    r.onend = () => {
      if (!this.wantRunning) return;
      setTimeout(() => this.wantRunning && this.#spin(), this.restartDelay);
    };

    try {
      r.start();
      this.handlers.onListening?.();
    } catch {
      // start() throws if a previous session is still closing; onend will retry.
    }
  }
}
