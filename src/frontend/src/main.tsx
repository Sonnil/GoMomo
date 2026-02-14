import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { DemoApp } from './DemoApp';
import './index.css';

// Auto-detect demo mode: ?demo=1 or VITE_DEMO_MODE=1
const params = new URLSearchParams(window.location.search);
const isDemoMode =
  params.get('demo') === '1' ||
  import.meta.env.VITE_DEMO_MODE === '1' ||
  import.meta.env.VITE_DEMO_MODE === 'true';

// Embed mode: ?embed=1 — fills iframe, no header/branding
const isEmbedMode = params.get('embed') === '1';

// In embed mode, force html/body/#root to fill the iframe
if (isEmbedMode) {
  document.documentElement.classList.add('embed');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isDemoMode ? <DemoApp /> : <App embed={isEmbedMode} />}
  </React.StrictMode>,
);
