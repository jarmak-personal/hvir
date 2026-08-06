/** Closed build identities that may appear in local application evidence. */
export const APPLICATION_BUILD_CHANNELS = [
  'release',
  'development',
  'ssh-acceptance',
  'smoke',
] as const

export type ApplicationBuildChannel = (typeof APPLICATION_BUILD_CHANNELS)[number]

export function isApplicationBuildChannel(
  value: unknown,
): value is ApplicationBuildChannel {
  return APPLICATION_BUILD_CHANNELS.includes(value as ApplicationBuildChannel)
}
