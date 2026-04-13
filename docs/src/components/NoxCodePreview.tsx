import React from 'react';

const STYLES = `
  .nox-code {
    padding: 56px 0 64px;
    text-align: center;
  }

  .nox-code__label {
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

  .nox-code__label::before,
  .nox-code__label::after {
    content: '';
    width: 24px;
    height: 1px;
    background: var(--ifm-color-emphasis-300);
  }

  .nox-code h2 {
    font-size: clamp(1.5rem, 3.5vw, 2.2rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    margin: 0 0 40px;
  }

  .nox-code__block {
    text-align: left;
    max-width: 560px;
    margin: 0 auto;
    border-radius: 12px;
    border: 1px solid var(--nox-border);
    overflow: hidden;
    background: #1a1a1a;
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.15);
  }

  [data-theme='dark'] .nox-code__block {
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.4);
  }

  .nox-code__header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .nox-code__dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    opacity: 0.5;
  }

  .nox-code__filename {
    font-size: 12px;
    font-family: var(--ifm-font-family-monospace);
    color: rgba(255, 255, 255, 0.35);
    margin-left: 8px;
  }

  .nox-code__body {
    padding: 20px 24px;
    font-family: var(--ifm-font-family-monospace);
    font-size: 13px;
    line-height: 1.7;
    color: #e5e5e5;
    overflow-x: auto;
  }

  .nox-code__body .kw { color: #c792ea; }
  .nox-code__body .fn { color: #82aaff; }
  .nox-code__body .str { color: #c3e88d; }
  .nox-code__body .cm { color: #546e7a; }
  .nox-code__body .pr { color: #f78c6c; }
  .nox-code__body .vr { color: #89ddff; }

  .nox-code__cta {
    margin-top: 32px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 28px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 14px;
    text-decoration: none;
    color: #000;
    background: var(--ifm-color-primary);
    box-shadow: 0 0 24px var(--nox-glow);
    transition: all 0.2s ease;
  }

  .nox-code__cta:hover {
    color: #000;
    text-decoration: none;
    box-shadow: 0 0 40px var(--nox-glow);
    transform: translateY(-1px);
  }
`;

export default function NoxCodePreview() {
  return (
    <div className="nox-code">
      <style>{STYLES}</style>
      <div className="nox-code__label">Quick look</div>
      <h2>Four lines to privacy</h2>

      <div className="nox-code__block">
        <div className="nox-code__header">
          <span className="nox-code__dot" style={{ background: '#ff5f57' }} />
          <span className="nox-code__dot" style={{ background: '#febc2e' }} />
          <span className="nox-code__dot" style={{ background: '#28c840' }} />
          <span className="nox-code__filename">app.ts</span>
        </div>
        <pre className="nox-code__body">
{`\n`}<span className="kw">import</span>{` { NoxClient } `}<span className="kw">from</span>{` `}<span className="str">'@hisoka-io/nox-client'</span>{`\n`}
{`\n`}<span className="kw">const</span>{` client = `}<span className="kw">await</span>{` NoxClient.`}<span className="fn">connect</span>{`()\n`}
{`\n`}<span className="cm">{'// Your RPC provider never sees your IP'}</span>{`\n`}<span className="kw">const</span>{` block = `}<span className="kw">await</span>{` client.`}<span className="fn">rpcCall</span>{`(`}<span className="str">'eth_blockNumber'</span>{`, [])\n`}
{`\n`}<span className="cm">{'// Broadcast transactions through the mixnet'}</span>{`\n`}<span className="kw">await</span>{` client.`}<span className="fn">broadcastSignedTransaction</span>{`(signedTx)\n`}
        </pre>
      </div>

      <a href="/quickstart" className="nox-code__cta">
        Read the quickstart
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </a>
    </div>
  );
}
