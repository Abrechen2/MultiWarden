// Page for tests/confirm-dialog.test.ts: the popup's real DialogHost; window.openConfirm(message) opens a
// confirmation and stores the answer in window.__answer.
import { render } from "preact";
import { DialogHost, useDialogs } from "../src/popup/dialogs";

function Opener() {
  const dialogs = useDialogs();
  (window as any).openConfirm = (message: string) =>
    dialogs.confirm({ title: "Duplikate entfernen?", message, okLabel: "In den Papierkorb", danger: true }).then((v) => {
      (window as any).__answer = v;
    });
  return null;
}

render(
  <DialogHost>
    <Opener />
  </DialogHost>,
  document.getElementById("root")!,
);
