import { localPath } from '../../src/shared/host-path'

export const setupSelection = {
  executable: localPath('/tools/skillager'),
  catalog: localPath('/catalog'),
  version: 'skillager 0.9.1',
  environment: { HOME: '/selected-home', PATH: '/selected-bin' },
}
export const setupLibrary = {
  schema: 'skillager.library.v1',
  namespace: 'lib',
  registration: 'valid',
  library_id: '45c79d81-a615-4123-b35e-fae2d7362442',
  root: '/personal/library',
  skills_path: '/personal/library/skills',
}
export function setupStatus(gitHistory = true) {
  return {
    schema: 'skillager.library-status.v1',
    status: 'ready',
    initialized: true,
    library: setupLibrary,
    git: { mode: gitHistory ? 'system' : 'disabled', repository: gitHistory },
    warnings: [],
    advisories: ['Unpublished advisory'],
    counts: { skills: 0 },
    skill: null,
  }
}
export function setupInitialization(gitHistory = true) {
  return {
    ...setupStatus(gitHistory),
    schema: 'skillager.library-init.v1',
    status: 'initialized',
    created: true,
    git_repository_created: gitHistory,
    indexed: 0,
    errors: [],
  }
}
