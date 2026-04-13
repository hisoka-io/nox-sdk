import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'overview',
    'quickstart',
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
    'architecture',
    'deployments',
    'faq',
  ],
};

export default sidebars;
