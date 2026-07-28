import { Component } from 'react'

class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback(this.state.error)
        : this.props.fallback
    }
    return this.props.children
  }
}

export default ErrorBoundary
