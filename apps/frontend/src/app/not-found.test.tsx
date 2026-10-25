import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { metadata as rootMetadata } from "@/app/layout";
import { metadata as notFoundMetadata } from "@/app/not-found";
import { NotFoundView } from "@/components/ui/NotFoundView";

const authState = vi.hoisted(() => ({ user: null as { id: string } | null, loading: false }));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
}));

/** Compose the segment title the way Next's metadata template does. */
function renderedTitle(segment: string | undefined, template: string): string {
  return template.replace("%s", String(segment ?? ""));
}

describe("custom 404", () => {
  beforeEach(() => {
    authState.user = null;
    authState.loading = false;
  });

  it("yields exactly one Prysm Note in the composed document title", () => {
    const template = (rootMetadata.title as { template: string }).template;
    const title = renderedTitle(notFoundMetadata.title as string, template);
    expect(title).toBe("Page not found | Prysm Note");
    expect(title.match(/Prysm Note/g)).toHaveLength(1);
  });

  it("renders the branded not-found heading and a logged-out CTA", () => {
    render(<NotFoundView />);
    expect(
      screen.getByRole("heading", { name: "We could not find that page" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start for free" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    // Brand appears once in the body mark, not doubled by a second label.
    expect(screen.getAllByText("Prysm Note")).toHaveLength(1);
  });

  it("sends a signed-in visitor back to their workspace instead of sign-up", () => {
    authState.user = { id: "u1" };
    render(<NotFoundView />);
    expect(
      screen.getByRole("link", { name: "Back to your workspace" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start for free" })).not.toBeInTheDocument();
  });
});
