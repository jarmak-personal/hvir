export function exampleManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'example.reference',
    name: 'Reference',
    version: '0.1.0',
    contract: '1.0',
    requiredCapabilities: ['presentation.read', 'viewer.open-own'],
    optionalCapabilities: [],
    access: [],
    views: [
      {
        id: 'reference',
        title: 'Reference',
        entry: 'index.html',
        placement: 'application',
        representations: ['view'],
      },
      {
        id: 'detail',
        title: 'Detail',
        entry: 'detail.html',
        placement: 'application',
        representations: ['view'],
      },
    ],
    ...overrides,
  }
}
