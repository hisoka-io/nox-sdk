import React from 'react';

const STYLES = `
  .nox-how {
    padding: 56px 0;
    text-align: center;
  }

  .nox-how__label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ifm-color-emphasis-500);
    margin-bottom: 12px;
  }

  .nox-how__label::before,
  .nox-how__label::after {
    content: '';
    width: 24px;
    height: 1px;
    background: var(--ifm-color-emphasis-300);
  }

  .nox-how h2 {
    font-size: clamp(1.5rem, 3.5vw, 2.2rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    margin: 0 0 12px;
  }

  .nox-how__desc {
    font-size: 15px;
    color: var(--ifm-color-emphasis-600);
    line-height: 1.7;
    max-width: 500px;
    margin: 0 auto;
  }

  .nox-how__surb {
    font-size: 14px;
    color: var(--ifm-color-emphasis-500);
    line-height: 1.7;
    max-width: 480px;
    margin: 0 auto;
    padding: 16px 24px;
    border-radius: 10px;
    border: 1px solid var(--nox-border);
    background: var(--nox-surface);
  }

  .nox-net-wrap {
    padding: 40px 0 32px;
  }

  .nox-net {
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    display: block;
  }

  .nox-net text {
    font-family: var(--ifm-font-family-base);
  }

  .nox-net .label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .nox-net .sublabel {
    font-size: 8.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .nox-net .conn {
    stroke-width: 1;
    opacity: 0.08;
  }

  [data-theme='dark'] .nox-net .conn {
    opacity: 0.12;
  }

  @keyframes noxPacketFlow {
    0% { offset-distance: 0%; opacity: 0; }
    5% { opacity: 1; }
    95% { opacity: 1; }
    100% { offset-distance: 100%; opacity: 0; }
  }

  .nox-net .packet {
    offset-distance: 0%;
    animation: noxPacketFlow 3s ease-in-out infinite;
  }

  @keyframes noxNodePulse {
    0%, 100% { r: 22; opacity: 0.06; }
    50% { r: 28; opacity: 0.12; }
  }

  .nox-net .node-glow {
    animation: noxNodePulse 4s ease-in-out infinite;
  }
`;

export default function NoxNetwork() {
  return (
    <div className="nox-how">
      <style>{STYLES}</style>

      <div className="nox-how__label">How it works</div>
      <h2>Three hops. Zero trace.</h2>
      <p className="nox-how__desc">
        Every request wraps in layers of Sphinx encryption — one per hop. No single node ever knows both who sent the message and what it contains.
      </p>

      <div className="nox-net-wrap">
        <svg className="nox-net" viewBox="0 0 740 220" fill="none">
          <defs>
            <radialGradient id="nox-glow-g">
              <stop offset="0%" stopColor="var(--ifm-color-primary)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--ifm-color-primary)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Connection lines */}
          <line x1="110" y1="110" x2="240" y2="60" className="conn" stroke="var(--ifm-font-color-base)" />
          <line x1="110" y1="110" x2="240" y2="110" className="conn" stroke="var(--ifm-font-color-base)" />
          <line x1="110" y1="110" x2="240" y2="160" className="conn" stroke="var(--ifm-font-color-base)" />

          <line x1="280" y1="60" x2="400" y2="85" className="conn" stroke="var(--ifm-font-color-base)" />
          <line x1="280" y1="110" x2="400" y2="85" className="conn" stroke="var(--ifm-font-color-base)" />
          <line x1="280" y1="110" x2="400" y2="135" className="conn" stroke="var(--ifm-font-color-base)" />
          <line x1="280" y1="160" x2="400" y2="135" className="conn" stroke="var(--ifm-font-color-base)" />

          <line x1="440" y1="85" x2="530" y2="110" className="conn" stroke="var(--ifm-font-color-base)" />
          <line x1="440" y1="135" x2="530" y2="110" className="conn" stroke="var(--ifm-font-color-base)" />

          <line x1="570" y1="110" x2="640" y2="110" className="conn" stroke="var(--ifm-font-color-base)" />

          {/* Animated packets */}
          <circle r="3.5" fill="var(--ifm-color-primary)" className="packet"
            style={{ offsetPath: "path('M110,110 L240,110 L400,85 L530,110 L640,110')" }} opacity="0" />
          <circle r="3" fill="var(--ifm-color-primary)" className="packet"
            style={{ offsetPath: "path('M110,110 L240,160 L400,135 L530,110 L640,110')", animationDelay: '1.5s' }} opacity="0" />
          <circle r="2.5" fill="var(--nox-accent, #06b6d4)" className="packet"
            style={{ offsetPath: "path('M110,110 L240,60 L400,85 L530,110 L640,110')", animationDelay: '0.7s' }} opacity="0" />

          {/* You node */}
          <circle cx="110" cy="110" r="22" className="node-glow" fill="url(#nox-glow-g)" />
          <circle cx="110" cy="110" r="18" fill="none" stroke="var(--ifm-color-primary)" strokeWidth="1.5" opacity="0.6" />
          <text x="110" y="107" textAnchor="middle" className="label" fill="var(--ifm-color-primary)">You</text>
          <text x="110" y="118" textAnchor="middle" className="sublabel" fill="var(--ifm-color-emphasis-500)">dApp</text>

          {/* Entry nodes */}
          <circle cx="260" cy="60" r="16" fill="none" stroke="var(--ifm-color-emphasis-300)" strokeWidth="1" />
          <circle cx="260" cy="110" r="16" fill="none" stroke="var(--ifm-color-emphasis-300)" strokeWidth="1" />
          <circle cx="260" cy="160" r="16" fill="none" stroke="var(--ifm-color-emphasis-300)" strokeWidth="1" />
          <text x="260" y="195" textAnchor="middle" className="label" fill="var(--ifm-color-emphasis-600)">Entry</text>
          <text x="260" y="207" textAnchor="middle" className="sublabel" fill="var(--ifm-color-emphasis-400)">sees IP only</text>

          {/* Mix nodes */}
          <circle cx="420" cy="85" r="16" fill="none" stroke="var(--ifm-color-emphasis-300)" strokeWidth="1" />
          <circle cx="420" cy="135" r="16" fill="none" stroke="var(--ifm-color-emphasis-300)" strokeWidth="1" />
          <text x="420" y="170" textAnchor="middle" className="label" fill="var(--ifm-color-emphasis-600)">Mix</text>
          <text x="420" y="182" textAnchor="middle" className="sublabel" fill="var(--ifm-color-emphasis-400)">sees nothing</text>

          {/* Exit node */}
          <circle cx="550" cy="110" r="17" fill="none" stroke="var(--ifm-color-emphasis-300)" strokeWidth="1" />
          <text x="550" y="145" textAnchor="middle" className="label" fill="var(--ifm-color-emphasis-600)">Exit</text>
          <text x="550" y="157" textAnchor="middle" className="sublabel" fill="var(--ifm-color-emphasis-400)">sees payload</text>

          {/* Destination */}
          <circle cx="640" cy="110" r="22" className="node-glow" fill="url(#nox-glow-g)" style={{ animationDelay: '2s' }} />
          <circle cx="640" cy="110" r="18" fill="none" stroke="var(--ifm-color-primary)" strokeWidth="1.5" opacity="0.6" />
          <text x="640" y="107" textAnchor="middle" className="label" fill="var(--ifm-color-primary)">ETH</text>
          <text x="640" y="118" textAnchor="middle" className="sublabel" fill="var(--ifm-color-emphasis-500)">RPC</text>
        </svg>
      </div>

      <p className="nox-how__surb">
        Responses travel back via <strong>single-use reply blocks (SURBs)</strong> — pre-built encrypted return paths that the exit node uses without learning your identity.
      </p>
    </div>
  );
}
