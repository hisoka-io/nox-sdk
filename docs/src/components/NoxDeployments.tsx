import React from 'react';

const STYLES = `
  .nox-deploy {
    margin-bottom: 32px;
  }

  .nox-deploy__net {
    margin-bottom: 36px;
  }

  .nox-deploy__net-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--nox-border);
  }

  .nox-deploy__badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-radius: 6px;
    background: var(--nox-surface);
    border: 1px solid var(--ifm-color-primary);
    color: var(--ifm-color-primary);
  }

  .nox-deploy__badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ifm-color-primary);
  }

  .nox-deploy__chain {
    font-size: 13px;
    font-family: var(--ifm-font-family-monospace);
    color: var(--ifm-color-emphasis-400);
  }

  .nox-deploy__table {
    width: 100%;
    border-collapse: collapse;
  }

  .nox-deploy__table tr {
    border-bottom: 1px solid var(--nox-border);
  }

  .nox-deploy__table tr:last-child {
    border-bottom: none;
  }

  .nox-deploy__table td {
    padding: 18px 16px;
    vertical-align: middle;
  }

  .nox-deploy__table td:first-child {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    padding-right: 32px;
    width: 160px;
    color: var(--ifm-color-emphasis-500);
  }

  .nox-deploy__addr {
    font-family: var(--ifm-font-family-monospace);
    font-size: 13px;
    word-break: break-all;
    color: var(--ifm-font-color-base);
    text-decoration: none;
    transition: color 0.2s ease;
  }

  .nox-deploy__addr:hover {
    color: var(--ifm-color-primary);
  }

`;

type Contract = {
  name: string;
  address: string;
};

type Network = {
  name: string;
  chainId: number;
  explorer: string;
  contracts: Contract[];
};

export default function NoxDeployments({ networks }: { networks: Network[] }) {
  return (
    <>
      <style>{STYLES}</style>
      <div className="nox-deploy">
        {networks.map((net) => (
          <div key={net.chainId} className="nox-deploy__net">
            <div className="nox-deploy__net-header">
              <span className="nox-deploy__badge">{net.name}</span>
              <span className="nox-deploy__chain">Chain {net.chainId}</span>
            </div>

            <table className="nox-deploy__table">
              <tbody>
                {net.contracts.map((c) => (
                  <tr key={c.address}>
                    <td>{c.name}</td>
                    <td>
                      <a
                        className="nox-deploy__addr"
                        href={`${net.explorer}/address/${c.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {c.address}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}
