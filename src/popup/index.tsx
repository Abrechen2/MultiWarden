import { render } from "preact";
import { initLanguage } from "../shared/i18n";
import { initAppearance } from "../shared/appearance";
import { App } from "./App";
import { PhishingWarning } from "./views/Phishing";
import "./styles.css";
import "../shared/select.css";

const phishingUrl = new URLSearchParams(location.search).get("phishing");

// the background notices when the last popup closes (vault timeout "immediately")
try {
  if (!phishingUrl) chrome.runtime.connect({ name: "mw-popup" });
} catch {
  /* tests without runtime */
}

// language and colours are applied before the first render (the App re-applies them on every state load)
Promise.all([initLanguage(), initAppearance()]).finally(() => {
  if (phishingUrl) {
    document.title = "MultiWarden";
    document.body.classList.add("popout");
    render(<PhishingWarning url={phishingUrl} />, document.getElementById("root")!);
  } else render(<App />, document.getElementById("root")!);
});
