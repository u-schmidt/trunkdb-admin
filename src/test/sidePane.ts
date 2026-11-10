import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Shows the documents' side pane, if hidden, with the tab `name` in front. */
export async function showSidePage(user: UserEvent, name: "Document" | "Explain" | "Statement") {
  const toggle = screen.getByRole("button", { name: "Side pane" });
  if (toggle.getAttribute("aria-pressed") !== "true") await user.click(toggle);
  await user.click(screen.getByRole("tab", { name }));
}
