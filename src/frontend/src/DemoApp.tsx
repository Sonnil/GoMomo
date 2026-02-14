import React from 'react';
import { DemoChatWidget } from './components/DemoChatWidget';

/**
 * Demo App — investor-facing presentation wrapper
 * Shows the gomomo branding around the polished chat widget.
 */
export function DemoApp() {
  return (
    <div className="demo-page">
      {/* Background decoration */}
      <div className="demo-bg-orb demo-bg-orb-1" />
      <div className="demo-bg-orb demo-bg-orb-2" />
      <div className="demo-bg-orb demo-bg-orb-3" />

      {/* Hero text */}
      <div className="demo-hero">
        <div className="demo-hero-badge">✨ Live Demo</div>
        <h1 className="demo-hero-title">
          gomomo.ai
        </h1>
        <p className="demo-hero-subtitle">
          Intelligent scheduling, powered by AI.<br />
          Try booking, rescheduling, or cancelling — just like talking to a real person.
        </p>
      </div>

      {/* Chat widget */}
      <div className="demo-widget-wrapper">
        <DemoChatWidget />
      </div>

      {/* Feature pills */}
      <div className="demo-features">
        {[
          { icon: '🧠', label: 'Natural Language Understanding' },
          { icon: '📅', label: 'Real-time Availability' },
          { icon: '⚡', label: 'Instant Responses' },
          { icon: '🔒', label: 'HIPAA-Ready Architecture' },
        ].map((f) => (
          <div key={f.label} className="demo-feature-pill">
            <span>{f.icon}</span>
            <span>{f.label}</span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="demo-page-footer">
        Powered by <strong>gomomo.ai</strong>
      </div>
    </div>
  );
}
