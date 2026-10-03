import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  /** Documents the getDerivedStateFromError behavior. */
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null };
  }

  /** Documents the componentDidCatch behavior. */
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  /** Documents the render behavior. */
  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
            <h2 style={{ marginBottom: '1rem' }}>Something went wrong</h2>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#dc2626',
                background: '#fef2f2',
                padding: '1rem',
                borderRadius: '0.5rem',
                textAlign: 'left',
                maxWidth: '600px',
                margin: '0 auto 1rem',
                fontSize: '0.875rem',
              }}
            >
              {this.state.error?.message}
              {'\n\n'}
              {this.state.error?.stack}
              {this.state.componentStack && (
                <>
                  {'\n\nComponent Stack:'}
                  {this.state.componentStack}
                </>
              )}
            </pre>
            <button
              type="button"
              onClick={/** Handles the onClick interaction. */ () => window.location.reload()}
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '0.375rem',
                border: '1px solid #d1d5db',
                background: '#fff',
                cursor: 'pointer',
                fontSize: '0.875rem',
              }}
            >
              Reload Page
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
