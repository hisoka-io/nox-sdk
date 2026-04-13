import React, { useState } from 'react';

const STYLES = `
  .nox-faq-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .nox-faq-item {
    border-bottom: 1px solid var(--nox-border);
  }

  .nox-faq-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 20px 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ifm-font-color-base);
    line-height: 1.4;
    gap: 16px;
    transition: color 0.2s ease;
  }

  .nox-faq-trigger:hover {
    color: var(--ifm-color-primary);
  }

  .nox-faq-icon {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.25s ease;
    background: var(--nox-surface);
    border: 1px solid var(--nox-border);
  }

  .nox-faq-icon--open {
    transform: rotate(45deg);
    background: var(--ifm-color-primary);
    border-color: var(--ifm-color-primary);
  }

  .nox-faq-icon--open svg {
    stroke: #000;
  }

  .nox-faq-body {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.3s ease;
  }

  .nox-faq-body--open {
    grid-template-rows: 1fr;
  }

  .nox-faq-body-inner {
    overflow: hidden;
  }

  .nox-faq-answer {
    padding: 0 0 20px;
    font-size: 0.93rem;
    line-height: 1.7;
    color: var(--ifm-color-emphasis-600);
    max-width: 640px;
  }
`;

type FaqItem = { q: string; a: string };

export default function NoxFaq({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <>
      <style>{STYLES}</style>
      <ul className="nox-faq-list">
        {items.map((item, i) => {
          const isOpen = open === i;
          return (
            <li key={i} className="nox-faq-item">
              <button
                className="nox-faq-trigger"
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
              >
                {item.q}
                <span className={`nox-faq-icon${isOpen ? ' nox-faq-icon--open' : ''}`}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="7" y1="1" x2="7" y2="13" />
                    <line x1="1" y1="7" x2="13" y2="7" />
                  </svg>
                </span>
              </button>
              <div className={`nox-faq-body${isOpen ? ' nox-faq-body--open' : ''}`}>
                <div className="nox-faq-body-inner">
                  <p className="nox-faq-answer">{item.a}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
