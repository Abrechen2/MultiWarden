// Offscreen document (Chrome): clipboard access for the service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.offscreen !== "copy") return false;
  const t = document.getElementById("t") as HTMLTextAreaElement;
  t.value = msg.text;
  t.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  t.value = "";
  sendResponse({ ok });
  return false;
});
