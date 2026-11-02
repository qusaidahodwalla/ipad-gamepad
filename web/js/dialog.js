// Tiny modal dialogs (text prompt, confirm). window.prompt/confirm are unreliable in Home Screen apps.

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
}

function show(build) {
  return new Promise((resolve) => {
    const backdrop = el("div", { className: "dialog-backdrop" });
    const card = el("div", { className: "dialog", role: "dialog" });
    const done = (value) => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) done(null); });
    build(card, done);
    backdrop.append(card);
    document.body.append(backdrop);
  });
}

/** Resolves to the trimmed text, or null if cancelled. */
export function askText({ title, value = "", ok = "OK", max = 40 }) {
  return show((card, done) => {
    const input = el("input", { type: "text", value, maxLength: max });
    const cancelBtn = el("button", { type: "button", className: "pbtn", textContent: "Cancel" });
    const okBtn = el("button", { type: "button", className: "pbtn primary", textContent: ok });
    const submit = () => {
      const text = input.value.trim();
      if (text) done(text);
    };
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") done(null);
    });
    card.append(el("h3", { textContent: title }), input, el("div", { className: "dialog-actions" }, cancelBtn, okBtn));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** Resolves to true (confirmed) or false. */
export function confirmBox({ title, message = "", ok = "OK", danger = false }) {
  return show((card, done) => {
    const cancelBtn = el("button", { type: "button", className: "pbtn", textContent: "Cancel" });
    const okBtn = el("button", { type: "button", className: `pbtn ${danger ? "danger" : "primary"}`, textContent: ok });
    cancelBtn.addEventListener("click", () => done(false));
    okBtn.addEventListener("click", () => done(true));
    card.append(el("h3", { textContent: title }), el("p", { textContent: message }),
      el("div", { className: "dialog-actions" }, cancelBtn, okBtn));
  }).then((v) => v === true);
}

/**
 * The pairing dialog for a device the PC doesn't know yet. It has no cancel: until the PC accepts
 * the 4-digit code (shown in the PC's terminal) the device can't send anything.
 * Returns { setMessage(text, isError), close() }.
 */
export function pairingDialog({ name, onSubmit }) {
  const backdrop = el("div", { className: "dialog-backdrop" });
  const card = el("div", { className: "dialog", role: "dialog" });
  const nameInput = el("input", { type: "text", value: name, maxLength: 24 });
  const codeInput = el("input", {
    type: "text", inputMode: "numeric", maxLength: 4, autocomplete: "off", placeholder: "0000", className: "codeinput",
  });
  const note = el("p", { className: "pairnote", textContent: "Look at the PC's terminal for the 4-digit code." });
  const button = el("button", { type: "button", className: "pbtn primary", textContent: "Pair this device" });
  const submit = () => {
    const code = codeInput.value.trim();
    const deviceName = nameInput.value.trim();
    if (!/^\d{4}$/.test(code)) return handle.setMessage("Enter the 4 digits shown on the PC.", true);
    if (!deviceName) return handle.setMessage("Give this device a name.", true);
    button.disabled = true;
    handle.setMessage("Checking...", false);
    onSubmit({ name: deviceName, code });
  };
  button.addEventListener("click", submit);
  codeInput.addEventListener("input", () => { codeInput.value = codeInput.value.replace(/\D/g, ""); });
  codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  card.append(
    el("h3", { textContent: "Pair this device" }),
    el("p", { textContent: "This PC doesn't know this device yet. Pairing happens once; after that it stays signed in." }),
    el("label", { className: "flabel", textContent: "Device name" }), nameInput,
    el("label", { className: "flabel", textContent: "Code from the PC" }), codeInput,
    note, el("div", { className: "dialog-actions" }, button),
  );
  backdrop.append(card);
  document.body.append(backdrop);
  const handle = {
    setMessage(text, isError) {
      note.textContent = text;
      note.classList.toggle("error", !!isError);
      if (isError) button.disabled = false;
    },
    close() { backdrop.remove(); },
  };
  setTimeout(() => codeInput.focus(), 0);
  return handle;
}
