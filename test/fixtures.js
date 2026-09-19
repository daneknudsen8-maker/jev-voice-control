// A synthetic Hacker News-ish page and tab set, plus the utterances we expect
// the question design to handle. Used by harness.js to exercise the real model
// without a browser.

export const ELEMENTS = [
  { id: "e0", text: "Hacker News", kind: "link", where: "navigation" },
  { id: "e1", text: "new", kind: "link", where: "navigation" },
  { id: "e2", text: "past", kind: "link", where: "navigation" },
  { id: "e3", text: "comments", kind: "link", where: "navigation" },
  { id: "e4", text: "ask", kind: "link", where: "navigation" },
  { id: "e5", text: "jobs", kind: "link", where: "navigation" },
  { id: "e6", text: "submit", kind: "link", where: "navigation" },
  { id: "e7", text: "login", kind: "link", where: "navigation" },
  { id: "e8", text: "Show HN: I built a voice-controlled browser extension", kind: "link", where: "main content" },
  { id: "e9", text: "142 comments", kind: "link", where: "main content" },
  { id: "e10", text: "upvote", kind: "button", where: "main content" },
  { id: "e11", text: "Rust 1.90 released with async improvements", kind: "link", where: "main content" },
  { id: "e12", text: "87 comments", kind: "link", where: "main content" },
  { id: "e13", text: "Why we moved off Kubernetes", kind: "link", where: "main content" },
  { id: "e14", text: "310 comments", kind: "link", where: "main content" },
  { id: "e15", text: "More", kind: "link", where: "footer" },
  { id: "e16", text: "Delete account permanently", kind: "button", where: "footer" },
  { id: "e17", text: "Guidelines", kind: "link", where: "footer" },
];

export const TYPEABLES = [
  { id: "e20", text: "Search stories", kind: "search input", where: "navigation" },
  { id: "e21", text: "Add a comment", kind: "text area", where: "main content" },
];

export const TABS = [
  { id: "t101", title: "Gmail — Inbox (3)", host: "mail.google.com" },
  { id: "t102", title: "TypeSafe docs — Primitives", host: "docs.typesafe.ai" },
  { id: "t103", title: "YouTube", host: "www.youtube.com" },
];

export const PAGE = { title: "Hacker News", url: "https://news.ycombinator.com/", host: "news.ycombinator.com" };

// expect: the action we want. target: the element id, when it matters.
export const CASES = [
  { say: "scroll down",                              expect: "scroll",     detail: "down" },
  { say: "scroll back to the top",                   expect: "scroll",     detail: "top" },
  { say: "go back",                                  expect: "back" },
  { say: "reload the page",                          expect: "reload" },
  { say: "open a new tab",                           expect: "new_tab" },
  { say: "click the login link",                     expect: "click",      target: "e7" },
  { say: "open the comments on the Rust story",      expect: "click",      target: "e12" },
  { say: "click the kubernetes post",                expect: "click",      target: "e13" },
  { say: "upvote that",                              expect: "click",      target: "e10" },
  { say: "show me the guidelines",                   expect: "click",      target: "e17" },
  { say: "delete my account",                        expect: "click",      target: "e16", risky: true },
  { say: "search for rust async",                    expect: "type",       target: "e20" },
  { say: "type nice write-up in the comment box",    expect: "type",       target: "e21" },
  { say: "go to gmail",                              expect: "switch_tab", target: "t101" },  // already open: switching beats reloading
  { say: "take me to the typesafe docs",             expect: "switch_tab", target: "t102" },
  { say: "go to wikipedia",                          expect: "navigate" },  // not open anywhere: really navigate
  { say: "switch to the gmail tab",                  expect: "switch_tab", target: "t101" },
  { say: "close the youtube tab",                    expect: "close_tab",  target: "t103", risky: true },
  { say: "is there anything about kubernetes here",  expect: "ask_page" },
  { say: "stop listening",                           expect: "stop" },
  { say: "uh so anyway what were you saying",        expect: "none" },
  { say: "yeah I think we should probably order lunch", expect: "none" },
];
