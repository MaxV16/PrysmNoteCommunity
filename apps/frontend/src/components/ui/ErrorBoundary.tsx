"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
}

/**
 * Small, self-contained error boundary. Wrap optional or third-party panels so
 * a render failure in one of them degrades to an inline message instead of
 * blanking the whole app through the layout-wide boundary in ThreePaneLayout.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="mt-3 rounded-xl border border-border bg-elevated px-3 py-2 text-[11px] text-muted">
          {this.props.label
            ? `${this.props.label} is unavailable right now.`
            : "This section is unavailable right now."}
        </div>
      );
    }
    return this.props.children;
  }
}
