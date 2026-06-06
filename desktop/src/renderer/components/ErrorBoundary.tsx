import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="alert alert-error" style={{ margin: 24 }}>
            <div>
              <strong>Something went wrong</strong>
              <pre style={{ marginTop: 8, fontSize: 12, overflow: "auto" }}>
                {this.state.error.message}
              </pre>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
