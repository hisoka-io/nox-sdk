import React from 'react';

const STYLES = `
  .nox-feat {
    padding: 56px 0 40px;
    text-align: center;
  }

  .nox-feat__label {
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

  .nox-feat__label::before,
  .nox-feat__label::after {
    content: '';
    width: 24px;
    height: 1px;
    background: var(--ifm-color-emphasis-300);
  }

  .nox-feat h2 {
    font-size: clamp(1.5rem, 3.5vw, 2.2rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    margin: 0 0 40px;
  }

  .nox-feat__grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    text-align: left;
    border-radius: 14px;
    overflow: hidden;
    background: var(--nox-border);
  }

  @media (max-width: 580px) {
    .nox-feat__grid { grid-template-columns: 1fr; }
  }

  .nox-feat__card {
    padding: 28px;
    background: var(--ifm-background-color);
    position: relative;
    transition: background 0.25s ease;
  }

  .nox-feat__card:hover {
    background: var(--nox-surface);
  }

  [data-theme='dark'] .nox-feat__card:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .nox-feat__icon {
    width: 42px;
    height: 42px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
    position: relative;
  }

  .nox-feat__icon::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--nox-gradient);
    opacity: 0.1;
  }

  .nox-feat__icon svg {
    width: 20px;
    height: 20px;
    stroke: var(--ifm-color-primary);
    fill: none;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    position: relative;
    z-index: 1;
  }

  .nox-feat__tag {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ifm-color-primary);
    margin: 0 0 6px;
  }

  .nox-feat__desc {
    font-size: 14px;
    line-height: 1.6;
    color: var(--ifm-color-emphasis-600);
    margin: 0;
  }
`;

const items = [
  {
    title: 'Transact',
    icon: <svg viewBox="0 0 24 24"><path d="M12 2v20M17 7l-5-5-5 5M7 17l5 5 5-5" /></svg>,
    desc: 'Broadcast signed transactions through the mixnet. Your RPC provider never sees your IP.',
  },
  {
    title: 'Query',
    icon: <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>,
    desc: 'Any JSON-RPC call — blocks, balances, logs — routed without your identity touching the provider.',
  },
  {
    title: 'HTTP',
    icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" /></svg>,
    desc: 'Route requests to any API, price feed, or oracle. The destination sees the exit node, not you.',
  },
  {
    title: 'Cover',
    icon: <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
    desc: 'Poisson-distributed dummy traffic at random intervals. Real and fake packets are indistinguishable.',
  },
];

export default function NoxFeatures() {
  return (
    <div className="nox-feat">
      <style>{STYLES}</style>
      <div className="nox-feat__label">Capabilities</div>
      <h2>What you can route</h2>
      <div className="nox-feat__grid">
        {items.map((item) => (
          <div key={item.title} className="nox-feat__card">
            <div className="nox-feat__icon">{item.icon}</div>
            <p className="nox-feat__tag">{item.title}</p>
            <p className="nox-feat__desc">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
