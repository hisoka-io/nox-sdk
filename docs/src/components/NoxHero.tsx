import { useState, useEffect } from 'react';

const WORDS = ['IP', 'transactions', 'RPC calls', 'identity', 'metadata'];

function useTypewriter() {
  const [text, setText] = useState('');
  const [wordIdx, setWordIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const word = WORDS[wordIdx];
    const speed = deleting ? 40 : 80;
    const pause =
      !deleting && charIdx === word.length
        ? 2000
        : deleting && charIdx === 0
          ? 500
          : speed;

    const timer = setTimeout(() => {
      if (!deleting && charIdx === word.length) {
        setDeleting(true);
      } else if (deleting && charIdx === 0) {
        setDeleting(false);
        setWordIdx((prev: number) => (prev + 1) % WORDS.length);
      } else {
        const next = charIdx + (deleting ? -1 : 1);
        setCharIdx(next);
        setText(word.substring(0, next));
      }
    }, pause);

    return () => clearTimeout(timer);
  }, [charIdx, deleting, wordIdx]);

  return text;
}

const STYLES = `
  @keyframes noxBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @keyframes noxFadeUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes noxGridPulse {
    0%, 100% { opacity: 0.03; }
    50% { opacity: 0.06; }
  }

  .nox-hero {
    position: relative;
    padding: 64px 0 48px;
    text-align: center;
    overflow: hidden;
  }

  .nox-hero::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(circle at 1px 1px, var(--ifm-color-emphasis-300) 1px, transparent 0);
    background-size: 32px 32px;
    animation: noxGridPulse 8s ease-in-out infinite;
    pointer-events: none;
  }

  [data-theme='dark'] .nox-hero::before {
    background-image:
      radial-gradient(circle at 1px 1px, rgba(255,255,255,0.07) 1px, transparent 0);
  }

  .nox-hero::after {
    content: '';
    position: absolute;
    top: -120px;
    left: 50%;
    transform: translateX(-50%);
    width: 600px;
    height: 600px;
    background: radial-gradient(circle, var(--nox-glow) 0%, transparent 70%);
    pointer-events: none;
    z-index: 0;
  }

  .nox-hero__inner {
    position: relative;
    z-index: 1;
    animation: noxFadeUp 0.8s ease-out;
  }

  .nox-hero__badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 14px;
    border-radius: 100px;
    border: 1px solid var(--nox-border);
    background: var(--nox-surface);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--ifm-color-primary);
    margin-bottom: 24px;
    backdrop-filter: blur(8px);
  }

  .nox-hero__badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ifm-color-primary);
    animation: noxBlink 2s ease-in-out infinite;
  }

  .nox-hero h1 {
    font-size: clamp(2.2rem, 5vw, 3.5rem);
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.04em;
    margin: 0 0 24px;
    white-space: nowrap;
  }

  .nox-hero__gradient {
    background: linear-gradient(135deg, var(--ifm-color-primary), var(--nox-accent, #06b6d4));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .nox-hero__cursor {
    display: inline-block;
    width: 3px;
    height: 0.7em;
    background: var(--ifm-color-primary);
    margin-left: 2px;
    vertical-align: baseline;
    animation: noxBlink 1s step-end infinite;
    border-radius: 1px;
  }

  .nox-hero__sub {
    font-size: clamp(1rem, 2vw, 1.15rem);
    color: var(--ifm-color-emphasis-600);
    line-height: 1.7;
    margin: 0 auto 28px;
    max-width: 460px;
  }

  .nox-hero__actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }

  .nox-hero__btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 28px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 14px;
    text-decoration: none;
    transition: all 0.2s ease;
    cursor: pointer;
  }

  .nox-hero__btn:hover { text-decoration: none; }

  .nox-hero__btn--primary {
    background: none;
    color: var(--ifm-color-primary);
    border: 1px solid var(--ifm-color-primary);
  }
  .nox-hero__btn--primary:hover {
    background: var(--ifm-color-primary);
    color: #fff;
  }

  .nox-hero__btn--secondary {
    border: 1px solid var(--nox-border);
    color: var(--ifm-font-color-base);
    background: var(--nox-surface);
    backdrop-filter: blur(8px);
  }
  .nox-hero__btn--secondary:hover {
    color: var(--ifm-font-color-base);
    border-color: var(--ifm-color-emphasis-400);
    background: var(--nox-surface);
  }

  .nox-hero__install {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 20px;
    border-radius: 10px;
    border: 1px solid var(--nox-border);
    font-family: var(--ifm-font-family-monospace);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: var(--ifm-font-color-base);
    background: var(--nox-surface);
    backdrop-filter: blur(8px);
  }

  .nox-hero__install:hover {
    border-color: var(--ifm-color-primary);
    box-shadow: 0 0 20px var(--nox-glow);
  }
`;

function InstallCmd() {
  const [copied, setCopied] = useState(false);
  const cmd = 'npm i @hisoka-io/nox-client';

  return (
    <span
      className="nox-hero__install"
      role="button"
      tabIndex={0}
      onClick={() => {
        navigator.clipboard?.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <span style={{ color: 'var(--ifm-color-emphasis-400)' }}>$</span>
      <span style={{ color: 'var(--ifm-color-emphasis-700)' }}>{cmd}</span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={copied ? 'var(--ifm-color-primary)' : 'var(--ifm-color-emphasis-400)'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: 'stroke 0.2s ease', flexShrink: 0 }}
      >
        {copied ? (
          <path d="M20 6L9 17l-5-5" />
        ) : (
          <>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </>
        )}
      </svg>
    </span>
  );
}

export default function NoxHero() {
  const typedWord = useTypewriter();

  return (
    <div className="nox-hero">
      <style>{STYLES}</style>

      <div className="nox-hero__inner">
        <div className="nox-hero__badge">
          <span className="nox-hero__badge-dot" />
          Privacy layer for Ethereum
        </div>

        <h1>
          Nox can hide your{' '}
          <span className="nox-hero__gradient">{typedWord}</span>
          <span className="nox-hero__cursor" />
        </h1>

        <p className="nox-hero__sub">
          A 3-hop mix network that shields your identity from RPC providers, MEV bots, and chain observers.
        </p>

        <div className="nox-hero__actions">
          <a href="/quickstart" className="nox-hero__btn nox-hero__btn--primary">
            Get started
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </a>
          <a
            href="https://map.hisoka.io"
            target="_blank"
            rel="noopener noreferrer"
            className="nox-hero__btn nox-hero__btn--secondary"
          >
            Live network map
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7M7 7h10v10" />
            </svg>
          </a>
        </div>

        <InstallCmd />
      </div>
    </div>
  );
}
