import { createHash } from 'node:crypto'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type {
  SkillagerStoredTarget,
  SkillagerDeployment,
} from '../src/main/skillager/skillager-deployment-record'

export const deliveryId = '11111111-1111-1111-1111-111111111111'
export const deploymentFixture: SkillagerDeployment = {
  id: deliveryId,
  library: {
    id: '22222222-2222-2222-2222-222222222222',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
  skillId: 'lib/café',
  sourceHash: 'a'.repeat(64),
  agent: 'codex',
  destination: {
    projectId: 'project',
    workspaceId: 'workspace',
    root: hostPath(asHostId('remote'), '/workspace'),
  },
  targetEntry: '.agents/skills/lib-café',
  exposureId: 'lib-café',
  payload: {
    files: [
      {
        entry: 'SKILL.md',
        size: 4,
        mode: 0o644,
        sha256: createHash('sha256').update('test').digest('hex'),
      },
    ],
  },
}
export function preparedTarget(): Omit<SkillagerStoredTarget, 'revision'> {
  const { agent, destination, targetEntry, exposureId } = deploymentFixture
  return {
    identity: { agent, destination, targetEntry, exposureId },
    intent: {
      id: deliveryId,
      action: 'add',
      state: 'prepared',
      stageEntry: `.agents/skills/.hvir-skillager-stage-${deliveryId}`,
      quarantineEntry: `.agents/skills/.hvir-skillager-removed-${deliveryId}`,
      location: {
        root: destination.root,
        rootDevice: '1',
        rootInode: '50',
        ancestors: [
          { entry: '.agents', device: '1', inode: '10' },
          { entry: '.agents/skills', device: '1', inode: '11' },
        ],
        missingParents: [],
      },
      incoming: deploymentFixture,
    },
  }
}
