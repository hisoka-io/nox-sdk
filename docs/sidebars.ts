import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'overview',
    'quickstart',
    {
      type: 'category',
      label: 'Raven',
      items: [
        'raven-overview',
        'raven-architecture',
        'pir-trilemma',
      ],
    },
    {
      type: 'category',
      label: 'Nox Protocol',
      items: [
        'nox-protocol',
      ],
    },
    'security',
    {
      type: 'category',
      label: 'SDK',
      items: [
        'transactions',
        'rpc-calls',
        'http-requests',
        'cover-traffic',
      ],
    },
    'configuration',
    'error-handling',
    {
      type: 'doc',
      id: 'architecture',
      label: 'SDK Architecture',
    },
    'deployments',
    'glossary',
    'faq',
  ],
};

export default sidebars;
