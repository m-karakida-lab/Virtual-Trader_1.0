import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logError, readErrorLog } from '../lib/errorLog';

interface Props { children: ReactNode }
interface State { error: Error | null }

// 画面全体が「原因不明の黒画面」になる不具合の対策。
// React のレンダー/エフェクト中の例外を捕まえて、黒画面の代わりにエラー内容を
// 見える形で表示する（何が起きたか分かるように）。エラーは localStorage にも記録される（errorLog.ts）
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError('ErrorBoundary', error);
    console.error('[vt:error][ErrorBoundary] componentStack', info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const recent = readErrorLog().slice(-5).reverse();
    return (
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: '#0d0d0d', color: '#e0e0e0',
        fontFamily: '"SF Mono", "Fira Code", monospace', padding: '32px', overflow: 'auto',
      }}>
        <h1 style={{ color: '#ef5350', fontSize: '20px', marginBottom: '12px' }}>
          画面がクラッシュしました
        </h1>
        <p style={{ color: '#888', marginBottom: '16px' }}>
          エラー内容は localStorage（vt:errorLog）にも保存されています。再読み込みしてください。
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            backgroundColor: '#1a1a1a', color: '#e0e0e0', border: '1px solid #333',
            borderRadius: '4px', padding: '8px 16px', fontSize: '14px', cursor: 'pointer',
            marginBottom: '24px',
          }}
        >再読み込み</button>
        <pre style={{
          backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
          padding: '16px', fontSize: '12px', color: '#ff7b72', whiteSpace: 'pre-wrap',
          marginBottom: '24px',
        }}>{this.state.error.message}{'\n\n'}{this.state.error.stack}</pre>
        {recent.length > 0 && (
          <>
            <h2 style={{ fontSize: '14px', color: '#888', marginBottom: '8px' }}>直近のエラー履歴</h2>
            <pre style={{
              backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
              padding: '16px', fontSize: '11px', color: '#888', whiteSpace: 'pre-wrap',
            }}>{JSON.stringify(recent, null, 1)}</pre>
          </>
        )}
      </div>
    );
  }
}
