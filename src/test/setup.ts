import "@testing-library/jest-dom/vitest";

// The side pane remembers its layout in localStorage; every test starts fresh.
afterEach(() => localStorage.clear());

// jsdom has the <dialog> element but not its modal behavior. Enough of it
// for tests: open and close, with the `open` attribute as the browser sets it.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}
