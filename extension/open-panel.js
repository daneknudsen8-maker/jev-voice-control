// Clicking the toolbar icon opens the panel in its own window. It has to be a
// real window rather than a popup: a popup closes when it loses focus, which
// would kill the microphone the moment you clicked on a page.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("panel.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.windows.update(existing[0].windowId, { focused: true });
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url, type: "popup", width: 420, height: 620 });
});
